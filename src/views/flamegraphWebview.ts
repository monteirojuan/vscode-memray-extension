import * as path from 'path';
import vscode from '../vscodeApi';
import type { FlamegraphData, FlamegraphNode } from '../memray/flamegraphModel';

function asPanelResource(panel: vscode.WebviewPanel, filePath: string): string {
  const fileUri = vscode.Uri.file(filePath);
  const webview = panel.webview as vscode.Webview & { asWebviewUri?: (uri: vscode.Uri) => vscode.Uri };
  if (typeof webview.asWebviewUri === 'function') {
    return webview.asWebviewUri(fileUri).toString();
  }
  return fileUri.fsPath;
}

function toD3Node(node: FlamegraphNode): unknown {
  const frameText = [node.function, node.file ? `${node.file}:${node.line}` : '']
    .filter(Boolean)
    .join('\n');
  return {
    name: node.name,
    value: node.value,
    nAllocations: node.nAllocations,
    file: node.file,
    line: node.line,
    function: node.function,
    threadId: node.threadId,
    interesting: node.interesting,
    importSystem: node.importSystem,
    frameText,
    children: (node.children || []).map(toD3Node),
  };
}

export async function openNativeFlamegraphPanel(
  extensionContext: vscode.ExtensionContext,
  title: string,
  data: FlamegraphData,
  onOpenSource: (filePath: string, line: number) => Promise<void>,
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'memrayFlamegraph',
    title,
    { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
    {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(extensionContext.extensionPath, 'media')),
        vscode.Uri.file(path.join(extensionContext.extensionPath, 'node_modules')),
      ],
    },
  );

  const jsUri = asPanelResource(panel, path.join(extensionContext.extensionPath, 'media', 'flamegraph.js'));
  const cssUri = asPanelResource(panel, path.join(extensionContext.extensionPath, 'media', 'flamegraph.css'));
  const d3Uri = asPanelResource(panel, path.join(extensionContext.extensionPath, 'node_modules', 'd3', 'build', 'd3.min.js'));
  const d3FlameCssUri = asPanelResource(panel, path.join(extensionContext.extensionPath, 'node_modules', 'd3-flame-graph', 'dist', 'd3-flamegraph.css'));
  const d3FlameUri = asPanelResource(panel, path.join(extensionContext.extensionPath, 'node_modules', 'd3-flame-graph', 'dist', 'd3-flamegraph.min.js'));
  const nonce = String(Date.now());

  const payload = {
    ...data,
    d3Data: toD3Node(data.root),
  };

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src ${panel.webview.cspSource} 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${d3FlameCssUri}" rel="stylesheet" />
  <link href="${cssUri}" rel="stylesheet" />
  <title>${title}</title>
</head>
<body>
  <div class="layout">
    <div class="toolbar">
      <input id="searchBox" type="search" placeholder="Search frames" />
      <button id="resetZoomBtn">Reset Zoom</button>
      <label><input type="checkbox" id="hideIrrelevant" /> Hide irrelevant</label>
      <label><input type="checkbox" id="hideImportSystem" /> Hide import-system</label>
      <select id="threadFilter"><option value="">All threads</option></select>
      <span class="hint">Click: zoom • Alt+Click: open source</span>
    </div>
    <div class="content">
      <div id="flamegraph" class="graph"></div>
      <aside class="summary">
        <h3>Summary</h3>
        <div id="summaryContent"></div>
      </aside>
    </div>
    <div id="frameInfo" class="frame-info"></div>
  </div>

  <script nonce="${nonce}">window.__MEMRAY_FLAMEGRAPH_DATA__ = ${JSON.stringify(payload)};</script>
  <script nonce="${nonce}" src="${d3Uri}"></script>
  <script nonce="${nonce}" src="${d3FlameUri}"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;

  const webviewWithHandler = panel.webview as vscode.Webview & {
    onDidReceiveMessage?: (handler: (message: unknown) => void) => void;
  };

  if (typeof webviewWithHandler.onDidReceiveMessage === 'function') {
    webviewWithHandler.onDidReceiveMessage(async message => {
      const payloadMessage = message as { type?: string; file?: string; line?: number };
      if (payloadMessage?.type !== 'openSource' || !payloadMessage.file) {
        return;
      }
      await onOpenSource(payloadMessage.file, payloadMessage.line ?? 1);
    });
  }
}
