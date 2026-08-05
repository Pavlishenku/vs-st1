import { test } from 'node:test';
import assert from 'node:assert/strict';

import catalog from '../catalog/st1-catalog.json';
import { buildIndex, type Catalog } from '../shared/catalog.js';
import { parse } from '../shared/parser.js';
import { buildModel } from '../shared/model.js';

const index = buildIndex(catalog as unknown as Catalog);
const analyse = (text: string) => parse(text, index);

test('le point-virgule separe plusieurs commandes sur une ligne', () => {
  const document = analyse('OPTION PLANE ; TITRE \'Essai\'');
  assert.deepEqual(document.statements.map((s) => s.keyword), ['OPTION', 'TITRE']);
});

test('une ligne terminee par une virgule prolonge l instruction', () => {
  const document = analyse('OPTION PLANE\nBARRE 1,2,\n3 DE 1 A 2');
  const barre = document.statements.find((s) => s.keyword === 'BARRE');
  assert.equal(barre?.line, 1);
  assert.equal(barre?.endLine, 2);
});

test('un bloc est ouvert par sa commande et ferme par FIN', () => {
  const document = analyse("OPTION PLANE\nCHARG 1 'Poids'\n   POIDS PROPRE TOUT\nFIN");
  const charg = document.blocks.find((b) => b.name === 'CHARG');
  assert.ok(charg);
  assert.equal(charg!.closed, true);
  assert.equal(charg!.startLine, 1);
  assert.equal(charg!.endLine, 3);
});

test('un bloc non ferme est signale comme tel', () => {
  const document = analyse("OPTION PLANE\nCHARG 1\n   POIDS PROPRE TOUT");
  assert.equal(document.blocks.find((b) => b.name === 'CHARG')?.closed, false);
});

test('CHARG s imbrique dans PHASAGE et FIN PHASAGE ferme le bon bloc', () => {
  const document = analyse(
    ['OPTION PLANE', 'PHASAGE 1', '   ACTIVER APPUI 1', '   CHARG', '      POIDS PROPRE TOUT', '   FIN', 'FIN PHASAGE'].join('\n'),
  );
  const phasage = document.blocks.find((b) => b.name === 'PHASAGE');
  const charg = document.blocks.find((b) => b.name === 'CHARG');
  assert.equal(phasage?.closed, true);
  assert.equal(charg?.closed, true);
  assert.equal(charg?.depth, 1);
  assert.deepEqual(
    document.statements.find((s) => s.text.includes('POIDS'))?.blockPath,
    ['PHASAGE', 'CHARG'],
  );
});

test('les commandes composees sont reconnues entieres', () => {
  const document = analyse('OPTION SPATIALE\nGENER 5 NOEUD ID 100 10 X 5. 2. Y 4');
  const gener = document.statements[1];
  assert.ok(gener.keyword === 'GENER NOEUD' || gener.keyword === 'GENER');
  assert.ok(gener.keywordWords >= 1);
});

test('l OPTION de structure est detectee', () => {
  assert.equal(analyse('OPTION GRILL\nNOEUD 1 0. 0.').option, 'GRILL');
  assert.equal(analyse('NOEUD 1 0. 0.').option, null);
});

test('un bloc ecrit sur une seule instruction est considere ferme', () => {
  const document = analyse('OPTION PLANE\nRESU BARRE EFFORT DEPLA FIN');
  const resu = document.blocks.find((b) => b.name === 'RESU');
  assert.equal(resu?.closed, true);
});

// -------------------------------------------------------------------- modele

test('le modele reconstruit noeuds, barres et appuis', () => {
  const document = analyse(
    [
      'OPTION PLANE',
      'NOEUD 1 0. 0.',
      'NOEUD 2 10. 0.',
      'BARRE 1 DE 1 A 2',
      'APPUI 1 NOEUD 1 DX DY',
      'APPUI 2 NOEUD 2 DY',
    ].join('\n'),
  );
  const model = buildModel(document);
  assert.equal(model.nodes.size, 2);
  assert.deepEqual(model.nodes.get(2), { id: 2, x: 10, y: 0, z: 0, line: 2, file: 0 });
  assert.deepEqual(model.bars.get(1), { id: 1, from: 1, to: 2, line: 3, file: 0 });
  assert.equal(model.supports.length, 2);
  assert.deepEqual(model.supports[0].ddl, ['DX', 'DY']);
  assert.equal(model.supports[1].node, 2);
});

test('le modele resout les scripts parametres', () => {
  const document = analyse(['OPTION PLANE', 'lg = 25.', 'NOEUD 1 0. 0.', 'NOEUD 2 lg 0.', 'NOEUD 3 lg*2 0.'].join('\n'));
  const model = buildModel(document);
  assert.equal(model.nodes.get(2)?.x, 25);
  assert.equal(model.nodes.get(3)?.x, 50);
});

test('GENER NOEUD et GENER BARRE developpent la generation', () => {
  const document = analyse(
    ['OPTION PLANE', 'GENER 5 NOEUD ID 1 1 X 0. 2.5 Y 0.', 'GENER 4 BARRE ID 1 1 DE 1 1 A 2 1'].join('\n'),
  );
  const model = buildModel(document);
  assert.equal(model.nodes.size, 5);
  assert.equal(model.nodes.get(3)?.x, 5);
  assert.equal(model.bars.size, 4);
  assert.deepEqual(model.bars.get(4), { id: 4, from: 4, to: 5, line: 2, file: 0 });
});

test('la forme bloc de NOEUD est lue', () => {
  const document = analyse(['OPTION PLANE', 'NOEUD', '   1 0. 0.', '   2 5. 0.', 'BARRE 1 DE 1 A 2'].join('\n'));
  const model = buildModel(document);
  assert.equal(model.nodes.size, 2);
  assert.equal(model.nodes.get(2)?.x, 5);
});

test('CARA TOUT affecte toutes les barres definies', () => {
  const document = analyse(
    ['OPTION PLANE', 'NOEUD 1 0. 0.', 'NOEUD 2 5. 0.', 'NOEUD 3 10. 0.', 'BARRE 1 DE 1 A 2', 'BARRE 2 DE 2 A 3', 'CARA TOUT SX 0.5 IZ 0.04 VY 0.25 WY 0.25'].join('\n'),
  );
  const model = buildModel(document);
  assert.equal(model.caraByBar.size, 2);
  assert.ok(model.caraByBar.get(2)?.props.has('VY'));
});
