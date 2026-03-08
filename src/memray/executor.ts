import { spawn } from 'child_process';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import detection from '../utils/pythonDetection';
import cfg from '../config';

export interface RunOptions {
  scriptPath: string;
  outDir: string; // directory where outputs (bin, html) are written
  id: string; // filename base
  timeoutSeconds?: number;
  native?: boolean;
}

export interface RunResult {
  binPath: string;
  htmlPath: string;
  statsPath: string;
  durationMs: number;
  runOk: boolean;
  flamegraphOk: boolean;
  statsOk: boolean;
  errors: string[];
}

function spawnProcess(command: string, args: string[], output: vscode.OutputChannel, timeoutMs?: number): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    output.appendLine(`$ ${command} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout?.on('data', d => output.appendLine(d.toString()));
    child.stderr?.on('data', d => output.appendLine(d.toString()));

    let finished = false;
    const onFinish = (code: number | null) => {
      if (finished) return;
      finished = true;
      resolve({ code });
    };

    child.on('error', err => {
      if (finished) return;
      finished = true;
      reject(err);
    });

    child.on('close', code => onFinish(code));

    if (timeoutMs && timeoutMs > 0) {
      setTimeout(() => {
        if (!finished) {
          output.appendLine(`Process timeout (${timeoutMs}ms). Killing.`);
          child.kill('SIGKILL');
        }
      }, timeoutMs);
    }
  });
}

async function resolveMemrayCommand(output: vscode.OutputChannel): Promise<string[]> {
  const detected = await detection.detectMemray();
  const tried = detected?.tried ?? [];
  if (!detected || !detected.command || detected.command.length === 0) {
    output.appendLine('memray detection failed. Attempted:');
    for (const t of tried) output.appendLine(`  - ${t}`);
    throw new Error('memray not found. Install memray in your project or system (or set up Python module).');
  }

  output.appendLine(`memray detection: source=${detected.source ?? 'unknown'}`);
  output.appendLine(`memray command: ${detected.command.join(' ')}`);
  if (tried.length > 0) {
    output.appendLine('memray detection attempted locations:');
    for (const t of tried) output.appendLine(`  - ${t}`);
  }

  const ok = await detection.verifyMemray(detected.command);
  if (!ok) {
    output.appendLine('Detected memray failed verification (--version).');
    throw new Error('Detected memray is not usable (failed --version).');
  }

  output.appendLine(`Using memray: ${detected.command.join(' ')}`);
  return detected.command;
}

export async function runProfile(opts: RunOptions, output: vscode.OutputChannel): Promise<RunResult> {
  const start = Date.now();
  const conf = cfg.getConfig();

  // Determine output directory: prefer opts.outDir, otherwise use workspace + configured outputDirectory
  let outDir = opts.outDir;
  if (!outDir) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    outDir = path.join(workspaceRoot, conf.outputDirectory);
    output.appendLine(`Using configured output directory: ${outDir}`);
  }

  await fs.mkdir(outDir, { recursive: true });

  const memrayCmd = await resolveMemrayCommand(output);

  const binPath = path.join(outDir, `${opts.id}.bin`);
  const htmlPath = path.join(outDir, `${opts.id}.html`);
  const statsPath = path.join(outDir, 'stats.json');

  // Build memray run args
  const runArgs: string[] = ['run'];
  const nativeFlag = opts.native ?? conf.nativeTracing;
  if (nativeFlag) runArgs.push('--native');
  runArgs.push('--output', binPath);
  runArgs.push('--');
  runArgs.push(opts.scriptPath);

  // Run memray run <script>
  output.appendLine(`Starting memray run for ${opts.scriptPath}`);
  const timeoutSeconds = opts.timeoutSeconds ?? conf.timeoutSeconds ?? 0;
  const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined;
  const runCommand = memrayCmd[0];
  const runPrefix = memrayCmd.slice(1);
  const runRes = await spawnProcess(runCommand, runPrefix.concat(runArgs), output, timeoutMs);
  if (runRes.code !== 0) {
    throw new Error(`memray run exited with code ${runRes.code}`);
  }

  const errors: string[] = [];
  let flamegraphOk = false;
  let statsOk = false;

  // Generate flamegraph HTML
  output.appendLine(`Generating flamegraph HTML for ${binPath}`);
  const flameArgs = ['flamegraph', binPath, '-o', htmlPath];
  try {
    const flameRes = await spawnProcess(runCommand, runPrefix.concat(flameArgs), output, 30_000);
    flamegraphOk = flameRes.code === 0;
    if (!flamegraphOk) {
      errors.push(`memray flamegraph exited with code ${flameRes.code}`);
      output.appendLine(`Warning: ${errors[errors.length - 1]}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`memray flamegraph failed: ${msg}`);
    output.appendLine(`Warning: ${errors[errors.length - 1]}`);
  }

  output.appendLine(`Generating stats JSON for ${binPath}`);
  const statsArgs = ['stats', '--json', '-o', statsPath, '-f', binPath];
  try {
    const statsRes = await spawnProcess(runCommand, runPrefix.concat(statsArgs), output, 30_000);
    statsOk = statsRes.code === 0;
    if (!statsOk) {
      errors.push(`memray stats exited with code ${statsRes.code}`);
      output.appendLine(`Warning: ${errors[errors.length - 1]}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`memray stats failed: ${msg}`);
    output.appendLine(`Warning: ${errors[errors.length - 1]}`);
  }

  const durationMs = Date.now() - start;
  return {
    binPath,
    htmlPath,
    statsPath,
    durationMs,
    runOk: true,
    flamegraphOk,
    statsOk,
    errors,
  };
}
