/**
 * Vues de la barre d'activite ST1.
 *
 *  - « Commandes ST1 » : navigateur du catalogue, groupe par famille. Il rend
 *    la documentation consultable sans la chercher dans le manuel, et permet
 *    d'inserer une commande dans l'editeur.
 *  - « Modele courant » : resume du modele reconstruit depuis le fichier
 *    ouvert (nombre de noeuds, barres, appuis, emprise geometrique).
 */

import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

interface CatalogCommandLike {
  name: string;
  summary: string;
  family: string;
  syntax: string[];
  terminator?: string;
  pages: number[];
  requiresV2?: boolean;
  restrictedToOptions?: string[];
}

interface CatalogLike {
  commands: CatalogCommandLike[];
}

const FAMILY_LABELS: Record<string, string> = {
  general: 'General et session',
  geometrie: 'Geometrie',
  caracteristiques: 'Caracteristiques et masses',
  materiaux: 'Materiaux et precontrainte',
  chargements: 'Chargements fixes',
  exploitation: "Charges d'exploitation",
  phasage: 'Phasage de construction',
  dynamique: 'Dynamique et flambement',
  feu: 'Calcul au feu',
  resultats: 'Resultats et edition',
};

type Node =
  | { type: 'family'; key: string }
  | { type: 'command'; command: CatalogCommandLike };

export class CommandTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private catalog: CatalogLike | undefined;

  constructor(private readonly client: () => LanguageClient | undefined) {}

  refresh(): void {
    this.catalog = undefined;
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'family') {
      const item = new vscode.TreeItem(
        FAMILY_LABELS[node.key] ?? node.key,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.iconPath = new vscode.ThemeIcon('folder-library');
      return item;
    }

    const { command } = node;
    const item = new vscode.TreeItem(command.name, vscode.TreeItemCollapsibleState.None);
    item.description = command.summary;
    item.iconPath = new vscode.ThemeIcon(command.terminator ? 'symbol-namespace' : 'symbol-function');

    const lines = [`**${command.name}** — ${command.summary}`, ''];
    if (command.restrictedToOptions?.length) {
      lines.push(`Uniquement en \`OPTION ${command.restrictedToOptions.join(' / ')}\`.`, '');
    }
    if (command.requiresV2) lines.push('ST1 **v2** uniquement.', '');
    if (command.syntax.length) lines.push('```st1', ...command.syntax, '```', '');
    if (command.pages.length) lines.push(`*Manuel ST1 v24, p.${command.pages.join(', ')}*`);
    item.tooltip = new vscode.MarkdownString(lines.join('\n'));

    item.command = {
      command: 'st1.insertCommandByName',
      title: 'Inserer',
      arguments: [command],
    };
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const catalog = await this.load();
    if (!catalog) return [];

    if (!node) {
      const families = [...new Set(catalog.commands.map((c) => c.family))];
      const known = Object.keys(FAMILY_LABELS).filter((k) => families.includes(k));
      const extra = families.filter((f) => !(f in FAMILY_LABELS)).sort();
      return [...known, ...extra].map((key) => ({ type: 'family', key }));
    }

    if (node.type === 'family') {
      return catalog.commands
        .filter((c) => c.family === node.key)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((command) => ({ type: 'command', command }));
    }
    return [];
  }

  private async load(): Promise<CatalogLike | undefined> {
    if (this.catalog) return this.catalog;
    const client = this.client();
    if (!client) return undefined;
    try {
      this.catalog = (await client.sendRequest('st1/catalog')) as CatalogLike;
    } catch {
      return undefined;
    }
    return this.catalog;
  }
}

// --------------------------------------------------------------------------

interface ModelSummary {
  option: string | null;
  counts: { nodes: number; bars: number; supports: number; materials: number; cables?: number };
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  nodes: { id: number; x: number; y: number; z: number; line: number; file: number }[];
  bars: { id: number; from: number; to: number; line: number; file: number }[];
  supports: { id: number; node: number; ddl: string[]; line: number; file: number }[];
  /** Fichiers du modele : 0 = fichier actif, puis les inclusions `LIRE`. */
  files?: string[];
}

interface ModelEntry {
  label: string;
  description?: string;
  icon: string;
  line?: number;
  children?: ModelEntry[];
}

export class ModelTreeProvider implements vscode.TreeDataProvider<ModelEntry> {
  private readonly emitter = new vscode.EventEmitter<ModelEntry | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly client: () => LanguageClient | undefined) {}

  /** Rafraichissement anti-rebond : la frappe ne doit pas saturer le serveur. */
  refresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(undefined), 250);
  }

  getTreeItem(entry: ModelEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(
      entry.label,
      entry.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.description = entry.description;
    item.iconPath = new vscode.ThemeIcon(entry.icon);
    if (entry.line !== undefined) {
      item.command = { command: 'st1.revealLine', title: 'Aller a la definition', arguments: [entry.line] };
    }
    return item;
  }

  async getChildren(entry?: ModelEntry): Promise<ModelEntry[]> {
    if (entry) return entry.children ?? [];

    const editor = vscode.window.activeTextEditor;
    const client = this.client();
    if (!client || editor?.document.languageId !== 'st1') {
      return [{ label: 'Aucun fichier ST1 actif', icon: 'info' }];
    }

    let model: ModelSummary | null;
    try {
      model = (await client.sendRequest('st1/model', { uri: editor.document.uri.toString() })) as ModelSummary | null;
    } catch {
      return [{ label: 'Modele indisponible', icon: 'warning' }];
    }
    if (!model) return [{ label: 'Modele indisponible', icon: 'warning' }];

    // Un element defini dans un fichier inclus (`LIRE`) ne peut pas pointer
    // vers une ligne du fichier actif : on signale sa provenance a la place.
    const origin = (element: { file: number }) => {
      if (!element.file || !model!.files?.[element.file]) return undefined;
      return ` · ${model!.files[element.file].split(/[\\/]/).pop()}`;
    };
    const lineOf = (element: { line: number; file: number }) => (element.file ? undefined : element.line);

    const entries: ModelEntry[] = [
      { label: 'Option', description: model.option ?? 'non declaree', icon: model.option ? 'symbol-enum' : 'warning' },
      {
        label: 'Noeuds',
        description: String(model.counts.nodes),
        icon: 'circle-filled',
        children: model.nodes
          .slice(0, 500)
          .map((node) => ({
            label: `Noeud ${node.id}`,
            description: `${format(node, model!.option)}${origin(node) ?? ''}`,
            icon: 'circle-outline',
            line: lineOf(node),
          })),
      },
      {
        label: 'Barres',
        description: String(model.counts.bars),
        icon: 'symbol-ruler',
        children: model.bars
          .slice(0, 500)
          .map((bar) => ({
            label: `Barre ${bar.id}`,
            description: `${bar.from} → ${bar.to}${origin(bar) ?? ''}`,
            icon: 'dash',
            line: lineOf(bar),
          })),
      },
      {
        label: 'Appuis',
        description: String(model.counts.supports),
        icon: 'triangle-down',
        children: model.supports.map((support) => ({
          label: `Appui ${support.id}`,
          description: `noeud ${support.node} · ${support.ddl.join(' ') || 'aucun DDL bloque'}${origin(support) ?? ''}`,
          icon: 'triangle-down',
          line: lineOf(support),
        })),
      },
    ];

    if (model.bounds && model.counts.nodes) {
      const { min, max } = model.bounds;
      const span = (i: number) => (max[i] - min[i]).toFixed(3).replace(/\.?0+$/, '');
      entries.push({
        label: 'Emprise',
        description: model.option === 'SPATIALE' ? `${span(0)} × ${span(1)} × ${span(2)}` : `${span(0)} × ${span(1)}`,
        icon: 'symbol-array',
      });
    }

    return entries;
  }
}

function format(node: { x: number; y: number; z: number }, option: string | null): string {
  const round = (value: number) => Number(value.toFixed(4)).toString();
  return option === 'SPATIALE'
    ? `${round(node.x)} ; ${round(node.y)} ; ${round(node.z)}`
    : `${round(node.x)} ; ${round(node.y)}`;
}
