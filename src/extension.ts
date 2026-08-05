/**
 * Point d'entree de l'extension VS ST1 (extension host).
 *
 * Responsabilites : demarrer le serveur de langage, exposer les commandes,
 * lancer le solveur et remonter ses erreurs, ouvrir le visualiseur de modele.
 */

import * as vscode from 'vscode';
import {
  LanguageClient,
  RevealOutputChannelOn,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';

import { registerRunCommand, disposeRun } from './run';
import { ModelViewer } from './viewer';
import { StudyReportPanel } from './report';
import { CommandTreeProvider, ModelTreeProvider } from './tree';

let client: LanguageClient | undefined;
let output: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('VS ST1');
  context.subscriptions.push(output);
  output.appendLine(`[${stamp()}] VS ST1 active.`);

  await startClient(context);

  const viewer = new ModelViewer(context, () => client, output);
  context.subscriptions.push(viewer);

  const report = new StudyReportPanel(context, () => client, output);
  context.subscriptions.push(report);

  const commandTree = new CommandTreeProvider(() => client);
  const modelTree = new ModelTreeProvider(() => client);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('st1.commands', commandTree),
    vscode.window.registerTreeDataProvider('st1.model', modelTree),
  );

  registerRunCommand(context, output);

  context.subscriptions.push(
    vscode.commands.registerCommand('st1.openViewer', () => viewer.open()),

    vscode.commands.registerCommand('st1.studyReport', () => report.open()),

    vscode.commands.registerCommand('st1.showOutput', () => output.show(true)),

    vscode.commands.registerCommand('st1.restartServer', async () => {
      if (!client) {
        await startClient(context);
        return;
      }
      await client.restart();
      commandTree.refresh();
      void vscode.window.showInformationMessage('Serveur de langage ST1 redemarre.');
    }),

    vscode.commands.registerCommand('st1.validate', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.languageId !== 'st1') {
        void vscode.window.showWarningMessage('Ouvrez un fichier .st1 pour lancer la validation.');
        return;
      }
      // Les diagnostics sont deja publies a la frappe : la commande sert a les
      // remonter explicitement et a resumer l'etat de l'etude.
      await vscode.commands.executeCommand('workbench.action.problems.focus');
      const found = vscode.languages.getDiagnostics(editor.document.uri);
      const errors = found.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
      const warnings = found.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length;
      const message = errors
        ? `Etude non conforme : ${errors} erreur(s), ${warnings} avertissement(s).`
        : warnings
          ? `Etude coherente, ${warnings} avertissement(s) a verifier.`
          : 'Etude coherente : aucune anomalie detectee.';
      if (errors) void vscode.window.showErrorMessage(message);
      else void vscode.window.showInformationMessage(message);
    }),

    vscode.commands.registerCommand('st1.insertCommand', () => insertFromCatalog()),

    vscode.commands.registerCommand('st1.insertCommandByName', (command: CatalogCommandLike) =>
      insertSkeleton(command),
    ),

    vscode.commands.registerCommand('st1.newStudy', () => createStudyFromTemplate()),

    vscode.commands.registerCommand('st1.revealLine', (line: number) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const position = new vscode.Position(Math.max(0, line), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }),
  );

  const refresh = () => modelTree.refresh();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId === 'st1') refresh();
    }),
  );
}

export async function deactivate(): Promise<void> {
  disposeRun();
  await client?.stop();
}

// --------------------------------------------------------------------------
// Serveur de langage
// --------------------------------------------------------------------------

async function startClient(context: vscode.ExtensionContext): Promise<void> {
  const module = context.asAbsolutePath('dist/server.js');
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: {
      module,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6019'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'st1' }, { scheme: 'untitled', language: 'st1' }],
    synchronize: {
      configurationSection: 'st1',
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{st1,ST1}'),
    },
    outputChannel: output,
    // Une erreur du serveur ne doit pas passer inapercue : sur une extension de
    // ce type, l'essentiel des incidents vient du serveur, pas des fonctions.
    revealOutputChannelOn: RevealOutputChannelOn.Error,
  };

  client = new LanguageClient('st1', 'Serveur de langage ST1', serverOptions, clientOptions);

  try {
    await client.start();
    output.appendLine(`[${stamp()}] Serveur de langage demarre.`);
  } catch (error) {
    client = undefined;
    output.appendLine(`[${stamp()}] Echec du demarrage du serveur : ${(error as Error).message}`);
    const choice = await vscode.window.showErrorMessage(
      "Le serveur de langage ST1 n'a pas demarre. La coloration reste active, mais la completion et les diagnostics sont indisponibles.",
      'Voir le journal',
      'Reessayer',
    );
    if (choice === 'Voir le journal') output.show(true);
    if (choice === 'Reessayer') await startClient(context);
  }
}

// --------------------------------------------------------------------------
// Commandes utilitaires
// --------------------------------------------------------------------------

interface CatalogCommandLike {
  name: string;
  summary: string;
  family: string;
  syntax: string[];
  terminator?: string;
}

interface CatalogLike {
  commands: CatalogCommandLike[];
}

async function insertFromCatalog(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!client || editor?.document.languageId !== 'st1') {
    void vscode.window.showWarningMessage('Ouvrez un fichier .st1 pour inserer une commande.');
    return;
  }
  const catalog = (await client.sendRequest('st1/catalog')) as CatalogLike;
  const pick = await vscode.window.showQuickPick(
    catalog.commands.map((command) => ({
      label: command.name,
      description: command.family,
      detail: command.summary,
      command,
    })),
    { placeHolder: 'Commande ST1 a inserer', matchOnDetail: true },
  );
  if (pick) await insertSkeleton(pick.command);
}

async function insertSkeleton(command: CatalogCommandLike): Promise<void> {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'st1');
  if (!editor) {
    void vscode.window.showWarningMessage('Ouvrez un fichier .st1 pour inserer une commande.');
    return;
  }
  await vscode.window.showTextDocument(editor.document, editor.viewColumn);
  const skeleton = command.terminator
    ? `${command.name} \${1}\n\t\${0}\n${command.terminator}\n`
    : `${command.syntax[0] ?? command.name}\n`;
  await editor.insertSnippet(new vscode.SnippetString(skeleton));
}

const TEMPLATES: Record<string, string> = {
  'Poutre isostatique (PLANE)': `# Etude ST1 - poutre sur deux appuis
OPTION PLANE
TITRE 'Poutre isostatique'

# --- Geometrie
NOEUD 1 0. 0.
NOEUD 2 10. 0.
BARRE 1 DE 1 A 2

APPUI 1 NOEUD 1 DX DY
APPUI 2 NOEUD 2 DY

# --- Caracteristiques et materiau
CARA 1 SX 0.5 IZ 0.0417 VY 0.25 WY 0.25
CONS 1 E 3.5e10 NU 0.2 RO 25000.

# --- Sections d'etude
ETUDE EFFORT DEPLA
   TOUT SE 0. a 1. PAS 1/10 REL

# --- Chargement
CHARG 1 'Poids propre'
   POIDS PROPRE TOUT
FIN

EXEC CHARG

RESU
   BARRE EFFORT DEPLA CONTR
FIN
`,
  'Portique plan (PLANE)': `# Etude ST1 - portique plan
OPTION PLANE
TITRE 'Portique'

NOEUD 1 0. 0.
NOEUD 2 0. 6.
NOEUD 3 12. 6.
NOEUD 4 12. 0.

BARRE 1 DE 1 A 2
BARRE 2 DE 2 A 3
BARRE 3 DE 3 A 4

APPUI 1 NOEUD 1 DX DY RZ
APPUI 2 NOEUD 4 DX DY RZ

CARA TOUT SX 0.12 IZ 2.4e-3 VY 0.2 WY 0.2
CONS TOUT E 2.1e11 NU 0.3 RO 78500.

ETUDE EFFORT DEPLA
   TOUT SE 0. a 1. PAS 1/10 REL

CHARG 1 'Charge repartie sur la traverse'
   POIDS PROPRE TOUT
   BARRE
      2 UNI FY -15000. GLO
FIN

EXEC CHARG

RESU
   BARRE EFFORT DEPLA
FIN
`,
  'Grillage de poutres (GRILL)': `# Etude ST1 - grillage de poutres
OPTION GRILL
TITRE 'Grillage'

# En GRILL les coordonnees restent x,y ; les DDL sont RX, DZ, RY
# et le POIDS PROPRE n'est pas disponible.
NOEUD 1 0. 0.
NOEUD 2 10. 0.
BARRE 1 DE 1 A 2

APPUI 1 NOEUD 1 DZ RX
APPUI 2 NOEUD 2 DZ

CARA 1 SZ 0.4 IX 1.2e-3 IY 0.02 VZ 0.25 WZ 0.25
CONS 1 E 3.5e10 NU 0.2

ETUDE EFFORT DEPLA
   TOUT SE 0. a 1. PAS 1/10 REL

CHARG 1 'Charge verticale'
   BARRE
      1 UNI FZ -20000. GLO
FIN

EXEC CHARG

RESU
   BARRE EFFORT DEPLA
FIN
`,
};

async function createStudyFromTemplate(): Promise<void> {
  const pick = await vscode.window.showQuickPick(Object.keys(TEMPLATES), {
    placeHolder: "Modele d'etude ST1",
  });
  if (!pick) return;
  const document = await vscode.workspace.openTextDocument({ language: 'st1', content: TEMPLATES[pick] });
  await vscode.window.showTextDocument(document);
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}
