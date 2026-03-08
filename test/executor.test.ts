import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
const requireC = createRequire(process.cwd() + '/package.json');
const proxyquire = requireC('proxyquire').noCallThru();

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

class FakeOutput {
  public lines: string[] = [];
  appendLine(s: string) { this.lines.push(s); }
}

describe('executor.runProfile', function () {
  this.timeout(5000);

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

    const fakeConfig = { getConfig: () => ({ nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }), default: { getConfig: () => ({ nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }) } };

    const mocked = proxyquire('./src/memray/executor', {
      '../utils/pythonDetection': mockDetection,
      'child_process': { spawn: makeSpawnMock(0) },
      vscode: fakeVscode,
      '../config': fakeConfig
    });

    const out = new FakeOutput();
    const res = await mocked.runProfile({ scriptPath: 'script.py', outDir: tmp, id: 'run1' }, out as any);
    assert.strictEqual(res.binPath, path.join(tmp, 'run1.bin'));
    assert.strictEqual(res.htmlPath, path.join(tmp, 'run1.html'));
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

    const fakeConfig = { getConfig: () => ({ nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }), default: { getConfig: () => ({ nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }) } };

    const mocked = proxyquire('./src/memray/executor', {
      '../utils/pythonDetection': mockDetection,
      'child_process': { spawn: makeSpawnMock(42) },
      vscode: fakeVscode,
      '../config': fakeConfig
    });

    const out = new FakeOutput();
    let threw = false;
    try {
      await mocked.runProfile({ scriptPath: 'script.py', outDir: tmp, id: 'run2' }, out as any);
    } catch (e: any) {
      threw = true;
      assert.ok(/memray run exited with code/.test(e.message));
    }
    assert.ok(threw, 'expected runProfile to throw');
  });
});
