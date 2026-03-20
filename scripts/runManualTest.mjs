import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extensionDevelopmentPath = path.resolve(__dirname, '..');

async function main() {
  try {
    // Create a temporary workspace folder for manual testing
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memray-manual-test-'));
    
    // Launch VS Code with the extension
    // --extensionDevelopmentPath tells VS Code to load the extension in development mode
    const cmd = `code --extensionDevelopmentPath="${extensionDevelopmentPath}" "${tempDir}"`;
    
    console.log('Launching VS Code with Memray extension...');
    console.log(`Extension path: ${extensionDevelopmentPath}`);
    console.log(`Workspace: ${tempDir}`);
    
    execSync(cmd, { stdio: 'inherit' });
  } catch (error) {
    console.error('Failed to launch VS Code');
    console.error(error);
    process.exit(1);
  }
}

await main();
