import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseStatsSummary, readStatsSummaryFromFile } from '../src/memray/stats';

describe('stats.parseStatsSummary', () => {
  it('returns peakMemoryBytes from numeric metadata.peak_memory', () => {
    const result = parseStatsSummary({ metadata: { peak_memory: 1048576 } });
    assert.strictEqual(result.peakMemoryBytes, 1048576);
  });

  it('parses peak_memory from a numeric string', () => {
    const result = parseStatsSummary({ metadata: { peak_memory: '2097152' } });
    assert.strictEqual(result.peakMemoryBytes, 2097152);
  });

  it('returns undefined when metadata is absent', () => {
    const result = parseStatsSummary({});
    assert.strictEqual(result.peakMemoryBytes, undefined);
  });

  it('returns undefined for null input', () => {
    const result = parseStatsSummary(null);
    assert.strictEqual(result.peakMemoryBytes, undefined);
  });

  it('returns undefined when peak_memory is non-numeric string', () => {
    const result = parseStatsSummary({ metadata: { peak_memory: 'not-a-number' } });
    assert.strictEqual(result.peakMemoryBytes, undefined);
  });

  it('returns undefined when peak_memory is null', () => {
    const result = parseStatsSummary({ metadata: { peak_memory: null } });
    assert.strictEqual(result.peakMemoryBytes, undefined);
  });

  it('returns undefined when peak_memory is NaN (Infinity)', () => {
    const result = parseStatsSummary({ metadata: { peak_memory: Infinity } });
    assert.strictEqual(result.peakMemoryBytes, undefined);
  });
});

describe('stats.readStatsSummaryFromFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stats-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads and parses a valid stats.json file', async () => {
    const filePath = path.join(tmpDir, 'stats.json');
    await fs.promises.writeFile(
      filePath,
      JSON.stringify({ metadata: { peak_memory: 3145728 } }),
      'utf8',
    );
    const result = await readStatsSummaryFromFile(filePath);
    assert.ok(result !== undefined);
    assert.strictEqual(result!.peakMemoryBytes, 3145728);
  });

  it('returns undefined for a non-existent file', async () => {
    const result = await readStatsSummaryFromFile(path.join(tmpDir, 'missing.json'));
    assert.strictEqual(result, undefined);
  });

  it('returns undefined for a file with invalid JSON', async () => {
    const filePath = path.join(tmpDir, 'bad.json');
    await fs.promises.writeFile(filePath, 'not valid json', 'utf8');
    const result = await readStatsSummaryFromFile(filePath);
    assert.strictEqual(result, undefined);
  });

  it('returns object with undefined peakMemoryBytes for JSON missing peak_memory', async () => {
    const filePath = path.join(tmpDir, 'stats.json');
    await fs.promises.writeFile(filePath, JSON.stringify({ metadata: {} }), 'utf8');
    const result = await readStatsSummaryFromFile(filePath);
    assert.ok(result !== undefined);
    assert.strictEqual(result!.peakMemoryBytes, undefined);
  });
});
