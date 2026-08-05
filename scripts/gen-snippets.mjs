// Genere `snippets/st1.json` depuis le catalogue.
//
// NE PAS EDITER LES SNIPPETS A LA MAIN : ils sont reecrits a chaque `npm run gen`.
//
// Un snippet est produit pour chaque commande : squelette de bloc pour celles
// qui ont un terminateur, ligne de syntaxe pour les autres. Les arguments
// obligatoires deviennent des tabulations ordonnees, les arguments a valeurs
// enumerees des listes de choix `${n|A,B,C|}`.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(resolve(root, 'catalog/st1-catalog.json'), 'utf8'));

const snippets = {};

/** Echappe les caracteres speciaux du format snippet de VS Code. */
function escape(text) {
  return text.replace(/([$}\\])/g, '\\$1');
}

// Seules les commandes de PREMIER NIVEAU deviennent des snippets. Les
// sous-commandes sont proposees par le serveur de langage, qui sait dans quel
// bloc se trouve le curseur ; les mettre ici les rendrait disponibles partout,
// et les homonymes (CHARG au premier niveau / CHARG dans RESU) s'ecraseraient.
const topLevel = catalog.commands.filter((command) => !String(command.context).startsWith('bloc:'));

for (const command of topLevel) {
  const required = (command.args ?? []).filter((arg) => arg.required);
  let index = 1;

  const placeholder = (arg) => {
    if (arg.values?.length && arg.values.length <= 8) {
      return `\${${index++}|${arg.values.map(escape).join(',')}|}`;
    }
    const hint = arg.default !== undefined ? String(arg.default) : arg.name.toLowerCase();
    return `\${${index++}:${escape(hint)}}`;
  };

  const body = [];

  if (command.terminator) {
    // Bloc : en-tete, arguments obligatoires en lignes indentees, terminateur.
    const inline = required.filter((arg) => arg.kind === 'positional');
    const nested = required.filter((arg) => arg.kind !== 'positional');
    body.push(`${command.name}${inline.length ? ' ' + inline.map(placeholder).join(' ') : ' ${' + index++ + ':1}'}`);
    for (const arg of nested) body.push(`\t${arg.name} ${placeholder(arg)}`);
    if (!nested.length) body.push(`\t\${${index++}}`);
    body.push(command.terminator);
  } else {
    const parts = [command.name];
    for (const arg of required) {
      parts.push(arg.kind === 'flag' ? arg.name : `${arg.kind === 'keyword' ? arg.name + ' ' : ''}${placeholder(arg)}`);
    }
    body.push(parts.join(' '));
  }

  body[body.length - 1] += '$0';

  const restriction = command.restrictedToOptions?.length
    ? ` [OPTION ${command.restrictedToOptions.join('/')}]`
    : '';

  snippets[command.name] = {
    prefix: [command.name, command.name.toLowerCase()],
    body,
    description: `${command.summary}${restriction} — manuel p.${command.pages.join(', ')}`,
  };
}

// Squelettes d'etude complets : ce que l'ingenieur tape le plus souvent.
snippets['Etude — squelette complet'] = {
  prefix: ['etude', 'ETUDE-SQUELETTE'],
  body: [
    '# ${1:Titre de l etude}',
    'OPTION ${2|PLANE,GRILL,SPATIALE|}',
    "TITRE '${1:Titre de l etude}'",
    '',
    '# --- Geometrie',
    'NOEUD 1 0. 0.',
    'NOEUD 2 ${3:10.} 0.',
    'BARRE 1 DE 1 A 2',
    '',
    'APPUI 1 NOEUD 1 DX DY',
    'APPUI 2 NOEUD 2 DY',
    '',
    '# --- Caracteristiques et constantes physiques',
    'CARA 1 SX ${4:0.5} IZ ${5:0.0417} VY ${6:0.25} WY ${6:0.25}',
    'CONS 1 E ${7:3.5e10} NU ${8:0.2} RO ${9:25000.}',
    '',
    '# --- Sections d etude',
    'ETUDE EFFORT DEPLA',
    '   TOUT SE 0. a 1. PAS 1/10 REL',
    '',
    '# --- Chargements',
    "CHARG 1 '${10:Poids propre}'",
    '   POIDS PROPRE TOUT',
    'FIN',
    '',
    'EXEC CHARG',
    '',
    'RESU',
    '   BARRE EFFORT DEPLA CONTR',
    'FIN',
    '$0',
  ],
  description: "Squelette d'une etude ST1 complete : geometrie, appuis, caracteristiques, chargement, execution, edition.",
};

snippets['Boucle POUR'] = {
  prefix: ['pour', 'POUR'],
  body: ['POUR ${1:i} = ${2:1} a ${3:10} <<', '   $0', '>>'],
  description: 'Boucle de pseudo-programmation — manuel p.269',
};

snippets['Test SI'] = {
  prefix: ['si', 'SI'],
  body: ['SI (${1:\\$fy}<${2:0}) <<', '   $0', '>>'],
  description: 'Test conditionnel de pseudo-programmation — manuel p.270',
};

mkdirSync(resolve(root, 'snippets'), { recursive: true });
writeFileSync(resolve(root, 'snippets/st1.json'), JSON.stringify(snippets, null, 2) + '\n', 'utf8');

console.log(`Snippets generes : ${Object.keys(snippets).length}.`);
