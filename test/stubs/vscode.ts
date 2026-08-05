/**
 * Doublure minimale du module `vscode` pour les tests unitaires du code de
 * l'extension host (`src/`). Ce module n'existe qu'a l'interieur de VS Code :
 * sans doublure, tout fichier qui l'importe est intestable par `node --test`.
 *
 * Philosophie : n'implementer que les **valeurs** que le code pur construit
 * (enums, `Uri`, `Range`, `Diagnostic`...). Tout ce qui n'est pas exerce par un
 * chemin teste peut rester absent — completer au fil des besoins, pas d'avance.
 * L'alias est pose par `scripts/build.mjs` sur le bundle de tests uniquement.
 */

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ViewColumn {
  One = 1,
  Two = 2,
  Beside = -2,
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;
  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b as number);
      this.end = new Position(c!, d!);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
}

export class Diagnostic {
  source?: string;
  code?: string | number;
  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity = DiagnosticSeverity.Error,
  ) {}
}

export class Selection extends Range {}

/** Uri simplifie : suffisant pour `fsPath`, `toString()` et les cles de Map. */
export class Uri {
  private constructor(public readonly fsPath: string) {}
  static file(path: string): Uri {
    return new Uri(path);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri([base.fsPath, ...segments].join('/'));
  }
  static parse(value: string): Uri {
    return new Uri(value.replace(/^file:\/\/\/?/, ''));
  }
  get path(): string {
    return this.fsPath.replace(/\\/g, '/');
  }
  toString(): string {
    return 'file:///' + this.path;
  }
}

export class EventEmitter<T> {
  private readonly listeners: ((value: T) => void)[] = [];
  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => void 0 };
  };
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
  dispose(): void {}
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export class TreeItem {
  constructor(
    public label: string,
    public collapsibleState?: TreeItemCollapsibleState,
  ) {}
}

export class MarkdownString {
  constructor(public value = '') {}
}

export class SnippetString {
  constructor(public value = '') {}
}

const noop = () => undefined;
const disposable = { dispose: noop };

export const workspace = {
  getConfiguration: () => ({
    get: (_key: string, fallback?: unknown) => fallback,
    update: noop,
  }),
  workspaceFolders: undefined as undefined,
  onDidChangeConfiguration: () => disposable,
  onDidChangeTextDocument: () => disposable,
  createFileSystemWatcher: () => ({ ...disposable, onDidCreate: noop, onDidChange: noop, onDidDelete: noop }),
  fs: { stat: async () => ({}) },
};

export const window = {
  activeTextEditor: undefined as undefined,
  createStatusBarItem: () => ({ ...disposable, show: noop, hide: noop, text: '', tooltip: '', command: '' }),
  createOutputChannel: () => ({ ...disposable, appendLine: noop, append: noop, show: noop }),
  showErrorMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  onDidChangeActiveTextEditor: () => disposable,
  onDidChangeTextEditorSelection: () => disposable,
  terminals: [] as unknown[],
};

export const languages = {
  createDiagnosticCollection: () => ({
    ...disposable,
    set: noop,
    delete: noop,
    clear: noop,
  }),
  getDiagnostics: () => [],
};

export const commands = {
  registerCommand: () => disposable,
  executeCommand: async () => undefined,
};
