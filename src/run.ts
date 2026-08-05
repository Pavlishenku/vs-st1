/**
 * Lancement du solveur ST1 et remontee de ses messages dans le panneau Problems.
 *
 * Deux particularites de ST1 gouvernent ce module :
 *
 * 1. **ST1 est interactif.** Apres avoir interprete le fichier de donnees, il
 *    affiche le prompt `>` et attend (manuel p.31). Un lancement « batch » qui
 *    se contente d'attendre la fin du process resterait donc bloque. On lance
 *    dans un vrai terminal, ou l'utilisateur voit le prompt et garde la main —
 *    et on propose `st1.autoQuit` pour envoyer `QUITTER` automatiquement.
 *
 * 2. **Les messages sont ecrits dans `erreur.txt`** (p.34), quel que soit le
 *    mode de lancement. On surveille donc ce fichier plutot que la sortie du
 *    process : les diagnostics apparaissent meme si le calcul a ete lance par
 *    double-clic, hors de VS Code.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';

interface St1Message {
  file?: string;
  line?: number;
  severity: vscode.DiagnosticSeverity;
  message: string;
}

let diagnostics: vscode.DiagnosticCollection;
let status: vscode.StatusBarItem;
let watcher: vscode.FileSystemWatcher | undefined;
let lastRunFile: vscode.Uri | undefined;

export function registerRunCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  diagnostics = vscode.languages.createDiagnosticCollection('st1-solveur');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'st1.showOutput';
  context.subscriptions.push(diagnostics, status);

  context.subscriptions.push(
    vscode.commands.registerCommand('st1.run', () => run(output)),
    vscode.commands.registerCommand('st1.clearSolverProblems', () => {
      diagnostics.clear();
      status.hide();
    }),
  );

  installWatcher(context, output);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('st1.errorFile')) installWatcher(context, output);
      if (event.affectsConfiguration('st1.solverPath')) refreshSolverCache();
    }),
  );
}

export function disposeRun(): void {
  watcher?.dispose();
  watcher = undefined;
}

// --------------------------------------------------------------------------
// Lancement
// --------------------------------------------------------------------------

async function run(output: vscode.OutputChannel): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId !== 'st1') {
    void vscode.window.showWarningMessage('Ouvrez un fichier .st1 pour lancer un calcul.');
    return;
  }

  const configuration = vscode.workspace.getConfiguration('st1');
  if (configuration.get<boolean>('saveBeforeRun', true) && editor.document.isDirty) {
    await editor.document.save();
  }

  const file = editor.document.uri.fsPath;
  const launch = resolveLaunch(configuration, file);
  if (!launch) {
    const choice = await vscode.window.showErrorMessage(
      "Executable ST1 introuvable : aucune installation CEREMA detectee aux emplacements habituels. " +
        "Renseignez « st1.solverPath » (chemin de ST1_v2_24.exe) ou « st1.runCommand ».",
      'Ouvrir les reglages',
    );
    if (choice) await vscode.commands.executeCommand('workbench.action.openSettings', 'st1.solverPath');
    return;
  }

  // Chemin resolu mais inexistant (faute de frappe, mauvaise version) : on le
  // dit clairement plutot que de laisser le terminal echouer sur « Path to shell
  // executable does not exist ».
  if (launch.kind === 'executable' && !fs.existsSync(launch.executable)) {
    const choice = await vscode.window.showErrorMessage(
      `Executable ST1 introuvable a ce chemin : ${launch.executable}. Corrigez « st1.solverPath ».`,
      'Ouvrir les reglages',
    );
    if (choice) await vscode.commands.executeCommand('workbench.action.openSettings', 'st1.solverPath');
    return;
  }

  // Le fichier ne se terminant pas par QUITTER laisse ST1 au prompt `>`.
  // ST1 reconnait QUITTER/QUIT/EXIT (st1.par, mot-cle 152) ; le nom de projet
  // eventuel qui suit est tolere.
  const text = editor.document.getText().toUpperCase();
  const quits = /(^|\n)\s*(QUIT(TER)?|EXIT)\b.*$/m.test(text);
  const autoQuit = configuration.get<boolean>('autoQuit', false);

  lastRunFile = editor.document.uri;
  diagnostics.delete(editor.document.uri);

  // On repart d'un terminal neuf : dans le mode « executable » ci-dessous, le
  // terminal EST le process ST1, il ne se reutilise donc pas.
  vscode.window.terminals.find((t) => t.name === 'ST1')?.dispose();

  let terminal: vscode.Terminal;
  if (launch.kind === 'executable') {
    // On lance ST1 directement comme process du terminal (shellPath/shellArgs) :
    // VS Code passe les arguments tels quels, sans les faire interpreter par un
    // shell. C'est ce qui evite l'echec sous PowerShell, ou une ligne commencant
    // par une chaine entre guillemets (`"…exe" fichier`) est prise pour une
    // expression et non pour une commande (« Unexpected token »).
    terminal = vscode.window.createTerminal({
      name: 'ST1',
      cwd: path.dirname(file),
      shellPath: launch.executable,
      shellArgs: launch.args,
    });
  } else {
    // Escape hatch « st1.runCommand » : ligne de commande complete, forcement
    // interpretee par le shell du terminal (l'utilisateur la redige pour son shell).
    terminal = vscode.window.createTerminal({ name: 'ST1', cwd: path.dirname(file) });
    terminal.sendText(launch.commandLine);
  }
  terminal.show(true);

  if (!quits && autoQuit) {
    // `QUITTER` demande un nom de projet : un retour chariot seul = pas de sauvegarde.
    terminal.sendText('QUITTER');
    terminal.sendText('');
  }

  output.appendLine(`[${stamp()}] Lancement : ${launch.display}`);
  status.text = '$(sync~spin) ST1 : calcul lance';
  status.tooltip = launch.display;
  status.show();

  if (!quits && !autoQuit) {
    void vscode.window.showInformationMessage(
      "ST1 affiche le prompt « > » et attend apres interpretation du fichier : tapez QUITTER dans le terminal pour terminer, ou activez le reglage « st1.autoQuit ».",
    );
  }
}

/**
 * Deux facons de lancer ST1 :
 *  - `executable` : chemin + arguments passes directement au process (aucun
 *    shell, aucune question de guillemets). C'est le mode par defaut.
 *  - `shell` : ligne de commande complete de `st1.runCommand`, interpretee par
 *    le shell du terminal.
 * Les deux portent `display`, la forme lisible affichee dans le journal.
 */
type Launch =
  | { kind: 'executable'; executable: string; args: string[]; display: string }
  | { kind: 'shell'; commandLine: string; display: string };

function resolveLaunch(configuration: vscode.WorkspaceConfiguration, file: string): Launch | undefined {
  const substitute = (value: string) =>
    value
      .replace(/\$\{file\}/g, file)
      .replace(/\$\{fileBasename\}/g, path.basename(file))
      .replace(/\$\{fileDirname\}/g, path.dirname(file))
      .replace(/\$\{workspaceFolder\}/g, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(file));

  const custom = configuration.get<string>('runCommand', '').trim();
  if (custom) {
    const commandLine = substitute(custom);
    return { kind: 'shell', commandLine, display: commandLine };
  }

  // Chemin explicite, sinon detection automatique d'une installation CEREMA
  // standard : l'extension n'oblige pas a renseigner le reglage quand ST1 est
  // installe a l'emplacement par defaut (ethos « zero configuration »).
  const solver = configuration.get<string>('solverPath', '').trim() || autodetectSolver();
  if (!solver) return undefined;

  // Un chemin colle depuis un terminal arrive souvent entoure de guillemets.
  // `shellPath` prend la chaine telle quelle (pas de shell pour les retirer) :
  // on les enleve, sinon VS Code cherche un fichier au nom entre guillemets.
  const executable = unquote(substitute(solver));
  const args = [...configuration.get<string[]>('solverArguments', []).map(substitute), file];
  const display = [quote(executable), ...args.map(quote)].join(' ');
  return { kind: 'executable', executable, args, display };
}

/** Retire une paire de guillemets simples ou doubles qui entoure toute la valeur. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed[trimmed.length - 1] === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Cherche l'executable ST1 aux emplacements d'installation habituels du CEREMA.
 * PSPad lance ST1 par « "..\ST1_vx_24.exe" "%File%" » (Parametrage_PsPad.txt) :
 * le fichier est un simple argument, ce que `buildCommand` reproduit. Ne reste
 * qu'a localiser l'executable. On retient la version la plus recente trouvee.
 *
 * `undefined` memorise l'echec pour ne pas rebalayer le disque a chaque calcul ;
 * `refreshSolverCache()` le reinitialise si le reglage change.
 */
let solverCache: string | null | undefined;

export function refreshSolverCache(): void {
  solverCache = undefined;
}

function autodetectSolver(): string | undefined {
  if (solverCache !== undefined) return solverCache ?? undefined;
  solverCache = null;

  const env = process.env;
  const roots = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
    env.ProgramW6432,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
  ].filter((value): value is string => Boolean(value));

  for (const root of roots) {
    const base = path.join(root, 'CEREMA');
    let versions: fs.Dirent[];
    try {
      versions = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue; // dossier CEREMA absent sous cette racine
    }
    // Repertoires « ST1 v2.24 », « ST1 v2.10 »… : la version la plus haute d'abord.
    const dirs = versions
      .filter((entry) => entry.isDirectory() && /^ST1/i.test(entry.name))
      .map((entry) => path.join(base, entry.name))
      .sort()
      .reverse();
    for (const dir of dirs) {
      const exe = findExecutable(dir);
      if (exe) {
        solverCache = exe;
        return exe;
      }
    }
  }
  return undefined;
}

/** Retient « ST1_v2_24.10.exe » et ecarte les utilitaires (Dinkey, desinstalleur). */
function findExecutable(dir: string): string | undefined {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const candidates = files
    .filter((name) => /^ST1.*\.exe$/i.test(name) && !/dinkey|unins/i.test(name))
    .sort()
    .reverse();
  return candidates.length ? path.join(dir, candidates[0]) : undefined;
}

function quote(value: string): string {
  return /\s/.test(value) && !value.startsWith('"') ? `"${value}"` : value;
}

// --------------------------------------------------------------------------
// Surveillance de erreur.txt
// --------------------------------------------------------------------------

function installWatcher(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  watcher?.dispose();
  const name = vscode.workspace.getConfiguration('st1').get<string>('errorFile', 'erreur.txt');
  const pattern = `**/{${name},${name.toUpperCase()}}`;
  watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const handle = (uri: vscode.Uri) => void ingest(uri, output);
  watcher.onDidCreate(handle);
  watcher.onDidChange(handle);
  context.subscriptions.push(watcher);
}

async function ingest(uri: vscode.Uri, output: vscode.OutputChannel): Promise<void> {
  let raw: string;
  try {
    raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('latin1');
  } catch {
    return;
  }

  const messages = parseErrorFile(raw);
  const grouped = new Map<string, vscode.Diagnostic[]>();

  for (const message of messages) {
    const target = await resolveTarget(message.file, uri);
    if (!target) continue;
    const key = target.toString();
    const list = grouped.get(key) ?? [];
    const line = Math.max(0, (message.line ?? 1) - 1);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
      message.message,
      message.severity,
    );
    diagnostic.source = 'ST1 (solveur)';
    list.push(diagnostic);
    grouped.set(key, list);
  }

  diagnostics.clear();
  for (const [key, list] of grouped) diagnostics.set(vscode.Uri.parse(key), list);

  const errors = messages.filter((m) => m.severity === vscode.DiagnosticSeverity.Error).length;
  const warnings = messages.length - errors;
  output.appendLine(`[${stamp()}] ${path.basename(uri.fsPath)} : ${errors} erreur(s), ${warnings} avertissement(s).`);

  status.text = errors
    ? `$(error) ST1 : ${errors} erreur(s)`
    : warnings
      ? `$(warning) ST1 : ${warnings} avertissement(s)`
      : '$(check) ST1 : aucune erreur';
  status.tooltip = `Derniere lecture de ${uri.fsPath}`;
  status.show();

  if (errors) await vscode.commands.executeCommand('workbench.action.problems.focus');
}

/**
 * Analyse `erreur.txt`. Format documente (p.34) et confirme sur un run reel
 * de ST1 v2.24 (specimen du 2026-08-04) — trois ecarts au manuel : les lignes
 * commencent par une espace, le chemin est absolu derriere le prompt `>`, et
 * l en-tete de ligne porte un suffixe libre (`action : 4 ---`) ; plusieurs
 * messages peuvent suivre un meme en-tete. Bloc type :
 *
 * ```
 * --- fichier : >f1
 * --- ligne : 101 ---
 * erreur : parentheses non apaires
 * ```
 *
 * `attention :` remplace `erreur :` pour un avertissement. Le nom de fichier est
 * precede du marqueur de prompt `>` de ST1. Les blocs incomplets sont tolerés :
 * un message sans en-tete est rattache au dernier fichier/ligne connus.
 */
export function parseErrorFile(raw: string): St1Message[] {
  const messages: St1Message[] = [];
  let file: string | undefined;
  let line: number | undefined;

  for (const text of raw.split(/\r?\n/)) {
    const fileMatch = /^\s*-{2,}\s*fichier\s*:\s*>*\s*(.+?)\s*-*\s*$/i.exec(text);
    if (fileMatch) {
      file = fileMatch[1];
      line = undefined;
      continue;
    }
    const lineMatch = /^\s*-{2,}\s*ligne\s*:\s*(\d+)\b.*$/i.exec(text);
    if (lineMatch) {
      line = Number(lineMatch[1]);
      continue;
    }
    const messageMatch = /^\s*(erreur|attention|avertissement)\s*:\s*(.+)$/i.exec(text);
    if (messageMatch) {
      messages.push({
        file,
        line,
        severity: /^erreur$/i.test(messageMatch[1])
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning,
        message: messageMatch[2].trim(),
      });
    }
  }
  return messages;
}

/** Retrouve le document source d'un message, sinon retombe sur le dernier lance. */
async function resolveTarget(file: string | undefined, errorFile: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (file) {
    const candidates = [
      vscode.Uri.file(path.isAbsolute(file) ? file : path.join(path.dirname(errorFile.fsPath), file)),
    ];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      candidates.push(vscode.Uri.joinPath(folder.uri, file));
    }
    for (const candidate of candidates) {
      try {
        await vscode.workspace.fs.stat(candidate);
        return candidate;
      } catch {
        // candidat suivant
      }
    }
    // Nom tronque par ST1 (ex. « >f1 ») : on retombe sur le fichier lance.
  }
  return lastRunFile;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}
