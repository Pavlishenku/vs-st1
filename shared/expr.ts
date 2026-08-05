/**
 * Expressions, variables et listes numeriques ST1 (p.31, p.263-268).
 *
 * Deux regles du manuel gouvernent tout ce fichier :
 *  1. **Aucun caractere blanc dans une expression** — `1+2 +3` vaut deux
 *     valeurs (`3` puis `+3`), pas une. Le decoupage en valeurs se fait donc sur
 *     le collage des jetons (`glued`), pas sur une grammaire d'expression.
 *  2. Une liste numerique est une suite separee par des virgules, ou un
 *     intervalle `i a j`, eventuellement `i a j pas p` (pas negatif admis).
 *     `TOUT` remplace une liste pour viser tous les elements definis.
 */

import type { Token } from './lexer.js';

/** Valeur d'une variable ST1 : un scalaire, une liste nommee, ou un tableau. */
export type ScopeValue = number | number[];
export type Scope = Map<string, ScopeValue>;

/** Marqueur du mot-cle `TOUT` : la liste designe tous les elements definis. */
export const ALL = Symbol('TOUT');

const FUNCTIONS: Record<string, (x: number) => number> = {
  ABS: Math.abs,
  INT: Math.trunc,
  SQRT: Math.sqrt,
  SIN: Math.sin,
  COS: Math.cos,
  TAN: Math.tan,
  ASIN: Math.asin,
  ACOS: Math.acos,
  ATAN: Math.atan,
  EXP: Math.exp,
  LOG: Math.log,
  SINH: Math.sinh,
  COSH: Math.cosh,
  TANH: Math.tanh,
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS);

const RANGE_WORDS = new Set(['A']);
const STEP_WORDS = new Set(['PAS']);
const ALL_WORDS = new Set(['TOUT', 'TOUS', 'TOUTES']);

/**
 * Decoupe une suite de jetons en « valeurs » ST1.
 *
 * Frontiere de valeur : un blanc (jeton non colle au precedent) ou une virgule.
 * La virgule est consommee. Chaque groupe retourne est une expression complete.
 */
export function splitValues(tokens: Token[]): Token[][] {
  const groups: Token[][] = [];
  let current: Token[] = [];

  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
  };

  for (const token of tokens) {
    if (token.kind === 'separator' && (token.text === ',' || token.text === ';')) {
      flush();
      continue;
    }
    if (!token.glued) flush();
    current.push(token);
  }
  flush();
  return groups;
}

/**
 * Evalue une expression ST1 (un groupe issu de `splitValues`).
 * Retourne `undefined` si l'expression n'est pas evaluable (variable inconnue).
 */
export function evaluate(tokens: Token[], scope: Scope = new Map()): number | undefined {
  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const next = (): Token | undefined => tokens[position++];

  function parsePrimary(): number | undefined {
    const token = next();
    if (!token) return undefined;

    if (token.kind === 'number') {
      // Notation Fortran : `.2d-3` equivaut a `.2e-3`.
      return Number(token.text.replace(/[dD]/, 'e'));
    }
    if (token.kind === 'operator' && token.text === '(') {
      const value = parseSum();
      if (peek()?.text === ')') position++;
      return value;
    }
    if (token.kind === 'operator' && (token.text === '-' || token.text === '+')) {
      const value = parseUnary();
      return value === undefined ? undefined : token.text === '-' ? -value : value;
    }
    if (token.kind === 'variable') {
      const value = scope.get(token.value);
      return typeof value === 'number' ? value : undefined;
    }
    if (token.kind === 'word') {
      const name = token.value;
      if (name === 'PI') return Math.PI;
      const fn = FUNCTIONS[name];
      if (fn && peek()?.text === '(') {
        position++;
        const argument = parseSum();
        if (peek()?.text === ')') position++;
        return argument === undefined ? undefined : fn(argument);
      }
      // Variable ou tableau indice : `nom` ou `nom(i)`.
      if (peek()?.text === '(') {
        position++;
        const idx = parseSum();
        if (peek()?.text === ')') position++;
        const array = scope.get(token.text.toLowerCase());
        if (Array.isArray(array) && idx !== undefined) return array[Math.trunc(idx) - 1];
        return undefined;
      }
      const value = scope.get(token.text.toLowerCase());
      return typeof value === 'number' ? value : undefined;
    }
    return undefined;
  }

  function parseUnary(): number | undefined {
    return parsePower();
  }

  function parsePower(): number | undefined {
    const base = parsePrimary();
    if (base === undefined) return undefined;
    if (peek()?.text === '**') {
      position++;
      const exponent = parseUnary();
      return exponent === undefined ? undefined : base ** exponent;
    }
    return base;
  }

  function parseProduct(): number | undefined {
    let left = parseUnary();
    while (left !== undefined && (peek()?.text === '*' || peek()?.text === '/')) {
      const operator = next()!.text;
      const right = parseUnary();
      if (right === undefined) return undefined;
      left = operator === '*' ? left * right : left / right;
    }
    return left;
  }

  function parseSum(): number | undefined {
    let left = parseProduct();
    while (left !== undefined && (peek()?.text === '+' || peek()?.text === '-')) {
      const operator = next()!.text;
      const right = parseProduct();
      if (right === undefined) return undefined;
      left = operator === '+' ? left + right : left - right;
    }
    return left;
  }

  const result = parseSum();
  return position >= tokens.length ? result : result;
}

/**
 * Garde-fou d'un intervalle : au-dela, c'est une faute de frappe (`1 a 1e9`)
 * et le developper gelerait l'editeur. ST1 lui-meme plafonne les numeros
 * d'elements bien en dessous (32768, p.29).
 */
export const MAX_RANGE_VALUES = 100_000;

/** Developpe `i a j pas p` en tenant compte d'un pas negatif. */
export function expandRange(start: number, end: number, step = 1): number[] {
  const values: number[] = [];
  const increment = step === 0 ? 1 : step;
  if (increment > 0) {
    for (let v = start; v <= end + 1e-9 && values.length < MAX_RANGE_VALUES; v += increment) values.push(Math.round(v));
  } else {
    for (let v = start; v >= end - 1e-9 && values.length < MAX_RANGE_VALUES; v += increment) values.push(Math.round(v));
  }
  return values;
}

export interface ListResult {
  values: number[];
  /** Vrai si la liste etait le mot-cle `TOUT`. */
  all: boolean;
  /** Nombre de groupes consommes. */
  consumed: number;
  /** Vrai si au moins une valeur n'a pas pu etre evaluee. */
  partial: boolean;
}

/**
 * Lit une liste numerique a partir de `groups[from]`.
 * S'arrete au premier groupe qui n'est ni une valeur, ni `a`, ni `pas`
 * (typiquement un mot-cle de la commande, ex. `DE`, `X`, `SX`).
 */
export function parseList(groups: Token[][], from = 0, scope: Scope = new Map()): ListResult {
  const values: number[] = [];
  let index = from;
  let partial = false;

  if (groups[index]?.length === 1 && groups[index][0].kind === 'word' && ALL_WORDS.has(groups[index][0].value)) {
    return { values: [], all: true, consumed: 1, partial: false };
  }

  while (index < groups.length) {
    const group = groups[index];
    const single = group.length === 1 ? group[0] : undefined;

    // Intervalle : `i a j` puis eventuellement `pas p`.
    if (single?.kind === 'word' && RANGE_WORDS.has(single.value) && values.length) {
      const endGroup = groups[index + 1];
      const end = endGroup ? evaluate(endGroup, scope) : undefined;
      if (end === undefined) {
        partial = true;
        break;
      }
      let step = 1;
      let advance = 2;
      const stepWord = groups[index + 2];
      if (stepWord?.length === 1 && stepWord[0].kind === 'word' && STEP_WORDS.has(stepWord[0].value)) {
        const stepValue = groups[index + 3] ? evaluate(groups[index + 3], scope) : undefined;
        if (stepValue !== undefined) {
          step = stepValue;
          advance = 4;
        }
      }
      const start = values.pop()!;
      // Boucle plutot que `push(...)` : un intervalle developpe peut depasser
      // la limite d'arguments de V8 et faire deborder la pile.
      for (const value of expandRange(start, end, step)) values.push(value);
      index += advance;
      continue;
    }

    // Une liste nommee developpee : `ls1 = 1,2,5 a 8` puis `BARRE ls1`.
    if (single?.kind === 'word') {
      const named = scope.get(single.text.toLowerCase());
      if (Array.isArray(named)) {
        for (const value of named) values.push(value);
        index++;
        continue;
      }
    }

    const value = evaluate(group, scope);
    if (value === undefined) break;
    values.push(Math.round(value));
    index++;
  }

  return { values, all: false, consumed: index - from, partial };
}

/** Affecte `nom = valeur` ou `nom = liste` dans la portee courante. */
export function assign(scope: Scope, name: string, tokens: Token[]): void {
  const groups = splitValues(tokens);
  if (groups.length === 1) {
    const value = evaluate(groups[0], scope);
    if (value !== undefined) {
      scope.set(name.toLowerCase(), value);
      return;
    }
  }
  const list = parseList(groups, 0, scope);
  if (list.values.length) scope.set(name.toLowerCase(), list.values);
}
