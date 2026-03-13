import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { runProfile, __setExecutorDepsForTests, __resetExecutorDepsForTests } from '../src/memray/executor';

function makeSpawnMock(exitCode: number, delay = 0) {
  return (_cmd: string, _args: string[], _opts: any) => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    // emit close after next tick or delay
    if (delay > 0) setTimeout(() => child.emit('close', exitCode), delay);
    else process.nextTick(() => child.emit('close', exitCode));
    return child;
  };
}

function makeSpawnSequence(exitCodes: number[], delay = 0) {
  let idx = 0;
  return (_cmd: string, _args: string[], _opts: any) => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const code = idx < exitCodes.length ? exitCodes[idx] : exitCodes[exitCodes.length - 1];
    idx += 1;
    if (delay > 0) setTimeout(() => child.emit('close', code), delay);
    else process.nextTick(() => child.emit('close', code));
    return child;
  };
}

class FakeOutput {
  public lines: string[] = [];
  appendLine(s: string) { this.lines.push(s); }
}

describe('executor.runProfile', function () {
  this.timeout(5000);

  afterEach(() => {
    __resetExecutorDepsForTests();
  });

  it('runs successfully when memray commands exit 0', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memray-run-'));

    const mockDetection = {
      detectMemray: async () => ({ command: ['memray'], path: 'memray', source: 'system', tried: [] }),
      verifyMemray: async () => true,
    };

    const fakeVscode = {
      window: { createOutputChannel: () => ({ appendLine: (_s: string) => {} }) },
      workspace: { workspaceFolders: [] },
      ProgressLocation: { Notification: 1 }
    };

    const fakeConfig = { getConfig: () => ({ pythonPath: '', nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }), default: { getConfig: () => ({ pythonPath: '', nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }) } };

    __setExecutorDepsForTests({
      detection: mockDetection as any,
      spawn: makeSpawnMock(0) as any,
      vscode: fakeVscode as any,
      cfg: fakeConfig as any,
    });

    const out = new FakeOutput();
    const res = await runProfile({ scriptPath: 'script.py', outDir: tmp, id: 'run1' }, out as any);
    assert.strictEqual(res.binPath, path.join(tmp, 'run1.bin'));
    assert.strictEqual(res.htmlPath, path.join(tmp, 'run1.html'));
    assert.strictEqual(res.statsPath, path.join(tmp, 'stats.json'));
    assert.strictEqual(res.runOk, true);
    assert.strictEqual(res.flamegraphOk, true);
    assert.strictEqual(res.statsOk, true);
    assert.deepStrictEqual(res.errors, []);
  });

  it('throws when memray run exits non-zero', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memray-run-'));

    const mockDetection = {
      detectMemray: async () => ({ command: ['memray'], path: 'memray', source: 'system', tried: [] }),
      verifyMemray: async () => true,
    };

    const fakeVscode = {
      window: { createOutputChannel: () => ({ appendLine: (_s: string) => {} }) },
      workspace: { workspaceFolders: [] },
      ProgressLocation: { Notification: 1 }
    };

    const fakeConfig = { getConfig: () => ({ pythonPath: '', nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }), default: { getConfig: () => ({ pythonPath: '', nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }) } };

    __setExecutorDepsForTests({
      detection: mockDetection as any,
      spawn: makeSpawnMock(42) as any,
      vscode: fakeVscode as any,
      cfg: fakeConfig as any,
    });

    const out = new FakeOutput();
    let threw = false;
    try {
      await runProfile({ scriptPath: 'script.py', outDir: tmp, id: 'run2' }, out as any);
    } catch (e: any) {
      threw = true;
      assert.ok(/memray run exited with code/.test(e.message));
    }
    assert.ok(threw, 'expected runProfile to throw');
  });

  it('returns partial result when flamegraph fails but stats succeeds', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memray-run-'));

    const mockDetection = {
      detectMemray: async () => ({ command: ['memray'], path: 'memray', source: 'system', tried: [] }),
      verifyMemray: async () => true,
    };

    const fakeVscode = {
      window: { createOutputChannel: () => ({ appendLine: (_s: string) => {} }) },
      workspace: { workspaceFolders: [] },
      ProgressLocation: { Notification: 1 }
    };

    const fakeConfig = { getConfig: () => ({ pythonPath: '', nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }), default: { getConfig: () => ({ pythonPath: '', nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }) } };

    __setExecutorDepsForTests({
      detection: mockDetection as any,
      spawn: makeSpawnSequence([0, 5, 0]) as any,
      vscode: fakeVscode as any,
      cfg: fakeConfig as any,
    });

    const out = new FakeOutput();
    const res = await runProfile({ scriptPath: 'script.py', outDir: tmp, id: 'run3' }, out as any);
    assert.strictEqual(res.runOk, true);
    assert.strictEqual(res.flamegraphOk, false);
    assert.strictEqual(res.statsOk, true);
    assert.ok(res.errors.some((e: string) => /flamegraph/.test(e)));
  });

  it('returns partial result when stats fails but flamegraph succeeds', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memray-run-'));

    const mockDetection = {
      detectMemray: async () => ({ command: ['memray'], path: 'memray', source: 'system', tried: [] }),
      verifyMemray: async () => true,
    };

    const fakeVscode = {
      window: { createOutputChannel: () => ({ appendLine: (_s: string) => {} }) },
      workspace: { workspaceFolders: [] },
      ProgressLocation: { Notification: 1 }
    };

    const fakeConfig = { getConfig: () => ({ pythonPath: '', nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }), default: { getConfig: () => ({ pythonPath: '', nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }) } };

    // run=0, flamegraph=0, stats=7
    __setExecutorDepsForTests({
      detection: mockDetection as any,
      spawn: makeSpawnSequence([0, 0, 7]) as any,
      vscode: fakeVscode as any,
      cfg: fakeConfig as any,
    });

    const out = new FakeOutput();
    const res = await runProfile({ scriptPath: 'script.py', outDir: tmp, id: 'run4' }, out as any);
    assert.strictEqual(res.runOk, true);
    assert.strictEqual(res.flamegraphOk, true);
    assert.strictEqual(res.statsOk, false);
    assert.ok(res.errors.some((e: string) => /stats/.test(e)));
  });

  it('passes --native flag when native option is true', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memray-run-'));

    const mockDetection = {
      detectMemray: async () => ({ command: ['memray'], path: 'memray', source: 'system', tried: [] }),
      verifyMemray: async () => true,
    };

    const fakeVscode = {
      window: { createOutputChannel: () => ({ appendLine: (_s: string) => {} }) },
      workspace: { workspaceFolders: [] },
      ProgressLocation: { Notification: 1 }
    };

    const fakeConfig = { getConfig: () => ({ pythonPath: '', nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }), default: { getConfig: () => ({ pythonPath: '', nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }) } };

    const capturedArgs: string[][] = [];
    const spawnCapture = (_cmd: string, args: string[], _opts: any) => {
      capturedArgs.push(args);
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      process.nextTick(() => child.emit('close', 0));
      return child;
    };

    __setExecutorDepsForTests({
      detection: mockDetection as any,
      spawn: spawnCapture as any,
      vscode: fakeVscode as any,
      cfg: fakeConfig as any,
    });

    const out = new FakeOutput();
    await runProfile({ scriptPath: 'script.py', outDir: tmp, id: 'run5', native: true }, out as any);
    // First spawn invocation is the `run` step
    assert.ok(capturedArgs[0].includes('--native'), 'expected --native flag in run args');
  });
});
