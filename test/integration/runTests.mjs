import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { runTests } from '@vscode/test-electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extensionDevelopmentPath = path.resolve(__dirname, '../..');
const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.cjs');
const fixtureWorkspacePath = path.resolve(__dirname, 'fixtures', 'workspace-basic');
const DEFAULT_TIMEOUT_MS = 180_000;
const VSCODE_VERSION = process.env.MEMRAY_IT_VSCODE_VERSION;
// A persistent "seed" directory holds the built-in extension scan cache so the
// renderer starts up fast on repeat runs, avoiding the ~6 s processing that
// exceeds the extension-host heartbeat timeout (10 s) and falsely marks it
// unresponsive.  Each run copies this seed into a fresh temp dir so there are
// never stale lock files (which cause "only one instance" errors).
const seedUserDataDir = path.resolve(__dirname, '../..', '.vscode-test-userdata');

/** Files/dirs VS Code uses to cache extension scan data – the only ones worth seeding. */
const CACHE_DIRS = ['CachedProfilesData'];

async function seedToTemp(tempUserDataDir) {
  await fs.mkdir(tempUserDataDir, { recursive: true });
  for (const name of CACHE_DIRS) {
    const src = path.join(seedUserDataDir, name);
    const dst = path.join(tempUserDataDir, name);
    try {
      await fs.cp(src, dst, { recursive: true });
    } catch {
      // seed not populated yet – first run, ignore
    }
  }
}

async function syncCacheBack(tempUserDataDir) {
  await fs.mkdir(seedUserDataDir, { recursive: true });
  for (const name of CACHE_DIRS) {
    const src = path.join(tempUserDataDir, name);
    const dst = path.join(seedUserDataDir, name);
    try {
      await fs.rm(dst, { recursive: true, force: true });
      await fs.cp(src, dst, { recursive: true });
    } catch {
      // no cache produced – safe to ignore
    }
  }
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Integration test host did not complete within ${timeoutMs}ms.`));
      }, timeoutMs);
    }),
  ]);
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memray-vscode-it-'));
  const workspacePath = path.join(tempRoot, 'workspace-basic');
  let passed = false;

  const userDataDir = path.join(tempRoot, 'user-data');
  // Seed the temp user-data dir with cached extension scan data from previous runs.
  await seedToTemp(userDataDir);

  try {
    await fs.cp(fixtureWorkspacePath, workspacePath, { recursive: true });

    const timeoutMs = Number(process.env.MEMRAY_IT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    await withTimeout(
      runTests({
        ...(VSCODE_VERSION ? { version: VSCODE_VERSION } : {}),
        extensionDevelopmentPath,
        extensionTestsPath,
        extensionTestsEnv: {
          MEMRAY_INTEGRATION_TEST: '1',
          CI: process.env.CI || '1',
        },
        launchArgs: [
          workspacePath,
          '--disable-extensions',
          '--disable-workspace-trust',
          '--no-sandbox',
          '--disable-gpu',
          '--skip-release-notes',
          '--disable-updates',
          '--disable-telemetry',
          '--no-first-run',
          '--user-data-dir',
          userDataDir,
        ],
      }),
      timeoutMs,
    );
    passed = true;
  } catch (error) {
    console.error('Integration tests failed');
    console.error(`Temporary integration workspace retained at: ${tempRoot}`);
    console.error('Tips: close all VS Code windows and rerun; if running headless Linux, try xvfb-run -a npm run test:integration');
    console.error(error);
    process.exit(1);
  } finally {
    // Always sync the extension cache back to the seed dir.
    await syncCacheBack(userDataDir).catch(() => {});
    if (passed) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

await main();