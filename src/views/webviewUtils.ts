import vscode from '../vscodeApi';

/**
 * Converts an on-disk file path to a Webview-safe URI string.
 * Falls back to `fsPath` when running outside a real VS Code host (e.g. tests).
 */
export function asPanelResource(panel: vscode.WebviewPanel, filePath: string): string {
  const fileUri = vscode.Uri.file(filePath);
  const webview = panel.webview as vscode.Webview & { asWebviewUri?: (uri: vscode.Uri) => vscode.Uri };
  if (typeof webview.asWebviewUri === 'function') {
    return webview.asWebviewUri(fileUri).toString();
  }
  return fileUri.fsPath;
}
