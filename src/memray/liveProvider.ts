/**
 * liveProvider.ts — Orchestrates the Live Mode session for the VS Code Memray extension.
 *
 * Responsibilities:
 *  1. Detect memray and a memray-capable Python interpreter.
 *  2. Spawn the target Python script under `memray run --output <binPath> --no-compress --force`.
 *  3. Spawn the bridge middleware (scripts/memray_bridge.py) to poll the .bin file via FileReader.
 *  4. Parse newline-delimited JSON snapshots emitted by the bridge on stdout.
 *  5. Forward each parsed snapshot to registered listeners (e.g., the Webview).
 *  6. Tear down both child processes gracefully when the session ends.
 *
 * JSON snapshot schema (one object per line from bridge stdout):
 * {
 *   ts:    number   — Unix timestamp in ms
 *   heap:  number   — current live heap bytes (tracked by memray allocator hooks)
 *   rss:   number   — alias for heap (emitted by bridge for compatibility; not used by TS consumers)
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
import { splitJsonLines, parseSnapshot } from './liveUtils';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LiveSnapshot {
  ts: number;
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
  binPath?: string;           // path where memray will write the .bin file
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
  /** Reserved (kept for test compatibility). */
  readonly port: number;
  /** Path to the .bin file being written by this session. */
  readonly binPath: string;
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

// Re-export utility functions from liveUtils
export { splitJsonLines, parseSnapshot } from './liveUtils';

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
 *   3. Launch: `memray run --output <binPath> --no-compress --force -- <scriptPath>`
 *   4. Launch: `python memray_bridge.py --bin-path <binPath> [--interval ...] [--top-n ...]`
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

  // --- Reserve port (no longer used for live-remote; kept for interface compat) ---
  const port = await _deps.findFreePort();
  output.appendLine(`[live] Reserved port (unused): ${port}`);

  // --- Resolve .bin output path ---
  const binPath: string = opts.binPath ?? path.join(
    path.dirname(opts.scriptPath),
    `memray-live-${Date.now()}.bin`,
  );
  output.appendLine(`[live] .bin output: ${binPath}`);

  // --- Spawn target process (normal run with --output, no --live-remote) ---
  const memrayCmd = detected.command[0];
  const memrayPrefix = detected.command.slice(1);
  const targetArgs = [
    ...memrayPrefix,
    'run',
    '--output', binPath,
    '--no-compress',
    '--force',
    '--',
    opts.scriptPath,
  ];
  output.appendLine(`[live] Spawning target: ${memrayCmd} ${targetArgs.join(' ')}`);
  const targetProc = _deps.spawn(memrayCmd, targetArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  targetProc.stdout?.on('data', (d: Buffer) => output.appendLine(`[target] ${d.toString().trimEnd()}`));
  targetProc.stderr?.on('data', (d: Buffer) => output.appendLine(`[target] ${d.toString().trimEnd()}`));

  // --- Spawn bridge process (FileReader polling mode) ---
  const bridgeArgs = [
    BRIDGE_SCRIPT,
    '--bin-path', binPath,
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

  let targetExited = false;
  let bridgeExited = false;
  const onProcessExit = () => {
    if (targetExited && bridgeExited) {
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
    targetExited = true;
    onProcessExit();
  });

  bridgeProc.on('close', (code: number | null) => {
    output.appendLine(`[live] Bridge exited with code ${code}`);
    bridgeExited = true;
    onProcessExit();
  });

  // --- Return session handle ---
  const session: LiveSession = {
    port,
    binPath,
    stop: doStop,
    onSnapshot: (fn) => { snapshotListeners.push(fn); },
    onError: (fn) => { errorListeners.push(fn); },
    onStop: (fn) => { stopListeners.push(fn); },
  };

  return session;
}
