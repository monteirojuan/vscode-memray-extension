import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { detectMemrayPython } from '../src/utils/memrayPython';

function makeSpawnProbe(exitCode: number, stdout = '') {
  return (_cmd: string, _args: string[], _opts: any) => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', exitCode);
    });
    return child;
  };
}

describe('memrayPython.detectMemrayPython', function () {
  this.timeout(5000);

  it('uses configuredPythonPath when probe succeeds', async () => {
    const probe = makeSpawnProbe(0, JSON.stringify({ version: '1.2.3' }));
    const result = await detectMemrayPython(['memray'], '/usr/bin/python3', probe as any);
    assert.strictEqual(result.pythonPath, '/usr/bin/python3');
    assert.strictEqual(result.memrayVersion, '1.2.3');
    assert.ok(result.tried.includes('/usr/bin/python3'));
  });

  it('returns undefined pythonPath when all probes fail', async () => {
    const probe = makeSpawnProbe(1);
    const result = await detectMemrayPython(['memray'], '/bad/python', probe as any);
    assert.strictEqual(result.pythonPath, undefined);
    assert.ok(result.tried.length > 0);
  });

  it('falls back to sibling python when memrayCommand is a direct binary', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memray-py-'));
    const binDir = path.join(tmpDir, 'bin');
    await fs.promises.mkdir(binDir, { recursive: true });
    const fakeMemray = path.join(binDir, 'memray');
    const fakePython = path.join(binDir, 'python');
    await fs.promises.writeFile(fakeMemray, '#!/bin/sh\n');
    await fs.promises.writeFile(fakePython, '#!/bin/sh\n');
    await fs.promises.chmod(fakeMemray, 0o755);
    await fs.promises.chmod(fakePython, 0o755);

    const probe = makeSpawnProbe(0, JSON.stringify({ version: '2.0.0' }));
    const result = await detectMemrayPython([fakeMemray], undefined, probe as any);

    assert.strictEqual(result.pythonPath, fakePython);
    assert.strictEqual(result.memrayVersion, '2.0.0');

    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('uses python from python-module command (python -m memray)', async () => {
    const probe = makeSpawnProbe(0, JSON.stringify({ version: '3.1.0' }));
    const result = await detectMemrayPython(['/venv/bin/python', '-m', 'memray'], undefined, probe as any);
    assert.strictEqual(result.pythonPath, '/venv/bin/python');
    assert.strictEqual(result.memrayVersion, '3.1.0');
  });

  it('sets memrayVersion to undefined when stdout has no version field', async () => {
    const probe = makeSpawnProbe(0, JSON.stringify({ other: 'data' }));
    const result = await detectMemrayPython(['memray'], '/usr/bin/python3', probe as any);
    assert.strictEqual(result.pythonPath, '/usr/bin/python3');
    assert.strictEqual(result.memrayVersion, undefined);
  });

  it('handles probe with non-JSON stdout gracefully', async () => {
    const probe = makeSpawnProbe(0, 'not-json');
    const result = await detectMemrayPython(['memray'], '/usr/bin/python3', probe as any);
    // probe returned exit 0 but stdout was not parseable JSON -> still marks as ok with no version
    assert.strictEqual(result.pythonPath, '/usr/bin/python3');
    assert.strictEqual(result.memrayVersion, undefined);
  });

  it('deduplicates candidates and only tries unique paths', async () => {
    const probeCallArgs: string[] = [];
    const probe = (cmd: string, _args: string[], _opts: any) => {
      probeCallArgs.push(cmd);
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ version: '1.0.0' })));
        child.emit('close', 0);
      });
      return child;
    };

    // Pass the same path as both configuredPythonPath and the python-module command
    await detectMemrayPython(['/same/python', '-m', 'memray'], '/same/python', probe as any);
    const uniqueProbes = [...new Set(probeCallArgs)];
    assert.deepStrictEqual(probeCallArgs, uniqueProbes, 'each candidate should only be probed once');
  });
});
