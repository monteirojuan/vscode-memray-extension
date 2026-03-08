import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { runProfile } from './memray/executor';
import { createMemrayOutputDir, resolveArtifactPaths } from './utils/pathResolver';

interface ResultEntry {
  id: string;
  title?: string;
  html?: string;
  bin?: string;
  timestamp?: string;
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Memray');
  context.subscriptions.push(output);

  const provider = new MemrayResultsProvider(output);
  vscode.window.registerTreeDataProvider('memrayResults', provider);
  // Register a refresh command
  const refreshCmd = vscode.commands.registerCommand('memray.refreshResults', async () => {
    provider.refresh();
    vscode.window.showInformationMessage('Memray results refreshed');
  });
  context.subscriptions.push(refreshCmd);

  // Watch .memray/index.json for changes and refresh tree when it updates
  const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (ws) {
    const indexGlob = new vscode.RelativePattern(ws, '.memray/index.json');
    const watcher = vscode.workspace.createFileSystemWatcher(indexGlob);
    watcher.onDidChange(() => provider.refresh());
    watcher.onDidCreate(() => provider.refresh());
    watcher.onDidDelete(() => provider.refresh());
    context.subscriptions.push(watcher);
  }

  // Command to open a result HTML inside a Webview
  const openCmd = vscode.commands.registerCommand('memray.openResult', async (relativePath?: string) => {
    if (!relativePath) {
      vscode.window.showWarningMessage('No result file provided');
      return;
    }
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!ws) return vscode.window.showWarningMessage('Open a workspace to view results');
    try {
      const abs = path.isAbsolute(relativePath) ? relativePath : path.join(ws.uri.fsPath, relativePath);
      const html = await fs.readFile(abs, 'utf8');
      const panel = vscode.window.createWebviewPanel('memrayReport', path.basename(abs), { viewColumn: vscode.ViewColumn.One, preserveFocus: false }, { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.dirname(abs))] });
      panel.webview.html = html;
    } catch (err: any) {
      output.appendLine(`Error opening result: ${err?.message || err}`);
      vscode.window.showErrorMessage(`Failed to open result: ${err?.message || err}`);
    }
  });
  context.subscriptions.push(openCmd);

  // On activation, scan existing .memray artifacts and populate index.json
  (async () => {
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!ws) return;
    try {
      await scanAndPopulateIndex(ws.uri.fsPath, output);
      provider.refresh();
    } catch (err) {
      output.appendLine(`Error scanning .memray directory: ${err}`);
    }
  })();

  const disposable = vscode.commands.registerCommand('memray.profileFile', async (uri?: vscode.Uri) => {
    try {
      const editor = vscode.window.activeTextEditor;
      const fileUri = uri || editor?.document.uri;
      if (!fileUri) {
        vscode.window.showWarningMessage('No file selected to profile. Open a Python file or pass a file URI.');
        return;
      }

      const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      if (!ws) {
        vscode.window.showWarningMessage('Open a workspace folder before profiling.');
        return;
      }

      const scriptPath = fileUri.fsPath;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Running Memray...',
        cancellable: false
      }, async (progress) => {
        progress.report({ message: 'Preparing output directory' });
        const { dir, id } = await createMemrayOutputDir(ws.uri.fsPath);

        progress.report({ message: 'Profiling script' });
        const result = await runProfile({ scriptPath, outDir: dir, id }, output);

        progress.report({ message: 'Saving metadata' });
        const meta = { id, script: scriptPath, bin: result.binPath, html: result.htmlPath, timestamp: new Date().toISOString(), durationMs: result.durationMs };
        const metaPath = path.join(dir, 'meta.json');
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

        // update global index
        const indexPath = path.join(ws.uri.fsPath, '.memray', 'index.json');
        let index: any[] = [];
        try {
          const raw = await fs.readFile(indexPath, 'utf8');
          index = JSON.parse(raw);
        } catch {}
        index.unshift({ id, title: path.basename(scriptPath), html: path.relative(ws.uri.fsPath, result.htmlPath), bin: path.relative(ws.uri.fsPath, result.binPath), timestamp: meta.timestamp });
        await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');

        vscode.window.showInformationMessage(`Memray profiling complete: ${id}`);
        provider.refresh();
        // Auto-open the generated HTML result in the webview (if available)
        try {
          const rel = path.relative(ws.uri.fsPath, result.htmlPath);
          await vscode.commands.executeCommand('memray.openResult', rel);
        } catch (err) {
          output.appendLine(`Failed to auto-open result: ${err}`);
        }
      });
    } catch (err: any) {
      output.appendLine(`Error running memray: ${err?.message || err}`);
      vscode.window.showErrorMessage(`Memray: ${err?.message || err}`);
    }
  });
  context.subscriptions.push(disposable);
}

class MemrayResultsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private output: vscode.OutputChannel) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!ws) {
      return [new vscode.TreeItem('No workspace open')];
    }

    const indexPath = path.join(ws.uri.fsPath, '.memray', 'index.json');
    try {
      const raw = await fs.readFile(indexPath, 'utf8');
      const entries: ResultEntry[] = JSON.parse(raw);
      return entries.map(e => this.toTreeItem(e));
    } catch (err) {
      this.output.appendLine(`No .memray index found at ${indexPath}`);
      return [];
    }
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  private toTreeItem(e: ResultEntry): vscode.TreeItem {
    const label = e.title || e.id || path.basename(e.html || e.bin || 'result');
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    if (e.html) {
      item.command = {
        command: 'memray.openResult',
        title: 'Open Result',
        arguments: [e.html]
      };
    } else if (e.bin) {
      item.command = {
        command: 'memray.openResult',
        title: 'Open Result',
        arguments: [e.bin]
      };
    }
    item.description = e.timestamp;
    return item;
  }
}

export async function scanAndPopulateIndex(workspacePath: string, output: vscode.OutputChannel): Promise<void> {
  const memrayDir = path.join(workspacePath, '.memray');
  try {
    const dirStat = await fs.stat(memrayDir);
    if (!dirStat.isDirectory()) return;
  } catch {
    // no .memray dir
    return;
  }

  const entries: any[] = [];
  const files = await fs.readdir(memrayDir);

  // collect loose files (e.g., manual-test.html) by basename
  const looseMap: Record<string, { html?: string; bin?: string; mtime?: string }> = {};

  for (const name of files) {
    const p = path.join(memrayDir, name);
    const s = await fs.stat(p);
    if (s.isDirectory()) {
      // check for meta.json
      const metaPath = path.join(p, 'meta.json');
      try {
        const raw = await fs.readFile(metaPath, 'utf8');
        const meta = JSON.parse(raw);
        entries.push({ id: meta.id || path.basename(p), title: meta.title || path.basename(p), html: path.relative(workspacePath, meta.html || ''), bin: path.relative(workspacePath, meta.bin || ''), timestamp: meta.timestamp || meta.created || new Date().toISOString() });
        continue;
      } catch {
        // fallback: scan for html/bin inside directory
        const inside = await fs.readdir(p);
        let html: string | undefined;
        let bin: string | undefined;
        for (const f of inside) {
          if (f.endsWith('.html')) html = path.join(p, f);
          if (f.endsWith('.bin')) bin = path.join(p, f);
        }
        entries.push({ id: path.basename(p), title: path.basename(p), html: html ? path.relative(workspacePath, html) : undefined, bin: bin ? path.relative(workspacePath, bin) : undefined, timestamp: s.mtime.toISOString() });
      }
    } else if (s.isFile()) {
      // loose files in .memray root
      const base = name.replace(/\.html$|\.bin$/i, '');
      if (name.endsWith('.html') || name.endsWith('.bin')) {
        looseMap[base] = looseMap[base] || {};
        if (name.endsWith('.html')) looseMap[base].html = path.join('.memray', name);
        if (name.endsWith('.bin')) looseMap[base].bin = path.join('.memray', name);
        looseMap[base].mtime = s.mtime.toISOString();
      }
    }
  }

  for (const [k, v] of Object.entries(looseMap)) {
    entries.push({ id: k, title: k, html: v.html ? path.relative(workspacePath, v.html) : undefined, bin: v.bin ? path.relative(workspacePath, v.bin) : undefined, timestamp: v.mtime });
  }

  // sort by timestamp desc
  entries.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  const indexPath = path.join(memrayDir, 'index.json');
  await fs.writeFile(indexPath, JSON.stringify(entries, null, 2), 'utf8');
  output.appendLine(`Populated .memray/index.json with ${entries.length} entries`);
}

export function deactivate() {}
