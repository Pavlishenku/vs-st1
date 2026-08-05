import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lexLine } from '../shared/lexer.js';
import { splitValues, evaluate, parseList, assign, type Scope } from '../shared/expr.js';

const groups = (text: string) => splitValues(lexLine(text, 0).tokens);
const value = (text: string, scope?: Scope) => evaluate(groups(text)[0], scope);

test('les operateurs et la priorite sont respectes', () => {
  assert.equal(value('2+3*4'), 14);
  assert.equal(value('(2+3)*4'), 20);
  assert.equal(value('2**3**2'), 512);
  assert.equal(value('-3+1'), -2);
});

test('les fonctions et la constante pi sont disponibles', () => {
  assert.equal(value('sqrt(16)'), 4);
  assert.equal(value('abs(-2.5)'), 2.5);
  assert.equal(value('int(7/2)'), 3);
  assert.ok(Math.abs((value('pi') ?? 0) - Math.PI) < 1e-12);
  assert.ok(Math.abs((value('cos(0)') ?? 0) - 1) < 1e-12);
});

test('un blanc coupe l expression : « 1+2 +3 » vaut deux valeurs', () => {
  const parts = groups('1+2 +3');
  assert.equal(parts.length, 2);
  assert.equal(evaluate(parts[0]), 3);
  assert.equal(evaluate(parts[1]), 3);
});

test('la virgule separe les valeurs meme sans blanc', () => {
  const parts = groups('1,23,12');
  assert.deepEqual(parts.map((p) => evaluate(p)), [1, 23, 12]);
});

test('un intervalle « i a j » se developpe', () => {
  assert.deepEqual(parseList(groups('5 a 9')).values, [5, 6, 7, 8, 9]);
});

test('un intervalle accepte un pas, y compris negatif', () => {
  assert.deepEqual(parseList(groups('1 a 9 pas 2')).values, [1, 3, 5, 7, 9]);
  assert.deepEqual(parseList(groups('5 a 1 pas -1')).values, [5, 4, 3, 2, 1]);
});

test('les formes combinees du manuel donnent le meme resultat', () => {
  const a = parseList(groups('1,23,12,5 a 9 pas 1')).values;
  const b = parseList(groups('1,23,12,5 a 9')).values;
  const c = parseList(groups('1,23,12,5 a 6,7 a 9')).values;
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.deepEqual(a, [1, 23, 12, 5, 6, 7, 8, 9]);
});

test('TOUT est reconnu comme liste universelle', () => {
  const result = parseList(groups('TOUT'));
  assert.equal(result.all, true);
  assert.deepEqual(result.values, []);
});

test('la lecture d une liste s arrete au premier mot-cle', () => {
  const parts = groups('1 a 3 DE 10 A 20');
  const result = parseList(parts);
  assert.deepEqual(result.values, [1, 2, 3]);
  assert.equal(parts[result.consumed][0].value, 'DE');
});

test('variables et listes nommees sont resolues', () => {
  const scope: Scope = new Map();
  assign(scope, 'lg', lexLine('25.', 0).tokens);
  assign(scope, 'ls1', lexLine('1,2,5 a 8', 0).tokens);
  assert.equal(value('lg*2', scope), 50);
  assert.deepEqual(parseList(groups('ls1'), 0, scope).values, [1, 2, 5, 6, 7, 8]);
});

test('une variable inconnue laisse la valeur indeterminee, sans planter', () => {
  assert.equal(value('inconnue+1'), undefined);
});
