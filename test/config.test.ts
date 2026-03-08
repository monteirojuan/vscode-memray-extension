import * as assert from 'assert';
import { __setVscodeForTests, __resetVscodeForTests } from '../src/vscodeApi';
import { getConfig } from '../src/config';

describe('config', () => {
  afterEach(() => {
    __resetVscodeForTests();
  });

  it('reads configuration defaults from vscode', async () => {
    const fakeVscode: any = {
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

    __setVscodeForTests(fakeVscode);
    const c = getConfig();
    assert.strictEqual(c.nativeTracing, true);
    assert.strictEqual(c.outputDirectory, '.custom_memray');
    assert.strictEqual(c.keepHistoryDays, 7);
    assert.strictEqual(c.timeoutSeconds, 60);
  });
});
