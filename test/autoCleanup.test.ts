import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { __setVscodeForTests, __resetVscodeForTests } from '../src/vscodeApi';

class FakeTreeItem {
  public label: string;
  constructor(label: string, _state?: number) { this.label = label; }
}

class FakeEventEmitter<T> {
  public event = (_listener: (value: T) => void) => ({ dispose: () => {} });
  fire(_value?: T) {}
}

class FakeOutput {
  lines: string[] = [];
  appendLine(s: string) { this.lines.push(s); }
}

function buildFakeVscode(keepHistoryDays: number) {
  return {
    workspace: {
      workspaceFolders: undefined as any,
      createFileSystemWatcher: () => ({
        onDidChange: (_cb: () => void) => {},
        onDidCreate: (_cb: () => void) => {},
        onDidDelete: (_cb: () => void) => {},
        dispose: () => {},
      }),
      getConfiguration: (_section?: string) => ({
        get: (key: string, def: unknown) => {
          if (key === 'keepHistoryDays') return keepHistoryDays;
          return def;
        },
      }),
    },
    window: {
      createOutputChannel: () => new FakeOutput(),
      showInformationMessage: async (_msg: string) => undefined,
      showWarningMessage: async (_msg: string) => undefined,
      showErrorMessage: async (_msg: string) => undefined,
      createWebviewPanel: () => ({ webview: { html: '' } }),
      registerTreeDataProvider: (_id: string, _provider: any) => ({ dispose: () => {} }),
      activeTextEditor: undefined,
    },
    commands: {
      registerCommand: (_id: string, _cb: (...args: any[]) => Promise<void> | void) => ({ dispose: () => {} }),
      executeCommand: async (_id: string, ..._args: any[]) => undefined,
    },
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    RelativePattern: class { constructor(_base: any, _pattern: string) {} },
    EventEmitter: FakeEventEmitter,
    TreeItem: FakeTreeItem,
    TreeItemCollapsibleState: { None: 0 },
    ViewColumn: { One: 1 },
    ProgressLocation: { Notification: 1 },
  };
}

describe('cleanupOldResults', function () {
  this.timeout(5000);

  afterEach(() => __resetVscodeForTests());

  /**
   * Helper: write a run directory + index entry with a given timestamp offset.
   */
  async function makeResult(memdir: string, id: string, daysAgo: number): Promise<object> {
    const dir = path.join(memdir, id);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'result.bin'), 'BIN');
    const timestamp = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    const entry = { id, title: id, bin: path.join('.memray', id, 'result.bin'), timestamp, runOk: true };
    const metaPath = path.join(dir, 'meta.json');
    await fs.promises.writeFile(metaPath, JSON.stringify(entry, null, 2), 'utf8');
    return entry;
  }

  it('removes entries older than keepHistoryDays', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cleanup-'));
    const memdir = path.join(tmp, '.memray');
    await fs.promises.mkdir(memdir, { recursive: true });

    const old1 = await makeResult(memdir, 'old1', 40);
    const old2 = await makeResult(memdir, 'old2', 35);
    const recent = await makeResult(memdir, 'recent', 1);

    const index = [old1, old2, recent];
    await fs.promises.writeFile(path.join(memdir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

    __setVscodeForTests(buildFakeVscode(30) as any);
    const ext = await import('../src/extension');

    const out = new FakeOutput();
    const removed = await ext.cleanupOldResults(tmp, out as any);

    assert.strictEqual(removed, 2, 'should remove 2 old entries');
    assert.ok(out.lines.some(l => l.includes('2 results')), 'should log removal count');

    const rawIndex = await fs.promises.readFile(path.join(memdir, 'index.json'), 'utf8');
    const remaining = JSON.parse(rawIndex) as Array<{ id: string }>;
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].id, 'recent');

    // The old run directories should be gone from disk
    const old1Exists = await fs.promises.access(path.join(memdir, 'old1')).then(() => true).catch(() => false);
    const old2Exists = await fs.promises.access(path.join(memdir, 'old2')).then(() => true).catch(() => false);
    assert.ok(!old1Exists, 'old1 directory should be deleted');
    assert.ok(!old2Exists, 'old2 directory should be deleted');

    // recent directory should still exist
    const recentExists = await fs.promises.access(path.join(memdir, 'recent')).then(() => true).catch(() => false);
    assert.ok(recentExists, 'recent directory should remain');
  });

  it('keeps all results when keepHistoryDays is 0', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cleanup-noop-'));
    const memdir = path.join(tmp, '.memray');
    await fs.promises.mkdir(memdir, { recursive: true });

    const old = await makeResult(memdir, 'veryold', 100);
    await fs.promises.writeFile(path.join(memdir, 'index.json'), JSON.stringify([old], null, 2), 'utf8');

    __setVscodeForTests(buildFakeVscode(0) as any);
    const ext = await import('../src/extension');

    const out = new FakeOutput();
    const removed = await ext.cleanupOldResults(tmp, out as any);

    assert.strictEqual(removed, 0, 'should not remove anything when keepHistoryDays is 0');

    const rawIndex = await fs.promises.readFile(path.join(memdir, 'index.json'), 'utf8');
    const remaining = JSON.parse(rawIndex) as Array<{ id: string }>;
    assert.strictEqual(remaining.length, 1, 'index should still have the entry');
  });

  it('keeps all results when keepHistoryDays is negative', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cleanup-neg-'));
    const memdir = path.join(tmp, '.memray');
    await fs.promises.mkdir(memdir, { recursive: true });

    const old = await makeResult(memdir, 'veryold2', 365);
    await fs.promises.writeFile(path.join(memdir, 'index.json'), JSON.stringify([old], null, 2), 'utf8');

    __setVscodeForTests(buildFakeVscode(-1) as any);
    const ext = await import('../src/extension');

    const out = new FakeOutput();
    const removed = await ext.cleanupOldResults(tmp, out as any);

    assert.strictEqual(removed, 0);
  });

  it('returns 0 when index.json does not exist', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cleanup-empty-'));

    __setVscodeForTests(buildFakeVscode(30) as any);
    const ext = await import('../src/extension');

    const out = new FakeOutput();
    const removed = await ext.cleanupOldResults(tmp, out as any);
    assert.strictEqual(removed, 0);
  });

  it('keeps all results when nothing is older than the threshold', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cleanup-fresh-'));
    const memdir = path.join(tmp, '.memray');
    await fs.promises.mkdir(memdir, { recursive: true });

    const fresh = await makeResult(memdir, 'fresh1', 2);
    await fs.promises.writeFile(path.join(memdir, 'index.json'), JSON.stringify([fresh], null, 2), 'utf8');

    __setVscodeForTests(buildFakeVscode(30) as any);
    const ext = await import('../src/extension');

    const out = new FakeOutput();
    const removed = await ext.cleanupOldResults(tmp, out as any);

    assert.strictEqual(removed, 0);
    const rawIndex = await fs.promises.readFile(path.join(memdir, 'index.json'), 'utf8');
    const remaining = JSON.parse(rawIndex) as Array<{ id: string }>;
    assert.strictEqual(remaining.length, 1);
  });
});
