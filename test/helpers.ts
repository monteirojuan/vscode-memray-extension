import { EventEmitter } from 'events';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export function makeSpawnMock(exitCode: number, delay = 0) {
  return (_cmd: string, _args: string[], _opts: any) => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    if (delay > 0) setTimeout(() => child.emit('close', exitCode), delay);
    else process.nextTick(() => child.emit('close', exitCode));
    return child;
  };
}

export class FakeOutput {
  public lines: string[] = [];
  appendLine(s: string) { this.lines.push(s); }
}

export const fakeVscodeMinimal = {
  window: { createOutputChannel: () => ({ appendLine: (_s: string) => {} }) },
  workspace: { workspaceFolders: [] },
  ProgressLocation: { Notification: 1 }
};

export const fakeConfig = {
  getConfig: () => ({ nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }),
  default: { getConfig: () => ({ nativeTracing: false, outputDirectory: '.memray', keepHistoryDays: 30, timeoutSeconds: 0 }) }
};

export async function makeTmpDir(prefix = 'tmp-') {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}
