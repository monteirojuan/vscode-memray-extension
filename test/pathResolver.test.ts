import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMemrayOutputDir, resolveArtifactPaths } from '../src/utils/pathResolver';

describe('pathResolver', () => {
  it('createMemrayOutputDir creates directory and id', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pr-'));
    const { dir, id } = await createMemrayOutputDir(tmp);
    const stat = await fs.promises.stat(dir);
    assert.ok(stat.isDirectory());
    assert.ok(typeof id === 'string' && id.length > 0);
    // cleanup
    await fs.promises.rm(path.join(tmp, '.memray'), { recursive: true, force: true });
  });

  it('resolveArtifactPaths returns correct paths', () => {
    const dir = '/some/workspace/.memray/2023-01-01';
    const id = 'run-id';
    const p = resolveArtifactPaths(dir, id);
    assert.strictEqual(p.bin, path.join(dir, `${id}.bin`));
    assert.strictEqual(p.html, path.join(dir, `${id}.html`));
    assert.strictEqual(p.meta, path.join(dir, 'meta.json'));
  });
});
