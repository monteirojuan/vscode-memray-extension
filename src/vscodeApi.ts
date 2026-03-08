type VscodeModule = typeof import('vscode');

class FallbackTreeItem {
	public label: string;

	constructor(label: string) {
		this.label = label;
	}
}

class FallbackEventEmitter<T> {
	public event = (listener: (value: T) => void) => {
		void listener;
		return { dispose: () => {} };
	};
	fire(value?: T) {
		void value;
	}
}

const fallbackVscode = {
	window: {
		showErrorMessage: async (...args: unknown[]) => {
			void args;
			return undefined;
		},
		showInformationMessage: async (...args: unknown[]) => {
			void args;
			return undefined;
		},
		showWarningMessage: async (...args: unknown[]) => {
			void args;
			return undefined;
		},
		createOutputChannel: (...args: unknown[]) => {
			void args;
			return {
				append: (value: string) => {
					void value;
				},
				appendLine: (value: string) => {
					void value;
				},
			clear: () => {},
			show: () => {},
			dispose: () => {},
			};
		},
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
			update: async (...args: unknown[]) => {
				void args;
				return undefined;
			},
		}),
		workspaceFolders: [] as unknown[],
	},
	Uri: {
		file: (fsPath: string) => ({ fsPath, scheme: 'file' as const }),
		parse: (value: string) => {
			void value;
			return {};
		},
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