/**
 * Extraction du modele geometrique depuis le texte d'une etude ST1.
 *
 * Contrairement a code_aster, un modele ST1 est **entierement decrit dans le
 * fichier texte** : il n'y a ni maillage volumique, ni fichier binaire
 * intermediaire. On peut donc reconstruire noeuds, barres et appuis par simple
 * lecture — ce qui alimente a la fois le visualiseur (rafraichi a la frappe) et
 * les diagnostics de coherence (barre sur un noeud inexistant, barre sans
 * caracteristiques, etc.).
 *
 * Les etudes reelles ne se contentent pas de commandes lineaires : elles
 * **generent** la geometrie (`POUR i=1 a nb << BARRE i i i+1 >>`), la
 * parametrent (`lg=25.` puis `NOEUD 2 lg 0.`) et la repartissent sur plusieurs
 * fichiers (`LIRE 'noeuds.st1'`). Ce module est donc un petit *executeur* :
 * il deroule les boucles `POUR`/`FAIRE`, evalue les `SI`/`SINON` decidables,
 * suit les inclusions `LIRE` (via un resolveur injecte par le serveur — ce
 * module n'accede jamais au disque lui-meme) et evalue les expressions au fil
 * de l'eau (cf. `expr.ts`).
 */

import type { CatalogIndex, StructureOption } from './catalog.js';
import { matchCommand, normalize } from './catalog.js';
import { assign, evaluate, expandRange, parseList, splitValues, type Scope } from './expr.js';
import type { Token } from './lexer.js';
import type { ParsedDocument, Statement } from './parser.js';

export interface ModelNode {
  id: number;
  x: number;
  y: number;
  z: number;
  line: number;
  /** Index dans `Model.files` du fichier qui definit l'element (0 = fichier hote). */
  file: number;
}

export interface ModelBar {
  id: number;
  from: number;
  to: number;
  line: number;
  file: number;
}

export interface ModelSupport {
  /** Numero d'appui. */
  id: number;
  /** Noeud portant l'appui. */
  node: number;
  ddl: string[];
  elastic: boolean;
  decol: boolean;
  line: number;
  file: number;
}

export interface BarProperties {
  /**
   * Proprietes RDM renseignees et leur valeur si elle est evaluable
   * (`SX` -> 0.35, `IZ` -> 3.57e-3…). `undefined` : propriete presente mais
   * valeur non evaluable (variable inconnue, `CARA VAR`…).
   */
  props: Map<string, number | undefined>;
  line: number;
  file: number;
  /** Barre sur sol elastique / plastique (`CARA PSE`). */
  pse: boolean;
  /** Caracteristiques variables (`CARA VAR LIN` / `CARA VAR PARA`). */
  variable?: boolean;
  /**
   * `CARA liste SECTION is` (calcul au feu, p.227) : les caracteristiques ET
   * le materiau viennent de la section — la barre se passe alors de `CONS`.
   */
  section?: number;
}

export interface BarConstants {
  line: number;
  file: number;
  /** Numero de materiau (`CONS liste MAT i`). */
  material?: number;
  /** Constantes directes evaluables : `E`, `NU`, `RO`, `TEMP`, `G`. */
  values: Map<string, number>;
}

export interface ModelMaterial {
  line: number;
  file: number;
  title?: string;
  /** Constantes numeriques directes relevees dans le bloc (`RO 2.5`…). */
  values: Map<string, number>;
}

/**
 * Point de passage d'un trace de cable, dans le **repere global** (p.96).
 * Les modificateurs conditionnent l'allure entre les points : ST1 interpole
 * le trace par des cubiques, pas par des segments droits (p.334).
 */
export interface CablePoint {
  x: number;
  y: number;
  z: number;
  /** Pente du trace en ce point (angle avec le plan horizontal, radians). */
  pente?: number;
  /** Angle en plan par rapport a OX global (radians). */
  gis?: number;
  /** Alignement droit impose entre ce point et le suivant. */
  aligne?: boolean;
  /** Raccordement circulaire au passage d'un pole (cable exterieur). */
  rayon?: number;
}

export interface ModelCable {
  id: number;
  name?: string;
  /** Points du trace (`TRACE` puis lignes `X x Y y (Z z)` ou positionnelles). */
  points: CablePoint[];
  /** Vrai si une commande `TRACE` a ete rencontree (meme sans point lisible). */
  traceDeclared?: boolean;
  /** `TRACE EXTERIEUR` : ligne brisee sur deviateurs, pas de courbe continue. */
  exterior?: boolean;
  /** Barres auxquelles le cable est rattache (`BARRE liste`). */
  bars: number[];
  /** Precontrainte associee (`PREC j`). */
  prec?: number;
  line: number;
  file: number;
}

/** Instantane cumulatif du modele a un `ETAT` du phasage. */
export interface PhaseState {
  /** Numero d'`ETAT`, absent pour l'etat final implicite. */
  id?: number;
  title?: string;
  line: number;
  file: number;
  date?: number;
  bars: number[];
  supports: number[];
  /** Cables tendus (`TENDRE CABLE` / `TENDRE_BANC CABLE`). */
  tensioned: number[];
}

export interface ModelPhasage {
  id?: number;
  title?: string;
  line: number;
  file: number;
  states: PhaseState[];
}

/**
 * Types d'objets numerotes de l'etude, pour le rapport de coherence.
 * Chaque objet se verifie dans les deux sens : reference -> defini ?
 * (erreur), defini -> utilise ? (avertissement).
 */
export type StudyKind =
  | 'CHARG' | 'SURCH' | 'COMB' | 'ENV' | 'PHASAGE' | 'ETAT'
  | 'MAT' | 'PREC' | 'CABLE'
  | 'SPECTRE' | 'SPECTRE REPONSE'
  | 'SECTION' | 'EXPOSITION FEU' | 'INCENDIE';

export interface StudyDef {
  id: number;
  title?: string;
  line: number;
  file: number;
}

export interface StudyRef {
  kind: StudyKind;
  id: number;
  line: number;
  file: number;
  /** Commande ou bloc d'ou vient la reference (`RESU`, `ENV 3`, `GET`…). */
  via: string;
  /** Objet englobant qui porte la reference (`ENV 3`), si identifiable. */
  owner?: { kind: StudyKind; id: number };
}

export interface StudyExec {
  /** Cible de l'`EXEC` : `CHARG`, `SURCH`, `PHASAGE`, `SPECTRE REPONSE`… */
  kind: string;
  /** Liste executee, ou `null` : sans liste, ST1 execute tous les cas. */
  list: number[] | null;
  line: number;
  file: number;
}

/** Index des objets de l'etude : definitions, references, executions. */
export interface StudyIndex {
  defs: Map<StudyKind, Map<number, StudyDef>>;
  refs: StudyRef[];
  /** References sans liste (`RESU CHARG`) : tous les objets du type. */
  allRefs: { kind: StudyKind; via: string; line: number; file: number }[];
  execs: StudyExec[];
  /** Au moins un bloc `RESU` : des resultats seront edites. */
  resuPresent: boolean;
}

/** Inclusion `LIRE` rencontree, resolue ou non. */
export interface ModelInclude {
  /** Chemin tel qu'ecrit dans la commande. */
  file: string;
  /** Ligne de la commande `LIRE` dans le fichier hote (ancre des diagnostics). */
  line: number;
  resolved: boolean;
}

export interface Model {
  option: StructureOption | null;
  nodes: Map<number, ModelNode>;
  bars: Map<number, ModelBar>;
  supports: ModelSupport[];
  /** Articulations : barre -> extremites liberees. */
  articulations: Map<number, { or: string[]; ex: string[] }>;
  /** Excentrements declares, par barre. */
  eccentric: Set<number>;
  caraByBar: Map<number, BarProperties>;
  /** Barres dotees de constantes physiques (`CONS`) ou d'un materiau (`MAT`). */
  constantsByBar: Map<number, BarConstants>;
  materials: Map<number, ModelMaterial>;
  cables: ModelCable[];
  phasages: ModelPhasage[];
  /** Barres portant au moins une charge. */
  loadedBars: Set<number>;
  /** Barres portant des sections d'etude explicites. */
  studiedBars: Set<number>;
  /** Barres du tablier (`TABLIER BARRE …`). */
  deckBars: number[];
  scope: Scope;
  /** Fichiers du modele : index 0 = fichier hote, puis les `LIRE` resolus. */
  files: string[];
  /** Ligne, dans le fichier hote, du `LIRE` qui a introduit chaque fichier. */
  fileAnchors: number[];
  includes: ModelInclude[];
  /** Vrai si l'executeur a atteint son budget (boucle demesuree ou infinie). */
  truncated: boolean;
  /** Index defs/refs/execs pour le rapport de coherence de l'etude. */
  study: StudyIndex;
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

/** Document inclus resolu par l'hote (le serveur lit le disque, pas ce module). */
export interface ResolvedInclude {
  document: ParsedDocument;
  /** Chemin resolu (absolu de preference), pour la navigation et les cycles. */
  file: string;
}

export interface BuildOptions {
  /** Index du catalogue : necessaire pour reconnaitre les commandes des corps de boucle. */
  index?: CatalogIndex;
  /** Resout un `LIRE 'fichier'` relatif au fichier `fromFile`. */
  resolve?: (file: string, fromFile: string) => ResolvedInclude | null;
  /** Chemin du fichier hote (index 0 de `Model.files`). */
  file?: string;
}

const DDL_WORDS = new Set(['DX', 'DY', 'DZ', 'RX', 'RY', 'RZ']);
const CARA_PROPS = new Set([
  'SX', 'SY', 'SZ', 'IX', 'IY', 'IZ', 'IPOL', 'VY', 'WY', 'VZ', 'WZ',
  'EXTY', 'EXTZ', 'KFX', 'KFY', 'KFZ', 'KMX',
]);
const CONS_PROPS = new Set(['E', 'NU', 'G', 'RO', 'TEMP', 'AMOR']);
const OPTION_VALUES = new Set(['PLANE', 'GRILL', 'SPATIALE']);
const COMPARATORS = new Set(['=', '==', '<', '>', '<=', '>=', '/=', '<>']);
/** Actions de phasage sur cables : `TENDRE CABLE`, `TENDRE_BANC CABLES`… */
const PHASE_CABLE_ACTIONS = new Set(['TENDRE', 'TENDRE_BANC', 'DETENDRE', 'RELACHER_BANC', 'INJECTER']);

/**
 * Blocs dans lesquels `NOEUD`, `BARRE`, `APPUI`, `CARA`… designent des
 * elements existants (references), et non des definitions. Premier mot du nom
 * de bloc : `CHARG` couvre `CHARG COMB`, `ENV` couvre `ENV COMB`.
 *
 * On ne teste PAS « est dans un bloc » : un bloc reste parfois ouvert
 * (`EXPOSITION FEU i TEMP t` ecrit en une ligne, `FIN` oublie en cours de
 * frappe) et tout le reste du fichier s'y retrouverait — les definitions
 * disparaitraient du modele. La liste des contextes de reference est fermee
 * et documentee ; tout autre bloc laisse passer les definitions.
 */
const REFERENCE_BLOCK_HEADS = new Set([
  'CHARG', 'SURCH', 'TABLIER', 'RESU', 'ENV', 'COMB', 'CABLE', 'ETUDE',
  'PREC', 'MAT', 'SECTION', 'MASSE', 'DESS', 'DEFORM', 'ARMATURE',
]);

function inReferenceBlock(blockPath: string[]): boolean {
  return blockPath.some((name) => REFERENCE_BLOCK_HEADS.has(name.split(' ')[0]));
}

/**
 * Budget d'instructions de l'executeur : tres au-dela d'une etude reelle, mais
 * garde-fou contre une boucle sur une liste enorme pendant la frappe.
 */
const STATEMENT_BUDGET = 200_000;
/** Profondeur maximale d'inclusion `LIRE`. */
const MAX_INCLUDE_DEPTH = 8;

// --------------------------------------------------------------------------
// Contexte d'execution
// --------------------------------------------------------------------------

type DataMode = 'NOEUD' | 'BARRE' | 'CARA' | 'APPUI' | 'CONS' | 'EXC' | undefined;

interface PhaseTracking {
  definition: ModelPhasage;
  bars: Set<number>;
  supports: Set<number>;
  tensioned: Set<number>;
  date?: number;
  /** Actions survenues depuis le dernier `ETAT`. */
  dirty: boolean;
}

interface Ctx {
  model: Model;
  index?: CatalogIndex;
  resolve?: BuildOptions['resolve'];
  /** Fichiers en cours d'inclusion (detection de cycle). */
  includeStack: string[];
  /** Ligne d'ancrage, dans le fichier hote, de chaque fichier inclus. */
  anchorByFile: number[];
  budget: number;
  /** Commande « en mode bloc » courante : `NOEUD` seul, puis lignes de donnees. */
  dataMode: DataMode;
  /** Mots de l'en-tete de la forme bloc en cours (`cara pse` seul puis les donnees). */
  dataWords: string[];
  /** Forme bloc de `BARRE` dans un chargement ou un tablier. */
  referenceMode: 'load' | 'deck' | undefined;
  /** Cable en cours de definition (bloc `CABLE i … FIN`). */
  cable?: ModelCable;
  /** Vrai apres `TRACE` : les lignes de donnees sont des points du cable. */
  cableTrace: boolean;
  /** Phasage en cours de definition. */
  phase?: PhaseTracking;
  /**
   * Forme bloc d'une sous-commande de reference (`CHARG` seul dans un `ENV`,
   * puis des lignes `i coef`) : type d'objet reference par les lignes suivantes.
   */
  refKind?: StudyKind;
  /** Objet a bloc en cours de definition (`ENV 3 … FIN`), porteur des references. */
  owner?: { kind: StudyKind; id: number; block: string };
}

// --------------------------------------------------------------------------
// Petites aides sur les jetons
// --------------------------------------------------------------------------

/**
 * Jetons de l'instruction, prives des seuls mots qui composent le nom de la
 * commande. Une commande composee peut etre coupee par une valeur — `CHARG 1
 * COMB 'Titre'`, `GENER 5 NOEUD …` — et cette valeur doit etre conservee.
 */
function body(statement: Statement): Token[] {
  if (!statement.keywordWords) return statement.tokens;
  let seen = 0;
  return statement.tokens.filter((token) => {
    if (token.kind === 'word' && seen < statement.keywordWords) {
      seen++;
      return false;
    }
    return true;
  });
}

/** Index du premier groupe dont le mot unique appartient a `words`. */
function findWord(groups: Token[][], words: Set<string>, from = 0): number {
  for (let i = from; i < groups.length; i++) {
    const group = groups[i];
    if (group.length === 1 && group[0].kind === 'word' && words.has(group[0].value)) return i;
  }
  return -1;
}

function wordAt(groups: Token[][], index: number): string | undefined {
  const group = groups[index];
  return group?.length === 1 && group[0].kind === 'word' ? group[0].value : undefined;
}

function isOperator(token: Token | undefined, text: string): boolean {
  return token?.kind === 'operator' && token.text === text;
}

/** Premier jeton chaine de l'instruction (titres de `CHARG`, `CABLE`, `ETAT`…). */
function firstString(tokens: Token[]): string | undefined {
  return tokens.find((t) => t.kind === 'string')?.value;
}

// --------------------------------------------------------------------------
// Index de l'etude (defs / refs / execs) pour le rapport de coherence
// --------------------------------------------------------------------------

/** Enregistre une definition d'objet (`ENV 3 'Titre'`) ; retourne son numero. */
function studyDef(model: Model, kind: StudyKind, statement: Statement, groups: Token[][], file: number): number | undefined {
  const id = evaluate(groups[0] ?? [], model.scope);
  if (id === undefined) return undefined;
  let byId = model.study.defs.get(kind);
  if (!byId) model.study.defs.set(kind, (byId = new Map()));
  byId.set(id, { id, title: firstString(statement.tokens), line: statement.line, file });
  return id;
}

function studyRef(ctx: Ctx, kind: StudyKind, id: number, statement: Statement, file: number, via: string): void {
  ctx.model.study.refs.push({
    kind,
    id,
    line: statement.line,
    file,
    via,
    owner: ctx.owner ? { kind: ctx.owner.kind, id: ctx.owner.id } : undefined,
  });
}

/**
 * Liste de references d'une sous-commande (`CHARG liste (coef)`). A la
 * difference de `parseList`, les valeurs separees par un simple blanc ne
 * prolongent PAS la liste : `charg 1 1.00 1.35` reference le seul cas 1, les
 * valeurs suivantes sont des coefficients. Seuls la virgule et l'intervalle
 * `a … (pas …)` etendent la liste (p.31).
 */
function readRefIds(tokens: Token[], scope: Scope): { ids: number[]; all: boolean; consumed: number } {
  // Regroupe comme `splitValues`, en retenant si le groupe suit une virgule.
  const groups: { tokens: Token[]; afterComma: boolean }[] = [];
  let current: Token[] = [];
  let comma = false;
  let nextComma = false;
  const flush = () => {
    if (current.length) groups.push({ tokens: current, afterComma: comma });
    current = [];
    comma = nextComma;
    nextComma = false;
  };
  for (const token of tokens) {
    if (token.kind === 'separator' && (token.text === ',' || token.text === ';')) {
      nextComma = token.text === ',';
      flush();
      continue;
    }
    if (!token.glued) flush();
    current.push(token);
  }
  flush();

  const single = (g: { tokens: Token[] }) =>
    g.tokens.length === 1 && g.tokens[0].kind === 'word' ? g.tokens[0].value : undefined;

  if (groups.length && ALL_LIST_WORDS.has(single(groups[0]) ?? '')) return { ids: [], all: true, consumed: 1 };

  const ids: number[] = [];
  let index = 0;
  while (index < groups.length) {
    const group = groups[index];
    const word = single(group);

    if (word === 'A' && ids.length) {
      const end = evaluate(groups[index + 1]?.tokens ?? [], scope);
      if (end === undefined) break;
      let step = 1;
      let advance = 2;
      if (single(groups[index + 2] ?? { tokens: [] }) === 'PAS') {
        const stepValue = evaluate(groups[index + 3]?.tokens ?? [], scope);
        if (stepValue !== undefined) {
          step = stepValue;
          advance = 4;
        }
      }
      const start = ids.pop()!;
      for (const value of expandRange(start, end, step)) ids.push(value);
      index += advance;
      continue;
    }

    // Au-dela du premier groupe, seule une virgule prolonge la liste : une
    // valeur simplement juxtaposee est un coefficient, pas une reference.
    if (index > 0 && !group.afterComma) break;

    if (word) {
      const named = scope.get(group.tokens[0].text.toLowerCase());
      if (Array.isArray(named)) {
        for (const value of named) ids.push(value);
        index++;
        continue;
      }
      break;
    }
    const value = evaluate(group.tokens, scope);
    if (value === undefined) break;
    ids.push(Math.round(value));
    index++;
  }
  return { ids, all: false, consumed: index };
}

const ALL_LIST_WORDS = new Set(['TOUT', 'TOUS', 'TOUTES']);

/**
 * Blocs porteurs de sous-commandes de reference, et types references.
 * Piege releve sur l'exemple 19.7 du manuel : dans une combinaison ou une
 * enveloppe, `SPECTRE liste` reference une **reponse spectrale**
 * (`SPECTRE i REPONSE`), pas un spectre de base — seul le bloc
 * `SPECTRE REPONSE` reference les spectres eux-memes.
 */
const COMBINATION_HEADS: Record<string, StudyKind> = {
  CHARG: 'CHARG', ENV: 'ENV', COMB: 'COMB', PHASAGE: 'PHASAGE',
  SURCH: 'SURCH', SPECTRE: 'SPECTRE REPONSE', ETAT: 'ETAT', INCENDIE: 'INCENDIE',
};
const RESU_HEADS: Record<string, StudyKind> = { ...COMBINATION_HEADS, CABLE: 'CABLE' };
const REF_CONTEXTS = new Set(['RESU', 'ENV', 'ENV COMB', 'COMB', 'CHARG COMB', 'CHARG', 'SPECTRE REPONSE', 'INCENDIE', 'SECTION']);
const SECTION_FACES = new Set(['SUP', 'INF', 'VY', 'WY', 'VZ', 'WZ']);

/**
 * Sous-commandes de reference des blocs `RESU`, `ENV`, `COMB`, `CHARG COMB`,
 * `CHARG` (cables), `SPECTRE REPONSE`, `INCENDIE` et `SECTION`. Retourne vrai
 * si l'instruction a ete consommee comme reference.
 */
function readStudyRefs(ctx: Ctx, statement: Statement, groups: Token[][], file: number): boolean {
  const model = ctx.model;

  // Lignes de donnees d'une sous-commande en forme bloc (`CHARG` seul dans un
  // `ENV`, puis `2 .25`) : la premiere valeur reference un objet.
  if (!statement.keyword && ctx.refKind && statement.tokens[0]?.kind === 'number') {
    const { ids } = readRefIds(statement.tokens, model.scope);
    for (const id of ids) studyRef(ctx, ctx.refKind, id, statement, file, ctx.refKind);
    return true;
  }
  if (!statement.keyword) return false;

  const context = [...statement.blockPath].reverse().find((name) => REF_CONTEXTS.has(name));
  if (!context) return false;
  const head = statement.words[0];
  const body = () => statement.tokens.filter((t, i) => i >= indexAfterKeyword(statement));

  if (context === 'RESU') {
    const kind = RESU_HEADS[head];
    if (!kind) return false;
    const { ids, all } = readRefIds(body(), model.scope);
    if (!ids.length || all) model.study.allRefs.push({ kind, via: 'RESU', line: statement.line, file });
    for (const id of ids) studyRef(ctx, kind, id, statement, file, 'RESU');
    return true;
  }

  if (context === 'ENV' || context === 'ENV COMB' || context === 'COMB' || context === 'CHARG COMB') {
    const kind = COMBINATION_HEADS[head];
    if (!kind || (context === 'CHARG COMB' && head !== 'CHARG')) return false;
    const { ids, all } = readRefIds(body(), model.scope);
    if (!ids.length && !all) {
      // Forme bloc : les lignes suivantes portent `i coef`.
      ctx.refKind = kind;
      return true;
    }
    for (const id of ids) studyRef(ctx, kind, id, statement, file, context);
    return true;
  }

  if (context === 'CHARG') {
    if (head !== 'CABLE') return false;
    const { ids, all } = readRefIds(body(), model.scope);
    if (all) return true;
    for (const id of ids) studyRef(ctx, 'CABLE', id, statement, file, 'CHARG');
    return true;
  }

  if (context === 'SPECTRE REPONSE') {
    if (head !== 'SPECTRE') return false;
    const id = evaluate(groups[0] ?? [], model.scope);
    if (id !== undefined) studyRef(ctx, 'SPECTRE', id, statement, file, 'SPECTRE REPONSE');
    return true;
  }

  if (context === 'INCENDIE') {
    // `FEU j (LOCAL) CHARG k` : exposition au feu + cas de charge concomitant.
    if (head !== 'FEU') return false;
    const exposure = evaluate(groups[0] ?? [], model.scope);
    if (exposure !== undefined) studyRef(ctx, 'EXPOSITION FEU', exposure, statement, file, 'INCENDIE');
    const chargIndex = findWord(groups, new Set(['CHARG']));
    if (chargIndex >= 0) {
      const charg = evaluate(groups[chargIndex + 1] ?? [], model.scope);
      if (charg !== undefined) studyRef(ctx, 'CHARG', charg, statement, file, 'INCENDIE');
    }
    return true;
  }

  // context === 'SECTION' (calcul au feu)
  if (head === 'MAT' || head === 'MATERIAU') {
    const id = evaluate(groups[0] ?? [], model.scope);
    if (id !== undefined) studyRef(ctx, 'MAT', id, statement, file, 'SECTION');
    return true;
  }
  if (head === 'EXPOSITION') {
    for (let i = 0; i < groups.length; i++) {
      const word = wordAt(groups, i);
      if (!word || !SECTION_FACES.has(word)) continue;
      const id = evaluate(groups[i + 1] ?? [], model.scope);
      if (id !== undefined) studyRef(ctx, 'EXPOSITION FEU', id, statement, file, 'SECTION');
      i++;
    }
    return true;
  }
  return false;
}

const PAIR_REF_WORDS: Record<string, StudyKind> = {
  CHARG: 'CHARG', ETAT: 'ETAT', PHASAGE: 'PHASAGE', CABLE: 'CABLE',
  SPECTRE: 'SPECTRE', COMB: 'COMB', ENV: 'ENV',
};

/** References ponctuelles `MOT numero` d'une commande (`GET … CHARG j`). */
function recordPairRefs(ctx: Ctx, statement: Statement, groups: Token[][], file: number, via: string): void {
  for (let i = 0; i < groups.length; i++) {
    const word = wordAt(groups, i);
    const kind = word ? PAIR_REF_WORDS[word] : undefined;
    if (!kind) continue;
    if (wordAt(groups, i + 1) !== undefined) continue; // mot-cle sans numero
    const id = evaluate(groups[i + 1] ?? [], ctx.model.scope);
    if (id !== undefined) studyRef(ctx, kind, id, statement, file, via);
    i++;
  }
}

/** Nombre de jetons `word` consommes par le nom de la commande, en position. */
function indexAfterKeyword(statement: Statement): number {
  let seen = 0;
  for (let i = 0; i < statement.tokens.length; i++) {
    if (statement.tokens[i].kind === 'word') {
      seen++;
      if (seen === statement.keywordWords) return i + 1;
    }
  }
  return statement.keywordWords ? statement.tokens.length : 0;
}

// --------------------------------------------------------------------------
// Point d'entree
// --------------------------------------------------------------------------

export function buildModel(document: ParsedDocument, options: BuildOptions = {}): Model {
  const model: Model = {
    option: document.option,
    nodes: new Map(),
    bars: new Map(),
    supports: [],
    articulations: new Map(),
    eccentric: new Set(),
    caraByBar: new Map(),
    constantsByBar: new Map(),
    materials: new Map(),
    cables: [],
    phasages: [],
    loadedBars: new Set(),
    studiedBars: new Set(),
    deckBars: [],
    scope: new Map(),
    files: [options.file ?? ''],
    fileAnchors: [0],
    includes: [],
    truncated: false,
    study: { defs: new Map(), refs: [], allRefs: [], execs: [], resuPresent: false },
  };

  const ctx: Ctx = {
    model,
    index: options.index,
    resolve: options.resolve,
    includeStack: options.file ? [normalizePath(options.file)] : [],
    anchorByFile: model.fileAnchors,
    budget: STATEMENT_BUDGET,
    dataMode: undefined,
    dataWords: [],
    referenceMode: undefined,
    cableTrace: false,
  };

  run(ctx, document.statements, 0);
  finalizePhasage(ctx);
  computeBounds(model);
  return model;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

// --------------------------------------------------------------------------
// Executeur : boucles, conditionnelles, inclusions
// --------------------------------------------------------------------------

function run(ctx: Ctx, statements: Statement[], file: number): void {
  let i = 0;
  while (i < statements.length) {
    if (ctx.budget <= 0) {
      ctx.model.truncated = true;
      return;
    }
    const statement = statements[i];
    const first = statement.tokens[0];

    // `<<` ou `>>` orphelins (corps de boucle deja consomme, ou en cours de frappe).
    if (statement.tokens.length && statement.tokens.every((t) => t.kind === 'operator' && (t.text === '<<' || t.text === '>>'))) {
      i++;
      continue;
    }

    if (first?.kind === 'word' && (first.value === 'POUR' || first.value === 'FAIRE') && !isOperator(statement.tokens[1], '=')) {
      i = execLoop(ctx, statements, i, file);
      continue;
    }
    if (first?.kind === 'word' && first.value === 'SI' && !isOperator(statement.tokens[1], '=')) {
      i = execIf(ctx, statements, i, file);
      continue;
    }
    // `LIRE` se detecte sur le premier mot : dans un corps de boucle re-analyse
    // sans index, le nom de commande n'est pas toujours resolu.
    if (first?.kind === 'word' && first.value === 'LIRE' && !isOperator(statement.tokens[1], '=')) {
      execLire(ctx, statement, file);
      i++;
      continue;
    }

    ctx.budget--;
    apply(ctx, statement, file);
    i++;
  }
}

interface BodyLocation {
  /** Corps de la boucle, sous forme d'instructions executables. */
  parts: Statement[];
  /** Instruction contenant le `>>` fermant (ou la derniere du corps si absent). */
  endIndex: number;
  /** Jetons restant apres le `>>` sur cette meme instruction (`>> sinon <<`…). */
  trailing: Token[];
}

/**
 * Delimite un corps `<< … >>` a partir du jeton `<<` situe dans
 * `statements[startIndex]` a la position `tokenIndex`. Les `<<`/`>>` interieurs
 * (boucles imbriquees) restent dans le corps et seront re-executes.
 */
function collectBody(
  ctx: Ctx,
  statements: Statement[],
  startIndex: number,
  tokenIndex: number,
): BodyLocation {
  const parts: Statement[] = [];
  let depth = 1;

  for (let i = startIndex; i < statements.length; i++) {
    const statement = statements[i];
    const tokens = statement.tokens;
    const from = i === startIndex ? tokenIndex + 1 : 0;
    let segmentStart = from;

    for (let t = from; t < tokens.length; t++) {
      if (isOperator(tokens[t], '<<')) depth++;
      else if (isOperator(tokens[t], '>>')) {
        depth--;
        if (depth === 0) {
          pushSegment(ctx, parts, statement, tokens.slice(segmentStart, t), i === startIndex && segmentStart === from);
          return { parts, endIndex: i, trailing: tokens.slice(t + 1) };
        }
      }
    }
    pushSegment(ctx, parts, statement, tokens.slice(segmentStart), i === startIndex && segmentStart === from);
  }
  // `>>` manquant (fichier en cours d'edition) : le corps court jusqu'a la fin.
  return { parts, endIndex: statements.length - 1, trailing: [] };
}

/** Ajoute un segment au corps : instruction complete reutilisee, ou tranche re-analysee. */
function pushSegment(ctx: Ctx, parts: Statement[], source: Statement, tokens: Token[], sliced: boolean): void {
  if (!tokens.length) return;
  const whole = tokens.length === source.tokens.length;
  if (whole && !sliced) {
    parts.push(source);
    return;
  }
  parts.push(virtualStatement(ctx, source, tokens));
}

/**
 * Fabrique une instruction executable a partir d'une tranche de jetons (corps
 * de boucle ecrit sur la ligne de la commande : `pour i=1 a 3 << barre i i i+1 >>`).
 */
function virtualStatement(ctx: Ctx, source: Statement, tokens: Token[]): Statement {
  const words = tokens.filter((t) => t.kind === 'word').map((t) => t.value);
  let keyword: string | undefined;
  let command: Statement['command'];
  let keywordWords = 0;

  const isAssignment = tokens[0]?.kind === 'word' && isOperator(tokens[1], '=');
  if (!isAssignment && tokens[0]?.kind === 'word') {
    const block = source.blockPath[source.blockPath.length - 1];
    const match = ctx.index ? matchCommand(ctx.index, words, block) : undefined;
    if (match) {
      keyword = normalize(match.command.name);
      command = match.command;
      keywordWords = match.wordCount;
    }
  }

  return {
    line: tokens[0]?.line ?? source.line,
    endLine: tokens[tokens.length - 1]?.line ?? source.endLine,
    tokens,
    words,
    keyword,
    command,
    keywordWords,
    blockPath: source.blockPath,
    text: tokens.map((t) => t.text).join(' '),
  };
}

/**
 * `POUR i=liste << … >>` (et la variante `FAIRE i=debut,fin(,pas)` rencontree
 * dans les etudes reelles). Retourne l'index de la premiere instruction qui
 * suit la boucle.
 */
function execLoop(ctx: Ctx, statements: Statement[], index: number, file: number): number {
  const statement = statements[index];
  const tokens = statement.tokens;
  const isFaire = tokens[0].value === 'FAIRE';

  // En-tete : POUR <variable> = <liste jusqu'a `<<` ou fin d'instruction>.
  const nameToken = tokens[1];
  if (nameToken?.kind !== 'word' || !isOperator(tokens[2], '=')) return index + 1;
  const name = nameToken.text.toLowerCase();

  let openStatement = index;
  let openToken = -1;
  const listTokens: Token[] = [];
  for (let t = 3; t < tokens.length; t++) {
    if (isOperator(tokens[t], '<<')) {
      openToken = t;
      break;
    }
    listTokens.push(tokens[t]);
  }
  if (openToken < 0) {
    // `<<` sur une instruction suivante (forme multi-lignes).
    for (let i = index + 1; i < statements.length; i++) {
      const candidate = statements[i];
      if (!candidate.tokens.length) continue;
      if (isOperator(candidate.tokens[0], '<<')) {
        openStatement = i;
        openToken = 0;
      }
      break;
    }
  }
  if (openToken < 0) return index + 1;

  const values = loopValues(ctx, listTokens, isFaire);
  const bodyLocation = collectBody(ctx, statements, openStatement, openToken);

  for (const value of values) {
    if (ctx.budget <= 0) {
      ctx.model.truncated = true;
      break;
    }
    ctx.model.scope.set(name, value);
    run(ctx, bodyLocation.parts, file);
  }

  if (bodyLocation.trailing.length) {
    run(ctx, [virtualStatement(ctx, statements[bodyLocation.endIndex], bodyLocation.trailing)], file);
  }
  return bodyLocation.endIndex + 1;
}

/** Valeurs iterees par une boucle. `FAIRE i=1,n` est un intervalle, pas une liste. */
function loopValues(ctx: Ctx, listTokens: Token[], isFaire: boolean): number[] {
  const groups = splitValues(listTokens);
  const hasRange = findWord(groups, new Set(['A'])) >= 0;
  const list = parseList(groups, 0, ctx.model.scope);

  if (isFaire && !hasRange && !list.all && list.values.length >= 2 && list.values.length <= 3) {
    const [start, end, step] = list.values;
    const range: number[] = [];
    const increment = step ?? 1;
    if (increment > 0) for (let v = start; v <= end; v += increment) range.push(v);
    else if (increment < 0) for (let v = start; v >= end; v += increment) range.push(v);
    return range;
  }
  return list.values;
}

/**
 * `SI(condition) instruction` / `SI(condition) << … >> (SINON …)`.
 * Une condition indecidable (variable inconnue) n'execute aucune branche : on
 * prefere un modele incomplet a un modele double.
 */
function execIf(ctx: Ctx, statements: Statement[], index: number, file: number): number {
  const statement = statements[index];
  const tokens = statement.tokens;

  const open = tokens.findIndex((t) => isOperator(t, '('));
  if (open < 0) return index + 1;
  let depth = 0;
  let close = -1;
  for (let t = open; t < tokens.length; t++) {
    if (isOperator(tokens[t], '(')) depth++;
    else if (isOperator(tokens[t], ')')) {
      depth--;
      if (depth === 0) {
        close = t;
        break;
      }
    }
  }
  if (close < 0) return index + 1;

  const condition = evaluateCondition(tokens.slice(open + 1, close), ctx.model.scope);

  // Branche « alors » : bloc `<< … >>` ou instruction simple sur la meme ligne.
  const afterCondition = tokens.slice(close + 1);
  let thenParts: Statement[] = [];
  let cursorStatement = index;
  let trailing: Token[] = afterCondition;

  if (afterCondition.length && isOperator(afterCondition[0], '<<')) {
    const location = collectBody(ctx, statements, index, close + 1);
    thenParts = location.parts;
    cursorStatement = location.endIndex;
    trailing = location.trailing;
  } else if (afterCondition.length) {
    thenParts = [virtualStatement(ctx, statement, afterCondition)];
    trailing = [];
  }

  // Branche « sinon » : sur la meme instruction (`>> sinon << … >>`) ou la suivante.
  let elseParts: Statement[] = [];
  let elseFrom: { statementIndex: number; tokens: Token[] } | undefined;
  if (trailing.length && trailing[0]?.kind === 'word' && trailing[0].value === 'SINON') {
    elseFrom = { statementIndex: cursorStatement, tokens: trailing.slice(1) };
  } else if (!trailing.length) {
    const next = statements[cursorStatement + 1];
    if (next?.tokens[0]?.kind === 'word' && next.tokens[0].value === 'SINON') {
      cursorStatement++;
      elseFrom = { statementIndex: cursorStatement, tokens: next.tokens.slice(1) };
    }
  }
  if (elseFrom) {
    if (elseFrom.tokens.length && isOperator(elseFrom.tokens[0], '<<')) {
      const source = statements[elseFrom.statementIndex];
      const offset = source.tokens.length - elseFrom.tokens.length;
      const location = collectBody(ctx, statements, elseFrom.statementIndex, offset);
      elseParts = location.parts;
      cursorStatement = location.endIndex;
    } else if (elseFrom.tokens.length) {
      elseParts = [virtualStatement(ctx, statements[elseFrom.statementIndex], elseFrom.tokens)];
    }
  }

  if (condition === true) run(ctx, thenParts, file);
  else if (condition === false) run(ctx, elseParts, file);
  return cursorStatement + 1;
}

/** Evalue `a = b`, `a <= b`… ou une expression seule (vraie si non nulle). */
function evaluateCondition(tokens: Token[], scope: Scope): boolean | undefined {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (isOperator(token, '(')) depth++;
    else if (isOperator(token, ')')) depth--;
    else if (depth === 0 && token.kind === 'operator' && COMPARATORS.has(token.text)) {
      const left = evaluate(tokens.slice(0, i), scope);
      const right = evaluate(tokens.slice(i + 1), scope);
      if (left === undefined || right === undefined) return undefined;
      switch (token.text) {
        case '=':
        case '==':
          return left === right;
        case '/=':
        case '<>':
          return left !== right;
        case '<':
          return left < right;
        case '>':
          return left > right;
        case '<=':
          return left <= right;
        default:
          return left >= right;
      }
    }
  }
  const value = evaluate(tokens, scope);
  return value === undefined ? undefined : value !== 0;
}

/** `LIRE 'fichier'` : execute le fichier inclus dans le meme modele. */
function execLire(ctx: Ctx, statement: Statement, file: number): void {
  if (statement.words.includes('CONSOLE')) return;
  const name = firstString(statement.tokens);
  if (!name || !name.trim()) return;

  // Ancre des diagnostics : la commande LIRE du fichier hote, meme pour une
  // inclusion imbriquee.
  const anchor = file === 0 ? statement.line : ctx.anchorByFile[file] ?? 0;
  const include: ModelInclude = { file: name, line: anchor, resolved: false };
  ctx.model.includes.push(include);

  if (!ctx.resolve || ctx.includeStack.length > MAX_INCLUDE_DEPTH) return;
  const resolved = ctx.resolve(name, ctx.model.files[file]);
  if (!resolved) return;

  const key = normalizePath(resolved.file);
  if (ctx.includeStack.includes(key)) return; // cycle `LIRE`

  include.resolved = true;
  const newIndex = ctx.model.files.push(resolved.file) - 1;
  ctx.anchorByFile[newIndex] = anchor;
  ctx.includeStack.push(key);
  run(ctx, resolved.document.statements, newIndex);
  ctx.includeStack.pop();
}

// --------------------------------------------------------------------------
// Application d'une instruction au modele
// --------------------------------------------------------------------------

function apply(ctx: Ctx, statement: Statement, file: number): void {
  const model = ctx.model;
  const groups = splitValues(body(statement));
  const keyword = statement.keyword;

  // ---- Affectations et tableaux de la pseudo-programmation -------------
  if (!keyword && statement.tokens.length >= 3) {
    const [first, second] = statement.tokens;
    if (first.kind === 'word' && second.kind === 'operator' && second.text === '=') {
      assign(model.scope, first.text, statement.tokens.slice(2));
      return;
    }
  }
  if (keyword === 'DIM') {
    const name = wordAt(groups, 0);
    if (name) model.scope.set(name.toLowerCase(), []);
    return;
  }

  // Aiguillage sur le PREMIER mot de la commande : le catalogue nomme les
  // variantes entierement (`CARA PSE`, `BARRE UNI`, `GENER NOEUD`), un
  // aiguillage sur le nom complet passerait a cote.
  const head = keyword?.split(' ')[0];
  const inBlock = inReferenceBlock(statement.blockPath);
  const inCable = statement.blockPath.includes('CABLE');
  const inPhasage = statement.blockPath.includes('PHASAGE');

  // Sortie de bloc implicite : une instruction hors du bloc CABLE/PHASAGE
  // referme l'etat correspondant.
  if (!inCable && ctx.cable) {
    ctx.cable = undefined;
    ctx.cableTrace = false;
  }
  if (!inPhasage && ctx.phase && head !== 'PHASAGE') finalizePhasage(ctx);
  if (ctx.owner && !statement.blockPath.includes(ctx.owner.block)) ctx.owner = undefined;

  if (keyword) {
    ctx.dataMode = undefined;
    ctx.dataWords = statement.words;
    if (head !== 'BARRE') ctx.referenceMode = undefined;
    ctx.refKind = undefined;
  }

  // ---- Contenu d'un bloc CABLE ------------------------------------------
  if (inCable && ctx.cable) {
    readCableContent(ctx, statement, groups, file);
    return;
  }

  // ---- Sous-commandes de reference (RESU, ENV, COMB, CHARG CABLE…) -------
  if (readStudyRefs(ctx, statement, groups, file)) return;

  // ---- Contenu d'un bloc PHASAGE (hors CHARG imbrique) -------------------
  if (inPhasage && ctx.phase && readPhaseContent(ctx, statement, file)) return;

  // ---- Contenu d'un bloc MAT/MATERIAU ------------------------------------
  if (statement.blockPath.includes('MAT') && statement.tokens[0]?.kind === 'word') {
    readMaterialContent(model, statement);
    return;
  }

  switch (head) {
    case 'OPTION': {
      const value = statement.words[1];
      if (value && OPTION_VALUES.has(value)) model.option = value as StructureOption;
      break;
    }

    case 'NOEUD': {
      // Dans un chargement, `NOEUD` designe des noeuds charges, pas une definition.
      if (inBlock) break;
      if (!groups.length) {
        ctx.dataMode = 'NOEUD';
        break;
      }
      readNodes(model, groups, statement.line, file);
      break;
    }

    case 'GENER': {
      readGener(model, statement, file);
      break;
    }

    case 'BARRE': {
      if (inBlock) {
        // `BARRE` dans un bloc de chargement / tablier : ce sont des references.
        ctx.referenceMode = statement.blockPath.includes('TABLIER') ? 'deck' : 'load';
        if (!groups.length) break; // forme bloc : les lignes suivantes portent les listes
        addReferences(model, groups, ctx.referenceMode);
        break;
      }
      if (!groups.length) {
        ctx.dataMode = 'BARRE';
        break;
      }
      readBars(model, groups, statement.line, file);
      break;
    }

    case 'APPUI': {
      if (inBlock) break; // reference dans un chargement ou un phasage
      if (!groups.length) {
        ctx.dataMode = 'APPUI';
        break;
      }
      readSupports(model, body(statement), statement.line, file, statement.words);
      break;
    }

    case 'ART': {
      readArticulations(model, groups);
      break;
    }

    case 'EXC': {
      // Forme bloc attestee (exemple 19.1) : `exc` seul, puis `4 ex y -ep`.
      if (!groups.length) {
        ctx.dataMode = 'EXC';
        break;
      }
      const list = parseList(groups, 0, model.scope);
      for (const id of list.all ? [...model.bars.keys()] : list.values) model.eccentric.add(id);
      break;
    }

    case 'CARA': {
      if (inBlock) break; // `CARA` d'une section feu : pas de caracteristiques RDM
      if (!groups.length) {
        ctx.dataMode = 'CARA';
        break;
      }
      readCara(model, groups, statement.line, file, statement.words);
      break;
    }

    case 'CONS': {
      if (inBlock) break;
      if (!groups.length) {
        ctx.dataMode = 'CONS';
        break;
      }
      readConstants(model, groups, statement.line, file);
      break;
    }

    case 'MAT':
    case 'MATERIAU': {
      if (inBlock) break; // `MAT i` d'un CONS ou d'une SECTION : reference
      const number = studyDef(model, 'MAT', statement, groups, file);
      if (number !== undefined) {
        model.materials.set(number, {
          line: statement.line,
          file,
          title: firstString(statement.tokens),
          values: new Map(),
        });
      }
      break;
    }

    case 'CHARG': {
      // `CHARG i 'Titre'` / `CHARG i COMB 'Titre'` : definition d'un cas.
      if (inBlock) break;
      const id = studyDef(model, 'CHARG', statement, groups, file);
      if (id !== undefined) ctx.owner = { kind: 'CHARG', id, block: keyword! };
      break;
    }

    case 'SURCH': {
      if (inBlock) break;
      const id = studyDef(model, 'SURCH', statement, groups, file);
      if (id !== undefined) ctx.owner = { kind: 'SURCH', id, block: 'SURCH' };
      break;
    }

    case 'COMB': {
      if (inBlock) break;
      const id = studyDef(model, 'COMB', statement, groups, file);
      if (id !== undefined) ctx.owner = { kind: 'COMB', id, block: 'COMB' };
      break;
    }

    case 'ENV': {
      // `ENV i` / `ENV i COMB` : les deux definissent une enveloppe.
      if (inBlock) break;
      const id = studyDef(model, 'ENV', statement, groups, file);
      if (id !== undefined) ctx.owner = { kind: 'ENV', id, block: keyword! };
      break;
    }

    case 'PREC': {
      if (inBlock) break; // `PREC j` d'un bloc CABLE : deja lu comme reference
      studyDef(model, 'PREC', statement, groups, file);
      break;
    }

    case 'SPECTRE': {
      if (inBlock) break;
      if (keyword === 'SPECTRE REPONSE') {
        const id = studyDef(model, 'SPECTRE REPONSE', statement, groups, file);
        if (id !== undefined) ctx.owner = { kind: 'SPECTRE REPONSE', id, block: 'SPECTRE REPONSE' };
      } else {
        studyDef(model, 'SPECTRE', statement, groups, file);
      }
      break;
    }

    case 'SECTION': {
      if (inBlock) break;
      const id = studyDef(model, 'SECTION', statement, groups, file);
      if (id !== undefined) ctx.owner = { kind: 'SECTION', id, block: 'SECTION' };
      break;
    }

    case 'EXPOSITION': {
      if (inBlock) break;
      studyDef(model, 'EXPOSITION FEU', statement, groups, file);
      break;
    }

    case 'INCENDIE': {
      if (inBlock) break;
      const id = studyDef(model, 'INCENDIE', statement, groups, file);
      if (id !== undefined) ctx.owner = { kind: 'INCENDIE', id, block: 'INCENDIE' };
      break;
    }

    case 'RESU': {
      model.study.resuPresent = true;
      break;
    }

    case 'EXEC': {
      // `EXEC CHARG (liste)`, `EXEC PHASAGE PSE`, `EXEC SPECTRE REPONSE list`…
      const target = statement.words[1] === 'SPECTRE' && statement.words[2] === 'REPONSE'
        ? 'SPECTRE REPONSE'
        : statement.words[1] ?? '';
      const { ids } = readRefIds(body(statement), model.scope);
      model.study.execs.push({
        kind: target,
        list: ids.length ? ids : null,
        line: statement.line,
        file,
      });
      // `EXEC FLAMBEMENT (CTE CHARG i) (VAR COMB j)` : references ponctuelles.
      if (target === 'FLAMBEMENT') recordPairRefs(ctx, statement, groups, file, 'EXEC FLAMBEMENT');
      break;
    }

    case 'GET': {
      // `GET EFFORT BARRE … CHARG j`, `GET TENSION CABLE i … PHASAGE j`…
      recordPairRefs(ctx, statement, groups, file, 'GET');
      break;
    }

    case 'ETUDE': {
      if (inBlock) break;
      const list = parseList(groups, 0, model.scope);
      for (const id of list.all ? [...model.bars.keys()] : list.values) model.studiedBars.add(id);
      break;
    }

    case 'CABLE': {
      if (inBlock) break; // `CABLE` dans un CHARG ou un RESU : reference, pas definition
      const number = studyDef(model, 'CABLE', statement, groups, file);
      if (number !== undefined) {
        const cable: ModelCable = {
          id: number,
          name: firstString(statement.tokens),
          points: [],
          bars: [],
          line: statement.line,
          file,
        };
        model.cables.push(cable);
        ctx.cable = cable;
        ctx.cableTrace = false;
      }
      break;
    }

    case 'PHASAGE': {
      if (inBlock) break; // `PHASAGE` dans COMB/ENV/RESU : reference
      finalizePhasage(ctx);
      studyDef(model, 'PHASAGE', statement, groups, file);
      const definition: ModelPhasage = {
        id: evaluate(groups[0] ?? [], model.scope),
        title: firstString(statement.tokens),
        line: statement.line,
        file,
        states: [],
      };
      model.phasages.push(definition);
      ctx.phase = {
        definition,
        bars: new Set(),
        supports: new Set(),
        tensioned: new Set(),
        dirty: false,
      };
      break;
    }

    default: {
      if (!keyword && ctx.referenceMode && statement.blockPath.length && groups.length) {
        addReferences(model, groups, ctx.referenceMode);
        break;
      }
      if (!keyword && ctx.dataMode) {
        readDataLine(ctx, groups, statement.tokens, statement.line, file);
      }
      // Sections d'etude en forme bloc : `liste SE liste`.
      if (!keyword && groups.length) {
        const seIndex = findWord(groups, new Set(['SE']));
        if (seIndex > 0) {
          const list = parseList(groups, 0, model.scope);
          for (const id of list.all ? [...model.bars.keys()] : list.values) model.studiedBars.add(id);
        }
      }
      break;
    }
  }
}

// --------------------------------------------------------------------------
// Lecteurs par commande
// --------------------------------------------------------------------------

/**
 * `NOEUD liste coor1 coor2 (coor3)` — piege : la liste **et** les coordonnees
 * sont numeriques, un decoupage gourmand avalerait les coordonnees dans la
 * liste. On s'appuie donc sur le nombre de coordonnees impose par l'`OPTION` :
 * ce sont les dernieres valeurs de l'instruction. La forme a mots-cles
 * `NOEUD liste (X x) (Y y) (Z z)` leve l'ambiguite d'elle-meme.
 */
function readNodes(model: Model, groups: Token[][], line: number, file: number): void {
  const axes = model.option === 'SPATIALE' ? ['X', 'Y', 'Z'] : ['X', 'Y'];
  const axisSet = new Set(axes);
  const coordinates: Record<string, number> = {};

  const firstAxis = findWord(groups, axisSet);
  let listGroups: Token[][];

  if (firstAxis >= 0) {
    listGroups = groups.slice(0, firstAxis);
    for (let i = firstAxis; i < groups.length; i++) {
      const word = wordAt(groups, i);
      if (!word || !axisSet.has(word)) continue;
      const value = evaluate(groups[i + 1] ?? [], model.scope);
      if (value !== undefined) coordinates[word] = value;
    }
  } else {
    // Forme positionnelle : les `axes.length` dernieres valeurs sont les coordonnees.
    const cut = Math.max(0, groups.length - axes.length);
    listGroups = groups.slice(0, cut);
    groups.slice(cut).forEach((group, i) => {
      const value = evaluate(group, model.scope);
      if (value !== undefined) coordinates[axes[i]] = value;
    });
  }

  const list = parseList(listGroups, 0, model.scope);
  for (const id of list.values) {
    model.nodes.set(id, {
      id,
      x: coordinates.X ?? 0,
      y: coordinates.Y ?? 0,
      z: coordinates.Z ?? 0,
      line,
      file,
    });
  }
}

/** `GENER n NOEUD (ID) j (pas0) X c1 (pas1) Y c2 (pas2) Z c3 (pas3)` (p.46) */
function readGener(model: Model, statement: Statement, file: number): void {
  const words = statement.words;
  const isNode = words.includes('NOEUD');
  const isBar = words.includes('BARRE');
  if (!isNode && !isBar) return;

  // Le compte precede le mot NOEUD/BARRE ; il figure donc dans les groupes si
  // la commande a ete reconnue comme `GENER`, sinon en tete du corps.
  const all = splitValues(statement.tokens);
  const kindIndex = all.findIndex((g) => g.length === 1 && g[0].kind === 'word' && (g[0].value === 'NOEUD' || g[0].value === 'BARRE'));
  const count = evaluate(all[kindIndex - 1] ?? [], model.scope);
  if (count === undefined || count <= 0) return;

  let index = kindIndex + 1;
  if (wordAt(all, index) === 'ID') index++;

  const first = evaluate(all[index] ?? [], model.scope);
  if (first === undefined) return;
  index++;
  let numberStep = 1;
  const maybeStep = evaluate(all[index] ?? [], model.scope);
  if (maybeStep !== undefined && wordAt(all, index) === undefined) {
    numberStep = maybeStep;
    index++;
  }

  if (isNode) {
    const axes = model.option === 'SPATIALE' ? ['X', 'Y', 'Z'] : ['X', 'Y'];
    const origin: Record<string, number> = {};
    const step: Record<string, number> = {};
    while (index < all.length) {
      const word = wordAt(all, index);
      if (!word || !axes.includes(word)) break;
      const base = evaluate(all[index + 1] ?? [], model.scope);
      index += 2;
      const increment = wordAt(all, index) === undefined ? evaluate(all[index] ?? [], model.scope) : undefined;
      if (increment !== undefined) index++;
      if (base !== undefined) origin[word] = base;
      step[word] = increment ?? 0;
    }
    for (let k = 0; k < count; k++) {
      const id = Math.round(first + k * numberStep);
      model.nodes.set(id, {
        id,
        x: (origin.X ?? 0) + k * (step.X ?? 0),
        y: (origin.Y ?? 0) + k * (step.Y ?? 0),
        z: (origin.Z ?? 0) + k * (step.Z ?? 0),
        line: statement.line,
        file,
      });
    }
    return;
  }

  // `GENER n BARRE (ID) j (pas0) DE j1 (pas1) A j2 (pas2)`
  const deIndex = findWord(all, new Set(['DE']), index);
  if (deIndex < 0) return;
  const origin = evaluate(all[deIndex + 1] ?? [], model.scope);
  let cursor = deIndex + 2;
  let originStep = 0;
  if (wordAt(all, cursor) === undefined && all[cursor]) {
    originStep = evaluate(all[cursor], model.scope) ?? 0;
    cursor++;
  }
  const aIndex = findWord(all, new Set(['A']), cursor);
  if (aIndex < 0 || origin === undefined) return;
  const end = evaluate(all[aIndex + 1] ?? [], model.scope);
  let endStep = 0;
  if (all[aIndex + 2] && wordAt(all, aIndex + 2) === undefined) {
    endStep = evaluate(all[aIndex + 2], model.scope) ?? 0;
  }
  if (end === undefined) return;

  for (let k = 0; k < count; k++) {
    const id = Math.round(first + k * numberStep);
    model.bars.set(id, {
      id,
      from: Math.round(origin + k * originStep),
      to: Math.round(end + k * endStep),
      line: statement.line,
      file,
    });
  }
}

function readBars(model: Model, groups: Token[][], line: number, file: number): void {
  const deIndex = findWord(groups, new Set(['DE']));
  if (deIndex >= 0) {
    const list = parseList(groups, 0, model.scope);
    const aIndex = findWord(groups, new Set(['A']), deIndex + 1);
    const from = evaluate(groups[deIndex + 1] ?? [], model.scope);
    const to = aIndex >= 0 ? evaluate(groups[aIndex + 1] ?? [], model.scope) : undefined;
    if (from === undefined || to === undefined) return;
    for (const id of list.values) model.bars.set(id, { id, from, to, line, file });
    return;
  }

  // Forme courte `BARRE liste j1 j2` : les deux dernieres valeurs sont les noeuds.
  const values = groups.map((g) => evaluate(g, model.scope));
  if (values.length < 3 || values.some((v) => v === undefined)) {
    const list = parseList(groups, 0, model.scope);
    if (list.values.length >= 3) {
      const to = list.values.pop()!;
      const from = list.values.pop()!;
      for (const id of list.values) model.bars.set(id, { id, from, to, line, file });
    }
    return;
  }
  const numbers = values as number[];
  const to = numbers.pop()!;
  const from = numbers.pop()!;
  for (const id of numbers) model.bars.set(Math.round(id), { id: Math.round(id), from, to, line, file });
}

/**
 * `APPUI liste (NOEUD listen) (ddl…)` et variantes `APPUI EL (DI)` : la liste
 * des numeros d'appui doit etre lue au sens strict des virgules — pour
 * `APPUI 1,3 EL 26924.`, la raideur 26924 suit la liste sans virgule et n'est
 * PAS un numero d'appui (le mot `EL` peut avoir ete consomme par le nom de la
 * commande `APPUI EL`, d'ou `words`).
 */
function readSupports(model: Model, tokens: Token[], line: number, file: number, words: string[] = []): void {
  const list = readRefIds(tokens, model.scope);
  const groups = splitValues(tokens);
  let index = list.consumed;

  let nodes = list.ids;
  if (wordAt(groups, index) === 'NOEUD') {
    const nodeList = parseList(groups, index + 1, model.scope);
    if (nodeList.values.length) nodes = nodeList.values;
    index = index + 1 + nodeList.consumed;
  }

  const ddl: string[] = [];
  let elastic = words.includes('EL');
  let decol = false;
  for (let i = index; i < groups.length; i++) {
    const word = wordAt(groups, i);
    if (!word) continue;
    if (DDL_WORDS.has(word)) ddl.push(word);
    else if (word === 'EL') elastic = true;
    else if (word === 'DECOL') decol = true;
  }

  for (let i = 0; i < list.ids.length; i++) {
    model.supports.push({
      id: list.ids[i],
      node: nodes[i] ?? nodes[nodes.length - 1] ?? list.ids[i],
      ddl,
      elastic,
      decol,
      line,
      file,
    });
  }
}

function readArticulations(model: Model, groups: Token[][]): void {
  const list = parseList(groups, 0, model.scope);
  const or: string[] = [];
  const ex: string[] = [];
  let target: string[] | undefined;
  for (let i = list.consumed; i < groups.length; i++) {
    const word = wordAt(groups, i);
    if (word === 'OR') target = or;
    else if (word === 'EX') target = ex;
    else if (word && (word === 'RY' || word === 'RZ') && target) target.push(word);
  }
  const targets = list.all ? [...model.bars.keys()] : list.values;
  for (const id of targets) model.articulations.set(id, { or, ex });
}

/**
 * `words` porte les mots de l'instruction complete : selon que le catalogue
 * nomme la commande `CARA` ou `CARA PSE`, le mot `PSE` est present ou non dans
 * les groupes restants. On regarde donc les deux.
 */
function readCara(model: Model, groups: Token[][], line: number, file: number, words: string[] = []): void {
  // Formes `CARA PSE liste …`, `CARA VAR LIN Y liste`, `CARA VAR PARA liste`,
  // `CARA SPECIAL j` (element special, sans barre associee).
  if (words.includes('SPECIAL') || wordAt(groups, 0) === 'SPECIAL') return;

  const pse = words.includes('PSE') || wordAt(groups, 0) === 'PSE';
  const variable = words.includes('VAR') || wordAt(groups, 0) === 'VAR';
  let start = 0;
  const head = wordAt(groups, 0);
  if (head === 'PSE') {
    start = 1;
  } else if (head === 'VAR') {
    start = wordAt(groups, 1) === 'LIN' ? 3 : 2;
  } else if (words.includes('VAR')) {
    // Le nom de la commande a deja consomme `VAR LIN` / `VAR PARA`.
    start = wordAt(groups, 0) === 'Y' || wordAt(groups, 0) === 'Z' ? 1 : 0;
  }

  const list = parseList(groups, start, model.scope);
  if (!list.values.length && !list.all) return;

  // `CARA liste SECTION is` (calcul au feu, p.227) : reference une section.
  let section: number | undefined;
  const sectionIndex = findWord(groups, new Set(['SECTION']), start + list.consumed);
  if (sectionIndex >= 0) {
    section = evaluate(groups[sectionIndex + 1] ?? [], model.scope);
    if (section !== undefined) model.study.refs.push({ kind: 'SECTION', id: section, line, file, via: 'CARA' });
  }

  // Chaque propriete est suivie de sa valeur (deux valeurs pour `CARA VAR`,
  // origine puis extremite : on retient la premiere).
  const props = new Map<string, number | undefined>();
  for (let i = start + list.consumed; i < groups.length; i++) {
    const word = wordAt(groups, i);
    if (!word || !CARA_PROPS.has(word)) continue;
    const next = groups[i + 1];
    props.set(word, next && wordAt(groups, i + 1) === undefined ? evaluate(next, model.scope) : undefined);
  }

  const targets = list.all ? [...model.bars.keys()] : list.values;
  for (const id of targets) {
    const existing = model.caraByBar.get(id);
    if (existing) {
      for (const [name, value] of props) existing.props.set(name, value ?? existing.props.get(name));
      existing.pse ||= pse;
      existing.variable ||= variable;
      if (section !== undefined) existing.section = section;
    } else {
      model.caraByBar.set(id, { props: new Map(props), line, file, pse, variable: variable || undefined, section });
    }
  }
}

/** Rattache une liste de barres a un chargement ou a un tablier. */
function addReferences(model: Model, groups: Token[][], mode: 'load' | 'deck'): void {
  const list = parseList(groups, 0, model.scope);
  const targets = list.all ? [...model.bars.keys()] : list.values;
  if (mode === 'deck') for (const id of targets) model.deckBars.push(id);
  else for (const id of targets) model.loadedBars.add(id);
}

/** Ligne de donnees d'une commande en forme bloc (`NOEUD` seul puis les lignes). */
function readDataLine(ctx: Ctx, groups: Token[][], tokens: Token[], line: number, file: number): void {
  if (!groups.length) return;
  const model = ctx.model;
  if (ctx.dataMode === 'NOEUD') readNodes(model, groups, line, file);
  else if (ctx.dataMode === 'BARRE') readBars(model, groups, line, file);
  else if (ctx.dataMode === 'CARA') readCara(model, groups, line, file, ctx.dataWords);
  else if (ctx.dataMode === 'CONS') readConstants(model, groups, line, file);
  else if (ctx.dataMode === 'APPUI') readSupports(model, tokens, line, file, ctx.dataWords);
  else if (ctx.dataMode === 'EXC') {
    const list = parseList(groups, 0, model.scope);
    for (const id of list.all ? [...model.bars.keys()] : list.values) model.eccentric.add(id);
  }
}

/** `CONS liste (E e) (NU nu) …` ou `CONS liste MAT i`. */
function readConstants(model: Model, groups: Token[][], line: number, file: number): void {
  const list = parseList(groups, 0, model.scope);
  const values = new Map<string, number>();
  let material: number | undefined;

  for (let i = list.consumed; i < groups.length; i++) {
    const word = wordAt(groups, i);
    if (!word) continue;
    if (word === 'MAT') {
      material = evaluate(groups[i + 1] ?? [], model.scope);
      i++;
    } else if (CONS_PROPS.has(word)) {
      const value = evaluate(groups[i + 1] ?? [], model.scope);
      if (value !== undefined) values.set(word, value);
      i++;
    }
  }

  if (material !== undefined) {
    model.study.refs.push({ kind: 'MAT', id: material, line, file, via: 'CONS' });
  }

  const targets = list.all ? [...model.bars.keys()] : list.values;
  for (const id of targets) {
    const existing = model.constantsByBar.get(id);
    if (existing) {
      if (material !== undefined) existing.material = material;
      for (const [name, value] of values) existing.values.set(name, value);
    } else {
      model.constantsByBar.set(id, { line, file, material, values: new Map(values) });
    }
  }
}

/** Constantes numeriques directes d'un bloc `MATERIAU` (`RO 2.5`, `NU 0.2`…). */
function readMaterialContent(model: Model, statement: Statement): void {
  const material = [...model.materials.values()].pop();
  if (!material) return;
  const name = statement.words[0];
  if (!name || !CONS_PROPS.has(name)) return;
  // `E EC2 TM2 FCK 40` : module defini par une loi, pas par une valeur directe.
  const first = splitValues(statement.tokens.slice(1))[0];
  const value = first ? evaluate(first, model.scope) : undefined;
  if (value !== undefined) material.values.set(name, value);
}

// --------------------------------------------------------------------------
// Cables de precontrainte
// --------------------------------------------------------------------------

/**
 * Contenu d'un bloc `CABLE i … FIN` : rattachement aux barres, precontrainte,
 * et surtout le trace geometrique (`TRACE` puis une ligne par point).
 */
function readCableContent(ctx: Ctx, statement: Statement, groups: Token[][], file: number): void {
  const cable = ctx.cable!;
  const model = ctx.model;
  const head = statement.words[0];

  if (statement.keyword) {
    if (head === 'BARRE') {
      const list = parseList(groups, 0, model.scope);
      cable.bars.push(...(list.all ? [...model.bars.keys()] : list.values));
      return;
    }
    if (head === 'PREC') {
      cable.prec = evaluate(groups[0] ?? [], model.scope);
      if (cable.prec !== undefined) studyRef(ctx, 'PREC', cable.prec, statement, file, 'CABLE');
      return;
    }
    if (head === 'TRACE') {
      ctx.cableTrace = true;
      cable.traceDeclared = true;
      if (statement.words.includes('EXTERIEUR')) cable.exterior = true;
      return;
    }
    // `TENSION`, `PAS CABLE`, `LG GAINE`… : sans effet sur la geometrie.
    return;
  }

  if (!ctx.cableTrace || !groups.length) return;

  // Certaines etudes reelles ecrivent `PAS_CABLE` / `LG_GAINE` en un seul mot :
  // non reconnues par le catalogue, ces lignes arriveraient ici. Un point de
  // trace commence par une coordonnee (`X`, `Y`, `Z`) ou par un nombre.
  const first = wordAt(groups, 0);
  if (first && !['X', 'Y', 'Z'].includes(first)) return;

  const axes = new Set(['X', 'Y', 'Z']);
  const coordinates: Record<string, number> = {};
  let cursor = 0;

  if (first && axes.has(first)) {
    for (; cursor < groups.length; cursor++) {
      const word = wordAt(groups, cursor);
      if (!word) continue;
      if (!axes.has(word)) break; // fin des coordonnees, place aux modificateurs
      const value = evaluate(groups[cursor + 1] ?? [], model.scope);
      if (value !== undefined) coordinates[word] = value;
      cursor++;
    }
  } else {
    // Forme positionnelle : x y (z), puis eventuels modificateurs.
    const order = model.option === 'SPATIALE' ? ['X', 'Y', 'Z'] : ['X', 'Y'];
    for (; cursor < groups.length && cursor < order.length; cursor++) {
      if (wordAt(groups, cursor) !== undefined) break;
      const value = evaluate(groups[cursor], model.scope);
      if (value === undefined) break;
      coordinates[order[cursor]] = value;
    }
  }

  if (!('X' in coordinates) && !('Y' in coordinates) && !('Z' in coordinates)) return;

  // Modificateurs d'allure : ST1 interpole le trace par des cubiques, ces
  // indications sont donc necessaires pour dessiner la vraie forme du cable.
  const point: CablePoint = { x: coordinates.X ?? 0, y: coordinates.Y ?? 0, z: coordinates.Z ?? 0 };
  for (; cursor < groups.length; cursor++) {
    const word = wordAt(groups, cursor);
    if (!word) continue;
    if (word === 'ALIGNE') point.aligne = true;
    else if (word === 'PENTE' || word === 'GIS' || word === 'RAYON') {
      const value = evaluate(groups[cursor + 1] ?? [], model.scope);
      if (value !== undefined) {
        if (word === 'PENTE') point.pente = value;
        else if (word === 'GIS') point.gis = value;
        else point.rayon = value;
      }
      cursor++;
    }
  }
  cable.points.push(point);
}

// --------------------------------------------------------------------------
// Phasage de construction
// --------------------------------------------------------------------------

/**
 * Contenu d'un bloc `PHASAGE … FIN PHASAGE`. Retourne vrai si l'instruction a
 * ete consommee (les `CHARG` imbriques repassent par le traitement general).
 */
function readPhaseContent(ctx: Ctx, statement: Statement, file: number): boolean {
  const phase = ctx.phase!;
  const model = ctx.model;
  const words = statement.words;
  const head = words[0];
  if (!head || statement.tokens[0]?.kind !== 'word') return false;

  // `FIN PHASAGE` : instantane final implicite.
  if (head === 'FIN') {
    if (words[1] === 'PHASAGE') finalizePhasage(ctx);
    return true;
  }

  const groupsAfter = (skip: number): Token[][] => {
    let seen = 0;
    return splitValues(statement.tokens.filter((token) => {
      if (token.kind === 'word' && seen < skip) {
        seen++;
        return false;
      }
      return true;
    }));
  };

  if ((head === 'ACTIVER' || head === 'DESACTIVER') && words[1]) {
    const target = words[1];
    const groups = groupsAfter(2);
    const list = parseList(groups, 0, model.scope);
    if (target === 'BARRE' || target === 'BARRES') {
      const ids = list.all ? [...model.bars.keys()] : list.values;
      for (const id of ids) (head === 'ACTIVER' ? phase.bars.add(id) : phase.bars.delete(id));
      phase.dirty = true;
    } else if (target === 'APPUI' || target === 'APPUIS') {
      const ids = list.all ? model.supports.map((s) => s.id) : list.values;
      for (const id of ids) (head === 'ACTIVER' ? phase.supports.add(id) : phase.supports.delete(id));
      phase.dirty = true;
    } else if (target === 'ENV') {
      // `ACTIVER/DESACTIVER ENV liste` : bascule d'enveloppes (p.183-184).
      for (const id of list.values) studyRef(ctx, 'ENV', id, statement, file, head);
    } else if (target === 'TOUT') {
      for (const id of model.bars.keys()) (head === 'ACTIVER' ? phase.bars.add(id) : phase.bars.delete(id));
      for (const support of model.supports) (head === 'ACTIVER' ? phase.supports.add(support.id) : phase.supports.delete(support.id));
      phase.dirty = true;
    }
    return true;
  }

  if (PHASE_CABLE_ACTIONS.has(head) && words.some((w) => w === 'CABLE' || w === 'CABLES')) {
    const cableIndex = words.findIndex((w) => w === 'CABLE' || w === 'CABLES');
    const groups = groupsAfter(cableIndex + 1);
    const list = parseList(groups, 0, model.scope);
    const ids = list.all ? model.cables.map((c) => c.id) : list.values;
    for (const id of ids) {
      if (!list.all) studyRef(ctx, 'CABLE', id, statement, file, head);
      if (head === 'DETENDRE') phase.tensioned.delete(id);
      else if (head === 'TENDRE' || head === 'TENDRE_BANC') phase.tensioned.add(id);
      // `INJECTER` / `RELACHER_BANC` ne changent pas l'etat tendu/detendu.
    }
    phase.dirty = true;
    return true;
  }

  if (head === 'DATE') {
    const groups = groupsAfter(1);
    phase.date = evaluate(groups[0] ?? [], model.scope);
    return true;
  }

  if (head === 'ETAT') {
    const groups = groupsAfter(1);
    const id = evaluate(groups[0] ?? [], model.scope);
    if (id !== undefined) {
      let byId = model.study.defs.get('ETAT');
      if (!byId) model.study.defs.set('ETAT', (byId = new Map()));
      byId.set(id, { id, title: firstString(statement.tokens), line: statement.line, file });
    }
    pushPhaseState(phase, {
      id,
      title: firstString(statement.tokens),
      line: statement.line,
      file,
    });
    return true;
  }

  if (head === 'SUITE' && words[1] === 'PHASAGE') {
    // Reprise d'un phasage precedent : on herite de son dernier etat connu.
    const groups = groupsAfter(2);
    const list = parseList(groups, 0, model.scope);
    for (const id of list.values) studyRef(ctx, 'PHASAGE', id, statement, file, 'SUITE PHASAGE');
    for (const id of list.values) {
      const previous = model.phasages.find((p) => p.id === id);
      const last = previous?.states[previous.states.length - 1];
      if (!last) continue;
      for (const bar of last.bars) phase.bars.add(bar);
      for (const support of last.supports) phase.supports.add(support);
      for (const cable of last.tensioned) phase.tensioned.add(cable);
    }
    return true;
  }

  // `VERINER APPUI`, `MODIFIER APPUI`, `ENV`… : sans effet sur les instantanes.
  // Les `CHARG` imbriques (head `CHARG`, `BARRE`, `NOEUD`, lignes de donnees)
  // repassent par le traitement general pour alimenter `loadedBars`.
  return !['CHARG', 'BARRE', 'NOEUD', 'POIDS'].includes(head) && Boolean(statement.keyword);
}

function pushPhaseState(
  phase: PhaseTracking,
  at: { id?: number; title?: string; line: number; file: number },
): void {
  phase.definition.states.push({
    ...at,
    date: phase.date,
    bars: [...phase.bars].sort((a, b) => a - b),
    supports: [...phase.supports].sort((a, b) => a - b),
    tensioned: [...phase.tensioned].sort((a, b) => a - b),
  });
  phase.dirty = false;
}

/** Cloture le phasage courant : etat final implicite si des actions restent. */
function finalizePhasage(ctx: Ctx): void {
  const phase = ctx.phase;
  if (!phase) return;
  if (phase.dirty || !phase.definition.states.length) {
    pushPhaseState(phase, {
      title: 'fin du phasage',
      line: phase.definition.line,
      file: phase.definition.file,
    });
  }
  ctx.phase = undefined;
}

// --------------------------------------------------------------------------

function computeBounds(model: Model): void {
  if (!model.nodes.size) return;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const node of model.nodes.values()) {
    const point: [number, number, number] = [node.x, node.y, node.z];
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], point[i]);
      max[i] = Math.max(max[i], point[i]);
    }
  }
  model.bounds = { min, max };
}
