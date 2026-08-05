/**
 * Formatage d'un fichier ST1.
 *
 * **Le formatage ne touche jamais a l'interieur d'une ligne.** Le manuel precise
 * qu'aucun caractere blanc n'est admis dans une expression (`1+2 +3` vaut deux
 * valeurs) : reindenter est sur, « normaliser les espaces » ne le serait pas et
 * changerait silencieusement les resultats du calcul.
 *
 * Ce formateur se limite donc a deux operations reversibles :
 *  - fixer l'indentation de chaque ligne selon la profondeur de bloc ;
 *  - supprimer les blancs de fin de ligne.
 */

import type { ParsedDocument } from './parser.js';

export interface FormatOptions {
  /** Chaine d'indentation d'un niveau. */
  indent?: string;
  /** Restreint la reindentation a un intervalle de lignes. */
  fromLine?: number;
  toLine?: number;
}

export function formatDocument(text: string, document: ParsedDocument, options: FormatOptions = {}): string {
  const indent = options.indent ?? '   ';
  const from = options.fromLine ?? 0;
  const to = options.toLine ?? Number.MAX_SAFE_INTEGER;
  const lines = text.split(/\r?\n/);

  // Profondeur cible de chaque ligne : nombre de blocs ouverts qui la couvrent.
  const depth = new Array(lines.length).fill(0);
  for (const block of document.blocks) {
    for (let line = block.startLine + 1; line <= Math.min(block.endLine, lines.length - 1); line++) {
      // La ligne du terminateur revient au niveau du bloc. Un bloc souple n'en
      // a pas : sa derniere ligne est une ligne de contenu, a indenter.
      if (line === block.endLine && block.closed && !block.soft) continue;
      depth[line] += 1;
    }
  }

  const formatted = lines.map((line, number) => {
    const trimmed = line.replace(/\s+$/, '');
    if (number < from || number > to) return trimmed;
    if (!trimmed.trim()) return '';
    return indent.repeat(depth[number]) + trimmed.replace(/^\s+/, '');
  });

  // Preserve le style de fin de ligne du fichier d'origine.
  return formatted.join(text.includes('\r\n') ? '\r\n' : '\n');
}
