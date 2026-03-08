// Mock for the vscode module (framework-agnostic, Mocha-friendly)
type Spy<TArgs extends unknown[] = unknown[], TReturn = unknown> = ((...args: TArgs) => TReturn) & {
  calls: TArgs[];
};

function createSpy<TArgs extends unknown[] = unknown[], TReturn = unknown>(
  impl?: (...args: TArgs) => TReturn,
): Spy<TArgs, TReturn> {
  const calls: TArgs[] = [];
  const fn = ((...args: TArgs): TReturn => {
    calls.push(args);
    if (impl) {
      return impl(...args);
    }
    return undefined as TReturn;
  }) as Spy<TArgs, TReturn>;
  fn.calls = calls;
  return fn;
}

export const window = {
  showErrorMessage: createSpy<[string], void>(),
  showInformationMessage: createSpy<[string], void>(),
  showWarningMessage: createSpy<[string], void>(),
  createOutputChannel: createSpy<[string?], {
    append: Spy<[string], void>;
    appendLine: Spy<[string], void>;
    clear: Spy<[], void>;
    show: Spy<[], void>;
    dispose: Spy<[], void>;
  }>(() => ({
    append: createSpy<[string], void>(),
    appendLine: createSpy<[string], void>(),
    clear: createSpy<[], void>(),
    show: createSpy<[], void>(),
    dispose: createSpy<[], void>(),
  })),
  createWebviewPanel: createSpy<unknown[], {
    webview: {
      html: string;
      onDidReceiveMessage: Spy<[], void>;
      asWebviewUri: Spy<[unknown], unknown>;
    };
    onDidDispose: Spy<[], void>;
    reveal: Spy<[], void>;
  }>(() => ({
    webview: {
      html: '',
      onDidReceiveMessage: createSpy<[], void>(),
      asWebviewUri: createSpy<[unknown], unknown>((uri: unknown) => uri),
    },
    onDidDispose: createSpy<[], void>(),
    reveal: createSpy<[], void>(),
  })),
};

export const workspace = {
  getConfiguration: createSpy<[string?], {
    get: Spy<[string, unknown], unknown>;
    update: Spy<unknown[], void>;
  }>(() => ({
    get: createSpy<[string, unknown], unknown>((_key: string, defaultValue: unknown) => defaultValue),
    update: createSpy<unknown[], void>(),
  })),
  workspaceFolders: [] as unknown[],
};

export const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: 'file' as const }),
  parse: createSpy<[string], unknown>(),
};

export const ViewColumn = {
  One: 1,
};