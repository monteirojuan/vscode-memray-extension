import * as assert from 'assert';
import { createRequire } from 'module';
const requireC = createRequire(process.cwd() + '/package.json');
const proxyquire = requireC('proxyquire').noCallThru();

describe('config', () => {
  it('reads configuration defaults from vscode', () => {
    const fakeVscode = {
      workspace: {
        getConfiguration: () => ({ get: (key: string, def: any) => {
          const map: any = {
            nativeTracing: true,
            outputDirectory: '.custom_memray',
            keepHistoryDays: 7,
            timeoutSeconds: 60
          };
          return map[key] ?? def;
        } })
      }
    };

    const cfg = proxyquire('./src/config', { vscode: fakeVscode });
    const c = cfg.getConfig();
    assert.strictEqual(c.nativeTracing, true);
    assert.strictEqual(c.outputDirectory, '.custom_memray');
    assert.strictEqual(c.keepHistoryDays, 7);
    assert.strictEqual(c.timeoutSeconds, 60);
  });
});
