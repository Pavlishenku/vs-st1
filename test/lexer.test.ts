import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lexLine, hasAccent, isValidKeywordCase, stripAccents } from '../shared/lexer.js';

test('le commentaire # court jusqu a la fin de ligne', () => {
  const line = lexLine('NOEUD 1 0. 0. # premier appui', 0);
  assert.equal(line.tokens.length, 4);
  assert.equal(line.comment?.text, '# premier appui');
});

test('un # a l interieur d une chaine ne demarre pas un commentaire', () => {
  const line = lexLine("TITRE 'Pont # 3'", 0);
  assert.equal(line.comment, undefined);
  assert.equal(line.tokens[1].value, 'Pont # 3');
});

test('la quote interne se double', () => {
  const line = lexLine("TITRE 'Poussage d''un pont'", 0);
  assert.equal(line.tokens[1].value, "Poussage d'un pont");
});

test('la notation Fortran d est reconnue comme un nombre', () => {
  const line = lexLine('CARA 1 IZ .2d-3', 0);
  const numbers = line.tokens.filter((t) => t.kind === 'number').map((t) => t.text);
  assert.deepEqual(numbers, ['1', '.2d-3']);
});

test('le collage des jetons est memorise : il porte la regle du blanc dans les expressions', () => {
  const line = lexLine('1+2 +3', 0);
  assert.deepEqual(line.tokens.map((t) => [t.text, t.glued]), [
    ['1', false],
    ['+', true],
    ['2', true],
    ['+', false],
    ['3', true],
  ]);
});

test('une ligne terminee par une virgule poursuit la liste', () => {
  assert.equal(lexLine('BARRE 1,2,3,', 0).continues, true);
  assert.equal(lexLine('BARRE 1,2,3', 0).continues, false);
  assert.equal(lexLine('BARRE 1,2,3, # suite', 0).continues, true);
});

test('la casse mixte d un mot-cle est detectee', () => {
  assert.equal(isValidKeywordCase('NOEUD'), true);
  assert.equal(isValidKeywordCase('noeud'), true);
  assert.equal(isValidKeywordCase('Noeud'), false);
  assert.equal(isValidKeywordCase('NOEud'), false);
});

test('les accents sont detectes et supprimables', () => {
  assert.equal(hasAccent("TITRE 'Béton'"), true);
  assert.equal(hasAccent("TITRE 'Beton'"), false);
  assert.equal(stripAccents('déjà çà'), 'deja ca');
});

test('les variables tampon $ sont insensibles a la casse', () => {
  const line = lexLine('SI ($FY<0) APPUI 4 DX', 0);
  const variable = line.tokens.find((t) => t.kind === 'variable');
  assert.equal(variable?.value, '$fy');
});
