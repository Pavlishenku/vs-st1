/**
 * Tests du rapport de coherence de l'etude (`shared/report.ts`).
 *
 * Chaque famille de controles a au moins un cas declencheur et un cas
 * conforme. Le dernier test passe le corpus reel des exemples du manuel
 * (s'il est present sur la machine) : un fichier que ST1 accepte ne doit
 * declencher aucune reference brisee — c'est la chasse aux faux positifs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import catalog from '../catalog/st1-catalog.json';
import { buildIndex, type Catalog } from '../shared/catalog.js';
import { parse } from '../shared/parser.js';
import { buildModel } from '../shared/model.js';
import { buildStudyReport, type StudyReport } from '../shared/report.js';

const index = buildIndex(catalog as unknown as Catalog);

function report(lines: string[]): StudyReport {
  const document = parse(lines.join('\n'), index);
  const model = buildModel(document, { index });
  return buildStudyReport(document, model);
}

/** Tous les controles du rapport, a plat : [code, verdict, detail]. */
function flat(r: StudyReport): { code: string; verdict: string; detail?: string }[] {
  return r.families.flatMap((f) => f.rows.flatMap((row) => row.checks));
}

function verdictOf(r: StudyReport, code: string): string[] {
  return flat(r).filter((c) => c.code === code).map((c) => c.verdict);
}

const BASE = [
  'OPTION PLANE',
  'NOEUD 1 0. 0.',
  'NOEUD 2 10. 0.',
  'BARRE 1 DE 1 A 2',
  'APPUI 1 NOEUD 1 DX DY',
  'APPUI 2 NOEUD 2 DY',
  'CARA 1 SX 0.5 IZ 0.0417',
  'CONS 1 E 3.5e10 RO 25000.',
];

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test('etude complete et coherente : aucun controle en erreur', () => {
  const r = report([
    ...BASE,
    "CHARG 1 'poids'",
    '  POIDS PROPRE TOUT',
    'FIN',
    'EXEC CHARG',
    'RESU',
    '  CHARG 1 BARRE EFFORT',
    'FIN',
  ]);
  assert.equal(r.summary.errors, 0, JSON.stringify(flat(r).filter((c) => c.verdict === 'error')));
});

test('I1 : noeud isole signale, C2/C3 : barre sans CARA ni CONS', () => {
  const r = report(['OPTION PLANE', 'NOEUD 1,2,3 0. 0.', 'BARRE 1 1 2', 'APPUI 1 NOEUD 1 DX DY']);
  assert.deepEqual(verdictOf(r, 'I1'), ['warn']); // noeud 3
  assert.deepEqual(verdictOf(r, 'C2'), ['error']);
  assert.deepEqual(verdictOf(r, 'C3'), ['error']);
});

test('C4 : aucun appui = mecanisme, sauf sol elastique PSE', () => {
  const libre = report(['OPTION PLANE', 'NOEUD 1,2 0. 0.', 'BARRE 1 1 2']);
  assert.deepEqual(verdictOf(libre, 'C4'), ['error']);
  const pse = report(['OPTION PLANE', 'NOEUD 1,2 0. 0.', 'BARRE 1 1 2', 'CARA PSE 1 SX 1 IZ 1 ZONE 1 KFX 1 KFY 500']);
  assert.deepEqual(verdictOf(pse, 'C4'), []);
});

// ---------------------------------------------------------------------------
// Cas de charge, combinaisons, enveloppes
// ---------------------------------------------------------------------------

test('I6/I7 : CHARG sans EXEC et jamais repris', () => {
  const r = report([...BASE, "CHARG 1 'poids'", '  POIDS PROPRE TOUT', 'FIN']);
  assert.deepEqual(verdictOf(r, 'I6'), ['warn']);
  assert.deepEqual(verdictOf(r, 'I7'), ['warn']);
});

test('I6 : EXEC CHARG avec liste explicite ne couvre pas les autres cas', () => {
  const r = report([
    ...BASE,
    "CHARG 1 'a'", '  POIDS PROPRE TOUT', 'FIN',
    "CHARG 2 'b'", '  POIDS PROPRE TOUT', 'FIN',
    'EXEC CHARG 1',
    'RESU', '  CHARG 1,2', 'FIN',
  ]);
  // CHARG 1 execute, CHARG 2 hors liste.
  assert.deepEqual(verdictOf(r, 'I6').sort(), ['ok', 'warn']);
  assert.deepEqual(verdictOf(r, 'I7'), ['ok', 'ok']);
});

test('R8 : une enveloppe qui reprend un cas non defini est en erreur', () => {
  const r = report([
    ...BASE,
    "CHARG 1 'a'", '  POIDS PROPRE TOUT', 'FIN',
    'EXEC CHARG',
    "ENV 1 'enveloppe'",
    '  CHARG',
    '  1 .25',
    '  3 .50',
    'FIN',
    'RESU', '  ENV 1', 'FIN',
  ]);
  const broken = flat(r).filter((c) => c.code === 'R8' && c.verdict === 'error');
  assert.equal(broken.length, 1);
  assert.match(broken[0].detail ?? '', /CHARG 3/);
});

test('R8 : les coefficients ne sont pas pris pour des references (charg 1 1.00 1.35)', () => {
  const r = report([
    ...BASE,
    "CHARG 1 'a'", '  POIDS PROPRE TOUT', 'FIN',
    'EXEC CHARG',
    "ENV 3 COMB 'ELU'",
    '  CHARG 1  1.00  1.35',
    'FIN',
    'RESU', '  ENV 3', 'FIN',
  ]);
  assert.deepEqual(verdictOf(r, 'R8'), ['ok']);
});

test('I8 : combinaison jamais editee ; RESU ENV sans liste couvre tout', () => {
  const inerte = report([...BASE, "CHARG 1 'a'", 'FIN', 'EXEC CHARG', "ENV 1 'e'", '  CHARG 1', 'FIN']);
  assert.deepEqual(verdictOf(inerte, 'I8'), ['warn']);
  const editee = report([...BASE, "CHARG 1 'a'", 'FIN', 'EXEC CHARG', "ENV 1 'e'", '  CHARG 1', 'FIN', 'RESU', '  ENV', 'FIN']);
  assert.deepEqual(verdictOf(editee, 'I8'), ['ok']);
});

// ---------------------------------------------------------------------------
// Materiaux et precontrainte
// ---------------------------------------------------------------------------

test('I3/I4/R5/I5 : materiau inerte, PREC orpheline, PREC manquante, cable jamais tendu', () => {
  const r = report([
    'OPTION SPATIALE',
    'NOEUD 1,2 0. 0. 0.',
    'BARRE 1 1 2',
    'CARA 1 SX 1 IX 1 IY 1 IZ 1',
    "MATERIAU 7 'beton perdu'", '  RO 2.5', 'FIN',
    'CONS 1 E 1e6',
    "PREC 11 'active'", '  SECTION 1e-3', '  TENSION 1000', 'FIN',
    "PREC 12 'orpheline'", '  SECTION 1e-3', '  TENSION 1000', 'FIN',
    'CABLE 101', '  PREC 11', '  BARRE 1', 'FIN',
    'CABLE 102', '  PREC 99', '  BARRE 1', 'FIN',
  ]);
  assert.deepEqual(verdictOf(r, 'I3'), ['warn']); // materiau 7 jamais affecte
  assert.deepEqual(verdictOf(r, 'I4').sort(), ['ok', 'warn']); // PREC 12 orpheline
  assert.deepEqual(verdictOf(r, 'R5').sort(), ['error', 'ok']); // PREC 99 non definie
  assert.deepEqual(verdictOf(r, 'I5'), ['warn', 'warn']); // aucun cable tendu
});

test('I5 : un cable charge par CHARG CABLE ou tendu en phasage est conforme', () => {
  const r = report([
    'OPTION SPATIALE',
    'NOEUD 1,2 0. 0. 0.',
    'BARRE 1 1 2',
    "PREC 11 'p'", 'FIN',
    'CABLE 101', '  PREC 11', '  BARRE 1', 'FIN',
    'CABLE 102', '  PREC 11', '  BARRE 1', 'FIN',
    "CHARG 1 'tension'", '  CABLE 101 TENSION', 'FIN',
    'EXEC CHARG',
    'PHASAGE 1', '  ACTIVER TOUT', '  TENDRE CABLE 102', '  ETAT 1', 'FIN PHASAGE',
    'EXEC PHASAGE',
    'RESU', '  CHARG', '  PHASAGE', 'FIN',
  ]);
  assert.deepEqual(verdictOf(r, 'I5'), ['ok', 'ok']);
});

// ---------------------------------------------------------------------------
// Phasage
// ---------------------------------------------------------------------------

test('I9/I10 : phasage sans EXEC, barres jamais activees', () => {
  const r = report([
    ...BASE,
    'NOEUD 3 20. 0.',
    'BARRE 2 DE 2 A 3',
    'CARA 2 SX 0.5 IZ 0.0417',
    'CONS 2 E 3.5e10',
    'PHASAGE 1', '  ACTIVER APPUI 1,2', '  ACTIVER BARRE 1', '  ETAT 1', 'FIN PHASAGE',
  ]);
  assert.deepEqual(verdictOf(r, 'I9'), ['warn']);
  const i10 = flat(r).filter((c) => c.code === 'I10' && c.verdict === 'warn');
  assert.equal(i10.length, 1); // barre 2 jamais activee ; les appuis sont couverts
  assert.match(i10[0].detail ?? '', /2/);
});

// ---------------------------------------------------------------------------
// Dynamique, feu, references hors bloc
// ---------------------------------------------------------------------------

test('I11/I12 : spectre repris et reponse executee', () => {
  const r = report([
    ...BASE,
    'MASSE PROPRE', '  BARRE TOUT MASSE', 'FIN',
    'SPECTRE 1', '  ACCELERATION', '  PERIODE 0.1 AX 1. AY 1.', 'FIN',
    'SPECTRE 2', '  ACCELERATION', '  PERIODE 0.1 AX 1. AY 1.', 'FIN',
    'SPECTRE 5 REPONSE', '  SPECTRE 1', '  SRSS', 'FIN',
    'EXEC MODE 10',
    'EXEC SPECTRE REPONSE 5',
  ]);
  assert.deepEqual(verdictOf(r, 'I11').sort(), ['ok', 'warn']); // spectre 2 inerte
  assert.deepEqual(verdictOf(r, 'I12'), ['ok']);
});

test('R12 : EXEC avec liste visant un cas non defini', () => {
  const r = report([...BASE, "CHARG 1 'a'", 'FIN', 'EXEC CHARG 1,9', 'RESU', ' CHARG', 'FIN']);
  const broken = flat(r).filter((c) => c.code === 'R12');
  assert.equal(broken.length, 1);
  assert.match(broken[0].detail ?? '', /9/);
});

test('G4 : aucune edition signalee ; R14 : LIRE non resolu suspend les existences', () => {
  const muet = report([...BASE]);
  assert.deepEqual(verdictOf(muet, 'G4'), ['warn']);

  const document = parse([...BASE.slice(0, 4), "LIRE 'suite.st1'"].join('\n'), index);
  const model = buildModel(document, { index, resolve: () => null });
  const r = buildStudyReport(document, model);
  assert.deepEqual(verdictOf(r, 'R14'), ['error']);
  assert.equal(r.silenced, true);
  assert.deepEqual(verdictOf(r, 'C2'), ['na']); // existence suspendue
});

// ---------------------------------------------------------------------------
// Corpus reel : zero reference brisee sur les exemples officiels du manuel
// ---------------------------------------------------------------------------

const CORPUS = 'C:/Users/Yoshida/Desktop/exemple_ST1';

test('corpus du manuel : aucune reference brisee (chasse aux faux positifs)', { skip: !existsSync(CORPUS) }, () => {
  for (const name of readdirSync(CORPUS).filter((f) => f.toLowerCase().endsWith('.st1'))) {
    const text = readFileSync(join(CORPUS, name), 'latin1');
    const document = parse(text, index);
    const model = buildModel(document, { index, file: join(CORPUS, name) });
    const r = buildStudyReport(document, model);
    // Un fichier que ST1 accepte ne doit produire AUCUNE erreur — les
    // avertissements (objets inertes) restent legitimes sur des exemples.
    const broken = flat(r).filter((c) => c.verdict === 'error');
    assert.deepEqual(
      broken,
      [],
      `${name} : ${broken.map((c) => `${c.code} ${c.detail ?? ''}`).join(' | ')}`,
    );
  }
});
