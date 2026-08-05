/**
 * Analyse lexicale ST1.
 *
 * Regles du manuel v24 (p.30-32) implementees ici :
 *  - commentaire `#` jusqu'a la fin de ligne (hors chaine) ;
 *  - separateur de commandes `;` sur une meme ligne ;
 *  - chaines entre quotes simples, quote interne doublee `''` ;
 *  - nombres avec notation scientifique `e` **et** notation Fortran `d` ;
 *  - variables tampon `$nom` (casse indifferente) ;
 *  - **aucun caractere blanc dans une expression** : on memorise donc, pour
 *    chaque jeton, s'il est colle au precedent (`glued`). C'est ce qui permet
 *    de distinguer `1+2 +3` (deux valeurs) de `1+2+3` (une valeur).
 */

export type TokenKind =
  | 'word'
  | 'number'
  | 'string'
  | 'variable'
  | 'operator'
  | 'separator'
  | 'comment';

export interface Token {
  kind: TokenKind;
  /** Texte brut, tel qu'ecrit. */
  text: string;
  /** Pour un `word` : texte en MAJUSCULES. Pour un `number` : valeur. */
  value: string;
  line: number;
  /** Colonne de debut, base 0. */
  start: number;
  /** Colonne de fin, exclusive. */
  end: number;
  /** Vrai si le jeton touche le precedent, sans blanc intercale. */
  glued: boolean;
}

const OPERATORS = ['**', '<=', '>=', '==', '/=', '<>', '<<', '>>', '+', '-', '*', '/', '=', '<', '>', '(', ')'];

/** Nombre ST1 : entier, decimal, notation scientifique `e` ou Fortran `d`. */
const NUMBER_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?/;
const WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const VARIABLE_RE = /^\$[A-Za-z_][A-Za-z0-9_]*/;

export interface LexLine {
  line: number;
  tokens: Token[];
  comment?: Token;
  /** Texte brut de la ligne, commentaire compris. */
  raw: string;
  /** Vrai si la ligne se termine par une virgule : la liste continue. */
  continues: boolean;
}

export function lexLine(raw: string, line: number): LexLine {
  const tokens: Token[] = [];
  let comment: Token | undefined;
  let i = 0;
  let previousEnd = -1;

  while (i < raw.length) {
    const ch = raw[i];

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }

    if (ch === '#') {
      comment = { kind: 'comment', text: raw.slice(i), value: raw.slice(i), line, start: i, end: raw.length, glued: previousEnd === i };
      break;
    }

    const glued = previousEnd === i;
    const rest = raw.slice(i);

    if (ch === "'") {
      // Chaine : la quote interne se double (`'Poussage d''un pont'`).
      let j = i + 1;
      let closed = false;
      while (j < raw.length) {
        if (raw[j] === "'") {
          if (raw[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          closed = true;
          break;
        }
        j++;
      }
      const text = raw.slice(i, closed ? j : raw.length);
      tokens.push({
        kind: 'string',
        text,
        value: text.slice(1, closed ? -1 : undefined).replace(/''/g, "'"),
        line,
        start: i,
        end: closed ? j : raw.length,
        glued,
      });
      previousEnd = closed ? j : raw.length;
      i = previousEnd;
      continue;
    }

    if (ch === ';' || ch === ',' || ch === ':') {
      tokens.push({ kind: 'separator', text: ch, value: ch, line, start: i, end: i + 1, glued });
      previousEnd = i + 1;
      i++;
      continue;
    }

    const variable = VARIABLE_RE.exec(rest);
    if (variable) {
      const text = variable[0];
      tokens.push({ kind: 'variable', text, value: text.toLowerCase(), line, start: i, end: i + text.length, glued });
      previousEnd = i + text.length;
      i = previousEnd;
      continue;
    }

    const number = NUMBER_RE.exec(rest);
    if (number && /[\d.]/.test(ch)) {
      const text = number[0];
      tokens.push({ kind: 'number', text, value: text, line, start: i, end: i + text.length, glued });
      previousEnd = i + text.length;
      i = previousEnd;
      continue;
    }

    const word = WORD_RE.exec(rest);
    if (word) {
      const text = word[0];
      tokens.push({ kind: 'word', text, value: text.toUpperCase(), line, start: i, end: i + text.length, glued });
      previousEnd = i + text.length;
      i = previousEnd;
      continue;
    }

    const operator = OPERATORS.find((op) => rest.startsWith(op));
    if (operator) {
      tokens.push({ kind: 'operator', text: operator, value: operator, line, start: i, end: i + operator.length, glued });
      previousEnd = i + operator.length;
      i = previousEnd;
      continue;
    }

    // Caractere non reconnu : on l'emet en operateur pour ne rien perdre, la
    // validation lexicale s'en chargera (accents notamment).
    tokens.push({ kind: 'operator', text: ch, value: ch, line, start: i, end: i + 1, glued });
    previousEnd = i + 1;
    i++;
  }

  const code = comment ? raw.slice(0, comment.start) : raw;
  return { line, tokens, comment, raw, continues: /,\s*$/.test(code) };
}

export function lex(text: string): LexLine[] {
  return text.split(/\r?\n/).map((raw, index) => lexLine(raw, index));
}

/** Vrai si le mot est ecrit tout en majuscules ou tout en minuscules (p.30). */
export function isValidKeywordCase(text: string): boolean {
  return text === text.toUpperCase() || text === text.toLowerCase();
}

const ACCENT_RE = /[À-ɏḀ-ỿ]/;

/** Vrai si le texte contient un caractere accentue — interdit en ST1 (p.31). */
export function hasAccent(text: string): boolean {
  return ACCENT_RE.test(text.normalize('NFC'));
}

/** Retire les accents : `déjà` -> `deja`. Utilise par le quick fix. */
export function stripAccents(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}
