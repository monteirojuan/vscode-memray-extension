type VscodeModule = typeof import('vscode');

class FallbackTreeItem {
	public label: string;

	constructor(label: string) {
		this.label = label;
	}
}

class FallbackEventEmitter<T> {
	public event = (_listener: (value: T) => void) => ({ dispose: () => {} });
	fire(_value?: T) {}
}

const fallbackVscode = {
	window: {
		showErrorMessage: async (_message: string) => undefined,
		showInformationMessage: async (_message: string) => undefined,
		showWarningMessage: async (_message: string) => undefined,
		createOutputChannel: (_name?: string) => ({
			append: (_value: string) => {},
			appendLine: (_value: string) => {},
			clear: () => {},
			show: () => {},
			dispose: () => {},
		}),
		createWebviewPanel: () => ({
			webview: {
				html: '',
				onDidReceiveMessage: () => {},
				asWebviewUri: (uri: unknown) => uri,
			},
			onDidDispose: () => {},
			reveal: () => {},
		}),
	},
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue: unknown) => defaultValue,
			update: async (..._args: unknown[]) => undefined,
		}),
		workspaceFolders: [] as unknown[],
	},
	Uri: {
		file: (fsPath: string) => ({ fsPath, scheme: 'file' as const }),
		parse: (_value: string) => ({}),
	},
	ViewColumn: {
		One: 1,
	},
	TreeItem: FallbackTreeItem,
	EventEmitter: FallbackEventEmitter,
	TreeItemCollapsibleState: { None: 0 },
	ProgressLocation: { Notification: 1 },
} as unknown as VscodeModule;

let resolvedVscode: VscodeModule;

try {
	resolvedVscode = (await import('vscode')) as VscodeModule;
} catch {
	resolvedVscode = fallbackVscode;
}

const defaultVscode = resolvedVscode;

export function __setVscodeForTests(mock: VscodeModule): void {
	resolvedVscode = mock;
}

export function __resetVscodeForTests(): void {
	resolvedVscode = defaultVscode;
}

export { resolvedVscode as default };