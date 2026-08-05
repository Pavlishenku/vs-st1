/**
 * Garde-fous du catalogue.
 *
 * Le catalogue etant la source de verite de toute l'extension, ces tests
 * verifient son integrite : provenance obligatoire, absence de doublon,
 * coherence des contextes de bloc et des restrictions par OPTION. Ils font
 * echouer le build plutot que de laisser passer un catalogue qui produirait
 * une completion ou une validation fausse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import catalogJson from '../catalog/st1-catalog.json';
import { buildIndex, blockOf, normalize, renderCommandDoc, formatPages, type Catalog } from '../shared/catalog.js';

const catalog = catalogJson as unknown as Catalog;
const index = buildIndex(catalog);

test('le catalogue declare sa provenance', () => {
  assert.ok(catalog.source.pageCount > 0);
  assert.equal(catalog.source.provenanceKind, 'physical_pdf_page');
});

test('chaque commande porte au moins une page source', () => {
  const orphelines = catalog.commands.filter((c) => !c.pages?.length);
  assert.deepEqual(orphelines.map((c) => c.name), []);
});

test('les pages citees existent dans le manuel', () => {
  const hors = catalog.commands.filter((c) =>
    c.pages.some((p) => !Number.isInteger(p) || p < 1 || p > catalog.source.pageCount),
  );
  assert.deepEqual(hors.map((c) => `${c.name}: ${c.pages.join(',')}`), []);
});

test('aucun doublon de nom dans un meme contexte', () => {
  const seen = new Set<string>();
  const doublons: string[] = [];
  for (const command of catalog.commands) {
    const key = `${command.context}|${normalize(command.name)}`;
    if (seen.has(key)) doublons.push(key);
    seen.add(key);
  }
  assert.deepEqual(doublons, []);
});

test('chaque commande a un resume et au moins une ligne de syntaxe', () => {
  const incompletes = catalog.commands.filter((c) => !c.summary?.trim() || !c.syntax?.length);
  assert.deepEqual(incompletes.map((c) => c.name), []);
});

test('tout contexte « bloc:X » designe une commande existante', () => {
  // X n'est pas forcement ferme par un terminateur : ST1 compte aussi des
  // blocs souples (CARA VAR LIN Y, ETUDE, TRACE) dont les sous-commandes
  // suivent l'en-tete sans FIN.
  const noms = new Set(catalog.commands.map((c) => normalize(c.name)));
  const inconnus = catalog.commands
    .map((c) => blockOf(c.context))
    .filter((b): b is string => Boolean(b))
    .filter((b) => !noms.has(b));
  assert.deepEqual([...new Set(inconnus)], []);
});

test('les restrictions par OPTION n emploient que des options connues', () => {
  const connues = new Set(Object.keys(catalog.structureOptions));
  const invalides: string[] = [];
  for (const command of catalog.commands) {
    for (const option of command.restrictedToOptions ?? []) {
      if (!connues.has(option)) invalides.push(`${command.name}: ${option}`);
    }
    for (const arg of command.args ?? []) {
      for (const option of arg.onlyOptions ?? []) {
        if (!connues.has(option)) invalides.push(`${command.name}.${arg.name}: ${option}`);
      }
    }
  }
  assert.deepEqual(invalides, []);
});

test('les trois options de structure sont completement decrites', () => {
  for (const [name, spec] of Object.entries(catalog.structureOptions)) {
    assert.ok(spec.coordinates.length >= 2, `${name}: coordonnees`);
    assert.ok(spec.ddl.length >= 3, `${name}: DDL`);
    assert.ok(spec.barProperties.length > 0, `${name}: caracteristiques`);
    for (const famille of ['EFFORT', 'DEPLA', 'CONTR', 'PRESS', 'REAC']) {
      assert.ok(spec.surchargeComponents[famille]?.length, `${name}: composantes ${famille}`);
    }
  }
});

test('les exemples du catalogue respectent les regles lexicales ST1', () => {
  const fautifs: string[] = [];
  for (const command of catalog.commands) {
    for (const example of command.examples ?? []) {
      if (/[À-ɏ]/.test(example.normalize('NFC'))) fautifs.push(`${command.name}: accent dans « ${example} »`);
      if (example.includes('//')) fautifs.push(`${command.name}: commentaire // dans « ${example} »`);
    }
  }
  assert.deepEqual(fautifs, []);
});

test('l index reconnait les commandes composees en priorite', () => {
  // Une commande composee doit gagner sur son premier mot.
  for (const command of catalog.commands) {
    const words = normalize(command.name).split(' ');
    if (words.length < 2) continue;
    const found = index.byName.get(normalize(command.name));
    assert.ok(found, `${command.name} absente de l index`);
    assert.ok(index.compoundHeads.has(words[0]));
  }
});

test('le rendu de documentation reste utilisable pour toutes les commandes', () => {
  for (const command of catalog.commands) {
    const rendered = renderCommandDoc(command);
    assert.ok(rendered.includes(command.name));
    assert.ok(rendered.includes('Manuel ST1 v24'));
  }
});

test('les plages de pages sont compactees a l affichage', () => {
  assert.equal(formatPages([47, 48, 49, 52]), '47-49, 52');
  assert.equal(formatPages([5]), '5');
  assert.equal(formatPages([3, 1, 2]), '1-3');
});

test('le catalogue couvre les commandes fondamentales d une etude', () => {
  const attendues = [
    'OPTION', 'TITRE', 'NOEUD', 'BARRE', 'APPUI', 'CARA', 'CONS', 'MAT',
    'ETUDE', 'CHARG', 'EXEC CHARG', 'COMB', 'ENV', 'RESU',
    'PREC', 'CABLE', 'TABLIER', 'SURCH', 'PHASAGE', 'EXEC MODE',
  ];
  const manquantes = attendues.filter((name) => !index.byName.has(name));
  assert.deepEqual(manquantes, []);
});
