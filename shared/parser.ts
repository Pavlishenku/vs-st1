/**
 * Analyse syntaxique ST1 : jetons -> instructions -> blocs.
 *
 * Une instruction est delimitee par une fin de ligne ou par `;` (p.30). Une
 * ligne terminee par une virgule poursuit la liste sur la ligne suivante
 * (p.31), les deux lignes forment alors une seule instruction.
 *
 * Un bloc est ouvert par une commande porteuse d'un terminateur au catalogue
 * (`MAT … FIN`, `PHASAGE … FIN PHASAGE`) et ferme par ce terminateur. Les blocs
 * s'imbriquent : un `CHARG … FIN` est valide a l'interieur d'un `PHASAGE`.
 */

import type { CatalogCommand, CatalogIndex, StructureOption } from './catalog.js';
import { blockOf, matchCommand, normalize } from './catalog.js';
import { lex, type LexLine, type Token } from './lexer.js';

export interface Statement {
  /** Ligne de debut, base 0. */
  line: number;
  /** Ligne de fin (differente si la liste s'etend sur plusieurs lignes). */
  endLine: number;
  tokens: Token[];
  /** Valeurs des jetons `word`, en MAJUSCULES, dans l'ordre. */
  words: string[];
  /** Nom normalise de la commande reconnue, si reconnue. */
  keyword?: string;
  command?: CatalogCommand;
  /** Nombre de jetons `word` consommes par le nom de la commande. */
  keywordWords: number;
  /** Pile des blocs englobants, du plus externe au plus interne. */
  blockPath: string[];
  /** Texte du code, commentaire exclu. */
  text: string;
}

export interface Block {
  name: string;
  command?: CatalogCommand;
  terminator?: string;
  startLine: number;
  /** Ligne du terminateur, ou derniere ligne du document si non ferme. */
  endLine: number;
  closed: boolean;
  statements: Statement[];
  depth: number;
  /**
   * Bloc **souple** : commande qui porte des sous-commandes sans etre fermee par
   * un terminateur. ST1 en compte plusieurs — `CARA VAR LIN Y liste` suivi de
   * `OR …` / `EX …`, `ETUDE` suivi de `liste SE liste`, `TRACE` suivi de ses
   * points. Un tel bloc se referme de lui-meme des qu'une commande qui ne lui
   * appartient pas apparait.
   */
  soft?: boolean;
}

export interface ParsedDocument {
  lexLines: LexLine[];
  statements: Statement[];
  blocks: Block[];
  /** Option de structure declaree, ou `null` si absente. */
  option: StructureOption | null;
  optionLine: number;
  /** Instructions de premier niveau uniquement. */
  topLevel: Statement[];
}

const OPTION_VALUES = new Set(['PLANE', 'GRILL', 'SPATIALE']);

/** Reconstruit le texte d'une instruction a partir de ses jetons. */
function statementText(tokens: Token[]): string {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0 && !tokens[i].glued) out += ' ';
    out += tokens[i].text;
  }
  return out;
}

/** Decoupe les lignes lexees en instructions, en respectant `;` et la continuation. */
function splitStatements(lexLines: LexLine[]): { tokens: Token[]; line: number; endLine: number }[] {
  const result: { tokens: Token[]; line: number; endLine: number }[] = [];
  let buffer: Token[] = [];
  let start = -1;
  let end = -1;

  const flush = () => {
    if (buffer.length) result.push({ tokens: buffer, line: start, endLine: end });
    buffer = [];
    start = -1;
  };

  for (let index = 0; index < lexLines.length; index++) {
    const lexLine = lexLines[index];
    for (const token of lexLine.tokens) {
      if (token.kind === 'separator' && token.text === ';') {
        flush();
        continue;
      }
      if (start < 0) start = token.line;
      end = token.line;
      buffer.push(token);
    }
    // Une ligne qui ne se termine pas par une virgule clot l'instruction.
    if (!lexLine.continues) flush();
  }
  flush();
  return result;
}

/**
 * Referme un bloc souple sur sa derniere instruction reelle : les lignes vides
 * et les commentaires qui suivent n'en font pas partie, et ne doivent donc pas
 * heriter de son indentation.
 */
function closeSoft(block: Block): void {
  const last = block.statements[block.statements.length - 1];
  block.endLine = last ? last.endLine : block.startLine;
  block.closed = true;
}

/**
 * Position, dans la pile, du bloc que ces premiers mots referment.
 * Le terminateur le plus long gagne (`FIN PHASAGE` avant `FIN`), et a longueur
 * egale c'est le bloc le plus interne. Retourne -1 si aucun ne correspond.
 */
function findClosingBlock(stack: Block[], words: string[]): number {
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const key = words.slice(0, n).join(' ');
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].terminator === key) return i;
    }
  }
  return -1;
}

/** Commandes de premier niveau qui referment implicitement un bloc `MAT` oublie. */
const MAT_INTERRUPTERS = new Set([
  'OPTION', 'NOEUD', 'APPUI', 'BARRE', 'CARA', 'CONS', 'PREC', 'CABLE',
  'CHARG', 'TABLIER', 'SURCH', 'PHASAGE', 'EXEC', 'RESU', 'ETUDE', 'COMB', 'ENV',
]);

export function parse(text: string, index: CatalogIndex): ParsedDocument {
  const lexLines = lex(text);
  const raw = splitStatements(lexLines);

  const statements: Statement[] = [];
  const blocks: Block[] = [];
  const topLevel: Statement[] = [];
  const stack: Block[] = [];
  let option: StructureOption | null = null;
  let optionLine = -1;

  for (const entry of raw) {
    const words = entry.tokens.filter((t) => t.kind === 'word').map((t) => t.value);
    if (!words.length && !entry.tokens.length) continue;

    const current = stack[stack.length - 1];

    // --- Terminateurs -----------------------------------------------------
    // Ils ne se limitent pas a `FIN` : `PHASAGE` se ferme par `FIN PHASAGE` et
    // le mode graphique `DESS` par `RETOUR`. On cherche donc, parmi les blocs
    // ouverts, celui dont le terminateur correspond aux premiers mots — le plus
    // long d'abord, pour que `FIN PHASAGE` l'emporte sur `FIN`.
    const closingIndex = findClosingBlock(stack, words);
    const closesSoftOnly = closingIndex < 0 && words[0] === 'FIN' && Boolean(current?.soft);

    if (closingIndex >= 0 || closesSoftOnly) {
      const target = closingIndex >= 0 ? stack[closingIndex] : undefined;
      const terminatorWords = target ? target.terminator!.split(' ').length : 1;
      const statement: Statement = {
        line: entry.line,
        endLine: entry.endLine,
        tokens: entry.tokens,
        words,
        keyword: target ? target.terminator! : 'FIN',
        keywordWords: terminatorWords,
        blockPath: stack.map((b) => b.name),
        text: statementText(entry.tokens),
      };
      statements.push(statement);
      current?.statements.push(statement);

      // Tout ce qui est ouvert au-dessus de la cible se referme avec elle.
      // La borne est figee AVANT la boucle : `stack.length` diminue a chaque
      // tour, une borne relative ne s'atteindrait jamais.
      const floor = closingIndex >= 0 ? closingIndex : stack.length - 1;
      while (stack.length > floor) {
        const inner = stack.pop()!;
        if (inner.soft) closeSoft(inner);
        else {
          inner.endLine = entry.endLine;
          inner.closed = inner === target;
        }
      }
      continue;
    }

    // `FIN` qui ne ferme rien : signale par la validation. `RETOUR` est exclu,
    // c'est aussi une commande a part entiere hors du mode graphique (p.37).
    if (!stack.length && words[0] === 'FIN') {
      const statement: Statement = {
        line: entry.line,
        endLine: entry.endLine,
        tokens: entry.tokens,
        words,
        keyword: words[0] === 'FIN' && words[1] === 'PHASAGE' ? 'FIN PHASAGE' : words[0],
        keywordWords: words[0] === 'FIN' && words[1] === 'PHASAGE' ? 2 : 1,
        blockPath: [],
        text: statementText(entry.tokens),
      };
      statements.push(statement);
      topLevel.push(statement);
      continue;
    }

    // --- Fermeture implicite d'un bloc MAT laisse ouvert. -------------------
    if (current?.name === 'MAT' && MAT_INTERRUPTERS.has(words[0])) {
      const orphan = stack.pop()!;
      orphan.endLine = entry.line - 1;
    }

    // --- Fermeture des blocs souples que cette instruction quitte. ----------
    // Une ligne de donnees non reconnue reste dans le bloc souple ; une
    // commande qui n'en est pas une sous-commande le referme.
    while (stack.length && stack[stack.length - 1].soft) {
      const soft = stack[stack.length - 1];
      const inner = matchCommand(index, words, soft.name);
      if (!inner || blockOf(inner.command.context) === soft.name) break;
      stack.pop();
      closeSoft(soft);
    }

    const enclosing = stack[stack.length - 1];
    // Une commande ST1 commence TOUJOURS par son mot-cle. Une instruction qui
    // debute par une valeur est une ligne de donnees d'une forme bloc
    // (`1 lin xl 0. 1. rel fx 10. 0.` sous `barre`) : la faire correspondre a
    // une commande sur un mot-cle plus loin dans la ligne serait une erreur.
    const startsWithKeyword = entry.tokens[0]?.kind === 'word';
    const match = startsWithKeyword ? matchCommand(index, words, enclosing?.name) : undefined;

    const statement: Statement = {
      line: entry.line,
      endLine: entry.endLine,
      tokens: entry.tokens,
      words,
      keyword: match ? normalize(match.command.name) : undefined,
      command: match?.command,
      keywordWords: match?.wordCount ?? 0,
      blockPath: stack.map((b) => b.name),
      text: statementText(entry.tokens),
    };
    statements.push(statement);
    if (enclosing) enclosing.statements.push(statement);
    else topLevel.push(statement);

    if (statement.keyword === 'OPTION' && OPTION_VALUES.has(words[1])) {
      option = words[1] as StructureOption;
      if (optionLine < 0) optionLine = entry.line;
    }

    // --- Ouverture d'un bloc. ---------------------------------------------
    const terminator = match?.command.terminator?.toUpperCase();
    if (match && !terminator && index.byBlock.has(normalize(match.command.name))) {
      // Bloc souple : la commande porte des sous-commandes mais aucun terminateur.
      const block: Block = {
        name: normalize(match.command.name),
        command: match.command,
        startLine: entry.line,
        endLine: entry.endLine,
        closed: false,
        statements: [],
        depth: stack.length,
        soft: true,
      };
      blocks.push(block);
      stack.push(block);
    } else if (terminator) {
      // Bloc ecrit entierement sur une instruction : `RESU BARRE EFFORT FIN`.
      const tail = words.slice(-terminator.split(' ').length).join(' ');
      if (tail === terminator) {
        blocks.push({
          name: normalize(match!.command.name),
          command: match!.command,
          terminator,
          startLine: entry.line,
          endLine: entry.endLine,
          closed: true,
          statements: [statement],
          depth: stack.length,
        });
      } else {
        const block: Block = {
          name: normalize(match!.command.name),
          command: match!.command,
          terminator,
          startLine: entry.line,
          endLine: entry.endLine,
          closed: false,
          statements: [],
          depth: stack.length,
        };
        blocks.push(block);
        stack.push(block);
      }
    }
  }

  // Blocs restes ouverts en fin de document. Un bloc souple s'arrete a sa
  // derniere instruction ; un bloc dur reste ouvert jusqu'a la fin du fichier,
  // ce qui permet de signaler le terminateur manquant a la bonne place.
  for (const block of stack) {
    if (block.soft) closeSoft(block);
    else block.endLine = Math.max(block.endLine, lexLines.length - 1);
  }

  return { lexLines, statements, blocks, option, optionLine, topLevel };
}

/** Nom du bloc englobant une ligne donnee, pour la completion contextuelle. */
export function blockAtLine(document: ParsedDocument, line: number): Block | undefined {
  let found: Block | undefined;
  for (const block of document.blocks) {
    if (block.startLine <= line && line <= block.endLine) {
      if (!found || block.depth > found.depth) found = block;
    }
  }
  return found;
}

/** Instruction couvrant une ligne donnee. */
export function statementAtLine(document: ParsedDocument, line: number): Statement | undefined {
  return document.statements.find((s) => s.line <= line && line <= s.endLine);
}
