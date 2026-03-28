/**
 * liveProvider.test.ts — Unit tests for src/memray/liveProvider.ts
 *
 * All tests use injected fakes (no real child processes, no real TCP sockets).
 * The tests cover:
 *   - splitJsonLines: buffer splitting logic
 *   - parseSnapshot: JSON validation & null cases
 *   - startLiveSession: full lifecycle with mocked spawn/detection
 */

import * as assert from 'assert';
import { EventEmitter } from 'events';
import {
  splitJsonLines,
  parseSnapshot,
  startLiveSession,
  __setLiveProviderDepsForTests,
  __resetLiveProviderDepsForTests,
  LiveSnapshot,
} from '../src/memray/liveProvider';
import { FakeOutput } from './helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a fake child process whose stdout can be manually written to and
 * whose lifecycle events (close, error) can be triggered programmatically.
 */
function makeFakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  proc._triggerClose = (code: number | null) => proc.emit('close', code);
  proc._triggerError = (err: Error) => proc.emit('error', err);
  proc._writeStdout = (data: string) => proc.stdout.emit('data', Buffer.from(data));
  proc._writeStderr = (data: string) => proc.stderr.emit('data', Buffer.from(data));
  return proc;
}

function makeMockDeps(targetProc: any, bridgeProc: any, port = 19999) {
  let spawnCallCount = 0;
  return {
    spawn: (_cmd: string, _args: string[], _opts: any) => {
      spawnCallCount += 1;
      return spawnCallCount === 1 ? targetProc : bridgeProc;
    },
    detection: {
      detectMemray: async () => ({ command: ['memray'], source: 'system', tried: [] }),
      verifyMemray: async () => true,
    },
    detectMemrayPython: async () => ({ pythonPath: '/usr/bin/python3', tried: [], memrayVersion: '1.0' }),
    findFreePort: async () => port,
  };
}

// ---------------------------------------------------------------------------
// splitJsonLines
// ---------------------------------------------------------------------------

describe('liveProvider.splitJsonLines', () => {
  it('returns empty lines and buffer as remainder when no newline', () => {
    const { lines, remainder } = splitJsonLines('{"ts":1');
    assert.deepStrictEqual(lines, []);
    assert.strictEqual(remainder, '{"ts":1');
  });

  it('splits one complete line and keeps empty remainder', () => {
    const { lines, remainder } = splitJsonLines('{"ts":1}\n');
    assert.deepStrictEqual(lines, ['{"ts":1}']);
    assert.strictEqual(remainder, '');
  });

  it('splits multiple complete lines', () => {
    const { lines, remainder } = splitJsonLines('{"ts":1}\n{"ts":2}\n');
    assert.deepStrictEqual(lines, ['{"ts":1}', '{"ts":2}']);
    assert.strictEqual(remainder, '');
  });

  it('keeps incomplete final segment as remainder', () => {
    const { lines, remainder } = splitJsonLines('{"ts":1}\n{"ts":2');
    assert.deepStrictEqual(lines, ['{"ts":1}']);
    assert.strictEqual(remainder, '{"ts":2');
  });

  it('filters blank lines', () => {
    const { lines } = splitJsonLines('\n\n{"ts":3}\n\n');
    assert.deepStrictEqual(lines, ['{"ts":3}']);
  });

  it('handles empty string input', () => {
    const { lines, remainder } = splitJsonLines('');
    assert.deepStrictEqual(lines, []);
    assert.strictEqual(remainder, '');
  });

  it('handles only newlines', () => {
    const { lines, remainder } = splitJsonLines('\n\n\n');
    assert.deepStrictEqual(lines, []);
    assert.strictEqual(remainder, '');
  });
});

// ---------------------------------------------------------------------------
// parseSnapshot
// ---------------------------------------------------------------------------

describe('liveProvider.parseSnapshot', () => {
  const validSnap = JSON.stringify({
    ts: 1000, heap: 2048, peak: 4096,
    top: [{ func: 'main', file: 'a.py', line: 1, mem: 512, allocs: 3 }],
  });

  it('returns a LiveSnapshot for a valid JSON line', () => {
    const snap = parseSnapshot(validSnap);
    assert.ok(snap !== null);
    assert.strictEqual(snap!.ts, 1000);
    assert.strictEqual(snap!.heap, 2048);
    assert.strictEqual(snap!.peak, 4096);
    assert.strictEqual(snap!.top.length, 1);
    assert.strictEqual(snap!.top[0].func, 'main');
  });

  it('returns null for invalid JSON', () => {
    assert.strictEqual(parseSnapshot('{bad json'), null);
  });

  it('returns null when ts is missing', () => {
    const bad = JSON.stringify({ heap: 0, peak: 0, top: [] });
    assert.strictEqual(parseSnapshot(bad), null);
  });

  it('returns null when top is not an array', () => {
    const bad = JSON.stringify({ ts: 1, heap: 0, peak: 0, top: null });
    assert.strictEqual(parseSnapshot(bad), null);
  });

  it('returns null when heap is a string', () => {
    const bad = JSON.stringify({ ts: 1, heap: 'big', peak: 0, top: [] });
    assert.strictEqual(parseSnapshot(bad), null);
  });

  it('returns null for empty string', () => {
    assert.strictEqual(parseSnapshot(''), null);
  });

  it('accepts a snapshot with empty top array', () => {
    const snap = parseSnapshot(JSON.stringify({ ts: 0, heap: 0, peak: 0, top: [] }));
    assert.ok(snap !== null);
    assert.deepStrictEqual(snap!.top, []);
  });
});

// ---------------------------------------------------------------------------
// startLiveSession — lifecycle
// ---------------------------------------------------------------------------

describe('liveProvider.startLiveSession', () => {
  afterEach(() => {
    __resetLiveProviderDepsForTests();
  });

  it('returns a session with the expected port', async () => {
    const target = makeFakeProc();
    const bridge = makeFakeProc();
    __setLiveProviderDepsForTests(makeMockDeps(target, bridge, 19001) as any);

    const out = new FakeOutput();
    const session = await startLiveSession({ scriptPath: 'script.py' }, out as any);
    assert.strictEqual(session.port, 19001);

    // cleanup
    session.stop();
    target._triggerClose(0);
    bridge._triggerClose(0);
  });

  it('delivers parsed snapshots to onSnapshot listener', (done) => {
    const target = makeFakeProc();
    const bridge = makeFakeProc();
    __setLiveProviderDepsForTests(makeMockDeps(target, bridge) as any);

    const out = new FakeOutput();
    const snapLine = JSON.stringify({ ts: 1, heap: 512, peak: 1024, top: [] }) + '\n';

    startLiveSession({ scriptPath: 'script.py' }, out as any).then(session => {
      session.onSnapshot(snap => {
        assert.strictEqual(snap.ts, 1);
        assert.strictEqual(snap.peak, 1024);
        session.stop();
        target._triggerClose(0);
        bridge._triggerClose(0);
        done();
      });

      // Simulate bridge emitting a JSON line
      bridge._writeStdout(snapLine);
    });
  });

  it('handles chunked stdout correctly (partial lines)', (done) => {
    const target = makeFakeProc();
    const bridge = makeFakeProc();
    __setLiveProviderDepsForTests(makeMockDeps(target, bridge) as any);

    const out = new FakeOutput();
    const fullLine = JSON.stringify({ ts: 42, heap: 100, peak: 200, top: [] });

    const received: LiveSnapshot[] = [];

    startLiveSession({ scriptPath: 'script.py' }, out as any).then(session => {
      session.onSnapshot(snap => received.push(snap));

      // Send in two chunks — first half, then second half + newline
      const half = Math.floor(fullLine.length / 2);
      bridge._writeStdout(fullLine.slice(0, half));
      bridge._writeStdout(fullLine.slice(half) + '\n');

      setImmediate(() => {
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].ts, 42);
        session.stop();
        target._triggerClose(0);
        bridge._triggerClose(0);
        done();
      });
    });
  });

  it('calls onStop listeners when both processes exit', (done) => {
    const target = makeFakeProc();
    const bridge = makeFakeProc();
    __setLiveProviderDepsForTests(makeMockDeps(target, bridge) as any);

    const out = new FakeOutput();

    startLiveSession({ scriptPath: 'script.py' }, out as any).then(session => {
      session.onStop(() => done());
      target._triggerClose(0);
      bridge._triggerClose(0);
    });
  });

  it('kills bridge when target exits first', (done) => {
    const target = makeFakeProc();
    const bridge = makeFakeProc();
    const killed: string[] = [];
    bridge.kill = (sig: string) => killed.push(sig);
    __setLiveProviderDepsForTests(makeMockDeps(target, bridge) as any);

    const out = new FakeOutput();

    startLiveSession({ scriptPath: 'script.py' }, out as any).then(session => {
      // When target closes, bridge should be killed
      target._triggerClose(0);
      setImmediate(() => {
        assert.ok(killed.includes('SIGTERM'), 'expected SIGTERM sent to bridge');
        bridge._triggerClose(0);
        done();
      });
    });
  });

  it('calls onError listener when bridge errors', (done) => {
    const target = makeFakeProc();
    const bridge = makeFakeProc();
    __setLiveProviderDepsForTests(makeMockDeps(target, bridge) as any);

    const out = new FakeOutput();

    startLiveSession({ scriptPath: 'script.py' }, out as any).then(session => {
      session.onError(err => {
        assert.ok(err.message.includes('crash'));
        target._triggerClose(null);
        bridge._triggerClose(null);
        done();
      });

      bridge._triggerError(new Error('bridge crash'));
    });
  });

  it('throws when memray detection fails', async () => {
    __setLiveProviderDepsForTests({
      detection: {
        detectMemray: async () => ({ command: [], source: 'none', tried: [] }),
        verifyMemray: async () => false,
      },
      findFreePort: async () => 9999,
    } as any);

    const out = new FakeOutput();
    let threw = false;
    try {
      await startLiveSession({ scriptPath: 'script.py' }, out as any);
    } catch {
      threw = true;
    }
    assert.ok(threw, 'expected startLiveSession to throw when memray not found');
  });

  it('throws when memray verification fails', async () => {
    __setLiveProviderDepsForTests({
      detection: {
        detectMemray: async () => ({ command: ['memray'], source: 'system', tried: [] }),
        verifyMemray: async () => false,
      },
      findFreePort: async () => 9999,
    } as any);

    const out = new FakeOutput();
    let threw = false;
    try {
      await startLiveSession({ scriptPath: 'script.py' }, out as any);
    } catch {
      threw = true;
    }
    assert.ok(threw, 'expected startLiveSession to throw when memray verification fails');
  });

  it('throws when no memray-capable Python is found', async () => {
    __setLiveProviderDepsForTests({
      spawn: (() => {}) as any,
      detection: {
        detectMemray: async () => ({ command: ['memray'], source: 'system', tried: [] }),
        verifyMemray: async () => true,
      },
      detectMemrayPython: async () => ({ pythonPath: undefined, tried: ['python3'], memrayVersion: undefined }),
      findFreePort: async () => 9999,
    } as any);

    const out = new FakeOutput();
    let threw = false;
    try {
      await startLiveSession({ scriptPath: 'script.py' }, out as any);
    } catch {
      threw = true;
    }
    assert.ok(threw, 'expected startLiveSession to throw when Python not found');
  });

  it('ignores unparseable lines from bridge stdout', (done) => {
    const target = makeFakeProc();
    const bridge = makeFakeProc();
    __setLiveProviderDepsForTests(makeMockDeps(target, bridge) as any);

    const out = new FakeOutput();
    const validLine = JSON.stringify({ ts: 5, heap: 0, peak: 0, top: [] }) + '\n';

    const received: LiveSnapshot[] = [];

    startLiveSession({ scriptPath: 'script.py' }, out as any).then(session => {
      session.onSnapshot(snap => received.push(snap));

      bridge._writeStdout('not json\n');
      bridge._writeStdout(validLine);

      setImmediate(() => {
        assert.strictEqual(received.length, 1, 'only 1 valid snapshot expected');
        assert.strictEqual(received[0].ts, 5);
        session.stop();
        target._triggerClose(0);
        bridge._triggerClose(0);
        done();
      });
    });
  });

  it('multiple snapshots are delivered in order', (done) => {
    const target = makeFakeProc();
    const bridge = makeFakeProc();
    __setLiveProviderDepsForTests(makeMockDeps(target, bridge) as any);

    const out = new FakeOutput();
    const received: number[] = [];

    startLiveSession({ scriptPath: 'script.py' }, out as any).then(session => {
      session.onSnapshot(snap => received.push(snap.ts));

      for (let i = 1; i <= 5; i++) {
        bridge._writeStdout(JSON.stringify({ ts: i, heap: 0, peak: 0, top: [] }) + '\n');
      }

      setImmediate(() => {
        assert.deepStrictEqual(received, [1, 2, 3, 4, 5]);
        session.stop();
        target._triggerClose(0);
        bridge._triggerClose(0);
        done();
      });
    });
  });
});
