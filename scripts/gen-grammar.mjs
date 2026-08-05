// Genere `syntaxes/st1.tmLanguage.json` depuis le catalogue.
//
// NE PAS EDITER LA GRAMMAIRE A LA MAIN : elle est reecrite a chaque `npm run gen`.
//
// Choix deliberé : les mots-cles sont enumeres en MAJUSCULES et en minuscules
// plutot que via un `(?i)`. ST1 refuse la casse mixte (`Noeud` n'est pas
// reconnu, manuel p.30) ; ne pas coloriser `Noeud` donne donc a l'utilisateur
// un signal visuel immediat, coherent avec le diagnostic du serveur.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(resolve(root, 'catalog/st1-catalog.json'), 'utf8'));

/** `NOEUD` -> `NOEUD|noeud` ; les mots composes deviennent `MOT\s+MOT`. */
function bothCases(word) {
  const upper = word.toUpperCase().split(/\s+/).join('\\s+');
  const lower = word.toLowerCase().split(/\s+/).join('\\s+');
  return upper === lower ? [upper] : [upper, lower];
}

function alternation(words) {
  const seen = new Set();
  const parts = [];
  // Une categorie vide doit produire un motif qui ne matche jamais : une
  // alternative vide (`()`) matcherait la chaine vide partout.
  if (![...words].length) return '(?!)';
  // Les mots les plus longs d'abord : `EXEC SPECTRE REPONSE` avant `EXEC`.
  for (const word of [...words].sort((a, b) => b.length - a.length || a.localeCompare(b))) {
    for (const variant of bothCases(word)) {
      if (!seen.has(variant)) {
        seen.add(variant);
        parts.push(variant);
      }
    }
  }
  return parts.join('|');
}

// -------------------------------------------------------------- vocabulaires
const commandNames = new Set();
const argumentNames = new Set();
const enumValues = new Set();
const terminators = new Set();

// Convention de notation du manuel (p.32) : les MOTS-CLES s'ecrivent en
// majuscules, les valeurs et listes a fournir par l'utilisateur en minuscules.
// Un nom d'argument en minuscules (`liste`, `coef`, `commande_de_phasage`) est
// donc une metavariable, pas un mot du langage : la coloriser ferait passer une
// variable utilisateur homonyme pour un mot-cle.
const isKeyword = (word) => /^[A-Z_][A-Z0-9_]*$/.test(word);

for (const command of catalog.commands) {
  for (const name of [command.name, ...(command.aliases ?? [])]) commandNames.add(name);
  if (command.terminator) terminators.add(command.terminator);
  for (const arg of command.args ?? []) {
    if (isKeyword(arg.name)) argumentNames.add(arg.name);
    for (const value of arg.values ?? []) {
      if (isKeyword(value)) enumValues.add(value);
    }
  }
}

// Les options de structure sont le pivot du langage : scope dedie.
const structureOptions = Object.keys(catalog.structureOptions);
for (const option of structureOptions) enumValues.delete(option);

// Un mot ne doit appartenir qu'a une seule categorie ; l'ordre de priorite est
// commande > terminateur > argument > valeur enumeree.
for (const name of commandNames) {
  argumentNames.delete(name);
  enumValues.delete(name);
}
for (const name of terminators) {
  argumentNames.delete(name);
  enumValues.delete(name);
}
for (const name of argumentNames) enumValues.delete(name);

const control = catalog.lexical.controlKeywords ?? [];
const listWords = catalog.lexical.listKeywords ?? [];
const functions = catalog.lexical.functions ?? [];
const colors = catalog.lexical.colors ?? [];
for (const word of [...control, ...listWords, ...functions]) {
  commandNames.delete(word);
  argumentNames.delete(word);
  enumValues.delete(word);
}

// Mots reserves de st1.par (pilotes de trace, types d'ecran, PI) : PsPad les
// classe en [ReservedWords]. On ne colorise que ceux qu'aucune categorie du
// manuel ne revendique deja, pour ne pas requalifier un mot-cle documente.
const reserved = new Set(catalog.lexical.reservedWords ?? []);
for (const name of [...commandNames, ...terminators, ...argumentNames, ...enumValues, ...control, ...functions, ...colors, ...structureOptions]) {
  reserved.delete(name.toUpperCase());
}

const grammar = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  name: 'ST1',
  scopeName: 'source.st1',
  fileTypes: ['st1', 'ST1'],
  // Fichier genere — toute edition manuelle sera ecrasee par `npm run gen`.
  patterns: [
    { include: '#comment' },
    { include: '#string' },
    { include: '#terminator' },
    { include: '#exec' },
    { include: '#command' },
    { include: '#control' },
    { include: '#structure-option' },
    { include: '#function' },
    { include: '#list-keyword' },
    { include: '#color' },
    { include: '#reserved' },
    { include: '#argument' },
    { include: '#enum' },
    { include: '#variable' },
    { include: '#number' },
    { include: '#operator' },
  ],
  repository: {
    comment: {
      match: '#.*$',
      name: 'comment.line.number-sign.st1',
    },
    string: {
      begin: "'",
      end: "'",
      name: 'string.quoted.single.st1',
      patterns: [{ match: "''", name: 'constant.character.escape.st1' }],
    },
    terminator: {
      match: `^\\s*(${alternation([...terminators])})\\b`,
      captures: { 1: { name: 'keyword.control.terminator.st1' } },
    },
    exec: {
      match: `^\\s*(${alternation([...commandNames].filter((n) => n.toUpperCase().startsWith('EXEC')))})\\b`,
      captures: { 1: { name: 'keyword.control.exec.st1' } },
    },
    command: {
      match: `(?:^|;)\\s*(${alternation([...commandNames].filter((n) => !n.toUpperCase().startsWith('EXEC')))})\\b`,
      captures: { 1: { name: 'entity.name.function.command.st1' } },
    },
    control: {
      match: `\\b(${alternation(control)})\\b`,
      name: 'keyword.control.flow.st1',
    },
    'structure-option': {
      match: `\\b(${alternation(structureOptions)})\\b`,
      name: 'support.class.structure-option.st1',
    },
    function: {
      match: `\\b(${alternation(functions)})\\s*(?=\\()`,
      name: 'support.function.math.st1',
    },
    'list-keyword': {
      match: `(?<=[\\s,])(${alternation(listWords)})(?=[\\s,])`,
      name: 'keyword.operator.range.st1',
    },
    color: {
      match: `\\b(${alternation(colors)})\\b`,
      name: 'support.constant.color.st1',
    },
    // Mots reserves de st1.par : scope `constant.language`, que les themes
    // colorisent de facon distincte (souvent avec un style marque). On evite un
    // theme fixe code en dur, qui casserait en clair ou en sombre.
    reserved: {
      match: `\\b(${alternation([...reserved])})\\b`,
      name: 'constant.language.st1',
    },
    argument: {
      match: `\\b(${alternation([...argumentNames])})\\b`,
      name: 'variable.parameter.st1',
    },
    enum: {
      match: `\\b(${alternation([...enumValues])})\\b`,
      name: 'support.constant.st1',
    },
    variable: {
      match: '\\$[A-Za-z_][A-Za-z0-9_]*',
      name: 'variable.other.readwrite.st1',
    },
    number: {
      // Notation scientifique `e` et notation Fortran `d` (manuel p.61).
      match: '(?<![A-Za-z0-9_])[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eEdD][-+]?\\d+)?\\b',
      name: 'constant.numeric.st1',
    },
    operator: {
      match: '\\*\\*|<=|>=|==|/=|<>|[-+*/=<>]',
      name: 'keyword.operator.st1',
    },
  },
};

mkdirSync(resolve(root, 'syntaxes'), { recursive: true });
writeFileSync(resolve(root, 'syntaxes/st1.tmLanguage.json'), JSON.stringify(grammar, null, 2) + '\n', 'utf8');

console.log(
  `Grammaire generee : ${commandNames.size} commandes, ${argumentNames.size} arguments, ${enumValues.size} valeurs enumerees.`,
);
