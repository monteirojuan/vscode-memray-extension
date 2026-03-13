import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readFlamegraphData } from '../src/memray/flamegraphModel';

function makeValidFlamegraph(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    runId: 'test-run',
    script: 'script.py',
    generatedAt: new Date().toISOString(),
    nativeTraces: false,
    mergeThreads: false,
    root: {
      name: 'root',
      function: 'root',
      file: '',
      line: 0,
      value: 100,
      nAllocations: 10,
      threadId: '0x0',
      interesting: false,
      importSystem: false,
      children: [],
    },
    ...overrides,
  };
}

describe('flamegraphModel.readFlamegraphData', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flamegraph-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads and parses a valid flamegraph.json file', async () => {
    const data = makeValidFlamegraph();
    const filePath = path.join(tmpDir, 'flamegraph.json');
    await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf8');

    const result = await readFlamegraphData(filePath);
    assert.strictEqual(result.runId, 'test-run');
    assert.strictEqual(result.script, 'script.py');
    assert.strictEqual(result.version, 1);
    assert.ok(result.root);
    assert.strictEqual(result.root.name, 'root');
    assert.strictEqual(result.root.value, 100);
  });

  it('preserves nested children in the root node', async () => {
    const data = makeValidFlamegraph({
      root: {
        name: 'root',
        function: 'root',
        file: '',
        line: 0,
        value: 200,
        nAllocations: 20,
        threadId: '0x0',
        interesting: false,
        importSystem: false,
        children: [
          {
            name: 'child',
            function: 'child_fn',
            file: 'module.py',
            line: 42,
            value: 100,
            nAllocations: 10,
            threadId: '0x0',
            interesting: true,
            importSystem: false,
            children: [],
          },
        ],
      },
    });
    const filePath = path.join(tmpDir, 'flamegraph.json');
    await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf8');

    const result = await readFlamegraphData(filePath);
    assert.strictEqual(result.root.children.length, 1);
    assert.strictEqual(result.root.children[0].function, 'child_fn');
    assert.strictEqual(result.root.children[0].line, 42);
    assert.strictEqual(result.root.children[0].interesting, true);
  });

  it('includes optional summary when present', async () => {
    const data = makeValidFlamegraph({
      summary: { peakMemoryBytes: 1048576, totalAllocations: 500, durationMs: 250 },
    });
    const filePath = path.join(tmpDir, 'flamegraph.json');
    await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf8');

    const result = await readFlamegraphData(filePath);
    assert.ok(result.summary);
    assert.strictEqual(result.summary!.peakMemoryBytes, 1048576);
    assert.strictEqual(result.summary!.totalAllocations, 500);
    assert.strictEqual(result.summary!.durationMs, 250);
  });

  it('throws when the file is missing', async () => {
    let threw = false;
    try {
      await readFlamegraphData(path.join(tmpDir, 'missing.json'));
    } catch {
      threw = true;
    }
    assert.ok(threw, 'expected readFlamegraphData to throw for missing file');
  });

  it('throws for invalid JSON', async () => {
    const filePath = path.join(tmpDir, 'bad.json');
    await fs.promises.writeFile(filePath, 'not valid json', 'utf8');
    let threw = false;
    try {
      await readFlamegraphData(filePath);
    } catch {
      threw = true;
    }
    assert.ok(threw, 'expected readFlamegraphData to throw for invalid JSON');
  });

  it('throws when root node is missing', async () => {
    const filePath = path.join(tmpDir, 'flamegraph.json');
    await fs.promises.writeFile(filePath, JSON.stringify({ version: 1, runId: 'r', script: 's.py' }), 'utf8');
    let threw = false;
    try {
      await readFlamegraphData(filePath);
    } catch (err: unknown) {
      threw = true;
      assert.ok(err instanceof Error && /missing root node/.test(err.message));
    }
    assert.ok(threw, 'expected readFlamegraphData to throw when root is absent');
  });
});
