import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as util from 'util';
import { createRequire } from 'module';
const requireC = createRequire(process.cwd() + '/package.json');
const proxyquire = requireC('proxyquire').noCallThru();

describe('pythonDetection', function () {
  this.timeout(5000);

  let tmpBase: string;

  beforeEach(async () => {
    tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memray-test-'));
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tmpBase, { recursive: true, force: true });
    } catch {}
    delete process.env.VIRTUAL_ENV;
  });

  it('prefers workspace venv memray', async () => {
    // create workspace with .venv/bin/memray
    const workspace = path.join(tmpBase, 'workspace');
    const venvBin = path.join(workspace, '.venv', 'bin');
    await fs.promises.mkdir(venvBin, { recursive: true });
    const memrayPath = path.join(venvBin, 'memray');
    await fs.promises.writeFile(memrayPath, '#!/bin/sh\n');
    await fs.promises.chmod(memrayPath, 0o755);

    const mockVscode = {
      workspace: {
        workspaceFolders: [{ uri: { fsPath: workspace } }],
        getConfiguration: () => ({ get: () => undefined }),
      },
    };

    const pd = proxyquire('./src/utils/pythonDetection', { vscode: mockVscode });
    const res = await pd.detectMemray();
    assert.ok(res.command && res.command[0].endsWith(path.join('.venv', 'bin', 'memray')));
    assert.strictEqual(res.source, 'workspace-venv');
  });

  it('prefers VIRTUAL_ENV memray when set', async () => {
    const venv = path.join(tmpBase, 'venv_env');
    const bin = path.join(venv, 'bin');
    await fs.promises.mkdir(bin, { recursive: true });
    const mem = path.join(bin, 'memray');
    await fs.promises.writeFile(mem, '#!/bin/sh\n');
    await fs.promises.chmod(mem, 0o755);

    process.env.VIRTUAL_ENV = venv;

    const mockVscode = {
      workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({ get: () => undefined }),
      },
    };

    const pd = proxyquire('./src/utils/pythonDetection', { vscode: mockVscode });
    const res = await pd.detectMemray();
    assert.ok(res.command && res.command[0].startsWith(venv));
    assert.strictEqual(res.source, 'env-venv');
  });

  it('falls back to user-local (~/.local/bin)', async () => {
    // set HOME to tmp dir
    const fakeHome = path.join(tmpBase, 'home');
    const localBin = path.join(fakeHome, '.local', 'bin');
    await fs.promises.mkdir(localBin, { recursive: true });
    const mem = path.join(localBin, 'memray');
    await fs.promises.writeFile(mem, '#!/bin/sh\n');
    await fs.promises.chmod(mem, 0o755);

    const mockVscode = {
      workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({ get: () => undefined }),
      },
    };

    const env = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const pd = proxyquire('./src/utils/pythonDetection', { vscode: mockVscode });
      const res = await pd.detectMemray();
      assert.ok(res.command && res.command[0].startsWith(path.join(fakeHome, '.local')));
      assert.strictEqual(res.source, 'user-local');
    } finally {
      process.env.HOME = env;
    }
  });
});
