import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { __setVscodeForTests, __resetVscodeForTests } from '../src/vscodeApi';

class FakeTreeItem {
  public label: string;
  public command: any;
  public description?: string;
  public tooltip?: string;
  public contextValue?: string;

  constructor(label: string, _state?: number) {
    this.label = label;
  }
}

class FakeEventEmitter<T> {
  public event = (_listener: (value: T) => void) => ({ dispose: () => {} });
  fire(_value?: T) {}
}

function createFakeVscode(workspaceRootRef: { current?: string }) {
  const commands = new Map<string, (...args: any[]) => Promise<void> | void>();
  const executed: Array<{ command: string; args: any[] }> = [];

  let warningResponse: string | undefined;
  let saveDialogResponse: { fsPath: string } | undefined;

  const fakeVscode: any = {
    window: {
      createOutputChannel: () => ({ appendLine: (_s: string) => {} }),
      createWebviewPanel: () => ({ webview: { html: '' } }),
      registerTreeDataProvider: (_id: string, _provider: any) => ({ dispose: () => {} }),
      showWarningMessage: async (_msg: string, ..._args: any[]) => warningResponse,
      showInformationMessage: async (_msg: string) => undefined,
      showErrorMessage: async (_msg: string) => undefined,
      showSaveDialog: async (_options: any) => saveDialogResponse,
      withProgress: async (_opts: any, task: any) => task({ report: (_x: any) => {} }),
      activeTextEditor: undefined,
    },
    workspace: {
      workspaceFolders: undefined as any,
      createFileSystemWatcher: () => ({
        onDidChange: (_cb: () => void) => {},
        onDidCreate: (_cb: () => void) => {},
        onDidDelete: (_cb: () => void) => {},
        dispose: () => {},
      }),
      getConfiguration: () => ({
        get: (_k: string, def: any) => def,
      }),
    },
    commands: {
      registerCommand: (id: string, cb: (...args: any[]) => Promise<void> | void) => {
        commands.set(id, cb);
        return { dispose: () => {} };
      },
      executeCommand: async (id: string, ...args: any[]) => {
        executed.push({ command: id, args });
      },
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

  const setWorkspaceRoot = (root?: string) => {
    workspaceRootRef.current = root;
    fakeVscode.workspace.workspaceFolders = root ? [{ uri: { fsPath: root } }] : undefined;
  };

  return {
    fakeVscode,
    commands,
    executed,
    setWorkspaceRoot,
    setWarningResponse: (value: string | undefined) => { warningResponse = value; },
    setSaveDialogResponse: (value: { fsPath: string } | undefined) => { saveDialogResponse = value; },
  };
}

describe('context menu commands', function () {
  this.timeout(5000);

  afterEach(() => {
    __resetVscodeForTests();
  });

  it('deletes result directory and removes index entry', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ctx-del-'));
    const memrayDir = path.join(tmp, '.memray');
    const runDir = path.join(memrayDir, 'run1');
    await fs.promises.mkdir(runDir, { recursive: true });
    await fs.promises.writeFile(path.join(runDir, 'result.html'), '<html>ok</html>', 'utf8');

    const entryToDelete = {
      id: 'run1',
      title: 'script.py',
      html: path.join('.memray', 'run1', 'result.html'),
      bin: path.join('.memray', 'run1', 'run1.bin'),
      timestamp: '2026-03-08T00:00:00.000Z',
    };
    const keepEntry = {
      id: 'run2',
      title: 'other.py',
      html: path.join('.memray', 'run2', 'result.html'),
      bin: path.join('.memray', 'run2', 'run2.bin'),
      timestamp: '2026-03-08T01:00:00.000Z',
    };

    await fs.promises.mkdir(path.join(memrayDir, 'run2'), { recursive: true });
    await fs.promises.writeFile(path.join(memrayDir, 'index.json'), JSON.stringify([entryToDelete, keepEntry], null, 2), 'utf8');

    const workspaceRootRef: { current?: string } = {};
    const mock = createFakeVscode(workspaceRootRef);
    __setVscodeForTests(mock.fakeVscode as any);
    const ext = await import('../src/extension');

    const context = { subscriptions: [] as any[] };
    ext.activate(context);
    mock.setWorkspaceRoot(tmp);
    mock.setWarningResponse('Delete');

    const cmd = mock.commands.get('memray.deleteResult');
    assert.ok(cmd, 'memray.deleteResult should be registered');

    await cmd!({ entry: entryToDelete });

    const exists = await fs.promises.stat(runDir).then(() => true).catch(() => false);
    assert.strictEqual(exists, false, 'expected run directory to be deleted');

    const indexRaw = await fs.promises.readFile(path.join(memrayDir, 'index.json'), 'utf8');
    const index = JSON.parse(indexRaw);
    assert.strictEqual(index.length, 1);
    assert.strictEqual(index[0].id, 'run2');
  });

  it('exports html result to selected file', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ctx-exp-'));
    const srcDir = path.join(tmp, '.memray', 'run1');
    await fs.promises.mkdir(srcDir, { recursive: true });
    const srcHtml = path.join(srcDir, 'result.html');
    await fs.promises.writeFile(srcHtml, '<html>export</html>', 'utf8');

    const outPath = path.join(tmp, 'exported.html');
    const workspaceRootRef: { current?: string } = {};
    const mock = createFakeVscode(workspaceRootRef);
    __setVscodeForTests(mock.fakeVscode as any);
    const ext = await import('../src/extension');

    const context = { subscriptions: [] as any[] };
    ext.activate(context);
    mock.setWorkspaceRoot(tmp);
    mock.setSaveDialogResponse({ fsPath: outPath });

    const cmd = mock.commands.get('memray.exportHtml');
    assert.ok(cmd, 'memray.exportHtml should be registered');

    await cmd!({ entry: { id: 'run1', html: path.join('.memray', 'run1', 'result.html') } });

    const exported = await fs.promises.readFile(outPath, 'utf8');
    assert.strictEqual(exported, '<html>export</html>');
  });
});
