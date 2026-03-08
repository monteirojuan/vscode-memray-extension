import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
const requireC = createRequire(process.cwd() + '/package.json');
const proxyquire = requireC('proxyquire').noCallThru();

class FakeOutput {
  lines: string[] = [];
  appendLine(s: string) { this.lines.push(s); }
}

describe('scanAndPopulateIndex', function () {
  this.timeout(5000);

  it('builds index.json from various layouts', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scan-'));
    const memdir = path.join(tmp, '.memray');
    await fs.promises.mkdir(memdir, { recursive: true });

    // 1) dir with meta.json
    const d1 = path.join(memdir, 'result1');
    await fs.promises.mkdir(d1, { recursive: true });
    const meta = { id: 'result1', title: 'Result One', html: path.join(d1, 'r.html'), bin: path.join(d1, 'r.bin'), timestamp: new Date().toISOString() };
    await fs.promises.writeFile(path.join(d1, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    // 2) dir without meta but with html/bin
    const d2 = path.join(memdir, 'result2');
    await fs.promises.mkdir(d2, { recursive: true });
    await fs.promises.writeFile(path.join(d2, 'out.html'), '<html></html>');
    await fs.promises.writeFile(path.join(d2, 'out.bin'), 'BIN');

    // 3) loose files
    await fs.promises.writeFile(path.join(memdir, 'loose.html'), '<html></html>');
    await fs.promises.writeFile(path.join(memdir, 'loose.bin'), 'BIN');

    const fakeVscode = { workspace: { workspaceFolders: [{ uri: { fsPath: tmp } }] } };
    const fakeExecutor = { runProfile: async () => ({ binPath: '', htmlPath: '', durationMs: 0 }) };
    const ext = proxyquire('./src/extension', { vscode: fakeVscode, './memray/executor': fakeExecutor });

    const out = new FakeOutput();
    await ext.scanAndPopulateIndex(tmp, out as any);

    const idxPath = path.join(memdir, 'index.json');
    const raw = await fs.promises.readFile(idxPath, 'utf8');
    const arr = JSON.parse(raw);
    // expect at least three entries (result1, result2, loose)
    assert.ok(arr.find((e: any) => e.id === 'result1'));
    assert.ok(arr.find((e: any) => e.id === 'result2'));
    assert.ok(arr.find((e: any) => e.id === 'loose'));
  });
});
