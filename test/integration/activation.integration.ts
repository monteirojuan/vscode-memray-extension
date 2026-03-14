import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'JuanMonteiro.memray-profiler';

async function waitForFile(filePath: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}

describe('integration: activation', function () {
  this.timeout(20000);

  let workspaceRoot: string;

  before(async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'expected an integration test workspace');
    workspaceRoot = workspaceFolder.uri.fsPath;

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `expected extension ${EXTENSION_ID} to be available`);

    await extension.activate();
  });

  it('registers the contributed Memray commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'memray.profileFile',
      'memray.profileCurrentFile',
      'memray.viewFlamegraph',
      'memray.openOutputDirectory',
      'memray.deleteResult',
      'memray.clearResults',
      'memray.exportHtml',
      'memray.refreshResults',
    ]) {
      assert.ok(commands.includes(command), `expected command ${command} to be registered`);
    }
  });

  it('scans the workspace .memray directory and populates index.json', async () => {
    const indexPath = path.join(workspaceRoot, '.memray', 'index.json');
    await vscode.commands.executeCommand('memray.refreshResults');
    await waitForFile(indexPath);

    const raw = await fs.readFile(indexPath, 'utf8');
    const entries = JSON.parse(raw) as Array<{ id?: string; html?: string; bin?: string; peakMemoryBytes?: number }>;

    assert.strictEqual(entries.length, 1, 'expected one indexed fixture result');
    assert.strictEqual(entries[0].id, 'legacy-run');
    assert.strictEqual(entries[0].html, path.join('.memray', 'legacy-run', 'result.html'));
    assert.strictEqual(entries[0].bin, path.join('.memray', 'legacy-run', 'result.bin'));
    assert.strictEqual(entries[0].peakMemoryBytes, 1048576);
  });

  it('exposes the refresh command as an executable activation sanity check', async () => {
    await vscode.commands.executeCommand('memray.refreshResults');
  });
});