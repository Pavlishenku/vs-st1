/**
 * Serveur de langage ST1 (LSP), en TypeScript.
 *
 * Il tourne dans le Node.js embarque de VS Code : **aucune dependance externe**
 * n'est requise (ni Python, ni Docker). C'est une decision explicite contre le
 * principal defaut de VS Code Aster, ou l'environnement Python concentre
 * l'essentiel des incidents. Le protocole restant standard, ce serveur est
 * reutilisable dans Neovim, Emacs ou Theia.
 */

import {
  CodeAction,
  CodeActionKind,
  CompletionItem,
  CompletionItemKind,
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  DocumentLink,
  DocumentSymbol,
  InsertTextFormat,
  Location,
  MarkupKind,
  ParameterInformation,
  ProposedFeatures,
  Range,
  SignatureHelp,
  SignatureInformation,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
  TextEdit,
  type InitializeResult,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize as normalizeFsPath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import embeddedCatalog from '../../catalog/st1-catalog.json';
import {
  buildIndex,
  normalize,
  renderCommandDoc,
  type Catalog,
  type CatalogCommand,
  type CatalogIndex,
  type StructureOption,
} from '../../shared/catalog.js';
import { parse, blockAtLine, type ParsedDocument } from '../../shared/parser.js';
import { buildModel, type Model, type ResolvedInclude } from '../../shared/model.js';
import { buildStudyReport } from '../../shared/report.js';
import { validate, type St1Diagnostic, type ValidationLevel } from '../../shared/validate.js';
import { formatDocument } from '../../shared/format.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let index: CatalogIndex = buildIndex(embeddedCatalog as unknown as Catalog);
let settings = {
  validationEnabled: true,
  validationLevel: 'complet' as ValidationLevel,
  maxProblems: 500,
  catalogPath: '',
};

/** Cache d'analyse : une passe par version de document. */
const parsed = new Map<string, { version: number; document: ParsedDocument; diagnostics: St1Diagnostic[]; model: Model }>();

function analyse(document: TextDocument) {
  const cached = parsed.get(document.uri);
  if (cached && cached.version === document.version) return cached;
  const text = document.getText();
  const parsedDocument = parse(text, index);
  // Le modele suit les inclusions `LIRE` : il sert au visualiseur, a la
  // navigation et a la validation (une meme construction pour les trois).
  const model = buildModel(parsedDocument, {
    index,
    file: uriToPath(document.uri),
    resolve: resolveInclude,
  });
  const { diagnostics } = settings.validationEnabled
    ? validate(text, parsedDocument, index, { level: settings.validationLevel, maxProblems: settings.maxProblems, model })
    : { diagnostics: [] as St1Diagnostic[] };
  const entry = { version: document.version, document: parsedDocument, diagnostics, model };
  parsed.set(document.uri, entry);
  return entry;
}

// --------------------------------------------------------------------------
// Resolution des inclusions `LIRE 'fichier'`
// --------------------------------------------------------------------------

/** Taille maximale d'un fichier inclus : garde-fou contre un binaire egare. */
const MAX_INCLUDE_BYTES = 2 * 1024 * 1024;

function uriToPath(uri: string): string | undefined {
  if (!uri.startsWith('file:')) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

/** Comparaison de chemins tolerante a la casse et aux separateurs (Windows). */
function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalizeFsPath(a).toLowerCase() === normalizeFsPath(b).toLowerCase();
}

/**
 * Resout un `LIRE` relatif au fichier qui le contient. Le contenu d'un fichier
 * **ouvert dans l'editeur** prime sur le disque : le visualiseur suit ainsi les
 * modifications non enregistrees des fichiers inclus.
 */
function resolveInclude(file: string, fromFile: string): ResolvedInclude | null {
  const absolute = isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file);
  if (!absolute && !fromFile) return null;
  const target = absolute ? normalizeFsPath(file) : normalizeFsPath(join(dirname(fromFile), file));

  const open = documents.all().find((d) => samePath(uriToPath(d.uri), target));
  let text: string;
  if (open) {
    text = open.getText();
  } else {
    try {
      if (statSync(target).size > MAX_INCLUDE_BYTES) return null;
      text = readFileSync(target, 'utf8');
    } catch {
      return null;
    }
  }
  return { document: parse(text, index), file: target };
}

// --------------------------------------------------------------------------
// Cycle de vie
// --------------------------------------------------------------------------

connection.onInitialize((): InitializeResult => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: {
      resolveProvider: false,
      triggerCharacters: [' ', ',', '\n'],
    },
    hoverProvider: true,
    signatureHelpProvider: { triggerCharacters: [' ', ','] },
    documentSymbolProvider: true,
    definitionProvider: true,
    codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.SourceFixAll] },
    documentFormattingProvider: true,
    documentRangeFormattingProvider: true,
    documentLinkProvider: { resolveProvider: false },
  },
}));

connection.onInitialized(() => {
  void connection.client.register(DidChangeConfigurationNotification.type, undefined);
  void refreshSettings();
});

connection.onDidChangeConfiguration(() => {
  parsed.clear();
  void refreshSettings().then(() => {
    for (const document of documents.all()) publish(document);
  });
});

async function refreshSettings(): Promise<void> {
  try {
    const configuration = await connection.workspace.getConfiguration('st1');
    settings = {
      validationEnabled: configuration?.validation?.enabled ?? true,
      validationLevel: (configuration?.validation?.level ?? 'complet') as ValidationLevel,
      maxProblems: configuration?.validation?.maxProblems ?? 500,
      catalogPath: configuration?.catalogPath ?? '',
    };
    loadCatalog(settings.catalogPath);
  } catch {
    // Configuration indisponible (client minimal) : on garde les valeurs par defaut.
  }
}

function loadCatalog(path: string): void {
  if (!path) {
    index = buildIndex(embeddedCatalog as unknown as Catalog);
    return;
  }
  try {
    const catalog = JSON.parse(readFileSync(path, 'utf8')) as Catalog;
    index = buildIndex(catalog);
    connection.console.info(`Catalogue ST1 charge depuis ${path} (${catalog.commands.length} commandes).`);
  } catch (error) {
    connection.window.showWarningMessage(
      `Catalogue ST1 illisible (${path}) : ${(error as Error).message}. Le catalogue embarque est utilise.`,
    );
    index = buildIndex(embeddedCatalog as unknown as Catalog);
  }
}

documents.onDidChangeContent((event) => {
  // Les documents qui incluent le fichier modifie (`LIRE`) doivent etre
  // re-analyses : leur modele agrege depend de son contenu.
  const changed = uriToPath(event.document.uri);
  const dependents: TextDocument[] = [];
  if (changed) {
    for (const other of documents.all()) {
      if (other.uri === event.document.uri) continue;
      const entry = parsed.get(other.uri);
      if (entry?.model.files.some((f) => samePath(f, changed))) {
        parsed.delete(other.uri);
        dependents.push(other);
      }
    }
  }
  publish(event.document);
  for (const dependent of dependents) publish(dependent);
});
documents.onDidClose((event) => {
  parsed.delete(event.document.uri);
  void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

// Un fichier `.st1` modifie sur disque (hors editeur) peut etre inclus par un
// document ouvert : on re-analyse ce qui en depend.
connection.onDidChangeWatchedFiles((event) => {
  for (const change of event.changes) {
    const changed = uriToPath(change.uri);
    if (!changed) continue;
    for (const open of documents.all()) {
      const entry = parsed.get(open.uri);
      if (entry?.model.files.some((f) => samePath(f, changed))) {
        parsed.delete(open.uri);
        publish(open);
      }
    }
  }
});

const SEVERITY = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
} as const;

function publish(document: TextDocument): void {
  const { diagnostics } = analyse(document);
  const converted: Diagnostic[] = diagnostics.map((d) => ({
    range: clampRange(document, d.line, d.start, d.end),
    severity: SEVERITY[d.severity],
    code: d.code,
    source: 'ST1',
    message: d.pages?.length ? `${d.message}\n\nManuel ST1 v24, p.${d.pages.join(', ')}.` : d.message,
    data: d.fix,
  }));
  void connection.sendDiagnostics({ uri: document.uri, diagnostics: converted });
}

function clampRange(document: TextDocument, line: number, start: number, end: number): Range {
  const lineText = lineAt(document, line);
  const safeStart = Math.max(0, Math.min(start, lineText.length));
  const safeEnd = Math.max(safeStart, Math.min(end, lineText.length));
  return {
    start: { line, character: safeStart },
    end: { line, character: safeEnd === safeStart ? lineText.length || safeStart : safeEnd },
  };
}

function lineAt(document: TextDocument, line: number): string {
  return document.getText({ start: { line, character: 0 }, end: { line, character: Number.MAX_SAFE_INTEGER } });
}

// --------------------------------------------------------------------------
// Completion contextuelle
// --------------------------------------------------------------------------

connection.onCompletion((params): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const { document: parsedDocument } = analyse(document);
  const line = lineAt(document, params.position.line);
  const before = line.slice(0, params.position.character);
  const option = parsedDocument.option;
  const block = blockAtLine(parsedDocument, params.position.line);

  // Position de commande : debut de ligne, ou juste apres un `;`.
  const atCommandStart = /(^|;)\s*[A-Za-z_]*$/.test(before);

  if (atCommandStart) {
    const items: CompletionItem[] = [];
    if (block && !block.closed) {
      for (const sub of index.byBlock.get(block.name) ?? []) {
        if (option && sub.restrictedToOptions?.length && !sub.restrictedToOptions.includes(option)) continue;
        items.push(commandItem(sub, option, CompletionItemKind.Field));
      }
      if (block.terminator) {
        items.push({
          label: block.terminator,
          kind: CompletionItemKind.Keyword,
          detail: `Ferme le bloc ${block.name}`,
          sortText: '0_' + block.terminator,
        });
      }
    }
    for (const command of index.topLevel) {
      if (option && command.restrictedToOptions?.length && !command.restrictedToOptions.includes(option)) continue;
      items.push(commandItem(command, option, CompletionItemKind.Function));
    }
    return items;
  }

  // A l'interieur d'une instruction : proposer les arguments de la commande.
  const words = keywordsOf(before);
  const match = findCommand(words, block?.name);
  if (!match) return [];

  const previous = words[words.length - 1];
  const args = (match.args ?? []).filter((a) => !option || !a.onlyOptions?.length || a.onlyOptions.includes(option));

  // Juste apres un mot-cle a valeurs enumerees : proposer ces valeurs.
  const keywordArg = args.find((a) => a.name.toUpperCase() === previous && a.values?.length);
  if (keywordArg) {
    return keywordArg.values!.map((value) => ({
      label: value,
      kind: CompletionItemKind.EnumMember,
      detail: `${match.name} ${keywordArg.name}`,
      documentation: keywordArg.doc,
      insertText: value + ' ',
      // Cascade : accepter une valeur rouvre la liste pour la suite de la commande.
      command: RETRIGGER,
    }));
  }

  return args.map((arg) => ({
    label: arg.name,
    kind: arg.kind === 'flag' ? CompletionItemKind.Keyword : CompletionItemKind.Property,
    detail: argumentDetail(arg),
    documentation: { kind: MarkupKind.Markdown, value: arg.doc },
    sortText: (arg.required ? '0_' : '1_') + arg.name,
    insertText: arg.name + ' ',
    // Cascade : un argument a valeurs enumerees enchaine directement sur elles.
    command: RETRIGGER,
  }));
});

/**
 * Rouvre la liste de suggestions apres l'insertion d'un element : l'ecriture
 * s'enchaine (commande -> arguments -> valeurs) sans rappeler Ctrl+Espace.
 * VS Code execute cette commande cote client apres l'insertion du texte.
 */
const RETRIGGER = { title: 'Suggestions', command: 'editor.action.triggerSuggest' };

function commandItem(command: CatalogCommand, option: StructureOption | null, kind: CompletionItemKind): CompletionItem {
  const snippet = commandSnippet(command);
  return {
    label: command.name,
    kind,
    detail: command.summary,
    documentation: { kind: MarkupKind.Markdown, value: renderCommandDoc(command, { option: option ?? undefined }) },
    insertText: snippet,
    insertTextFormat: snippet.includes('$') ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
    filterText: command.name,
    sortText: '1_' + command.name,
    // Cascade : accepter la commande ouvre aussitot la liste de ses arguments.
    command: RETRIGGER,
  };
}

/** Insere le squelette du bloc quand la commande en ouvre un. */
function commandSnippet(command: CatalogCommand): string {
  if (!command.terminator) return command.name + ' ';
  return `${command.name} \${1}\n\t\${0}\n${command.terminator}`;
}

function argumentDetail(arg: { type?: string; unit?: string; default?: string; required?: boolean }): string {
  const bits: string[] = [];
  if (arg.type) bits.push(arg.type);
  if (arg.unit) bits.push(`[${arg.unit}]`);
  if (arg.default !== undefined) bits.push(`defaut ${arg.default}`);
  if (arg.required === false) bits.push('optionnel');
  return bits.join(' · ');
}

/**
 * Mots-cles d'une portion de ligne, en MAJUSCULES, valeurs numeriques exclues.
 * Une commande composee peut etre coupee par un nombre (`GENER 5 NOEUD`) :
 * il faut donc retirer les valeurs avant de chercher le nom de la commande.
 */
function keywordsOf(text: string): string[] {
  return (text.replace(/'[^']*'/g, ' ').match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).map((w) => w.toUpperCase());
}

function findCommand(words: string[], block?: string): CatalogCommand | undefined {
  for (let n = Math.min(index.maxCommandWords, words.length); n >= 1; n--) {
    const key = normalize(words.slice(0, n).join(' '));
    if (block) {
      const sub = (index.byBlock.get(block) ?? []).find((c) => normalize(c.name) === key);
      if (sub) return sub;
    }
    const global = index.byName.get(key);
    if (global) return global;
  }
  return undefined;
}

// --------------------------------------------------------------------------
// Survol
// --------------------------------------------------------------------------

connection.onHover((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const { document: parsedDocument } = analyse(document);
  const statement = parsedDocument.statements.find(
    (s) => s.line <= params.position.line && params.position.line <= s.endLine,
  );
  if (!statement) return null;

  const token = statement.tokens.find(
    (t) => t.line === params.position.line && t.start <= params.position.character && params.position.character <= t.end,
  );

  // Survol d'un argument documente.
  if (token?.kind === 'word' && statement.command) {
    const arg = (statement.command.args ?? []).find((a) => a.name.toUpperCase() === token.value);
    if (arg && !isPartOfCommandName(statement, token.value)) {
      const bits: string[] = [`### \`${arg.name}\``, '', arg.doc];
      const detail = argumentDetail(arg);
      if (detail) bits.push('', `*${detail}*`);
      if (arg.values?.length) bits.push('', `Valeurs : \`${arg.values.join('`, `')}\``);
      if (arg.onlyOptions?.length) bits.push('', `Disponible en \`OPTION ${arg.onlyOptions.join('` / `')}\` uniquement.`);
      if (arg.pages?.length) bits.push('', `*Manuel ST1 v24, p.${arg.pages.join(', ')}*`);
      bits.push('', '---', '', `Argument de \`${statement.command.name}\`.`);
      return { contents: { kind: MarkupKind.Markdown, value: bits.join('\n') } };
    }
  }

  if (!statement.command) return null;
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: renderCommandDoc(statement.command, { option: parsedDocument.option ?? undefined }),
    },
  };
});

function isPartOfCommandName(statement: { words: string[]; keywordWords: number }, word: string): boolean {
  return statement.words.slice(0, statement.keywordWords).includes(word);
}

// --------------------------------------------------------------------------
// Signatures
// --------------------------------------------------------------------------

connection.onSignatureHelp((params): SignatureHelp | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const { document: parsedDocument } = analyse(document);
  const line = lineAt(document, params.position.line);
  const before = line.slice(0, params.position.character);
  const block = blockAtLine(parsedDocument, params.position.line);
  const words = keywordsOf(before);
  const command = findCommand(words, block?.name);
  if (!command) return null;

  const option = parsedDocument.option;
  const args = (command.args ?? []).filter((a) => !option || !a.onlyOptions?.length || a.onlyOptions.includes(option));
  const label = command.syntax[0] ?? `${command.name} ${args.map((a) => a.name).join(' ')}`;

  const parameters: ParameterInformation[] = args.map((arg) => ({
    label: arg.name,
    documentation: { kind: MarkupKind.Markdown, value: `${arg.doc}${argumentDetail(arg) ? `\n\n*${argumentDetail(arg)}*` : ''}` },
  }));

  // Parametre actif : dernier mot-cle reconnu, sinon position dans la liste.
  let active = 0;
  for (let i = words.length - 1; i >= 0; i--) {
    const found = args.findIndex((a) => a.name.toUpperCase() === words[i]);
    if (found >= 0) {
      active = found;
      break;
    }
  }

  const signature: SignatureInformation = {
    label,
    documentation: { kind: MarkupKind.Markdown, value: command.summary },
    parameters,
  };
  return { signatures: [signature], activeSignature: 0, activeParameter: active };
});

// --------------------------------------------------------------------------
// Plan du document
// --------------------------------------------------------------------------

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const { document: parsedDocument } = analyse(document);
  const symbols: DocumentSymbol[] = [];

  const kindOf = (name: string): SymbolKind => {
    if (['NOEUD', 'BARRE', 'APPUI', 'GENER NOEUD', 'GENER BARRE'].includes(name)) return SymbolKind.Struct;
    if (['MAT', 'MATERIAU', 'CONS', 'CARA'].includes(name)) return SymbolKind.Class;
    if (name.startsWith('EXEC')) return SymbolKind.Event;
    if (['CHARG', 'SURCH', 'PHASAGE', 'COMB', 'ENV'].includes(name)) return SymbolKind.Namespace;
    return SymbolKind.Function;
  };

  const covered: number[] = [];
  for (const block of parsedDocument.blocks) {
    if (block.depth > 0) continue;
    const title = block.statements[0]?.tokens.find((t) => t.kind === 'string')?.value;
    symbols.push({
      name: title ? `${block.name} — ${title}` : block.name,
      detail: block.command?.summary,
      kind: kindOf(block.name),
      range: fullRange(document, block.startLine, block.endLine),
      selectionRange: fullRange(document, block.startLine, block.startLine),
      children: block.statements
        .filter((s) => s.command && s.line !== block.startLine)
        .map((s) => ({
          name: s.command!.name,
          detail: s.text.slice(0, 60),
          kind: SymbolKind.Field,
          range: fullRange(document, s.line, s.endLine),
          selectionRange: fullRange(document, s.line, s.line),
        })),
    });
    covered.push(block.startLine, block.endLine);
  }

  for (const statement of parsedDocument.topLevel) {
    if (!statement.command || statement.command.terminator) continue;
    symbols.push({
      name: statement.text.slice(0, 70),
      detail: statement.command.summary,
      kind: kindOf(statement.keyword ?? ''),
      range: fullRange(document, statement.line, statement.endLine),
      selectionRange: fullRange(document, statement.line, statement.line),
    });
  }

  return symbols.sort((a, b) => a.range.start.line - b.range.start.line);
});

function fullRange(document: TextDocument, startLine: number, endLine: number): Range {
  return {
    start: { line: startLine, character: 0 },
    end: { line: endLine, character: lineAt(document, endLine).length },
  };
}

// --------------------------------------------------------------------------
// Aller a la definition : numero de noeud / de barre -> sa declaration
// --------------------------------------------------------------------------

connection.onDefinition((params): Location[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const { document: parsedDocument, model } = analyse(document);
  const statement = parsedDocument.statements.find(
    (s) => s.line <= params.position.line && params.position.line <= s.endLine,
  );
  if (!statement) return [];
  const token = statement.tokens.find(
    (t) => t.line === params.position.line && t.start <= params.position.character && params.position.character <= t.end,
  );
  if (!token || token.kind !== 'number') return [];

  const value = Math.round(Number(token.text));
  const targets: { line: number; file: number }[] = [];
  const keyword = statement.keyword ?? '';

  if (keyword === 'BARRE' || keyword === 'APPUI' || statement.blockPath.length) {
    const node = model.nodes.get(value);
    if (node) targets.push(node);
  }
  const bar = model.bars.get(value);
  if (bar && ['CARA', 'CONS', 'ETUDE', 'EXC', 'ART', 'BETA'].includes(keyword)) targets.push(bar);

  // Un element defini dans un fichier inclus par `LIRE` renvoie vers ce fichier.
  return targets.map((target) => ({
    uri: target.file === 0 ? params.textDocument.uri : pathToFileURL(model.files[target.file]).toString(),
    range:
      target.file === 0
        ? fullRange(document, target.line, target.line)
        : { start: { line: target.line, character: 0 }, end: { line: target.line, character: 200 } },
  }));
});

// --------------------------------------------------------------------------
// Fichiers inclus : `LIRE 'pont.st1'` devient cliquable
// --------------------------------------------------------------------------

connection.onDocumentLinks((params): DocumentLink[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const { document: parsedDocument } = analyse(document);
  const base = params.textDocument.uri.replace(/\/[^/]*$/, '/');
  const links: DocumentLink[] = [];

  for (const statement of parsedDocument.statements) {
    // `LIRE` inclut un fichier de donnees ; `PROJET` relit une base de projet.
    if (statement.keyword !== 'LIRE' && statement.keyword !== 'PROJET') continue;
    for (const token of statement.tokens) {
      if (token.kind !== 'string' || !token.value.trim()) continue;
      links.push({
        range: {
          start: { line: token.line, character: token.start + 1 },
          end: { line: token.line, character: Math.max(token.start + 1, token.end - 1) },
        },
        target: /^[A-Za-z]:[\\/]|^[\\/]/.test(token.value)
          ? `file:///${token.value.replace(/\\/g, '/')}`
          : base + encodeURI(token.value.replace(/\\/g, '/')),
        tooltip: `Ouvrir ${token.value}`,
      });
    }
  }
  return links;
});

// --------------------------------------------------------------------------
// Correctifs rapides
// --------------------------------------------------------------------------

connection.onCodeAction((params): CodeAction[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const { diagnostics } = analyse(document);
  const actions: CodeAction[] = [];

  const inRange = diagnostics.filter(
    (d) => d.fix && d.line >= params.range.start.line && d.line <= params.range.end.line,
  );

  for (const diagnostic of inRange) {
    actions.push(makeAction(document, diagnostic.fix!.title, diagnostic.fix!.edits, params.textDocument.uri));
  }

  // Correctif global pour les regles lexicales, toujours sures a appliquer.
  const bulkCodes = new Set(inRange.filter((d) => d.fix?.bulk).map((d) => d.code));
  for (const code of bulkCodes) {
    const all = diagnostics.filter((d) => d.code === code && d.fix);
    if (all.length < 2) continue;
    actions.push({
      ...makeAction(document, `${all[0].fix!.title} — tout le fichier (${all.length})`, all.flatMap((d) => d.fix!.edits), params.textDocument.uri),
      kind: CodeActionKind.SourceFixAll,
    });
  }

  return actions;
});

interface EditData {
  line: number;
  start: number;
  end: number;
  newText: string;
}

function makeAction(document: TextDocument, title: string, edits: EditData[], uri: string): CodeAction {
  const textEdits: TextEdit[] = edits.map((edit) => {
    const length = lineAt(document, edit.line).length;
    return {
      range: {
        start: { line: edit.line, character: Math.min(edit.start, length) },
        end: { line: edit.line, character: Math.min(edit.end, length) },
      },
      newText: edit.newText,
    };
  });
  return {
    title,
    kind: CodeActionKind.QuickFix,
    edit: { changes: { [uri]: textEdits } },
  };
}

// --------------------------------------------------------------------------
// Formatage
// --------------------------------------------------------------------------

connection.onDocumentFormatting((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const { document: parsedDocument } = analyse(document);
  const formatted = formatDocument(document.getText(), parsedDocument, {
    indent: params.options.insertSpaces ? ' '.repeat(params.options.tabSize) : '\t',
  });
  if (formatted === document.getText()) return [];
  return [TextEdit.replace(fullRange(document, 0, document.lineCount - 1), formatted)];
});

connection.onDocumentRangeFormatting((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const { document: parsedDocument } = analyse(document);
  const formatted = formatDocument(document.getText(), parsedDocument, {
    indent: params.options.insertSpaces ? ' '.repeat(params.options.tabSize) : '\t',
    fromLine: params.range.start.line,
    toLine: params.range.end.line,
  });
  if (formatted === document.getText()) return [];
  return [TextEdit.replace(fullRange(document, 0, document.lineCount - 1), formatted)];
});

// --------------------------------------------------------------------------
// Requetes personnalisees : modele pour le visualiseur, catalogue pour l'arbre
// --------------------------------------------------------------------------

connection.onRequest('st1/model', (params: { uri: string }) => {
  const document = documents.get(params.uri);
  if (!document) return null;
  const { model } = analyse(document);

  // Fiche par barre pour l'infobulle du visualiseur : caracteristiques RDM,
  // constantes physiques, materiau, articulations. Seules les barres dotees
  // d'au moins une information figurent dans la table.
  const barDetails: Record<number, Record<string, unknown>> = {};
  for (const id of model.bars.keys()) {
    const cara = model.caraByBar.get(id);
    const constants = model.constantsByBar.get(id);
    const material = constants?.material !== undefined ? model.materials.get(constants.material) : undefined;
    const articulation = model.articulations.get(id);
    const detail: Record<string, unknown> = {};
    if (cara) {
      // `undefined` disparaitrait a la serialisation JSON : `null` signale une
      // propriete presente mais sans valeur evaluable (`CARA VAR`, variable…).
      detail.cara = Object.fromEntries([...cara.props].map(([name, value]) => [name, value ?? null]));
      if (cara.pse) detail.pse = true;
      if (cara.variable) detail.variable = true;
    }
    if (constants?.values.size) detail.cons = Object.fromEntries(constants.values);
    if (constants?.material !== undefined) {
      detail.mat = { id: constants.material, title: material?.title };
    }
    if (articulation && (articulation.or.length || articulation.ex.length)) detail.art = articulation;
    if (Object.keys(detail).length) barDetails[id] = detail;
  }

  const unresolvedBars = [...model.bars.values()].filter(
    (bar) => !model.nodes.has(bar.from) || !model.nodes.has(bar.to),
  ).length;

  return {
    option: model.option,
    nodes: [...model.nodes.values()],
    bars: [...model.bars.values()],
    supports: model.supports,
    articulations: [...model.articulations.entries()].map(([bar, ddl]) => ({ bar, ...ddl })),
    eccentric: [...model.eccentric],
    loadedBars: [...model.loadedBars],
    deckBars: model.deckBars,
    cables: model.cables,
    phasages: model.phasages,
    barDetails,
    files: model.files,
    includes: model.includes,
    truncated: model.truncated,
    bounds: model.bounds,
    counts: {
      nodes: model.nodes.size,
      bars: model.bars.size,
      supports: model.supports.length,
      materials: model.materials.size,
      cables: model.cables.length,
      unresolvedBars,
    },
  };
});

connection.onRequest('st1/catalog', () => index.catalog);

// Rapport de coherence de l'etude : meme analyse en cache que le visualiseur.
connection.onRequest('st1/report', (params: { uri: string }) => {
  const document = documents.get(params.uri);
  if (!document) return null;
  const { document: parsedDocument, model } = analyse(document);
  return buildStudyReport(parsedDocument, model);
});

documents.listen(connection);
connection.listen();
