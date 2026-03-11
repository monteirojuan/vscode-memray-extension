import * as path from 'path';
import * as childProcess from 'child_process';
import detection from './pythonDetection';

export interface MemrayPythonResult {
  pythonPath?: string;
  memrayVersion?: string;
  tried: string[];
}

const PROBE_ARGS = [
  '-c',
  [
    'import json',
    'import memray',
    'from memray import FileReader',
    'print(json.dumps({"version": memray.__version__}))',
  ].join('; '),
];

async function probePython(pythonPath: string, spawnImpl: typeof childProcess.spawn): Promise<{ ok: boolean; version?: string }> {
  return new Promise(resolve => {
    const child = spawnImpl(pythonPath, PROBE_ARGS, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: string[] = [];

    child.stdout?.on('data', chunk => stdoutChunks.push(String(chunk)));
    child.on('error', () => resolve({ ok: false }));
    child.on('close', code => {
      if (code !== 0) {
        resolve({ ok: false });
        return;
      }
      const text = stdoutChunks.join('').trim();
      try {
        const payload = JSON.parse(text) as { version?: string };
        resolve({ ok: true, version: payload.version });
      } catch {
        resolve({ ok: true });
      }
    });
  });
}

function candidateFromMemrayCommand(memrayCommand: string[]): string | undefined {
  if (memrayCommand.length >= 3 && memrayCommand[1] === '-m' && memrayCommand[2] === 'memray') {
    return memrayCommand[0];
  }
  const executable = memrayCommand[0];
  if (!executable) {
    return undefined;
  }
  if (path.basename(executable) === 'memray') {
    return path.join(path.dirname(executable), 'python');
  }
  return undefined;
}

export async function detectMemrayPython(
  memrayCommand: string[],
  configuredPythonPath: string | undefined,
  spawnImpl: typeof childProcess.spawn = childProcess.spawn,
): Promise<MemrayPythonResult> {
  const tried: string[] = [];
  const candidates: string[] = [];

  if (configuredPythonPath) {
    candidates.push(configuredPythonPath);
  }

  const fromMemrayCommand = candidateFromMemrayCommand(memrayCommand);
  if (fromMemrayCommand) {
    candidates.push(fromMemrayCommand);
  }

  const detectedPython = await detection.detectPython();
  if (detectedPython.path) {
    candidates.push(detectedPython.path);
  }

  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
  for (const candidate of uniqueCandidates) {
    tried.push(candidate);
    const probe = await probePython(candidate, spawnImpl);
    if (probe.ok) {
      return {
        pythonPath: candidate,
        memrayVersion: probe.version,
        tried,
      };
    }
  }

  return { tried };
}
