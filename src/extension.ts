import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { runProfile } from './memray/executor';
import { readStatsSummaryFromFile } from './memray/stats';
import { createMemrayOutputDir } from './utils/pathResolver';

interface ResultEntry {
  id: string;
  title?: string;
  script?: string;
  html?: string;
  bin?: string;
  stats?: string;
  timestamp?: string;
  durationMs?: number;
  peakMemoryBytes?: number;
  runOk?: boolean;
  flamegraphOk?: boolean;
  statsOk?: boolean;
  errors?: string[];
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

        const statsSummary = await readStatsSummaryFromFile(result.statsPath);

        progress.report({ message: 'Saving metadata' });
        const meta = {
          id,
          title: path.basename(scriptPath),
          script: scriptPath,
          bin: result.binPath,
          html: result.htmlPath,
          stats: result.statsPath,
          timestamp: new Date().toISOString(),
          durationMs: result.durationMs,
          peakMemoryBytes: statsSummary?.peakMemoryBytes,
          runOk: result.runOk,
          flamegraphOk: result.flamegraphOk,
          statsOk: result.statsOk,
          errors: result.errors,
        };
        const metaPath = path.join(dir, 'meta.json');
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

        // update global index
        const indexPath = path.join(ws.uri.fsPath, '.memray', 'index.json');
        let index: ResultEntry[] = [];
        try {
          const raw = await fs.readFile(indexPath, 'utf8');
          index = JSON.parse(raw) as ResultEntry[];
        } catch {}
        index.unshift({
          id,
          title: path.basename(scriptPath),
          script: path.relative(ws.uri.fsPath, scriptPath),
          html: result.flamegraphOk ? path.relative(ws.uri.fsPath, result.htmlPath) : undefined,
          bin: path.relative(ws.uri.fsPath, result.binPath),
          stats: result.statsOk ? path.relative(ws.uri.fsPath, result.statsPath) : undefined,
          timestamp: meta.timestamp,
          durationMs: result.durationMs,
          peakMemoryBytes: statsSummary?.peakMemoryBytes,
          runOk: result.runOk,
          flamegraphOk: result.flamegraphOk,
          statsOk: result.statsOk,
          errors: result.errors,
        });
        await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');

        const peakLabel = statsSummary?.peakMemoryBytes !== undefined ? ` Peak: ${formatBytes(statsSummary.peakMemoryBytes)}.` : '';
        const statusNote = (!result.flamegraphOk || !result.statsOk) ? ' Saved as partial result.' : '';
        vscode.window.showInformationMessage(`Memray profiling complete.${peakLabel}${statusNote}`);
        provider.refresh();
        // Auto-open the generated HTML result in the webview (if available)
        if (result.flamegraphOk) {
          try {
            const rel = path.relative(ws.uri.fsPath, result.htmlPath);
            await vscode.commands.executeCommand('memray.openResult', rel);
          } catch (err) {
            output.appendLine(`Failed to auto-open result: ${err}`);
          }
        } else {
          output.appendLine('Skipping auto-open because flamegraph generation failed.');
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
    const scriptOrTitle = e.title || e.script || e.id || path.basename(e.html || e.bin || 'result');
    const label = e.timestamp ? `${scriptOrTitle} (${formatRelativeTimestamp(e.timestamp)})` : scriptOrTitle;
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
    const details: string[] = [];
    if (e.peakMemoryBytes !== undefined) {
      details.push(`Peak: ${formatBytes(e.peakMemoryBytes)}`);
    }
    if (e.statsOk === false || e.flamegraphOk === false) {
      details.push('partial');
    }
    item.description = details.join(' • ');
    item.tooltip = [
      `Script: ${scriptOrTitle}`,
      e.timestamp ? `Timestamp: ${e.timestamp}` : undefined,
      e.peakMemoryBytes !== undefined ? `Peak memory: ${formatBytes(e.peakMemoryBytes)}` : undefined,
      e.stats ? `Stats: ${e.stats}` : 'Stats: unavailable',
      e.html ? `Flamegraph: ${e.html}` : 'Flamegraph: unavailable',
      (e.errors && e.errors.length > 0) ? `Errors: ${e.errors.join('; ')}` : undefined,
    ].filter((line): line is string => Boolean(line)).join('\n');
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

  const entries: ResultEntry[] = [];
  const files = await fs.readdir(memrayDir);

  // collect loose files (e.g., manual-test.html) by basename
  const looseMap: Record<string, { html?: string; bin?: string; mtime?: string }> = {};

  for (const name of files) {
    const p = path.join(memrayDir, name);
    const s = await fs.stat(p);
    if (s.isDirectory()) {
      const legacyMetaPath = path.join(p, 'meta.json');
      const metadataPath = path.join(p, 'metadata.json');
      let loadedFromMeta = false;

      for (const candidate of [metadataPath, legacyMetaPath]) {
        try {
          const raw = await fs.readFile(candidate, 'utf8');
          const meta = JSON.parse(raw) as ResultEntry & { created?: string; peakMemory?: number };
          const statsAbs = meta.stats
            ? path.join(workspacePath, ensureRelativePath(workspacePath, meta.stats))
            : path.join(p, 'stats.json');
          const statsSummary = await readStatsSummaryFromFile(statsAbs);
          entries.push({
            id: meta.id || path.basename(p),
            title: meta.title || (meta.script ? path.basename(meta.script) : path.basename(p)),
            script: meta.script,
            html: meta.html ? ensureRelativePath(workspacePath, meta.html) : undefined,
            bin: meta.bin ? ensureRelativePath(workspacePath, meta.bin) : undefined,
            stats: meta.stats ? ensureRelativePath(workspacePath, meta.stats) : (await fileExists(statsAbs) ? path.relative(workspacePath, statsAbs) : undefined),
            timestamp: meta.timestamp || meta.created || s.mtime.toISOString(),
            durationMs: meta.durationMs,
            peakMemoryBytes: statsSummary?.peakMemoryBytes ?? meta.peakMemoryBytes ?? meta.peakMemory,
            runOk: meta.runOk ?? true,
            flamegraphOk: meta.flamegraphOk,
            statsOk: meta.statsOk ?? (statsSummary?.peakMemoryBytes !== undefined),
            errors: meta.errors,
          });
          loadedFromMeta = true;
          break;
        } catch {
          continue;
        }
      }

      if (!loadedFromMeta) {
        // fallback: scan for html/bin/stats inside directory
        const inside = await fs.readdir(p);
        let html: string | undefined;
        let bin: string | undefined;
        let stats: string | undefined;
        for (const f of inside) {
          if (f.endsWith('.html')) html = path.join(p, f);
          if (f.endsWith('.bin')) bin = path.join(p, f);
          if (f === 'stats.json') stats = path.join(p, f);
        }
        const statsSummary = stats ? await readStatsSummaryFromFile(stats) : undefined;
        entries.push({
          id: path.basename(p),
          title: path.basename(p),
          html: html ? path.relative(workspacePath, html) : undefined,
          bin: bin ? path.relative(workspacePath, bin) : undefined,
          stats: stats ? path.relative(workspacePath, stats) : undefined,
          timestamp: s.mtime.toISOString(),
          peakMemoryBytes: statsSummary?.peakMemoryBytes,
          runOk: Boolean(bin),
          flamegraphOk: Boolean(html),
          statsOk: Boolean(stats),
          errors: [],
        });
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
    entries.push({ id: k, title: k, html: v.html ? path.relative(workspacePath, v.html) : undefined, bin: v.bin ? path.relative(workspacePath, v.bin) : undefined, timestamp: v.mtime, runOk: Boolean(v.bin), flamegraphOk: Boolean(v.html), statsOk: false, errors: [] });
  }

  // sort by timestamp desc
  entries.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  const indexPath = path.join(memrayDir, 'index.json');
  await fs.writeFile(indexPath, JSON.stringify(entries, null, 2), 'utf8');
  output.appendLine(`Populated .memray/index.json with ${entries.length} entries`);
}

export function deactivate() {}

function ensureRelativePath(workspacePath: string, value: string): string {
  return path.isAbsolute(value) ? path.relative(workspacePath, value) : value;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function formatRelativeTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
