/**
 * liveProvider.ts — Orchestrates the Live Mode session for the VS Code Memray extension.
 *
 * Responsibilities:
 *  1. Reserve a free ephemeral TCP port.
 *  2. Spawn the target Python script under `memray run --live-remote --live-port <PORT>`.
 *  3. Spawn the bridge middleware (scripts/memray_bridge.py) once the target is ready.
 *  4. Parse newline-delimited JSON snapshots emitted by the bridge on stdout.
 *  5. Forward each parsed snapshot to registered listeners (e.g., the Webview).
 *  6. Tear down both child processes gracefully when the session ends.
 *
 * JSON snapshot schema (one object per line from bridge stdout):
 * {
 *   ts:    number   — Unix timestamp in ms
 *   rss:   number   — current live bytes
 *   heap:  number   — current heap bytes
 *   peak:  number   — session high watermark in bytes
 *   top:   Array<{ func: string; file: string; line: number; mem: number; allocs: number }>
 * }
 */

import * as childProcess from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type * as VSCode from 'vscode';
import detection from '../utils/pythonDetection';
import { detectMemrayPython } from '../utils/memrayPython';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LiveSnapshot {
  ts: number;
  rss: number;
  heap: number;
  peak: number;
  top: Array<{
    func: string;
    file: string;
    line: number;
    mem: number;
    allocs: number;
  }>;
}

export type SnapshotListener = (snapshot: LiveSnapshot) => void;
export type ErrorListener = (error: Error) => void;
export type StopListener = () => void;

export interface LiveSessionOptions {
  scriptPath: string;
  intervalSeconds?: number;   // aggregation window (default 0.5)
  topN?: number;              // top allocators to include (default 20)
  pythonPath?: string;        // override python interpreter
}

export interface LiveSessionDeps {
  spawn: typeof childProcess.spawn;
  detection: typeof detection;
  detectMemrayPython: typeof detectMemrayPython;
  findFreePort: () => Promise<number>;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

export interface LiveSession {
  /** Stop the live session and kill all child processes. */
  stop(): void;
  /** Subscribe to new snapshots. */
  onSnapshot(listener: SnapshotListener): void;
  /** Subscribe to errors. */
  onError(listener: ErrorListener): void;
  /** Subscribe to session termination (called after both processes exit). */
  onStop(listener: StopListener): void;
  /** The ephemeral port used for IPC. */
  readonly port: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROVIDER_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.resolve(PROVIDER_DIR, '../../scripts/memray_bridge.py');

/**
 * Finds a free TCP port by letting the OS assign one on 127.0.0.1.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        return reject(new Error('Could not determine free port'));
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * Splits a potentially chunked stdout buffer into complete JSON lines.
 * Returns { lines, remainder } where remainder is any incomplete trailing data.
 */
export function splitJsonLines(buffer: string): { lines: string[]; remainder: string } {
  const parts = buffer.split('\n');
  const remainder = parts.pop() ?? '';
  const lines = parts.filter(l => l.trim().length > 0);
  return { lines, remainder };
}

/**
 * Safely parse a JSON line into a LiveSnapshot. Returns null on failure.
 */
export function parseSnapshot(line: string): LiveSnapshot | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (
      typeof obj.ts !== 'number' ||
      typeof obj.rss !== 'number' ||
      typeof obj.heap !== 'number' ||
      typeof obj.peak !== 'number' ||
      !Array.isArray(obj.top)
    ) {
      return null;
    }
    return obj as unknown as LiveSnapshot;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default deps (production)
// ---------------------------------------------------------------------------

const defaultDeps: LiveSessionDeps = {
  spawn: childProcess.spawn,
  detection,
  detectMemrayPython,
  findFreePort,
};

let _deps: LiveSessionDeps = { ...defaultDeps };

export function __setLiveProviderDepsForTests(overrides: Partial<LiveSessionDeps>): void {
  _deps = { ...defaultDeps, ...overrides };
}

export function __resetLiveProviderDepsForTests(): void {
  _deps = { ...defaultDeps };
}

// ---------------------------------------------------------------------------
// Core: startLiveSession
// ---------------------------------------------------------------------------

/**
 * Start a live profiling session for `opts.scriptPath`.
 *
 * Flow:
 *   1. Detect memray command + memray-capable Python.
 *   2. Reserve a free port.
 *   3. Launch: `memray run --live-remote --live-port <PORT> -- <scriptPath>`
 *   4. Launch: `python memray_bridge.py --port <PORT> [...]`
 *   5. Pipe bridge stdout → parse JSON → notify listeners.
 *   6. Both processes are killed when stop() is called or the target exits.
 */
export async function startLiveSession(
  opts: LiveSessionOptions,
  output: VSCode.OutputChannel,
): Promise<LiveSession> {
  const snapshotListeners: SnapshotListener[] = [];
  const errorListeners: ErrorListener[] = [];
  const stopListeners: StopListener[] = [];

  const emit = (snap: LiveSnapshot) => snapshotListeners.forEach(fn => fn(snap));
  const emitError = (err: Error) => errorListeners.forEach(fn => fn(err));
  const emitStop = () => stopListeners.forEach(fn => fn());

  // --- Detect memray ---
  const detected = await _deps.detection.detectMemray();
  if (!detected?.command?.length) {
    throw new Error('memray not found. Install memray in your project Python environment.');
  }
  const ok = await _deps.detection.verifyMemray(detected.command);
  if (!ok) {
    throw new Error('Detected memray failed verification (--version).');
  }

  // --- Detect Python with memray ---
  const memrayPython = await _deps.detectMemrayPython(detected.command, opts.pythonPath, _deps.spawn);
  if (!memrayPython.pythonPath) {
    throw new Error(
      `memray-capable Python not found. Tried: ${memrayPython.tried.join(', ') || 'none'}`,
    );
  }

  // --- Reserve port ---
  const port = await _deps.findFreePort();
  output.appendLine(`[live] Reserved port: ${port}`);

  // --- Spawn target process ---
  const memrayCmd = detected.command[0];
  const memrayPrefix = detected.command.slice(1);
  const targetArgs = [
    ...memrayPrefix,
    'run',
    '--live-remote',
    '--live-port', String(port),
    '--',
    opts.scriptPath,
  ];
  output.appendLine(`[live] Spawning target: ${memrayCmd} ${targetArgs.join(' ')}`);
  const targetProc = _deps.spawn(memrayCmd, targetArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  targetProc.stdout?.on('data', (d: Buffer) => output.appendLine(`[target] ${d.toString().trimEnd()}`));
  targetProc.stderr?.on('data', (d: Buffer) => output.appendLine(`[target] ${d.toString().trimEnd()}`));

  // --- Spawn bridge process ---
  const bridgeArgs = [
    BRIDGE_SCRIPT,
    '--port', String(port),
    '--host', '127.0.0.1',
    '--interval', String(opts.intervalSeconds ?? 0.5),
    '--top-n', String(opts.topN ?? 20),
  ];
  output.appendLine(`[live] Spawning bridge: ${memrayPython.pythonPath} ${bridgeArgs.join(' ')}`);
  const bridgeProc = _deps.spawn(memrayPython.pythonPath, bridgeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  bridgeProc.stderr?.on('data', (d: Buffer) => output.appendLine(`[bridge] ${d.toString().trimEnd()}`));

  // --- Parse bridge stdout ---
  let stdoutBuffer = '';
  bridgeProc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    const { lines, remainder } = splitJsonLines(stdoutBuffer);
    stdoutBuffer = remainder;
    for (const line of lines) {
      const snap = parseSnapshot(line);
      if (snap) {
        emit(snap);
      } else {
        output.appendLine(`[bridge] Unparseable line: ${line.slice(0, 200)}`);
      }
    }
  });

  // --- Process lifecycle ---
  let stopped = false;

  const doStop = () => {
    if (stopped) return;
    stopped = true;
    output.appendLine('[live] Stopping session...');
    try { targetProc.kill('SIGTERM'); } catch { /* ignore */ }
    try { bridgeProc.kill('SIGTERM'); } catch { /* ignore */ }
  };

  let processesExited = 0;
  const onProcessExit = () => {
    processesExited += 1;
    if (processesExited >= 2) {
      output.appendLine('[live] Session ended.');
      emitStop();
    }
  };

  targetProc.on('error', (err: Error) => {
    output.appendLine(`[live] Target process error: ${err.message}`);
    emitError(err);
    doStop();
  });

  bridgeProc.on('error', (err: Error) => {
    output.appendLine(`[live] Bridge process error: ${err.message}`);
    emitError(err);
    doStop();
  });

  targetProc.on('close', (code: number | null) => {
    output.appendLine(`[live] Target exited with code ${code}`);
    // When the target finishes, stop the bridge too
    try { bridgeProc.kill('SIGTERM'); } catch { /* ignore */ }
    onProcessExit();
  });

  bridgeProc.on('close', (code: number | null) => {
    output.appendLine(`[live] Bridge exited with code ${code}`);
    onProcessExit();
  });

  // --- Return session handle ---
  const session: LiveSession = {
    port,
    stop: doStop,
    onSnapshot: (fn) => { snapshotListeners.push(fn); },
    onError: (fn) => { errorListeners.push(fn); },
    onStop: (fn) => { stopListeners.push(fn); },
  };

  return session;
}
