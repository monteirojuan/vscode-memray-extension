import vscode from './vscodeApi';
import * as path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { runProfile, spawnProcess } from './memray/executor';
import { readFlamegraphData } from './memray/flamegraphModel';
import { readStatsSummaryFromFile } from './memray/stats';
import { createMemrayOutputDir } from './utils/pathResolver';
import { openNativeFlamegraphPanel } from './views/flamegraphWebview';
import { openLiveWebviewPanel } from './views/liveWebview';
import { startLiveSession } from './memray/liveProvider';
import { getConfig } from './config';
import detection from './utils/pythonDetection';
import { detectMemrayPython } from './utils/memrayPython';

interface ResultEntry {
  id: string;
  title?: string;
  script?: string;
  html?: string;
  flamegraphJson?: string;
  bin?: string;
  stats?: string;
  timestamp?: string;
  durationMs?: number;
  peakMemoryBytes?: number;
  runOk?: boolean;
  flamegraphOk?: boolean;
  nativeFlamegraphOk?: boolean;
  renderer?: 'native' | 'html-fallback';
  memrayVersion?: string;
  statsOk?: boolean;
  errors?: string[];
}

type MemrayResultItem = vscode.TreeItem & { entry?: ResultEntry };

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Memray');
  context.subscriptions.push(output);

  const updateProfileButtonContext = () => {
    const hasWorkspace = Boolean(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0);
    const activeEditor = vscode.window.activeTextEditor;
    const activeEditorIsPython = Boolean(activeEditor && activeEditor.document.languageId === 'python');
    void vscode.commands.executeCommand('setContext', 'memray.hasWorkspace', hasWorkspace);
    void vscode.commands.executeCommand('setContext', 'memray.activeEditorIsPython', activeEditorIsPython);
  };

  updateProfileButtonContext();
  if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => updateProfileButtonContext()));
  }
  if (typeof vscode.workspace.onDidChangeWorkspaceFolders === 'function') {
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => updateProfileButtonContext()));
  }

  const profileCurrentFileCmd = vscode.commands.registerCommand('memray.profileCurrentFile', async () => {
    await vscode.commands.executeCommand('memray.profileFile');
  });
  context.subscriptions.push(profileCurrentFileCmd);

  const provider = new MemrayResultsProvider(output);
  vscode.window.registerTreeDataProvider('memrayResults', provider);
  // Register a refresh command
  const refreshCmd = vscode.commands.registerCommand('memray.refreshResults', async () => {
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (ws) {
      try {
        await scanAndPopulateIndex(ws.uri.fsPath, output);
      } catch (err) {
        output.appendLine(`Error refreshing .memray index: ${err}`);
      }
    }
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

  // Command to open a result in either native flamegraph webview or HTML fallback webview
  const openCmd = vscode.commands.registerCommand('memray.openResult', async (relativePath?: string) => {
    if (!relativePath) {
      vscode.window.showWarningMessage('No result file provided');
      return;
    }
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!ws) return vscode.window.showWarningMessage('Open a workspace to view results');
    try {
      const abs = path.isAbsolute(relativePath) ? relativePath : path.join(ws.uri.fsPath, relativePath);
      if (abs.endsWith('.json')) {
        const flamegraphData = await readFlamegraphData(abs);
        await openNativeFlamegraphPanel(
          context,
          path.basename(abs),
          flamegraphData,
          async (sourcePath, line) => openSourceLocation(ws.uri.fsPath, flamegraphData.script, sourcePath, line, output),
        );
        return;
      }
      const html = await fs.readFile(abs, 'utf8');
      const panel = vscode.window.createWebviewPanel('memrayReport', path.basename(abs), { viewColumn: vscode.ViewColumn.One, preserveFocus: false }, { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.dirname(abs))] });
      panel.webview.html = html;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`Error opening result: ${message}`);
      vscode.window.showErrorMessage(`Failed to open result: ${message}`);
    }
  });
  context.subscriptions.push(openCmd);

  const viewFlamegraphCmd = vscode.commands.registerCommand('memray.viewFlamegraph', async (item?: MemrayResultItem) => {
    const target = item?.entry?.flamegraphJson || item?.entry?.html;
    if (!target) {
      vscode.window.showWarningMessage('No flamegraph artifact available for this result.');
      return;
    }
    await vscode.commands.executeCommand('memray.openResult', target);
  });
  context.subscriptions.push(viewFlamegraphCmd);

  const openOutputDirCmd = vscode.commands.registerCommand('memray.openOutputDirectory', async (item?: MemrayResultItem) => {
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a workspace to access memray results.');
      return;
    }
    if (!item?.entry) {
      vscode.window.showWarningMessage('No result selected.');
      return;
    }

    const runDir = await resolveRunDirectory(ws.uri.fsPath, item.entry);
    if (!runDir) {
      vscode.window.showWarningMessage('Could not determine output directory for this result.');
      return;
    }

    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(runDir));
  });
  context.subscriptions.push(openOutputDirCmd);

  const deleteResultCmd = vscode.commands.registerCommand('memray.deleteResult', async (item?: MemrayResultItem) => {
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a workspace to manage memray results.');
      return;
    }
    if (!item?.entry) {
      vscode.window.showWarningMessage('No result selected.');
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `Delete result "${item.entry.title || item.entry.id}"?`,
      { modal: true },
      'Delete'
    );
    if (answer !== 'Delete') {
      return;
    }

    await deleteResultArtifacts(ws.uri.fsPath, item.entry, output);

    await removeIndexEntry(ws.uri.fsPath, item.entry);
    provider.refresh();
    vscode.window.showInformationMessage('Memray result deleted.');
  });
  context.subscriptions.push(deleteResultCmd);

  const clearResultsCmd = vscode.commands.registerCommand('memray.clearResults', async () => {
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a workspace to manage memray results.');
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      'Clear all Memray executions? This will delete all saved profiling artifacts.',
      { modal: true },
      'Clear All'
    );
    if (answer !== 'Clear All') {
      return;
    }

    const removed = await clearAllResults(ws.uri.fsPath, output);
    provider.refresh();
    vscode.window.showInformationMessage(`Cleared ${removed} Memray execution${removed === 1 ? '' : 's'}.`);
  });
  context.subscriptions.push(clearResultsCmd);

  const exportHtmlCmd = vscode.commands.registerCommand('memray.exportHtml', async (item?: MemrayResultItem) => {
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a workspace to export results.');
      return;
    }
    if (!item?.entry?.html) {
      vscode.window.showWarningMessage('No flamegraph HTML available for this result.');
      return;
    }

    const sourceHtml = path.isAbsolute(item.entry.html)
      ? item.entry.html
      : path.join(ws.uri.fsPath, item.entry.html);

    const defaultName = `${item.entry.id || 'memray-result'}.html`;
    const targetUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(ws.uri.fsPath, defaultName)),
      filters: { HTML: ['html'] },
      saveLabel: 'Export HTML'
    });

    if (!targetUri) {
      return;
    }

    await fs.copyFile(sourceHtml, targetUri.fsPath);
    vscode.window.showInformationMessage(`Exported flamegraph to ${targetUri.fsPath}`);
  });
  context.subscriptions.push(exportHtmlCmd);

  // Ensure indexing completes before activation resolves so integration tests
  // and first renderers see a ready .memray/index.json deterministically.
  const wsForInitialScan = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (wsForInitialScan) {
    try {
      await scanAndPopulateIndex(wsForInitialScan.uri.fsPath, output);
      const cleaned = await cleanupOldResults(wsForInitialScan.uri.fsPath, output);
      if (cleaned > 0) provider.refresh();
      else provider.refresh();
    } catch (err) {
      output.appendLine(`Error scanning .memray directory: ${err}`);
    }
  }

  const cleanupOldResultsCmd = vscode.commands.registerCommand('memray.cleanupOldResults', async () => {
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a workspace to manage memray results.');
      return;
    }
    const removed = await cleanupOldResults(ws.uri.fsPath, output);
    provider.refresh();
    if (removed > 0) {
      vscode.window.showInformationMessage(`Removed ${removed} old Memray result${removed === 1 ? '' : 's'}.`);
    } else {
      vscode.window.showInformationMessage('No old Memray results to clean up.');
    }
  });
  context.subscriptions.push(cleanupOldResultsCmd);

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
          flamegraphJson: result.flamegraphJsonPath,
          stats: result.statsPath,
          timestamp: new Date().toISOString(),
          durationMs: result.durationMs,
          peakMemoryBytes: statsSummary?.peakMemoryBytes,
          runOk: result.runOk,
          flamegraphOk: result.flamegraphOk,
          nativeFlamegraphOk: result.nativeFlamegraphOk,
          renderer: result.renderer,
          memrayVersion: result.memrayVersion,
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
        } catch {
          index = [];
        }
        index.unshift({
          id,
          title: path.basename(scriptPath),
          script: path.relative(ws.uri.fsPath, scriptPath),
          html: result.flamegraphOk ? path.relative(ws.uri.fsPath, result.htmlPath) : undefined,
          flamegraphJson: result.nativeFlamegraphOk ? path.relative(ws.uri.fsPath, result.flamegraphJsonPath) : undefined,
          bin: path.relative(ws.uri.fsPath, result.binPath),
          stats: result.statsOk ? path.relative(ws.uri.fsPath, result.statsPath) : undefined,
          timestamp: meta.timestamp,
          durationMs: result.durationMs,
          peakMemoryBytes: statsSummary?.peakMemoryBytes,
          runOk: result.runOk,
          flamegraphOk: result.flamegraphOk,
          nativeFlamegraphOk: result.nativeFlamegraphOk,
          renderer: result.renderer,
          memrayVersion: result.memrayVersion,
          statsOk: result.statsOk,
          errors: result.errors,
        });
        await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');

        // Auto-cleanup stale results after each run
        await cleanupOldResults(ws.uri.fsPath, output);

        const peakLabel = statsSummary?.peakMemoryBytes !== undefined ? ` Peak: ${formatBytes(statsSummary.peakMemoryBytes)}.` : '';
        const statusNote = (!result.flamegraphOk || !result.statsOk) ? ' Saved as partial result.' : '';
        vscode.window.showInformationMessage(`Memray profiling complete.${peakLabel}${statusNote}`);
        provider.refresh();
        // Auto-open native flamegraph when available; fallback to HTML
        if (result.nativeFlamegraphOk) {
          try {
            const rel = path.relative(ws.uri.fsPath, result.flamegraphJsonPath);
            await vscode.commands.executeCommand('memray.openResult', rel);
          } catch (err) {
            output.appendLine(`Failed to auto-open native flamegraph: ${err}`);
          }
        } else if (result.flamegraphOk) {
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`Error running memray: ${message}`);
      vscode.window.showErrorMessage(`Memray: ${message}`);
    }
  });
  context.subscriptions.push(disposable);

  // ---------------------------------------------------------------------------
  // memray.runLive — Live profiling mode
  // ---------------------------------------------------------------------------
  const runLiveCmd = vscode.commands.registerCommand('memray.runLive', async (uri?: vscode.Uri) => {
    try {
      const editor = vscode.window.activeTextEditor;
      const fileUri = uri || editor?.document.uri;
      if (!fileUri) {
        vscode.window.showWarningMessage('No file selected. Open a Python file or pass a file URI.');
        return;
      }

      const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      if (!ws) {
        vscode.window.showWarningMessage('Open a workspace folder before using Live Mode.');
        return;
      }

      const scriptPath = fileUri.fsPath;
      const conf = getConfig();

      // Create a dedicated output directory for this live run so artifacts are persisted
      const { dir: outDir, id } = await createMemrayOutputDir(ws.uri.fsPath);
      output.appendLine(`[live] Output directory: ${outDir} (id: ${id})`);

      // Open the Webview first so the user sees it immediately.
      // NOTE: `session` is assigned only after startLiveSession resolves (async).
      // We use a `stopRequested` flag to capture any Stop click that arrives
      // during that window; if it fires we honour it as soon as session exists.
      let stopRequested = false;
      let session: Awaited<ReturnType<typeof startLiveSession>> | undefined;

      const webviewPanel = openLiveWebviewPanel({
        extensionPath: context.extensionPath,
        title: `Live: ${path.basename(scriptPath)}`,
        onStop: () => {
          if (session) {
            session.stop();
          } else {
            // Session is still starting — record the intent and apply it after.
            stopRequested = true;
          }
        },
        onOpenSource: async (sourcePath, line) => {
          await openSourceLocation(ws.uri.fsPath, scriptPath, sourcePath, line, output);
        },
      });

      const binPath = path.join(outDir, `${id}.bin`);

      try {
        session = await startLiveSession(
          {
            scriptPath,
            intervalSeconds: conf.liveUpdateIntervalSeconds,
            topN: 20,
            pythonPath: conf.pythonPath.trim() || undefined,
            binPath,
          },
          output,
        );
      } catch (err: unknown) {
        webviewPanel.dispose();
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`[live] Failed to start session: ${message}`);
        vscode.window.showErrorMessage(`Memray Live: ${message}`);
        return;
      }

      // If the user clicked Stop while the session was starting, honour it now.
      if (stopRequested) {
        output.appendLine('[live] Stop was requested before session started — stopping now.');
        session.stop();
        webviewPanel.markStopped();
        return;
      }

      // Forward snapshots to the Webview
      session.onSnapshot(snap => webviewPanel.postSnapshot(snap));

      session.onError(err => {
        output.appendLine(`[live] Session error: ${err.message}`);
        vscode.window.showErrorMessage(`Memray Live error: ${err.message}`);
      });

      session.onStop(() => {
        webviewPanel.markStopped();
        output.appendLine('[live] Session stopped.');

        // Fire-and-forget: generate post-session artifacts from the .bin file
        void generateLiveArtifacts({
          binPath,
          outDir,
          id,
          scriptPath,
          workspacePath: ws.uri.fsPath,
          output,
          provider,
        });
      });

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`[live] Unexpected error: ${message}`);
      vscode.window.showErrorMessage(`Memray Live: ${message}`);
    }
  });
  context.subscriptions.push(runLiveCmd);
}

class MemrayResultsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private output: vscode.OutputChannel) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    void element;
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!ws) {
      return [new vscode.TreeItem('No workspace open')];
    }

    const indexPath = path.join(ws.uri.fsPath, '.memray', 'index.json');
    try {
      const raw = await fs.readFile(indexPath, 'utf8');
      const entries: ResultEntry[] = JSON.parse(raw);
      return entries.map(e => this.toTreeItem(e));
    } catch {
      this.output.appendLine(`No .memray index found at ${indexPath}`);
      return [];
    }
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  private toTreeItem(e: ResultEntry): MemrayResultItem {
    const scriptOrTitle = e.title || e.script || e.id || path.basename(e.html || e.bin || 'result');
    const label = e.timestamp ? `${scriptOrTitle} (${formatRelativeTimestamp(e.timestamp)})` : scriptOrTitle;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None) as MemrayResultItem;
    item.entry = e;
    if (e.flamegraphJson) {
      item.command = {
        command: 'memray.openResult',
        title: 'Open Result',
        arguments: [e.flamegraphJson]
      };
    } else if (e.html) {
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
    if (e.html) {
      item.contextValue = 'memrayResultHasHtml';
    } else if (e.flamegraphJson) {
      item.contextValue = 'memrayResultHasNative';
    } else {
      item.contextValue = 'memrayResult';
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
      e.flamegraphJson ? `Native flamegraph: ${e.flamegraphJson}` : 'Native flamegraph: unavailable',
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
            flamegraphJson: meta.flamegraphJson ? ensureRelativePath(workspacePath, meta.flamegraphJson) : undefined,
            bin: meta.bin ? ensureRelativePath(workspacePath, meta.bin) : undefined,
            stats: meta.stats ? ensureRelativePath(workspacePath, meta.stats) : (await fileExists(statsAbs) ? path.relative(workspacePath, statsAbs) : undefined),
            timestamp: meta.timestamp || meta.created || s.mtime.toISOString(),
            durationMs: meta.durationMs,
            peakMemoryBytes: statsSummary?.peakMemoryBytes ?? meta.peakMemoryBytes ?? meta.peakMemory,
            runOk: meta.runOk ?? true,
            flamegraphOk: meta.flamegraphOk,
            nativeFlamegraphOk: meta.nativeFlamegraphOk,
            renderer: meta.renderer,
            memrayVersion: meta.memrayVersion,
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
        let flamegraphJson: string | undefined;
        let bin: string | undefined;
        let stats: string | undefined;
        for (const f of inside) {
          if (f.endsWith('.html')) html = path.join(p, f);
          if (f === 'flamegraph.json') flamegraphJson = path.join(p, f);
          if (f.endsWith('.bin')) bin = path.join(p, f);
          if (f === 'stats.json') stats = path.join(p, f);
        }
        const statsSummary = stats ? await readStatsSummaryFromFile(stats) : undefined;
        entries.push({
          id: path.basename(p),
          title: path.basename(p),
          html: html ? path.relative(workspacePath, html) : undefined,
          flamegraphJson: flamegraphJson ? path.relative(workspacePath, flamegraphJson) : undefined,
          bin: bin ? path.relative(workspacePath, bin) : undefined,
          stats: stats ? path.relative(workspacePath, stats) : undefined,
          timestamp: s.mtime.toISOString(),
          peakMemoryBytes: statsSummary?.peakMemoryBytes,
          runOk: Boolean(bin),
          flamegraphOk: Boolean(html),
          nativeFlamegraphOk: Boolean(flamegraphJson),
          renderer: flamegraphJson ? 'native' : 'html-fallback',
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

async function resolveRunDirectory(workspacePath: string, entry: ResultEntry): Promise<string | undefined> {
  const candidates = [entry.flamegraphJson, entry.html, entry.stats, entry.bin]
    .filter((value): value is string => Boolean(value))
    .map(value => (path.isAbsolute(value) ? value : path.join(workspacePath, value)));

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return path.dirname(candidate);
    }
  }

  const guessed = entry.id ? path.join(workspacePath, '.memray', entry.id) : undefined;
  if (guessed && await fileExists(guessed)) {
    return guessed;
  }

  return undefined;
}

async function openSourceLocation(workspacePath: string, scriptPath: string, sourcePath: string, line: number, output?: vscode.OutputChannel): Promise<void> {
  const lineIndex = Math.max(0, (line || 1) - 1);
  const scriptDir = path.dirname(scriptPath);

  // Build a de-duplicated list of candidate paths to try
  const raw: string[] = [
    sourcePath,
    path.isAbsolute(sourcePath) ? '' : path.join(scriptDir, sourcePath),
    path.isAbsolute(sourcePath) ? '' : path.join(workspacePath, sourcePath),
  ];
  const candidates = [...new Set(raw.filter(Boolean))];

  output?.appendLine(`[source navigation] Resolving: ${sourcePath}`);
  for (const c of candidates) {
    output?.appendLine(`[source navigation]   trying: ${c}`);
  }

  let resolvedPath: string | undefined;
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      resolvedPath = candidate;
      output?.appendLine(`[source navigation]   found: ${resolvedPath}`);
      break;
    }
  }

  if (!resolvedPath) {
    output?.appendLine(`[source navigation]   NOT FOUND — skipping`);
    await vscode.window.showWarningMessage(`Source not found: ${sourcePath}`);
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedPath));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const position = new vscode.Position(lineIndex, 0);
  const range = new vscode.Range(position, position);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

export async function cleanupOldResults(workspacePath: string, output: vscode.OutputChannel): Promise<number> {
  const { keepHistoryDays } = getConfig();
  if (keepHistoryDays <= 0) {
    return 0;
  }

  const indexPath = path.join(workspacePath, '.memray', 'index.json');
  let entries: ResultEntry[] = [];
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    entries = JSON.parse(raw) as ResultEntry[];
  } catch {
    return 0;
  }

  const cutoff = Date.now() - keepHistoryDays * 86_400_000;
  const toDelete = entries.filter(e => {
    if (!e.timestamp) return false;
    const ts = new Date(e.timestamp).getTime();
    return Number.isFinite(ts) && ts < cutoff;
  });

  if (toDelete.length === 0) {
    return 0;
  }

  for (const entry of toDelete) {
    await deleteResultArtifacts(workspacePath, entry, output);
  }

  const toDeleteIds = new Set(toDelete.map(e => e.id));
  const remaining = entries.filter(e => !toDeleteIds.has(e.id));
  await fs.writeFile(indexPath, JSON.stringify(remaining, null, 2), 'utf8');
  output.appendLine(`Auto-cleanup: removed ${toDelete.length} result${toDelete.length === 1 ? '' : 's'} older than ${keepHistoryDays} day${keepHistoryDays === 1 ? '' : 's'}.`);
  return toDelete.length;
}

async function clearAllResults(workspacePath: string, output: vscode.OutputChannel): Promise<number> {
  const indexPath = path.join(workspacePath, '.memray', 'index.json');
  let entries: ResultEntry[] = [];
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    entries = JSON.parse(raw) as ResultEntry[];
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    await deleteResultArtifacts(workspacePath, entry, output);
  }

  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify([], null, 2), 'utf8');
  return entries.length;
}

async function deleteResultArtifacts(workspacePath: string, entry: ResultEntry, output: vscode.OutputChannel): Promise<void> {
  const memrayRoot = path.join(workspacePath, '.memray');
  const candidates = [entry.flamegraphJson, entry.html, entry.stats, entry.bin].filter((value): value is string => Boolean(value));
  const existingFiles: string[] = [];

  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.join(workspacePath, candidate);
    if (await fileExists(absolute)) {
      existingFiles.push(absolute);
    }
  }

  const parentDirs = [...new Set(existingFiles.map(file => path.dirname(file)))];
  const singleParent = parentDirs.length === 1 ? parentDirs[0] : undefined;
  const entryDir = entry.id ? path.join(memrayRoot, entry.id) : undefined;

  if (singleParent && entryDir && singleParent === entryDir && path.dirname(singleParent) === memrayRoot) {
    try {
      await fs.rm(singleParent, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      output.appendLine(`Failed to delete run directory ${singleParent}: ${err}`);
    }
  }

  for (const file of existingFiles) {
    try {
      await fs.rm(file, { force: true });
    } catch (err: unknown) {
      output.appendLine(`Failed to delete file ${file}: ${err}`);
    }
  }

  if (entryDir && path.dirname(entryDir) === memrayRoot && await fileExists(entryDir)) {
    try {
      await fs.rm(entryDir, { recursive: true, force: true });
    } catch (err: unknown) {
      output.appendLine(`Failed to delete run directory ${entryDir}: ${err}`);
    }
  }
}

async function removeIndexEntry(workspacePath: string, target: ResultEntry): Promise<void> {
  const indexPath = path.join(workspacePath, '.memray', 'index.json');
  let entries: ResultEntry[] = [];
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    entries = JSON.parse(raw) as ResultEntry[];
  } catch {
    return;
  }

  const filtered = entries.filter(entry => !sameEntry(entry, target));
  await fs.writeFile(indexPath, JSON.stringify(filtered, null, 2), 'utf8');
}

function sameEntry(left: ResultEntry, right: ResultEntry): boolean {
  return (
    left.id === right.id &&
    left.timestamp === right.timestamp &&
    left.flamegraphJson === right.flamegraphJson &&
    left.html === right.html &&
    left.bin === right.bin
  );
}

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

// ---------------------------------------------------------------------------
// generateLiveArtifacts — post-session artifact generation for Live Mode
// ---------------------------------------------------------------------------

const EXTENSION_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

interface GenerateLiveArtifactsOpts {
  binPath: string;
  outDir: string;
  id: string;
  scriptPath: string;
  workspacePath: string;
  output: vscode.OutputChannel;
  provider: MemrayResultsProvider;
}

async function generateLiveArtifacts(opts: GenerateLiveArtifactsOpts): Promise<void> {
  const { binPath, outDir, id, scriptPath, workspacePath, output, provider } = opts;

  // Verify the .bin file was actually written
  if (!(await fileExists(binPath))) {
    output.appendLine(`[live] .bin not found at ${binPath} — skipping artifact generation.`);
    return;
  }
  output.appendLine(`[live] Generating artifacts from ${binPath}...`);

  const htmlPath = path.join(outDir, `${id}.html`);
  const statsPath = path.join(outDir, 'stats.json');
  const flamegraphJsonPath = path.join(outDir, 'flamegraph.json');

  // Detect memray command
  const detected = await detection.detectMemray();
  if (!detected?.command?.length) {
    output.appendLine('[live] memray not found — cannot generate artifacts.');
    return;
  }
  const memrayCmd = detected.command[0];
  const memrayPrefix = detected.command.slice(1);

  const errors: string[] = [];
  let flamegraphOk = false;
  let nativeFlamegraphOk = false;
  let statsOk = false;
  let memrayVersion: string | undefined;

  // Generate flamegraph HTML
  output.appendLine(`[live] Generating flamegraph HTML...`);
  const flameArgs = [...memrayPrefix, 'flamegraph', binPath, '-o', htmlPath];
  try {
    const res = await spawnProcess(memrayCmd, flameArgs, output, 30_000);
    flamegraphOk = res.code === 0;
    if (!flamegraphOk) {
      errors.push(`memray flamegraph exited with code ${res.code}`);
      output.appendLine(`[live] Warning: ${errors[errors.length - 1]}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`memray flamegraph failed: ${msg}`);
    output.appendLine(`[live] Warning: ${errors[errors.length - 1]}`);
  }

  // Generate stats JSON
  output.appendLine(`[live] Generating stats JSON...`);
  const statsArgs = [...memrayPrefix, 'stats', '--json', '-o', statsPath, '-f', binPath];
  try {
    const res = await spawnProcess(memrayCmd, statsArgs, output, 30_000);
    statsOk = res.code === 0;
    if (!statsOk) {
      errors.push(`memray stats exited with code ${res.code}`);
      output.appendLine(`[live] Warning: ${errors[errors.length - 1]}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`memray stats failed: ${msg}`);
    output.appendLine(`[live] Warning: ${errors[errors.length - 1]}`);
  }

  // Generate native flamegraph JSON
  if (statsOk) {
    output.appendLine(`[live] Generating native flamegraph JSON...`);
    try {
      const conf = getConfig();
      const memrayPython = await detectMemrayPython(
        detected.command,
        conf.pythonPath.trim() || undefined,
        (await import('child_process')).spawn,
      );
      if (!memrayPython.pythonPath) {
        errors.push(`memray-capable Python not found. Tried: ${memrayPython.tried.join(', ') || 'none'}`);
        output.appendLine(`[live] Warning: ${errors[errors.length - 1]}`);
      } else {
        memrayVersion = memrayPython.memrayVersion;
        const exporterPath = path.resolve(EXTENSION_SRC_DIR, '../scripts/export_flamegraph.py');
        const exporterArgs = [
          exporterPath,
          '--bin', binPath,
          '--output', flamegraphJsonPath,
          '--run-id', id,
          '--script', scriptPath,
          '--stats', statsPath,
        ];
        const res = await spawnProcess(memrayPython.pythonPath, exporterArgs, output, 60_000);
        nativeFlamegraphOk = res.code === 0;
        if (!nativeFlamegraphOk) {
          errors.push(`flamegraph exporter exited with code ${res.code}`);
          output.appendLine(`[live] Warning: ${errors[errors.length - 1]}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`flamegraph exporter failed: ${msg}`);
      output.appendLine(`[live] Warning: ${errors[errors.length - 1]}`);
    }
  }

  const statsSummary = statsOk ? await readStatsSummaryFromFile(statsPath) : undefined;
  const timestamp = new Date().toISOString();

  // Save meta.json
  const meta: ResultEntry = {
    id,
    title: `Live: ${path.basename(scriptPath)}`,
    script: scriptPath,
    bin: path.relative(workspacePath, binPath),
    html: flamegraphOk ? path.relative(workspacePath, htmlPath) : undefined,
    flamegraphJson: nativeFlamegraphOk ? path.relative(workspacePath, flamegraphJsonPath) : undefined,
    stats: statsOk ? path.relative(workspacePath, statsPath) : undefined,
    timestamp,
    peakMemoryBytes: statsSummary?.peakMemoryBytes,
    runOk: true,
    flamegraphOk,
    nativeFlamegraphOk,
    renderer: nativeFlamegraphOk ? 'native' : 'html-fallback',
    memrayVersion,
    statsOk,
    errors,
  };
  const metaPath = path.join(outDir, 'meta.json');
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  // Update global index
  const indexPath = path.join(workspacePath, '.memray', 'index.json');
  let index: ResultEntry[] = [];
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    index = JSON.parse(raw) as ResultEntry[];
  } catch {
    index = [];
  }
  index.unshift(meta);
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');

  provider.refresh();

  const peakLabel = statsSummary?.peakMemoryBytes !== undefined
    ? ` Peak: ${formatBytes(statsSummary.peakMemoryBytes)}.`
    : '';
  const statusNote = (!flamegraphOk || !statsOk) ? ' Saved as partial result.' : '';
  vscode.window.showInformationMessage(`Memray Live session saved.${peakLabel}${statusNote}`);
  output.appendLine(`[live] Artifacts saved to ${outDir}`);

  // Auto-open flamegraph
  if (nativeFlamegraphOk) {
    try {
      await vscode.commands.executeCommand('memray.openResult', path.relative(workspacePath, flamegraphJsonPath));
    } catch (err) {
      output.appendLine(`[live] Failed to auto-open native flamegraph: ${err}`);
    }
  } else if (flamegraphOk) {
    try {
      await vscode.commands.executeCommand('memray.openResult', path.relative(workspacePath, htmlPath));
    } catch (err) {
      output.appendLine(`[live] Failed to auto-open flamegraph HTML: ${err}`);
    }
  }
}
