const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const Mocha = require('mocha');

async function collectIntegrationFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectIntegrationFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.integration.mjs')) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

async function run() {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 15000,
  });

  const compiledRootCandidates = [
    path.resolve(__dirname, '../../../dist/test/integration'),
    path.resolve(process.cwd(), 'dist/test/integration'),
  ];

  let compiledTestsRoot;
  for (const candidate of compiledRootCandidates) {
    try {
      if (fsSync.existsSync(candidate)) {
        compiledTestsRoot = candidate;
        break;
      }
      const realCandidate = fsSync.realpathSync(candidate);
      if (fsSync.existsSync(realCandidate)) {
        compiledTestsRoot = realCandidate;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!compiledTestsRoot) {
    throw new Error(`No compiled integration test directory found. Checked: ${compiledRootCandidates.join(', ')}`);
  }

  const testFiles = await collectIntegrationFiles(compiledTestsRoot);

  if (testFiles.length === 0) {
    throw new Error(`No compiled integration tests (.mjs) were found in ${compiledTestsRoot}`);
  }

  // Set up Mocha BDD globals (describe, it, before, etc.) before dynamic imports
  // so that the ES module test files can register their suites when loaded.
  mocha.suite.emit('pre-require', global, '', mocha);

  for (const file of testFiles) {
    const fileUrl = `file://${file.replace(/\\/g, '/')}`;
    await import(fileUrl);
  }

  return new Promise((resolve, reject) => {
    mocha.run(failures => {
      if (failures > 0) {
        reject(new Error(`${failures} integration test(s) failed.`));
        return;
      }
      resolve();
    });
  });
}

module.exports = { run };
