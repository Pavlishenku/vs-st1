import { test } from 'node:test';
import assert from 'node:assert/strict';

import catalog from '../catalog/st1-catalog.json';
import { buildIndex, type Catalog } from '../shared/catalog.js';
import { parse } from '../shared/parser.js';
import { validate, type ValidationLevel } from '../shared/validate.js';

const index = buildIndex(catalog as unknown as Catalog);

function codes(text: string, level: ValidationLevel = 'complet'): string[] {
  const document = parse(text, index);
  return validate(text, document, index, { level }).diagnostics.map((d) => d.code);
}

/** Etude minimale et coherente : sert de temoin negatif aux autres tests. */
const VALIDE = [
  'OPTION PLANE',
  "TITRE 'Poutre isostatique'",
  'NOEUD 1 0. 0.',
  'NOEUD 2 10. 0.',
  'BARRE 1 DE 1 A 2',
  'APPUI 1 NOEUD 1 DX DY',
  'APPUI 2 NOEUD 2 DY',
  'CARA 1 SX 0.5 IZ 0.0417 VY 0.25 WY 0.25',
  'CONS 1 E 3.5e10 NU 0.2 RO 25000.',
  'ETUDE EFFORT DEPLA',
  '   TOUT SE 0. a 1. PAS 1/10 REL',
  "CHARG 1 'Poids propre'",
  '   POIDS PROPRE TOUT',
  'FIN',
  'EXEC CHARG',
  'RESU',
  '   BARRE EFFORT DEPLA CONTR',
  'FIN',
].join('\n');

test('une etude coherente ne produit aucune erreur', () => {
  const document = parse(VALIDE, index);
  const errors = validate(VALIDE, document, index).diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors.map((e) => `${e.line}: ${e.code} — ${e.message}`), []);
});

// ------------------------------------------------------------------ lexical

test('« // » est signale comme commentaire invalide', () => {
  assert.ok(codes('OPTION PLANE\n// commentaire').includes('lex.comment-slash'));
});

test('un accent est signale', () => {
  assert.ok(codes("OPTION PLANE\nTITRE 'Béton'").includes('lex.accent'));
});

test('un mot-cle en casse mixte est signale', () => {
  assert.ok(codes('OPTION PLANE\nNoeud 1 0. 0.').includes('lex.mixed-case'));
});

test('une chaine non fermee est signalee', () => {
  assert.ok(codes("OPTION PLANE\nTITRE 'Pont").includes('lex.unbalanced-quote'));
});

// --------------------------------------------------------------- structurel

test('OPTION absente est signalee', () => {
  assert.ok(codes('NOEUD 1 0. 0.').includes('struct.missing-option'));
});

test('un DDL inexistant dans l OPTION est signale', () => {
  // En GRILL les DDL sont RX, DZ, RY : DX n'existe pas.
  assert.ok(codes('OPTION GRILL\nNOEUD 1 0. 0.\nAPPUI 1 NOEUD 1 DX').includes('struct.invalid-ddl'));
  // La meme ligne est valide en PLANE.
  assert.ok(!codes('OPTION PLANE\nNOEUD 1 0. 0.\nAPPUI 1 NOEUD 1 DX').includes('struct.invalid-ddl'));
});

test('une caracteristique de barre inexistante dans l OPTION est signalee', () => {
  assert.ok(codes('OPTION GRILL\nCARA 1 SX 0.5').includes('struct.invalid-bar-property'));
});

test('POIDS PROPRE est interdit en GRILL', () => {
  const text = ['OPTION GRILL', 'CHARG 1', '   POIDS PROPRE TOUT', 'FIN'].join('\n');
  assert.ok(codes(text).includes('exec.grill-self-weight'));
});

test('CARA PSE ne doit definir ni SY ni SZ', () => {
  assert.ok(codes('OPTION PLANE\nCARA PSE 1 SX 0.5 SY 0.4').includes('struct.pse-shear-area'));
});

test('un bloc non ferme est signale', () => {
  assert.ok(codes("OPTION PLANE\nCHARG 1\n   POIDS PROPRE TOUT").includes('struct.unclosed-block'));
});

test('un FIN orphelin est signale', () => {
  assert.ok(codes('OPTION PLANE\nFIN').includes('struct.orphan-fin'));
});

test('EXEC MODES est corrige en EXEC MODE', () => {
  assert.ok(codes('OPTION PLANE\nEXEC MODES 5').includes('typo.exec-modes'));
});

test('un pas relatif 1/3 est refuse', () => {
  assert.ok(codes('OPTION PLANE\nETUDE\n   TOUT SE 0. a 1. PAS 1/3 REL').includes('struct.invalid-relative-step'));
});

test('COMB ne combine pas les surcharges', () => {
  assert.ok(codes(['OPTION PLANE', 'COMB 1', '   SURCH 1 1.5', 'FIN'].join('\n')).includes('struct.comb-surcharge'));
});

// ----------------------------------------------------------------- prerequis

test('EXEC SURCH exige TABLIER et SURCH', () => {
  assert.ok(codes('OPTION PLANE\nEXEC SURCH').includes('exec.surch-prerequisite'));
});

test('EXEC SPECTRE REPONSE exige EXEC MODE prealable', () => {
  assert.ok(codes('OPTION PLANE\nEXEC SPECTRE REPONSE 1').includes('exec.spectrum-prerequisite'));
});

test('un CHARG sans EXEC est signale', () => {
  const text = ['OPTION PLANE', 'CHARG 1', '   POIDS PROPRE TOUT', 'FIN'].join('\n');
  assert.ok(codes(text).includes('exec.charg-without-exec'));
});

// -------------------------------------------------------------------- modele

test('une barre sur un noeud inexistant est signalee', () => {
  const text = ['OPTION PLANE', 'NOEUD 1 0. 0.', 'BARRE 1 DE 1 A 7'].join('\n');
  assert.ok(codes(text).includes('model.undefined-node'));
});

test('une barre sans CARA est signalee', () => {
  const text = ['OPTION PLANE', 'NOEUD 1 0. 0.', 'NOEUD 2 5. 0.', 'BARRE 1 DE 1 A 2', 'APPUI 1 NOEUD 1 DX DY'].join('\n');
  assert.ok(codes(text).includes('model.bar-without-cara'));
});

test('une structure sans appui est signalee', () => {
  const text = ['OPTION PLANE', 'NOEUD 1 0. 0.', 'NOEUD 2 5. 0.', 'BARRE 1 DE 1 A 2'].join('\n');
  assert.ok(codes(text).includes('model.no-support'));
});

test('CONTR demande sans fibres extremes dans CARA est signale (piege documente)', () => {
  const text = [
    'OPTION PLANE',
    'NOEUD 1 0. 0.',
    'NOEUD 2 5. 0.',
    'BARRE 1 DE 1 A 2',
    'APPUI 1 NOEUD 1 DX DY',
    'APPUI 2 NOEUD 2 DY',
    'CARA 1 SX 1 IZ 1',
    'CONS 1 E 3.5e10 NU 0.2',
    'CHARG 1',
    '   POIDS PROPRE TOUT',
    'FIN',
    'EXEC CHARG',
    'RESU',
    '   BARRE EFFORT DEPLA CONTR',
    'FIN',
  ].join('\n');
  assert.ok(codes(text).includes('model.contr-without-fibres'));
});

test('le niveau lexical n active pas les regles structurelles', () => {
  const found = codes('NOEUD 1 0. 0.', 'lexical');
  assert.ok(!found.includes('struct.missing-option'));
});

// ------------------------------------------------------- non-regression reelle

/**
 * Exemple 19.1 du manuel ST1 v24 : du ST1 ecrit par l'editeur lui-meme.
 * Entierement en minuscules, et il exerce les formes bloc de `noeud`, `barre`,
 * `cara`, `cara pse`, `cons`, `charg`, `etude`, `env`, `env comb` et `resu`.
 * Aucun diagnostic ne doit sortir : c'est le garde-fou anti-faux-positifs.
 */
const MANUEL_19_1 = [
  'option plane',
  'noeud',
  '1 0. 0.',
  '2 0. 5.',
  '3 6. 5.',
  '4 6. 0.',
  'barre',
  '1 1 2',
  '2 2 3',
  '3 3 4',
  '4 4 1',
  'cara',
  '1,2,3 sx .35 iz 3.57e-3',
  'cara pse',
  '4     sx .37 iz 4.22e-3 zone 1 kfx 10. kfy 2000.',
  'cons',
  'tout e 1.e6 ro 2.5',
  "charg 1 'poids propre du cadre et effet d''une charge repartie'",
  'poids propre tout',
  'barre',
  '2 uni fy -.300',
  'fin',
  "charg 2 'poussee des terres unitaire k=1'",
  'barre',
  '1 lin xl 0. 1. rel fx 10.  0.',
  '3 lin xl 0. 1. rel fx  0. -10.',
  'fin',
  'etude effort',
  'tout se 0. a 1 pas 0.1',
  'fin',
  'exec charg',
  "env 1 'enveloppe de la poussee des terres'",
  'charg',
  '2 .25',
  '2 .50',
  'fin',
  "env 2 comb 'combinaison ELS des charges permanentes'",
  'charg 1',
  'env 1',
  'fin',
  "sortie 'exemple1.txt'",
  'lister geom',
  'resu',
  'charg 1 env 1,2',
  'barre',
  'fin',
].join('\n');

test("l'exemple 19.1 du manuel ne produit aucun diagnostic", () => {
  const document = parse(MANUEL_19_1, index);
  const found = validate(MANUEL_19_1, document, index).diagnostics;
  assert.deepEqual(found.map((d) => `L${d.line + 1} ${d.code} — ${d.message}`), []);
});

test("l'exemple 19.1 du manuel est reconstruit correctement", () => {
  const document = parse(MANUEL_19_1, index);
  const { model } = validate(MANUEL_19_1, document, index);
  assert.equal(model.nodes.size, 4);
  assert.equal(model.bars.size, 4);
  assert.deepEqual(model.nodes.get(3), { id: 3, x: 6, y: 5, z: 0, line: 4, file: 0 });
  assert.deepEqual(model.bars.get(4), { id: 4, from: 4, to: 1, line: 10, file: 0 });
  // La barre 4 est sur sol elastique : elle n'a besoin d'aucun appui.
  assert.equal(model.caraByBar.get(4)?.pse, true);
  assert.equal(model.caraByBar.get(1)?.pse, false);
  // `cons tout e 1.e6 ro 2.5` en forme bloc couvre les quatre barres.
  assert.equal(model.constantsByBar.size, 4);
  assert.deepEqual([...model.loadedBars].sort((a, b) => a - b), [1, 2, 3]);
});
