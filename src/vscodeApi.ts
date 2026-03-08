import * as fallbackVscode from '../vscode';

type VscodeModule = typeof import('vscode');

let resolvedVscode: VscodeModule;

try {
	resolvedVscode = (await import('vscode')) as VscodeModule;
} catch {
	resolvedVscode = fallbackVscode as unknown as VscodeModule;
}

const defaultVscode = resolvedVscode;

export function __setVscodeForTests(mock: VscodeModule): void {
	resolvedVscode = mock;
}

export function __resetVscodeForTests(): void {
	resolvedVscode = defaultVscode;
}

export { resolvedVscode as default };