/**
 * Types du catalogue ST1 — la source de verite unique de l'extension.
 *
 * Le fichier `catalog/st1-catalog.json` alimente : la grammaire TextMate, les
 * snippets, la completion, le survol, les signatures et la validation. Aucune
 * liste de mots-cles ne doit etre codee en dur ailleurs.
 */

export type StructureOption = 'PLANE' | 'GRILL' | 'SPATIALE';

export const STRUCTURE_OPTIONS: StructureOption[] = ['PLANE', 'GRILL', 'SPATIALE'];

/** Ou une commande est-elle acceptee. */
export type CommandContext =
  /** Commande de premier niveau. */
  | 'top'
  /** Forme `EXEC ...` : declenche un calcul. */
  | 'exec'
  /** Sous-commande valide uniquement a l'interieur d'un bloc (`bloc:CHARG`). */
  | string;

export interface CatalogArg {
  /** Mot-cle exact tel qu'ecrit dans un script, ou nom du parametre positionnel. */
  name: string;
  kind: 'positional' | 'keyword' | 'flag' | 'subcommand' | 'choice';
  type?: 'real' | 'int' | 'string' | 'enum' | 'list' | 'flag' | 'bloc' | string;
  required?: boolean;
  /** Valeur par defaut **documentee** uniquement. */
  default?: string;
  /** Unite imposee par la documentation (radian, jour, minute...). */
  unit?: string;
  min?: number;
  max?: number;
  /** Valeurs enumerees admises. */
  values?: string[];
  /** Restreint a certaines options de structure. */
  onlyOptions?: StructureOption[];
  doc: string;
  pages?: number[];
}

export interface CatalogCommand {
  /** Mot-cle exact, en MAJUSCULES. Les commandes composees restent entieres. */
  name: string;
  aliases?: string[];
  family: string;
  context: CommandContext;
  summary: string;
  /** Documentation longue, en Markdown. */
  doc?: string;
  /** Lignes de syntaxe, notation du manuel : `( )` optionnel, `< a, b >` choix. */
  syntax: string[];
  /** `FIN`, `FIN PHASAGE`, ou absent si la commande tient sur une ligne. */
  terminator?: string;
  /** Commande `EXEC` qui declenche le calcul associe. */
  exec?: string;
  restrictedToOptions?: StructureOption[];
  /** Documentee « ST1 v2 seulement ». */
  requiresV2?: boolean;
  args?: CatalogArg[];
  prerequisites?: string[];
  forbidden?: string[];
  pitfalls?: string[];
  examples?: string[];
  /** Pages **physiques** du manuel v24. Obligatoire : pas de page, pas d'entree. */
  pages: number[];
}

export interface StructureOptionSpec {
  coordinates: string[];
  ddl: string[];
  barProperties: string[];
  nodalLoads: string[];
  /** Composantes de resultat admises par famille (EFFORT, DEPLA, CONTR, PRESS, REAC). */
  surchargeComponents: Record<string, string[]>;
  pages: number[];
}

export interface CatalogLexical {
  /** Fonctions mathematiques utilisables dans une expression. */
  functions: string[];
  /** Operateurs de comparaison et logiques de la pseudo-programmation. */
  operators: string[];
  /** Mots-cles de controle de la pseudo-programmation. */
  controlKeywords: string[];
  /** Couleurs admises par les commandes graphiques. */
  colors: string[];
  /** Mots reserves des listes numeriques (`i a j pas p`). */
  listKeywords: string[];
  /** Variables tampon `$…` alimentees par `GET`. */
  getVariables: string[];
}

export interface Catalog {
  schemaVersion: number;
  source: {
    title: string;
    version: string;
    sha256?: string;
    pageCount: number;
    provenanceKind: string;
  };
  structureOptions: Record<StructureOption, StructureOptionSpec>;
  lexical: CatalogLexical;
  commands: CatalogCommand[];
}

// --------------------------------------------------------------------------
// Index derive — construit une fois au chargement, consomme partout ailleurs.
// --------------------------------------------------------------------------

export interface CatalogIndex {
  catalog: Catalog;
  /** Toutes les commandes indexees par nom normalise (MAJUSCULES), alias compris. */
  byName: Map<string, CatalogCommand>;
  /** Commandes de premier niveau (contexte `top` ou `exec`). */
  topLevel: CatalogCommand[];
  /** Sous-commandes, indexees par nom de bloc parent (`CHARG` -> [...]). */
  byBlock: Map<string, CatalogCommand[]>;
  /** Blocs et leur terminateur (`PHASAGE` -> `FIN PHASAGE`). */
  terminators: Map<string, string>;
  /** Tous les mots-cles connus, en MAJUSCULES : mots de commande + arguments. */
  keywords: Set<string>;
  /** Premiers mots de commandes composees (`GENER`, `EXEC`, `EXPOSITION`...). */
  compoundHeads: Set<string>;
  /** Longueur maximale d'une commande composee, en mots. */
  maxCommandWords: number;
}

const BLOCK_PREFIX = 'bloc:';

/** Un mot-cle ST1 s'ecrit en majuscules dans la documentation (p.32). */
const KEYWORD_RE = /^[A-Z_][A-Z0-9_]*$/;

export function blockOf(context: CommandContext): string | undefined {
  return context.startsWith(BLOCK_PREFIX) ? context.slice(BLOCK_PREFIX.length).toUpperCase() : undefined;
}

export function buildIndex(catalog: Catalog): CatalogIndex {
  const byName = new Map<string, CatalogCommand>();
  const topLevel: CatalogCommand[] = [];
  const byBlock = new Map<string, CatalogCommand[]>();
  const terminators = new Map<string, string>();
  const keywords = new Set<string>();
  const compoundHeads = new Set<string>();
  let maxCommandWords = 1;

  for (const command of catalog.commands) {
    const isTopLevel = !blockOf(command.context);
    const names = [command.name, ...(command.aliases ?? [])];
    for (const name of names) {
      const key = normalize(name);
      // `byName` est la table **globale** : quand un nom existe a la fois au
      // premier niveau et comme sous-commande (ENV, CHARG, COMB, NOEUD…), c'est
      // la commande de premier niveau qui doit gagner. Les sous-commandes sont
      // resolues avant, par `byBlock`, quand le contexte s'y prete.
      const existing = byName.get(key);
      if (!existing || (isTopLevel && blockOf(existing.context))) byName.set(key, command);
      const words = key.split(/\s+/);
      maxCommandWords = Math.max(maxCommandWords, words.length);
      if (words.length > 1) compoundHeads.add(words[0]);
      for (const word of words) keywords.add(word);
    }

    const block = blockOf(command.context);
    if (block) {
      const list = byBlock.get(block) ?? [];
      list.push(command);
      byBlock.set(block, list);
    } else {
      topLevel.push(command);
    }

    if (command.terminator) {
      terminators.set(normalize(command.name), command.terminator.toUpperCase());
    }

    // Convention du manuel (p.32) : mots-cles en MAJUSCULES, valeurs et listes
    // a fournir en minuscules. Un nom d'argument en minuscules (`liste`,
    // `coef`) est une metavariable, pas un mot du langage : l'inscrire ici
    // ferait passer une variable utilisateur homonyme pour un mot-cle.
    for (const arg of command.args ?? []) {
      if (KEYWORD_RE.test(arg.name)) keywords.add(arg.name);
      for (const value of arg.values ?? []) {
        if (KEYWORD_RE.test(value)) keywords.add(value);
      }
    }
  }

  for (const word of catalog.lexical.controlKeywords) keywords.add(word.toUpperCase());
  for (const word of catalog.lexical.listKeywords) keywords.add(word.toUpperCase());

  return { catalog, byName, topLevel, byBlock, terminators, keywords, compoundHeads, maxCommandWords };
}

/** Normalise un nom de commande : MAJUSCULES, espaces internes reduits. */
export function normalize(name: string): string {
  return name.trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Reconnait la commande la plus longue en tete d'une suite de mots.
 * `['EXEC','SPECTRE','REPONSE','1']` -> `EXEC SPECTRE REPONSE` (3 mots).
 */
export function matchCommand(
  index: CatalogIndex,
  words: string[],
  block?: string,
): { command: CatalogCommand; wordCount: number } | undefined {
  const max = Math.min(index.maxCommandWords, words.length);
  for (let n = max; n >= 1; n--) {
    const key = normalize(words.slice(0, n).join(' '));
    const candidates: CatalogCommand[] = [];
    if (block) {
      for (const sub of index.byBlock.get(block) ?? []) {
        if (normalize(sub.name) === key || (sub.aliases ?? []).some((a) => normalize(a) === key)) {
          candidates.push(sub);
        }
      }
    }
    const global = index.byName.get(key);
    if (global) candidates.push(global);
    if (candidates.length) return { command: candidates[0], wordCount: n };
  }
  return undefined;
}

/** Rend la documentation Markdown d'une commande, pour le survol et la completion. */
export function renderCommandDoc(command: CatalogCommand, options?: { option?: StructureOption }): string {
  const out: string[] = [`### \`${command.name}\``, '', command.summary];

  if (command.restrictedToOptions?.length) {
    out.push('', `> Uniquement en \`OPTION ${command.restrictedToOptions.join('` / `')}\`.`);
  }
  if (command.requiresV2) out.push('', '> Disponible en **ST1 v2** seulement.');

  if (command.syntax.length) {
    out.push('', '```st1', ...command.syntax, '```');
  }
  if (command.doc) out.push('', command.doc);

  const args = (command.args ?? []).filter(
    (arg) => !options?.option || !arg.onlyOptions?.length || arg.onlyOptions.includes(options.option),
  );
  if (args.length) {
    out.push('', '**Parametres**', '');
    for (const arg of args) {
      const bits: string[] = [];
      if (arg.type) bits.push(`\`${arg.type}\``);
      if (arg.unit) bits.push(`[${arg.unit}]`);
      if (arg.required === false) bits.push('*(optionnel)*');
      if (arg.default !== undefined) bits.push(`defaut \`${arg.default}\``);
      if (arg.min !== undefined || arg.max !== undefined) {
        bits.push(`bornes \`${arg.min ?? '-inf'} … ${arg.max ?? '+inf'}\``);
      }
      if (arg.values?.length) bits.push(`valeurs \`${arg.values.join('`, `')}\``);
      if (arg.onlyOptions?.length) bits.push(`*${arg.onlyOptions.join('/')} uniquement*`);
      const head = `- **${arg.name}**${bits.length ? ' — ' + bits.join(', ') : ''}`;
      out.push(arg.doc ? `${head} — ${arg.doc}` : head);
    }
  }

  if (command.prerequisites?.length) {
    out.push('', `**Prerequis** : ${command.prerequisites.map((p) => `\`${p}\``).join(', ')}`);
  }
  if (command.exec) out.push('', `**Execution** : \`${command.exec}\``);
  if (command.terminator) out.push('', `**Bloc terminé par** \`${command.terminator}\``);
  if (command.forbidden?.length) {
    out.push('', '**Interdits**', '', ...command.forbidden.map((f) => `- ${f}`));
  }
  if (command.pitfalls?.length) {
    out.push('', '**Pieges**', '', ...command.pitfalls.map((p) => `- ${p}`));
  }
  if (command.examples?.length) {
    out.push('', '**Exemple**', '', '```st1', ...command.examples, '```');
  }
  if (command.pages.length) {
    out.push('', `*Manuel ST1 v24, p.${formatPages(command.pages)}*`);
  }
  return out.join('\n');
}

/** `[47,48,49,52]` -> `47-49, 52`. */
export function formatPages(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i] !== sorted[i - 1] + 1) {
      parts.push(i - start > 1 ? `${sorted[start]}-${sorted[i - 1]}` : `${sorted[start]}`);
      start = i;
    }
  }
  return parts.join(', ');
}
