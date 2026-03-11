import vscode from './vscodeApi';

export interface MemrayConfig {
  pythonPath: string;
  nativeTracing: boolean;
  outputDirectory: string;
  keepHistoryDays: number;
  timeoutSeconds: number;
}

export function getConfig(): MemrayConfig {
  const cfg = vscode.workspace.getConfiguration('memray');
  return {
    pythonPath: cfg.get<string>('pythonPath', ''),
    nativeTracing: cfg.get<boolean>('nativeTracing', false),
    outputDirectory: cfg.get<string>('outputDirectory', '.memray'),
    keepHistoryDays: cfg.get<number>('keepHistoryDays', 30),
    timeoutSeconds: cfg.get<number>('timeoutSeconds', 0),
  };
}

export default { getConfig };
