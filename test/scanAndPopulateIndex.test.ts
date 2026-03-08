import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { __setVscodeForTests, __resetVscodeForTests } from '../src/vscodeApi';

class FakeTreeItem {
  public label: string;

  constructor(label: string, _state?: number) {
    this.label = label;
  }
}

class FakeEventEmitter<T> {
  public event = (_listener: (value: T) => void) => ({ dispose: () => {} });
  fire(_value?: T) {}
}

class FakeOutput {
  lines: string[] = [];
  appendLine(s: string) { this.lines.push(s); }
}

describe('scanAndPopulateIndex', function () {
  this.timeout(5000);

  afterEach(() => {
    __resetVscodeForTests();
  });

  it('builds index.json from various layouts', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scan-'));
    const memdir = path.join(tmp, '.memray');
    await fs.promises.mkdir(memdir, { recursive: true });

    // 1) dir with meta.json
    const d1 = path.join(memdir, 'result1');
    await fs.promises.mkdir(d1, { recursive: true });
    const meta = { id: 'result1', title: 'Result One', html: path.join(d1, 'r.html'), bin: path.join(d1, 'r.bin'), stats: path.join(d1, 'stats.json'), timestamp: new Date().toISOString() };
    await fs.promises.writeFile(path.join(d1, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    await fs.promises.writeFile(path.join(d1, 'stats.json'), JSON.stringify({ metadata: { peak_memory: 1048576 } }, null, 2), 'utf8');

    // 2) dir without meta but with html/bin
    const d2 = path.join(memdir, 'result2');
    await fs.promises.mkdir(d2, { recursive: true });
    await fs.promises.writeFile(path.join(d2, 'out.html'), '<html></html>');
    await fs.promises.writeFile(path.join(d2, 'out.bin'), 'BIN');
    await fs.promises.writeFile(path.join(d2, 'stats.json'), JSON.stringify({ metadata: { peak_memory: 2097152 } }, null, 2), 'utf8');

    // 3) loose files
    await fs.promises.writeFile(path.join(memdir, 'loose.html'), '<html></html>');
    await fs.promises.writeFile(path.join(memdir, 'loose.bin'), 'BIN');

    const fakeVscode = {
      workspace: {
        workspaceFolders: [{ uri: { fsPath: tmp } }],
        getConfiguration: () => ({ get: (_key: string, def: unknown) => def }),
      },
      window: {
        createOutputChannel: () => ({ appendLine: (_s: string) => {} }),
        showInformationMessage: async (_msg: string) => undefined,
        showWarningMessage: async (_msg: string) => undefined,
        showErrorMessage: async (_msg: string) => undefined,
        createWebviewPanel: () => ({ webview: { html: '' } }),
        registerTreeDataProvider: (_id: string, _provider: any) => ({ dispose: () => {} }),
      },
      commands: {
        registerCommand: (_id: string, _cb: (...args: any[]) => Promise<void> | void) => ({ dispose: () => {} }),
        executeCommand: async (_id: string, ..._args: any[]) => undefined,
      },
      Uri: {
        file: (fsPath: string) => ({ fsPath }),
      },
      RelativePattern: class {
        constructor(_base: any, _pattern: string) {}
      },
      EventEmitter: FakeEventEmitter,
      TreeItem: FakeTreeItem,
      TreeItemCollapsibleState: { None: 0 },
      ViewColumn: { One: 1 },
      ProgressLocation: { Notification: 1 },
    };
    __setVscodeForTests(fakeVscode as any);
    const ext = await import('../src/extension');

    const out = new FakeOutput();
    await ext.scanAndPopulateIndex(tmp, out as any);

    const idxPath = path.join(memdir, 'index.json');
    const raw = await fs.promises.readFile(idxPath, 'utf8');
    const arr = JSON.parse(raw);
    // expect at least three entries (result1, result2, loose)
    const r1 = arr.find((e: any) => e.id === 'result1');
    const r2 = arr.find((e: any) => e.id === 'result2');
    assert.ok(r1);
    assert.ok(r2);
    assert.strictEqual(r1.peakMemoryBytes, 1048576);
    assert.strictEqual(r2.peakMemoryBytes, 2097152);
    assert.ok(arr.find((e: any) => e.id === 'loose'));
  });
});
