/**
 * Visualiseur du modele ST1 (webview).
 *
 * Un modele ST1 n'est fait que d'elements 1D et il est **entierement decrit
 * dans le fichier texte** : il n'y a donc ni maillage a convertir, ni fichier
 * binaire intermediaire, ni bibliotheque de rendu scientifique a embarquer. Le
 * rendu se fait au canvas 2D avec une projection orthographique — quelques
 * centaines de lignes, aucune dependance, et surtout un rafraichissement **a la
 * frappe** : le dessin suit le texte en cours d'edition.
 */

import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

export class ModelViewer implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private source: vscode.Uri | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** Fichiers du dernier modele recu (0 = fichier hote, puis les `LIRE`). */
  private files: string[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: () => LanguageClient | undefined,
    private readonly output: vscode.OutputChannel,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        // Tout fichier ST1 peut etre inclus par le fichier visualise (`LIRE`) :
        // on rafraichit des qu'un document ST1 change, le serveur fait le tri.
        if (event.document.languageId === 'st1') this.scheduleUpdate();
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === 'st1') {
          this.source = editor.document.uri;
          this.scheduleUpdate();
        }
      }),
      // Synchronisation editeur -> dessin : l'element defini a la ligne du
      // curseur se surligne dans le visualiseur.
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor.document.languageId !== 'st1') return;
        this.sendCursor(event.textEditor);
      }),
    );
  }

  /** Index du document dans les fichiers du modele (0 = fichier hote). */
  private fileIndexOf(document: vscode.TextDocument): number {
    const path = document.uri.fsPath.replace(/\\/g, '/').toLowerCase();
    return this.files.findIndex((f) => f.replace(/\\/g, '/').toLowerCase() === path);
  }

  private sendCursor(editor: vscode.TextEditor): void {
    if (!this.panel) return;
    const file = this.fileIndexOf(editor.document);
    if (file < 0) return; // le fichier ne participe pas au modele affiche
    void this.panel.webview.postMessage({
      type: 'cursor',
      line: editor.selection.active.line,
      file,
    });
  }

  async open(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== 'st1') {
      void vscode.window.showWarningMessage('Ouvrez un fichier .st1 pour visualiser le modele.');
      return;
    }
    this.source = editor.document.uri;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      await this.update();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'st1.viewer',
      'Modele ST1',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        // Sans cela, la vue (angle, zoom) est perdue des que l'onglet passe
        // en arriere-plan — reproche recurrent fait aux webviews.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      },
    );

    this.panel.webview.html = this.render(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(async (message: { type: string; line?: number; file?: number }) => {
      if (message.type === 'ready') await this.update();
      if (message.type === 'reveal' && message.line !== undefined) await this.reveal(message.line, message.file);
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private scheduleUpdate(): void {
    if (!this.panel) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), 200);
  }

  private async update(): Promise<void> {
    const client = this.client();
    if (!this.panel || !this.source || !client) return;
    try {
      const model = await client.sendRequest('st1/model', { uri: this.source.toString() });
      this.files = (model as { files?: string[] } | null)?.files ?? [];
      const configuration = vscode.workspace.getConfiguration('st1.viewer');
      await this.panel.webview.postMessage({
        type: 'model',
        model,
        settings: {
          defaultView: configuration.get<string>('defaultView', 'auto'),
          showNodeNumbers: configuration.get<boolean>('showNodeNumbers', false),
          showBarNumbers: configuration.get<boolean>('showBarNumbers', false),
          showCables: configuration.get<boolean>('showCables', true),
          showReleases: configuration.get<boolean>('showReleases', true),
        },
      });
      this.panel.title = `Modele ST1 — ${this.source.path.split('/').pop()}`;
    } catch (error) {
      this.output.appendLine(`[visualiseur] ${(error as Error).message}`);
      await this.panel.webview.postMessage({ type: 'error', message: (error as Error).message });
    }
  }

  private async reveal(line: number, file?: number): Promise<void> {
    if (!this.source) return;
    // Un element defini dans un fichier inclus (`LIRE`) ouvre ce fichier.
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
  <link href="${media('viewer.css')}" rel="stylesheet">
  <title>Modele ST1</title>
</head>
<body>
  <header id="toolbar">
    <div class="group" role="group" aria-label="Vue">
      <button data-view="XY" title="Vue dans le plan XY">XY</button>
      <button data-view="XZ" title="Vue dans le plan XZ">XZ</button>
      <button data-view="YZ" title="Vue dans le plan YZ">YZ</button>
      <button data-view="3D" title="Vue isometrique, rotation a la souris">3D</button>
    </div>
    <div class="group">
      <button id="fit" title="Ajuster a la fenetre">Ajuster</button>
    </div>
    <div class="group toggles">
      <label><input type="checkbox" id="nodeNumbers"> N&deg; noeuds</label>
      <label><input type="checkbox" id="barNumbers"> N&deg; barres</label>
      <label><input type="checkbox" id="showSupports" checked> Appuis</label>
      <label><input type="checkbox" id="showLoads" checked> Barres chargees</label>
      <label id="cablesToggle" hidden><input type="checkbox" id="showCables" checked> C&acirc;bles</label>
      <label id="releasesToggle" hidden><input type="checkbox" id="showReleases" checked title="Articulations (ART) et excentrements (EXC)"> Rotules/exc.</label>
    </div>
    <div class="group" id="phaseGroup" hidden>
      <label for="phaseSelect">Phase</label>
      <select id="phaseSelect" title="Etat du phasage a visualiser"></select>
    </div>
    <div class="spacer"></div>
    <output id="summary"></output>
  </header>
  <canvas id="canvas" tabindex="0"></canvas>
  <div id="tooltip" hidden></div>
  <footer id="hint">Molette : zoom &middot; glisser : deplacer &middot; glisser droit en 3D : rotation &middot; clic sur un element : aller a sa definition</footer>
  <script nonce="${nonce}" src="${media('viewer.js')}"></script>
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
