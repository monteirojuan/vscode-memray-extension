import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
import { exec, spawn } from 'child_process';
import vscode from '../vscodeApi';

const execP = promisify(exec);

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function workspaceFolders(): string[] {
  const wfs = vscode.workspace.workspaceFolders;
  if (!wfs) return [];
  return wfs.map(f => f.uri.fsPath);
}

async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execP(`which ${cmd}`);
    const p = stdout.trim();
    return p || null;
  } catch {
    return null;
  }
}

export type DetectionResult = {
  path?: string;
  source?: 'workspace-venv' | 'env-venv' | 'user-local' | 'system' | 'python-module' | 'system-python' | 'vscode-interpreter' | 'not-found';
};

/**
 * Detect a Python executable with the following priority:
 * 1. workspace virtual environment (./.venv, ./venv, ./env)
 * 2. system python3
 * 3. system python
 */
export async function detectPython(): Promise<DetectionResult> {
  const wfPaths = workspaceFolders();
  const venvNames = ['.venv', 'venv', 'env'];

  // Check VIRTUAL_ENV env var first (user may have activated a venv)
  const virtualEnv = process.env.VIRTUAL_ENV;
  if (virtualEnv) {
    const candidate = path.join(virtualEnv, 'bin', 'python');
    if (await fileExists(candidate)) {
      return { path: candidate, source: 'env-venv' };
    }
  }

  // Check VS Code configured interpreter (if set in workspace/user settings)
  try {
    const cfg = vscode.workspace.getConfiguration('python');
    const interp = cfg.get<string>('defaultInterpreterPath') || cfg.get<string>('pythonPath');
    if (interp) {
      if (await fileExists(interp)) {
        return { path: interp, source: 'vscode-interpreter' };
      }
    }
  } catch {
    // ignore if config read fails
  }

  for (const base of wfPaths) {
    for (const v of venvNames) {
      const candidate = path.join(base, v, 'bin', 'python');
      if (await fileExists(candidate)) {
        return { path: candidate, source: 'workspace-venv' };
      }
    }
  }

  const py3 = await which('python3');
  if (py3) return { path: py3, source: 'system-python' };

  const py = await which('python');
  if (py) return { path: py, source: 'system-python' };

  return { source: 'not-found' };
}

/**
 * Detect memray runtime with the following priority:
 * 1. project virtual environment (same venv dirs as Python detection)
 * 2. user-local (~/.local/bin/memray)
 * 3. system `memray` in PATH
 * 4. fallback to `python -m memray` when available in detected Python
 *
 * Returns a command array suitable for spawn (e.g. ['/full/path/memray'] or [python, '-m', 'memray']).
 */
export async function detectMemray(): Promise<{ command: string[]; path?: string; source?: DetectionResult['source']; tried: string[] }> {
  const wfPaths = workspaceFolders();
  const venvNames = ['.venv', 'venv', 'env'];
  const tried: string[] = [];

  // If VIRTUAL_ENV is set, prefer memray inside it
  const virtualEnv = process.env.VIRTUAL_ENV;
  if (virtualEnv) {
    const veCandidate = path.join(virtualEnv, 'bin', 'memray');
    tried.push(veCandidate);
    if (await fileExists(veCandidate)) {
      return { command: [veCandidate], path: veCandidate, source: 'env-venv', tried };
    }
  }

  for (const base of wfPaths) {
    for (const v of venvNames) {
      const candidate = path.join(base, v, 'bin', 'memray');
      tried.push(candidate);
      if (await fileExists(candidate)) {
        return { command: [candidate], path: candidate, source: 'workspace-venv', tried };
      }
    }
  }

  const userLocal = path.join(os.homedir(), '.local', 'bin', 'memray');
  tried.push(userLocal);
  if (await fileExists(userLocal)) {
    return { command: [userLocal], path: userLocal, source: 'user-local', tried };
  }

  const system = await which('memray');
  if (system) {
    tried.push(system);
    return { command: [system], path: system, source: 'system', tried };
  }

  // Fallback: try python -m memray (use spawn to avoid shell PATH issues)
  const py = await detectPython();
  if (py.path) {
    tried.push(`${py.path} -m memray`);
    try {
      // spawn python -m memray --version
      const ok = await new Promise<boolean>(resolve => {
        const child = spawn(py.path as string, ['-m', 'memray', '--version'], { stdio: 'ignore' });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
      });
      if (ok) {
        return { command: [py.path, '-m', 'memray'], source: 'python-module', tried };
      }
    } catch {
      // not available as module
    }
  }

  return { command: [], source: 'not-found', tried };
}

/**
 * Convenience: try to verify memray is usable by running `memray --version` (or python -m memray).
 * Returns true when the binary/module responds without error.
 */
export async function verifyMemray(command: string[]): Promise<boolean> {
  if (!command || command.length === 0) return false;
  const cmd = command[0];
  const args = command.slice(1).concat(['--version']);
  return await new Promise<boolean>(resolve => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    let finished = false;
    child.on('error', () => {
      if (!finished) { finished = true; resolve(false); }
    });
    child.on('close', (code) => {
      if (!finished) { finished = true; resolve(code === 0); }
    });
    // safety timeout
    setTimeout(() => {
      if (!finished) {
        try {
          child.kill('SIGKILL');
        } catch (killError: unknown) {
          void killError;
        }
        finished = true;
        resolve(false);
      }
    }, 5000);
  });
}

export default { detectPython, detectMemray, verifyMemray };
