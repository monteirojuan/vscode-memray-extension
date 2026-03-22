/**
 * liveWebview.ts — VS Code Webview panel for the Live Profiling Mode.
 *
 * Receives LiveSnapshot objects via postMessage() from the extension host
 * and renders:
 *   - A header showing current RSS, heap, and session peak (high watermark).
 *   - A time-series chart (Chart.js) of memory usage over time.
 *   - A live table of top allocators, sortable by memory usage.
 *   - A "Stop" button that posts a message back to the extension host.
 */

import * as path from 'path';
import vscode from '../vscodeApi';
import type { LiveSnapshot } from '../memray/liveProvider';
import { asPanelResource } from './webviewUtils';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LiveWebviewOptions {
  extensionPath: string;
  title?: string;
  onStop: () => void;
  onOpenSource: (file: string, line: number) => Promise<void>;
}

export interface LiveWebviewPanel {
  /** Push a new snapshot to the Webview. */
  postSnapshot(snapshot: LiveSnapshot): void;
  /** Mark the session as ended (disables Stop button, shows final stats). */
  markStopped(): void;
  /** Dispose the panel. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function openLiveWebviewPanel(opts: LiveWebviewOptions): LiveWebviewPanel {
  const title = opts.title ?? 'Memray Live';

  const panel = vscode.window.createWebviewPanel(
    'memrayLive',
    title,
    { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(opts.extensionPath, 'media')),
        vscode.Uri.file(path.join(opts.extensionPath, 'node_modules')),
      ],
    },
  );

  const liveJsUri = asPanelResource(panel, path.join(opts.extensionPath, 'media', 'live.js'));
  const liveCssUri = asPanelResource(panel, path.join(opts.extensionPath, 'media', 'live.css'));
  const nonce = String(Date.now());

  panel.webview.html = buildHtml({ title, liveJsUri, liveCssUri, nonce, cspSource: panel.webview.cspSource });

  // Handle messages from the Webview
  const webviewWithHandler = panel.webview as vscode.Webview & {
    onDidReceiveMessage?: (handler: (message: unknown) => void) => void;
    postMessage?: (message: unknown) => Thenable<boolean>;
  };

  if (typeof webviewWithHandler.onDidReceiveMessage === 'function') {
    webviewWithHandler.onDidReceiveMessage(async (message: unknown) => {
      const msg = message as { type?: string; file?: string; line?: number };
      if (msg?.type === 'stop') {
        opts.onStop();
      } else if (msg?.type === 'openSource' && msg.file) {
        await opts.onOpenSource(msg.file, msg.line ?? 1);
      }
    });
  }

  return {
    postSnapshot(snapshot: LiveSnapshot): void {
      void webviewWithHandler.postMessage?.({ type: 'snapshot', data: snapshot });
    },
    markStopped(): void {
      void webviewWithHandler.postMessage?.({ type: 'stopped' });
    },
    dispose(): void {
      panel.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

interface HtmlOptions {
  title: string;
  liveJsUri: string;
  liveCssUri: string;
  nonce: string;
  cspSource: string;
}

function buildHtml(opts: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 img-src ${opts.cspSource} data:;
                 style-src ${opts.cspSource} 'unsafe-inline';
                 script-src ${opts.cspSource} 'nonce-${opts.nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${opts.liveCssUri}" rel="stylesheet" />
  <title>${opts.title}</title>
</head>
<body>
  <div class="live-layout">

    <!-- Header bar -->
    <div class="live-header">
      <h2 class="live-title">${opts.title}</h2>
      <div class="live-stats">
          <span class="stat-badge" id="stat-heap">Heap: --</span>
          <span class="stat-badge peak" id="stat-peak">Peak: --</span>
        </div>
      <button id="btn-stop" class="btn-stop">Stop</button>
    </div>

    <!-- Chart -->
    <div class="live-chart-container">
      <canvas id="memChart"></canvas>
    </div>

    <!-- Top allocators table -->
    <div class="live-table-container">
      <table id="topTable">
        <thead>
          <tr>
            <th>Function</th>
            <th>File</th>
            <th>Line</th>
            <th>Memory</th>
            <th>Allocs</th>
          </tr>
        </thead>
        <tbody id="topTableBody">
          <tr><td colspan="5" class="empty-row">Waiting for data...</td></tr>
        </tbody>
      </table>
    </div>

    <div id="status-bar" class="status-bar">Running...</div>
  </div>

  <script nonce="${opts.nonce}" src="${opts.liveJsUri}"></script>
</body>
</html>`;
}
