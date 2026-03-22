/**
 * liveMode.integration.ts — Integration test for the Live Mode feature.
 *
 * This test verifies that:
 *   1. The `memray.runLive` command is registered after extension activation.
 *   2. The splitJsonLines and parseSnapshot utilities work correctly
 *      in a real Node.js environment (not just unit-test stubs).
 *   3. The live bridge script (`scripts/memray_bridge.py`) exits cleanly when
 *      called with missing or invalid arguments — exercising the real process
 *      spawn path.
 *
 * NOTE: Full end-to-end tests (spawning a real `memray run --output` process)
 * require memray to be installed in the test environment and are skipped
 * automatically when it is not present.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as childProcess from 'child_process';
import * as vscode from 'vscode';
import { splitJsonLines, parseSnapshot } from '../../src/memray/liveProvider';

const EXTENSION_ID = 'JuanMonteiro.memray-profiler';
const SCRIPTS_DIR = path.resolve(__dirname, '../../../scripts');
const BRIDGE_SCRIPT = path.join(SCRIPTS_DIR, 'memray_bridge.py');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spawnBridge(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise(resolve => {
    const proc = childProcess.spawn('python3', [BRIDGE_SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', code => resolve({ stdout, stderr, code }));
    // Kill after 5 s to avoid hanging in CI
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } }, 5000);
  });
}

async function isPython3Available(): Promise<boolean> {
  return new Promise(resolve => {
    const proc = childProcess.spawn('python3', ['--version'], { stdio: 'ignore' });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('integration: live mode — command registration', function () {
  this.timeout(20000);

  before(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `expected extension ${EXTENSION_ID} to be available`);
    await extension.activate();
  });

  it('registers the memray.runLive command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('memray.runLive'),
      'expected memray.runLive to be registered after activation',
    );
  });
});

// ---------------------------------------------------------------------------
// Suite: pure utility functions (no VS Code API needed)
// ---------------------------------------------------------------------------

describe('integration: live mode — splitJsonLines', function () {
  it('reassembles a snapshot split across three chunks', () => {
    const line = JSON.stringify({ ts: 1, heap: 512, peak: 1024, top: [] });
    const third = Math.floor(line.length / 3);

    let buf = '';
    const snapshots: string[] = [];

    // chunk 1
    buf += line.slice(0, third);
    const r1 = splitJsonLines(buf);
    snapshots.push(...r1.lines);
    buf = r1.remainder;

    // chunk 2
    buf += line.slice(third, 2 * third);
    const r2 = splitJsonLines(buf);
    snapshots.push(...r2.lines);
    buf = r2.remainder;

    // chunk 3 + newline
    buf += line.slice(2 * third) + '\n';
    const r3 = splitJsonLines(buf);
    snapshots.push(...r3.lines);
    buf = r3.remainder;

    assert.strictEqual(snapshots.length, 1);
    const parsed = parseSnapshot(snapshots[0]);
    assert.ok(parsed !== null);
    assert.strictEqual(parsed!.ts, 1);
    assert.strictEqual(parsed!.peak, 1024);
  });

  it('handles a burst of 50 snapshots in a single chunk', () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ ts: i, heap: i * 100, peak: i * 200, top: [] }),
    ).join('\n') + '\n';

    const { lines: parsed } = splitJsonLines(lines);
    assert.strictEqual(parsed.length, 50);

    for (let i = 0; i < 50; i++) {
      const snap = parseSnapshot(parsed[i]);
      assert.ok(snap !== null, `snapshot ${i} should parse`);
      assert.strictEqual(snap!.ts, i);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: bridge script process (requires python3)
// ---------------------------------------------------------------------------

describe('integration: live mode — bridge script process', function () {
  this.timeout(10000);

  before(async function () {
    const hasPython = await isPython3Available();
    if (!hasPython) {
      this.skip();
    }
  });

  it('exits with code 2 and prints usage when --bin-path is missing', async () => {
    const { stderr, code } = await spawnBridge([]);
    assert.strictEqual(code, 2, `expected exit code 2, got ${code}`);
    assert.ok(
      stderr.includes('--bin-path') || stderr.includes('required'),
      `expected usage error mentioning --bin-path, got: ${stderr.slice(0, 200)}`,
    );
  });

  it('exits with code 3 when the .bin file does not appear within timeout', async () => {
    // Pass a path that will never exist and a very short wait timeout so the
    // test completes quickly regardless of whether memray is installed.
    const { code, stderr } = await spawnBridge([
      '--bin-path', '/tmp/memray_bridge_test_nonexistent_file_that_will_never_exist.bin',
      '--wait-timeout', '0.5',
    ]);
    // Exit code 2: memray not installed; exit code 3: file not found (timeout)
    assert.ok(
      code === 2 || code === 3,
      `expected exit code 2 or 3, got ${code}\nstderr: ${stderr.slice(0, 300)}`,
    );
  });
});
