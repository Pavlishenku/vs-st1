/**
 * Panneau « Rapport de l'etude » (webview).
 *
 * Photographie, a la demande, de la coherence de l'etude complete — meme
 * modele que le visualiseur (fichiers `LIRE` inclus, boucles deroulees). Le
 * serveur fait toute l'analyse (`st1/report`) ; la webview ne fait qu'afficher
 * le tableau et renvoyer les clics. Pas de recalcul a la frappe : le bouton
 * Rafraichir reprend la photographie.
 */

import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

export class StudyReportPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private source: vscode.Uri | undefined;
  /** Fichiers du dernier rapport (0 = fichier hote, puis les `LIRE`). */
  private files: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: () => LanguageClient | undefined,
    private readonly output: vscode.OutputChannel,
  ) {}

  async open(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== 'st1') {
      void vscode.window.showWarningMessage("Ouvrez un fichier .st1 pour etablir le rapport de l'etude.");
      return;
    }
    this.source = editor.document.uri;

    if (this.panel) {
      this.panel.reveal(undefined, true);
      await this.update();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'st1.report',
      "Rapport de l'etude",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      },
    );
    this.panel.webview.html = this.render(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(async (message: { type: string; line?: number; file?: number }) => {
      if (message.type === 'ready' || message.type === 'refresh') await this.update();
      if (message.type === 'reveal' && message.line !== undefined) await this.reveal(message.line, message.file);
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private async update(): Promise<void> {
    const client = this.client();
    if (!this.panel || !this.source || !client) return;
    try {
      // Le rapport suit le fichier ST1 actif au moment du rafraichissement.
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.languageId === 'st1') this.source = editor.document.uri;

      const report = await client.sendRequest('st1/report', { uri: this.source.toString() });
      this.files = (report as { files?: string[] } | null)?.files ?? [];
      await this.panel.webview.postMessage({
        type: 'report',
        report,
        source: this.source.path.split('/').pop(),
      });
      this.panel.title = `Rapport — ${this.source.path.split('/').pop()}`;
    } catch (error) {
      this.output.appendLine(`[rapport] ${(error as Error).message}`);
      await this.panel.webview.postMessage({ type: 'error', message: (error as Error).message });
    }
  }

  private async reveal(line: number, file?: number): Promise<void> {
    if (!this.source) return;
    const target = file && this.files[file] ? vscode.Uri.file(this.files[file]) : this.source;
    const document = await vscode.workspace.openTextDocument(target);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });
    const position = new vscode.Position(Math.max(0, line), 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  private render(webview: vscode.Webview): string {
    const nonce = createNonce();
    const media = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));

    return /* html */ `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${media('report.css')}" rel="stylesheet">
  <title>Rapport de l'etude</title>
</head>
<body>
  <header id="toolbar">
    <span id="title">Rapport de l'etude</span>
    <span class="spacer"></span>
    <output id="summary"></output>
    <button id="refresh" title="Reprendre la photographie de l'etude">Rafraichir</button>
  </header>
  <div id="inventory"></div>
  <main id="families"></main>
  <footer id="legend">
    <span class="ok">&#10003; conforme</span>
    <span class="warn">&#9888; a verifier</span>
    <span class="error">&#10007; non conforme</span>
    <span class="na">&mdash; non applicable</span>
    <span class="spacer"></span>
    <span>clic sur une ligne : aller a la definition</span>
  </footer>
  <script nonce="${nonce}" src="${media('report.js')}"></script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
  return nonce;
}
