// Assemble `catalog/st1-catalog.json` depuis `catalog/base.json` et les
// fichiers de familles `catalog/commands/*.json`.
//
// Ce sont ces fichiers-sources qui s'editent ; le catalogue assemble est
// regenere par `npm run gen` et ne doit pas etre modifie a la main.
//
// L'assemblage refuse de produire un catalogue invalide : provenance manquante,
// doublon, page hors du manuel, contexte de bloc inexistant. Une source de
// verite fausse contaminerait la grammaire, la completion et la validation.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogDir = resolve(root, 'catalog');
const commandsDir = join(catalogDir, 'commands');

const base = JSON.parse(readFileSync(join(catalogDir, 'base.json'), 'utf8'));
delete base._comment;

if (!existsSync(commandsDir)) {
  console.error(`Repertoire introuvable : ${commandsDir}`);
  process.exit(1);
}

const files = readdirSync(commandsDir).filter((name) => name.endsWith('.json')).sort();
const commands = [];
for (const file of files) {
  const content = JSON.parse(readFileSync(join(commandsDir, file), 'utf8'));
  const list = Array.isArray(content) ? content : content.commands;
  if (!Array.isArray(list)) {
    console.error(`${file} : attendu un tableau, ou un objet { "commands": [...] }.`);
    process.exit(1);
  }
  commands.push(...list);
}

// ------------------------------------------------------------- verifications
const problems = [];
const seen = new Map();
// Un bloc parent n'est pas forcement ferme par un terminateur : ST1 compte
// aussi des « blocs souples » (CARA VAR LIN Y, ETUDE, TRACE…) dont les
// sous-commandes suivent l'en-tete sans FIN. Le parent doit donc simplement
// exister au catalogue.
const blockNames = new Set(commands.map((c) => String(c.name).toUpperCase().replace(/\s+/g, ' ')));
const knownOptions = new Set(Object.keys(base.structureOptions));

for (const command of commands) {
  const label = `${command.name ?? '(sans nom)'} [${command.family ?? '?'}]`;

  if (!command.name) problems.push(`${label} : nom manquant`);
  if (!command.family) problems.push(`${label} : famille manquante`);
  if (!command.context) problems.push(`${label} : contexte manquant`);
  if (!command.summary?.trim()) problems.push(`${label} : resume manquant`);
  if (!command.syntax?.length) problems.push(`${label} : aucune ligne de syntaxe`);

  if (!command.pages?.length) {
    problems.push(`${label} : aucune page source — pas de page, pas d'entree`);
  } else {
    const invalid = command.pages.filter((p) => !Number.isInteger(p) || p < 1 || p > base.source.pageCount);
    if (invalid.length) problems.push(`${label} : pages hors du manuel : ${invalid.join(', ')}`);
  }

  const key = `${command.context}|${(command.name ?? '').toUpperCase().replace(/\s+/g, ' ')}`;
  if (seen.has(key)) problems.push(`${label} : doublon avec ${seen.get(key)}`);
  else seen.set(key, label);

  if (typeof command.context === 'string' && command.context.startsWith('bloc:')) {
    const parent = command.context.slice(5).toUpperCase().replace(/\s+/g, ' ');
    if (!blockNames.has(parent)) {
      problems.push(`${label} : contexte « bloc:${parent} » mais aucune commande ${parent} au catalogue`);
    }
  }

  for (const option of command.restrictedToOptions ?? []) {
    if (!knownOptions.has(option)) problems.push(`${label} : option inconnue « ${option} »`);
  }
  for (const arg of command.args ?? []) {
    if (!arg.name) problems.push(`${label} : argument sans nom`);
    if (!arg.doc?.trim()) problems.push(`${label}.${arg.name} : documentation manquante`);
    for (const option of arg.onlyOptions ?? []) {
      if (!knownOptions.has(option)) problems.push(`${label}.${arg.name} : option inconnue « ${option} »`);
    }
  }
  for (const example of command.examples ?? []) {
    if (/[À-ɏ]/.test(example.normalize('NFC'))) {
      problems.push(`${label} : accent interdit dans l'exemple « ${example} »`);
    }
    if (example.includes('//')) {
      problems.push(`${label} : « // » n'est pas un commentaire ST1, dans l'exemple « ${example} »`);
    }
  }
}

if (problems.length) {
  console.error(`Catalogue invalide — ${problems.length} probleme(s) :`);
  for (const problem of problems.slice(0, 40)) console.error(`  - ${problem}`);
  if (problems.length > 40) console.error(`  … et ${problems.length - 40} autre(s).`);
  process.exit(1);
}

// Ordre stable : familles dans l'ordre du flux d'une etude, puis alphabetique.
const FAMILY_ORDER = [
  'general', 'geometrie', 'caracteristiques', 'materiaux', 'chargements',
  'exploitation', 'phasage', 'dynamique', 'feu', 'resultats',
];
const rank = (family) => {
  const position = FAMILY_ORDER.indexOf(family);
  return position < 0 ? FAMILY_ORDER.length : position;
};
commands.sort(
  (a, b) => rank(a.family) - rank(b.family) || a.family.localeCompare(b.family) || a.name.localeCompare(b.name),
);

const catalog = { ...base, commands };

mkdirSync(catalogDir, { recursive: true });
writeFileSync(join(catalogDir, 'st1-catalog.json'), JSON.stringify(catalog, null, 2) + '\n', 'utf8');

const blocks = commands.filter((c) => c.terminator).length;
const sub = commands.filter((c) => String(c.context).startsWith('bloc:')).length;
console.log(
  `Catalogue assemble : ${commands.length} entrees (${blocks} blocs, ${sub} sous-commandes) depuis ${files.length} famille(s).`,
);
