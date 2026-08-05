/**
 * Tests de l'extracteur de modele (`shared/model.ts`).
 *
 * Les cas viennent des etudes reelles : geometrie generee par boucles
 * (`POUR`/`FAIRE`), conditionnelles `SI`, fichiers repartis via `LIRE`,
 * cables de precontrainte et phasage — tout ce qui faisait defaut au
 * visualiseur de la version 0.1.x.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import catalog from '../catalog/st1-catalog.json';
import { buildIndex, type Catalog } from '../shared/catalog.js';
import { parse } from '../shared/parser.js';
import { buildModel, type BuildOptions } from '../shared/model.js';
import { validate } from '../shared/validate.js';

const index = buildIndex(catalog as unknown as Catalog);

function model(lines: string[], options: Omit<BuildOptions, 'index'> = {}) {
  const document = parse(lines.join('\n'), index);
  return buildModel(document, { index, ...options });
}

// ---------------------------------------------------------------------------
// Definitions reparties sur plusieurs commandes
// ---------------------------------------------------------------------------

test('noeuds et barres definis par plusieurs commandes separees', () => {
  const m = model([
    'OPTION PLANE',
    'NOEUD 1 0. 0.',
    'BARRE 1 DE 1 A 2',
    'NOEUD 2 10. 0.', // apres la barre qui l'utilise : l'ordre ne compte pas
    'NOEUD 3 20. 0.',
    'BARRE 2 DE 2 A 3',
  ]);
  assert.equal(m.nodes.size, 3);
  assert.equal(m.bars.size, 2);
  assert.equal(m.nodes.get(2)?.x, 10);
});

test('GENER BARRE a l\'interieur d\'une forme bloc BARRE (exemple 19.6)', () => {
  const m = model([
    'OPTION SPATIALE',
    'NOEUD',
    ' 1   X   0.000  Y  0.000   Z  0',
    ' 2   X   10     Y  0.000   Z  0',
    ' 3   X   20     Y  0.000   Z  0',
    'BARRE',
    '  GENER 2 BARRE ID 11 1 DE  1 1 A  2 1',
    'FIN',
  ]);
  assert.equal(m.nodes.size, 3);
  assert.deepEqual([...m.bars.keys()], [11, 12]);
  assert.equal(m.bars.get(12)?.from, 2);
  assert.equal(m.bars.get(12)?.to, 3);
});

// ---------------------------------------------------------------------------
// Boucles POUR / FAIRE
// ---------------------------------------------------------------------------

test('boucle POUR sur une ligne : pour i=1 a 3 << barre i i i+1 >>', () => {
  const m = model([
    'OPTION PLANE',
    'NOEUD 1,2,3,4 0. 0.',
    'pour i=1 a 3 << barre i i i+1 >>',
  ]);
  assert.deepEqual([...m.bars.keys()], [1, 2, 3]);
  assert.equal(m.bars.get(2)?.from, 2);
  assert.equal(m.bars.get(2)?.to, 3);
});

test('boucle POUR multi-lignes avec variable incrementee (exemple 19.11)', () => {
  const m = model([
    'option plane',
    'nb=4',
    'lg0= 10/nb',
    'lg =0',
    'pour i=1 a nb+1 pas 1',
    '<<',
    'noeud i  lg  0',
    'lg =lg+lg0',
    '>>',
    'pour i=1 a nb pas 1 << barre i i i+1 >>',
  ]);
  assert.equal(m.nodes.size, 5);
  assert.equal(m.bars.size, 4);
  assert.equal(m.nodes.get(1)?.x, 0);
  assert.equal(m.nodes.get(3)?.x, 5);
  assert.equal(m.nodes.get(5)?.x, 10);
});

test('boucles imbriquees', () => {
  const m = model([
    'option plane',
    'pour i=0 a 1',
    '<<',
    'pour j=1 a 2 << noeud 10*i+j i j >>',
    '>>',
  ]);
  assert.deepEqual([...m.nodes.keys()].sort((a, b) => a - b), [1, 2, 11, 12]);
  assert.equal(m.nodes.get(12)?.x, 1);
  assert.equal(m.nodes.get(12)?.y, 2);
});

test('FAIRE i=1,n est un intervalle, pas une liste de deux valeurs', () => {
  const m = model([
    'option plane',
    'n=4',
    'somme=0',
    'FAIRE i=1,n << somme = somme+i ; noeud i i 0. >>',
  ]);
  assert.equal(m.nodes.size, 4);
  assert.equal(m.scope.get('somme'), 10);
});

test('boucle POUR sur une liste nommee', () => {
  const m = model([
    'option plane',
    'lst = 2,4,6',
    'pour i=lst << noeud i i 0. >>',
  ]);
  assert.deepEqual([...m.nodes.keys()], [2, 4, 6]);
});

// ---------------------------------------------------------------------------
// Conditionnelles SI / SINON
// ---------------------------------------------------------------------------

test('SI vrai execute la branche alors, SINON est ignore', () => {
  const m = model([
    'option plane',
    'a=1',
    'si (a=1) << noeud 1 0. 0. >> sinon << noeud 2 0. 0. >>',
  ]);
  assert.ok(m.nodes.has(1));
  assert.ok(!m.nodes.has(2));
});

test('SI faux execute la branche SINON', () => {
  const m = model([
    'option plane',
    'a=0',
    'si (a=1) << noeud 1 0. 0. >> sinon << noeud 2 0. 0. >>',
  ]);
  assert.ok(!m.nodes.has(1));
  assert.ok(m.nodes.has(2));
});

test('SI indecidable (variable inconnue) n\'execute aucune branche', () => {
  const m = model([
    'option plane',
    'si (inconnue=1) << noeud 1 0. 0. >> sinon << noeud 2 0. 0. >>',
  ]);
  assert.equal(m.nodes.size, 0);
});

// ---------------------------------------------------------------------------
// Inclusions LIRE
// ---------------------------------------------------------------------------

test('LIRE resolu : le modele agrege les fichiers et retient leur provenance', () => {
  const included: Record<string, string> = {
    'noeuds.st1': ['NOEUD 1 0. 0.', 'NOEUD 2 10. 0.', "LIRE 'barres.st1'"].join('\n'),
    'barres.st1': 'BARRE 1 DE 1 A 2',
  };
  const m = model(
    ['OPTION PLANE', "LIRE 'noeuds.st1'", 'APPUI 1 NOEUD 1 DX DY'],
    {
      file: 'C:/etude/principal.st1',
      resolve: (file) => {
        const text = included[file];
        return text ? { document: parse(text, index), file: `C:/etude/${file}` } : null;
      },
    },
  );
  assert.equal(m.nodes.size, 2);
  assert.equal(m.bars.size, 1);
  assert.equal(m.files.length, 3);
  assert.equal(m.nodes.get(1)?.file, 1); // defini dans noeuds.st1
  assert.equal(m.bars.get(1)?.file, 2); // defini dans barres.st1 (inclusion imbriquee)
  assert.equal(m.supports[0].file, 0);
  assert.ok(m.includes.every((i) => i.resolved));
  // L'ancre d'une inclusion imbriquee remonte au LIRE du fichier hote (ligne 1).
  assert.equal(m.fileAnchors[2], 1);
});

test('LIRE non resolu : signale, et les regles d\'existence se taisent', () => {
  const text = ['OPTION PLANE', "LIRE 'noeuds.st1'", 'BARRE 1 DE 1 A 2', 'CARA 1 SX 0.5'].join('\n');
  const document = parse(text, index);
  const m = buildModel(document, { index, resolve: () => null });
  assert.equal(m.includes.length, 1);
  assert.equal(m.includes[0].resolved, false);

  const { diagnostics } = validate(text, document, index, { model: m });
  const codes = diagnostics.map((d) => d.code);
  assert.ok(!codes.includes('model.undefined-node'), `codes: ${codes.join(', ')}`);
  assert.ok(!codes.includes('model.bar-without-constants'));
});

test('cycle de LIRE : pas de recursion infinie', () => {
  const m = model(
    ['OPTION PLANE', "LIRE 'a.st1'"],
    {
      file: 'C:/etude/a.st1',
      resolve: (file) => ({ document: parse("LIRE 'a.st1'", index), file: `C:/etude/${file}` }),
    },
  );
  assert.equal(m.truncated, false);
});

// ---------------------------------------------------------------------------
// Cables de precontrainte
// ---------------------------------------------------------------------------

test('bloc CABLE : barres, PREC et points du TRACE (exemple 19.6)', () => {
  const m = model([
    'OPTION SPATIALE',
    'NOEUD 1,2,3 0. 0. 0.',
    'BARRE 11 1 2 ; BARRE 12 2 3',
    'CABLE 101 \'cable de fleau\'',
    '  PREC 11 SIMUL 3',
    '  PAS_CABLE 0.5',
    '  LG_GAINE OR 2 EX 2',
    '  BARRE 11,12',
    '  TRACE INTERIEUR',
    '    X  0    Y 0.05   Z 0',
    '    X  10   Y 0.05   Z 0',
    '    X  20   Y 0.05   Z 0',
    'FIN',
  ]);
  assert.equal(m.cables.length, 1);
  const cable = m.cables[0];
  assert.equal(cable.id, 101);
  assert.equal(cable.name, 'cable de fleau');
  assert.equal(cable.prec, 11);
  assert.deepEqual(cable.bars, [11, 12]);
  assert.equal(cable.points.length, 3); // PAS_CABLE et LG_GAINE ne sont pas des points
  assert.deepEqual(cable.points[1], { x: 10, y: 0.05, z: 0 });
});

test('TRACE : modificateurs d\'allure PENTE, ALIGNE, RAYON et GIS captures', () => {
  const m = model([
    'OPTION PLANE',
    'NOEUD 1,2 0. 0.',
    'BARRE 1 1 2',
    "CABLE 1 'cable de fleau'",
    '  BARRE 1',
    '  TRACE INTERIEUR',
    '    X 1 Y 3 ALIGNE',
    '    X 3 Y 2.5',
    '    X 5 Y 1 PENTE 0',
    '    X 9 Y 3',
    'FIN',
    "CABLE 2 'exterieur sur deviateurs'",
    '  BARRE 1',
    '  TRACE EXTERIEUR',
    '    X 1 Y 3',
    '    X 3 Y 2.5 RAYON 2',
    '    X 9 Y 3',
    'FIN',
  ]);
  const [interior, exterior] = m.cables;
  assert.equal(interior.points.length, 4);
  assert.equal(interior.points[0].aligne, true);
  assert.equal(interior.points[2].pente, 0);
  assert.equal(interior.traceDeclared, true);
  assert.ok(!interior.exterior);
  assert.equal(exterior.exterior, true);
  assert.equal(exterior.points[1].rayon, 2);
});

test('TRACE en forme positionnelle, et CABLE de CHARG sans effet', () => {
  const m = model([
    'OPTION PLANE',
    'NOEUD 1,2 0. 0.',
    'BARRE 1 1 2',
    'CABLE 5',
    '  BARRE 1',
    '  TRACE',
    '    0.  0.10',
    '    5.  -0.20 ALIGNE',
    'FIN',
    "CHARG 1 'tension'",
    '  CABLE 5 TENSION',
    'FIN',
  ]);
  assert.equal(m.cables.length, 1);
  assert.deepEqual(m.cables[0].points, [
    { x: 0, y: 0.1, z: 0 },
    { x: 5, y: -0.2, z: 0, aligne: true },
  ]);
});

// ---------------------------------------------------------------------------
// Valeurs des caracteristiques et des constantes
// ---------------------------------------------------------------------------

test('CARA et CONS retiennent les valeurs pour l\'infobulle du visualiseur', () => {
  const m = model([
    'OPTION PLANE',
    'NOEUD 1,2 0. 0.',
    'BARRE 1 1 2',
    'e_beton = 1.e6',
    'CARA 1 SX .35 IZ 3.57e-3',
    'CONS 1 E e_beton RO 2.5',
    "MATERIAU 2 'Beton C40'",
    '  RO 2.5',
    'FIN',
    'CONS 1 MAT 2',
  ]);
  const cara = m.caraByBar.get(1)!;
  assert.equal(cara.props.get('SX'), 0.35);
  assert.equal(cara.props.get('IZ'), 3.57e-3);
  const cons = m.constantsByBar.get(1)!;
  assert.equal(cons.values.get('E'), 1e6);
  assert.equal(cons.values.get('RO'), 2.5);
  assert.equal(cons.material, 2);
  assert.equal(m.materials.get(2)?.title, 'Beton C40');
  assert.equal(m.materials.get(2)?.values.get('RO'), 2.5);
});

// ---------------------------------------------------------------------------
// Phasage
// ---------------------------------------------------------------------------

test('PHASAGE : instantanes cumulatifs aux ETAT, cables tendus/detendus', () => {
  const m = model([
    'OPTION PLANE',
    'NOEUD 1,2,3 0. 0.',
    'BARRE 1 1 2 ; BARRE 2 2 3',
    'APPUI 11 NOEUD 1 DX DY',
    'APPUI 12 NOEUD 3 DY',
    'CABLE 101',
    '  BARRE 1,2',
    'FIN',
    "PHASAGE 1 'construction'",
    '  ACTIVER APPUI 11,12',
    '  ACTIVER BARRE 1',
    "  ETAT 10 'fleau 1'",
    '  ACTIVER BARRE 2',
    '  TENDRE CABLE 101',
    "  ETAT 20 'clavage'",
    '  DETENDRE CABLE 101',
    'FIN PHASAGE',
  ]);
  assert.equal(m.phasages.length, 1);
  const states = m.phasages[0].states;
  assert.equal(states.length, 3); // 2 ETAT + etat final implicite (DETENDRE apres le dernier ETAT)
  assert.deepEqual(states[0].bars, [1]);
  assert.deepEqual(states[0].supports, [11, 12]);
  assert.deepEqual(states[0].tensioned, []);
  assert.deepEqual(states[1].bars, [1, 2]);
  assert.deepEqual(states[1].tensioned, [101]);
  assert.deepEqual(states[2].tensioned, []);
});

test('PHASAGE : ACTIVER BARRE avec intervalle et TOUT', () => {
  const m = model([
    'OPTION PLANE',
    'NOEUD 1,2,3,4 0. 0.',
    'pour i=1 a 3 << barre i i i+1 >>',
    'APPUI 1 NOEUD 1 DX DY',
    'PHASAGE',
    '  ACTIVER BARRE 1 A 2 AGE -2',
    '  ETAT 1',
    '  ACTIVER TOUT',
    '  ETAT 2',
    'FIN PHASAGE',
  ]);
  const states = m.phasages[0].states;
  assert.deepEqual(states[0].bars, [1, 2]);
  assert.deepEqual(states[1].bars, [1, 2, 3]);
  assert.deepEqual(states[1].supports, [1]);
});

// ---------------------------------------------------------------------------
// Robustesse
// ---------------------------------------------------------------------------

test('OPTION declaree dans un fichier inclus', () => {
  const m = model(
    ["LIRE 'entete.st1'", 'NOEUD 1 1. 2. 3.'],
    {
      file: 'C:/etude/principal.st1',
      resolve: () => ({ document: parse('OPTION SPATIALE', index), file: 'C:/etude/entete.st1' }),
    },
  );
  assert.equal(m.option, 'SPATIALE');
  assert.equal(m.nodes.get(1)?.z, 3);
});

test('boucles demesurees : le budget tronque sans bloquer l\'editeur', () => {
  const m = model([
    'option plane',
    'pour i=1 a 2000',
    '<<',
    'pour j=1 a 2000 << noeud 1 0. 0. >>',
    '>>',
  ]);
  assert.equal(m.truncated, true);
});
