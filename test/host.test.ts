/**
 * Tests du code de l'extension host (`src/`), rendus possibles par la doublure
 * `test/stubs/vscode.ts` (aliassee par `scripts/build.mjs` sur le bundle de
 * tests). Deux cibles :
 *
 *  1. `parseErrorFile` (`src/run.ts`) — le pont entre `erreur.txt` et le
 *     panneau Problems : c'est la partie du lancement dont dependent les
 *     diagnostics du solveur.
 *  2. Le contrat commandes : chaque commande declaree dans `package.json`
 *     doit etre enregistree quelque part dans `src/` — le bug « bouton qui ne
 *     fait rien » se detecte statiquement, sans lancer VS Code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { DiagnosticSeverity } from 'vscode';
import { parseErrorFile } from '../src/run.js';

// ---------------------------------------------------------------------------
// parseErrorFile : format documente du manuel (p.34)
// ---------------------------------------------------------------------------

test('parseErrorFile lit un bloc complet fichier / ligne / erreur', () => {
  const messages = parseErrorFile([
    '--- fichier : >pont.st1',
    '--- ligne : 101 ---',
    'erreur : parentheses non apaires',
  ].join('\n'));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].file, 'pont.st1');
  assert.equal(messages[0].line, 101);
  assert.equal(messages[0].severity, DiagnosticSeverity.Error);
  assert.equal(messages[0].message, 'parentheses non apaires');
});

test('parseErrorFile : attention et avertissement sont des warnings', () => {
  const messages = parseErrorFile([
    'attention : valeur par defaut utilisee',
    'avertissement : commande obsolete',
  ].join('\n'));
  assert.equal(messages.length, 2);
  assert.ok(messages.every((m) => m.severity === DiagnosticSeverity.Warning));
});

test('parseErrorFile tolere un message sans en-tete et rattache au contexte connu', () => {
  const messages = parseErrorFile([
    '--- fichier : etude.st1',
    'erreur : premier message sans numero de ligne',
    '--- ligne : 12',
    'erreur : second message',
  ].join('\n'));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].file, 'etude.st1');
  assert.equal(messages[0].line, undefined);
  assert.equal(messages[1].line, 12);
});

test('parseErrorFile : un nouveau fichier reinitialise la ligne courante', () => {
  const messages = parseErrorFile([
    '--- fichier : a.st1',
    '--- ligne : 5',
    'erreur : dans a',
    '--- fichier : b.st1',
    'erreur : dans b, ligne inconnue',
  ].join('\n'));
  assert.equal(messages[1].file, 'b.st1');
  assert.equal(messages[1].line, undefined);
});

test('parseErrorFile ignore le bruit et reste insensible a la casse', () => {
  const messages = parseErrorFile([
    'ST1 v2.24 — interpretation du fichier',
    '--- FICHIER : >exemple5.st1 ---',
    '--- LIGNE : 3 ---',
    'ERREUR : mot-cle inconnu',
    '',
    'fin du traitement',
  ].join('\n'));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].file, 'exemple5.st1');
  assert.equal(messages[0].line, 3);
});

test('parseErrorFile : fichier vide ou sans message ne produit rien', () => {
  assert.equal(parseErrorFile('').length, 0);
  assert.equal(parseErrorFile('--- fichier : a.st1\n--- ligne : 4').length, 0);
});

test('parseErrorFile : format REEL de ST1 v2.24 (espace de tete, suffixe action, chemin absolu)', () => {
  // Extrait conforme au specimen erreur.txt d'un run reel (2026-08-04).
  const messages = parseErrorFile([
    ' CEREMA -                         PROGRAMME ST1 Version 2.24',
    ' Execution phasage    101',
    ' --- Fichier : >c:\\Users\\Yoshida\\Desktop\\exemple_ST1\\exemple5.st1',
    ' --- Ligne :   123 action :    4 ---',
    ' attention : age negatif',
    ' --- Ligne :   143 ---',
    ' attention : age negatif',
    '  -- etat :           12  --',
    ' --- Ligne :   130 action :    9 ---',
    ' attention : age nul de la barre activee :         11',
    ' attention : age nul de la barre activee :         12',
  ].join('\n'));
  assert.equal(messages.length, 4);
  assert.ok(messages.every((m) => m.file === 'c:\\Users\\Yoshida\\Desktop\\exemple_ST1\\exemple5.st1'));
  assert.ok(messages.every((m) => m.severity === DiagnosticSeverity.Warning));
  assert.deepEqual(messages.map((m) => m.line), [123, 143, 130, 130]);
  assert.equal(messages[2].message, 'age nul de la barre activee :         11');
});

const REAL_ERROR_FILE = 'C:/Users/Yoshida/Desktop/exemple_ST1/erreur.txt';

test('parseErrorFile : le specimen reel complet est lu', { skip: !existsSync(REAL_ERROR_FILE) }, () => {
  const messages = parseErrorFile(readFileSync(REAL_ERROR_FILE, 'latin1'));
  assert.equal(messages.length, 6);
  assert.ok(messages.every((m) => m.severity === DiagnosticSeverity.Warning));
  assert.deepEqual(messages.map((m) => m.line), [123, 143, 127, 127, 130, 130]);
  assert.match(messages[0].file ?? '', /exemple5\.st1$/i);
});

// ---------------------------------------------------------------------------
// Contrat commandes : package.json <-> src/
// ---------------------------------------------------------------------------

test('chaque commande declaree dans package.json est enregistree dans src/', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    contributes: { commands: { command: string }[] };
  };
  const sources = readdirSync('src')
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(`src/${name}`, 'utf8'))
    .join('\n');

  const missing = manifest.contributes.commands
    .map((c) => c.command)
    .filter((id) => !sources.includes(`'${id}'`) && !sources.includes(`"${id}"`));

  assert.deepEqual(missing, [], `Commande(s) declaree(s) mais jamais enregistree(s) : ${missing.join(', ')}`);
});

test('chaque commande utilisee dans les menus est declaree', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    contributes: {
      commands: { command: string }[];
      menus: Record<string, { command: string }[]>;
    };
  };
  const declared = new Set(manifest.contributes.commands.map((c) => c.command));
  const missing = Object.values(manifest.contributes.menus)
    .flat()
    .map((entry) => entry.command)
    .filter((id) => !declared.has(id));
  assert.deepEqual(missing, []);
});
