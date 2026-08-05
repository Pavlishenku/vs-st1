/**
 * Validation deterministe d'une etude ST1.
 *
 * Trois niveaux, selectionnables par reglage :
 *  - `lexical`    : regles du manuel p.30-32 (accents, casse, quotes, `#`).
 *  - `structurel` : + structure des blocs, prerequis et interdits du catalogue.
 *  - `complet`    : + coherence du modele (noeuds/barres references, barres sans
 *                   caracteristiques, pieges documentes du memo).
 *
 * Principe directeur : **ne signaler que ce qui est etabli par la source**.
 * Chaque diagnostic porte les pages du manuel qui le fondent ; un doute se
 * traduit par un avertissement, jamais par une erreur.
 */

import type { CatalogCommand, CatalogIndex, StructureOption } from './catalog.js';
import { blockOf, normalize } from './catalog.js';
import { hasAccent, isValidKeywordCase, stripAccents } from './lexer.js';
import { buildModel, type Model } from './model.js';
import type { Block, ParsedDocument, Statement } from './parser.js';

export type Severity = 'error' | 'warning' | 'info' | 'hint';
export type ValidationLevel = 'lexical' | 'structurel' | 'complet';

export interface TextEdit {
  line: number;
  start: number;
  end: number;
  newText: string;
}

export interface QuickFix {
  title: string;
  edits: TextEdit[];
  /** Applique le correctif a toutes les occurrences du meme code. */
  bulk?: boolean;
}

export interface St1Diagnostic {
  code: string;
  message: string;
  severity: Severity;
  line: number;
  start: number;
  end: number;
  /** Pages du manuel v24 qui fondent la regle. */
  pages?: number[];
  fix?: QuickFix;
}

export interface ValidationOptions {
  level?: ValidationLevel;
  maxProblems?: number;
  /**
   * Modele deja construit par l'appelant (avec inclusions `LIRE` resolues).
   * A defaut, un modele est reconstruit depuis le seul document courant.
   */
  model?: Model;
}

export interface ValidationResult {
  diagnostics: St1Diagnostic[];
  model: Model;
}

/** Limites documentees (p.29) et retour d'experience support. */
const MAX_LINE_LENGTH = 128;
const SAFE_ELEMENT_NUMBER = 32768;

const DDL_WORDS = ['DX', 'DY', 'DZ', 'RX', 'RY', 'RZ'];
/**
 * Caracteristiques dont la disponibilite par OPTION est explicitement tabulee
 * (manuel p.60). `IPOL`, `EXTY` et `EXTZ` en sont volontairement absents : le
 * manuel ne les rattache pas a cette table, les signaler produirait un faux
 * positif de severite « erreur ».
 */
const CARA_PROPS = ['SX', 'SY', 'SZ', 'IX', 'IY', 'IZ', 'VY', 'WY', 'VZ', 'WZ', 'KFX', 'KFY', 'KFZ', 'KMX'];
const COMPONENT_FAMILIES = ['EFFORT', 'DEPLA', 'CONTR', 'PRESS', 'REAC'];

export function validate(
  text: string,
  document: ParsedDocument,
  index: CatalogIndex,
  options: ValidationOptions = {},
): ValidationResult {
  const level = options.level ?? 'complet';
  const max = options.maxProblems ?? 500;
  const diagnostics: St1Diagnostic[] = [];
  const model = options.model ?? buildModel(document, { index });

  const push = (diagnostic: St1Diagnostic) => {
    if (diagnostics.length < max) diagnostics.push(diagnostic);
  };

  lexicalRules(text, document, index, push);

  if (level !== 'lexical') {
    structuralRules(document, index, push);
    blockContentRules(document, push);
    prerequisiteRules(document, model, push);
  }

  if (level === 'complet') {
    modelRules(document, model, push);
  }

  diagnostics.sort((a, b) => a.line - b.line || a.start - b.start);
  return { diagnostics, model };
}

// ==========================================================================
// 1. Regles lexicales (manuel p.30-32)
// ==========================================================================

function lexicalRules(
  text: string,
  document: ParsedDocument,
  index: CatalogIndex,
  push: (d: St1Diagnostic) => void,
): void {
  const lines = text.split(/\r?\n/);

  for (const lexLine of document.lexLines) {
    const raw = lines[lexLine.line] ?? '';

    // `//` n'est pas un commentaire ST1.
    const slashes = raw.indexOf('//');
    if (slashes >= 0 && !insideString(lexLine, slashes)) {
      push({
        code: 'lex.comment-slash',
        message: "« // » n'est pas un commentaire ST1 : le commentaire s'ecrit « # » jusqu'a la fin de ligne.",
        severity: 'error',
        line: lexLine.line,
        start: slashes,
        end: slashes + 2,
        pages: [30],
        fix: { title: 'Remplacer « // » par « # »', edits: [{ line: lexLine.line, start: slashes, end: slashes + 2, newText: '#' }], bulk: true },
      });
    }

    // Caracteres accentues : interdits partout dans un script.
    if (hasAccent(raw)) {
      const match = /[À-ɏḀ-ỿ]+/.exec(raw.normalize('NFC'));
      const start = match ? match.index : 0;
      const end = match ? start + match[0].length : raw.length;
      push({
        code: 'lex.accent',
        message: 'Caractere accentue interdit dans un script ST1.',
        severity: 'error',
        line: lexLine.line,
        start,
        end,
        pages: [31],
        fix: { title: 'Retirer les accents de la ligne', edits: [{ line: lexLine.line, start: 0, end: raw.length, newText: stripAccents(raw) }], bulk: true },
      });
    }

    // Quote non refermee.
    const code = lexLine.comment ? raw.slice(0, lexLine.comment.start) : raw;
    if ((code.split("''").join('').match(/'/g) ?? []).length % 2 === 1) {
      push({
        code: 'lex.unbalanced-quote',
        message: "Nombre impair de quotes « ' » : chaine probablement non fermee. Une quote interne se double ('').",
        severity: 'error',
        line: lexLine.line,
        start: 0,
        end: raw.length,
        pages: [31],
      });
    }

    // Longueur de ligne (limite du programme).
    if (raw.length > MAX_LINE_LENGTH) {
      push({
        code: 'lex.line-too-long',
        message: `Ligne de ${raw.length} caracteres : ST1 limite une ligne de fichier a ${MAX_LINE_LENGTH} caracteres.`,
        severity: 'warning',
        line: lexLine.line,
        start: MAX_LINE_LENGTH,
        end: raw.length,
        pages: [29],
      });
    }

    // Casse mixte d'un mot-cle : `Noeud` n'est pas reconnu par ST1.
    for (const token of lexLine.tokens) {
      if (token.kind !== 'word') continue;
      if (isValidKeywordCase(token.text)) continue;
      if (!index.keywords.has(token.value)) continue;
      push({
        code: 'lex.mixed-case',
        message: `Mot-cle « ${token.text} » en casse mixte : un mot-cle ST1 doit etre entierement en MAJUSCULES ou entierement en minuscules.`,
        severity: 'error',
        line: token.line,
        start: token.start,
        end: token.end,
        pages: [30],
        fix: { title: `Ecrire « ${token.value} »`, edits: [{ line: token.line, start: token.start, end: token.end, newText: token.value }], bulk: true },
      });
    }

    // Blanc autour d'un `*` ou `/` : ST1 y verra deux valeurs, pas un produit.
    const spaced = /(\d)\s+([*/])\s*(\d)/.exec(code);
    if (spaced) {
      const start = spaced.index + 1;
      push({
        code: 'lex.spaced-operator',
        message: "Un blanc coupe l'expression : ST1 lit deux valeurs distinctes, pas un produit. Ecrire l'expression sans aucun blanc.",
        severity: 'warning',
        line: lexLine.line,
        start,
        end: start + spaced[0].length - 1,
        pages: [266, 267, 268],
      });
    }
  }
}

function insideString(lexLine: { tokens: { kind: string; start: number; end: number }[] }, column: number): boolean {
  return lexLine.tokens.some((t) => t.kind === 'string' && t.start <= column && column < t.end);
}

// ==========================================================================
// 2. Regles structurelles
// ==========================================================================

function structuralRules(
  document: ParsedDocument,
  index: CatalogIndex,
  push: (d: St1Diagnostic) => void,
): void {
  const first = document.statements.find((s) => s.tokens.length);

  if (!document.option) {
    if (first) {
      push({
        code: 'struct.missing-option',
        message: 'Aucune OPTION de structure : une etude commence par OPTION PLANE, GRILL ou SPATIALE.',
        severity: 'error',
        line: first.line,
        start: 0,
        end: lengthOf(first),
        pages: [43, 44],
        fix: { title: 'Inserer « OPTION PLANE » en tete', edits: [{ line: first.line, start: 0, end: 0, newText: 'OPTION PLANE\n' }] },
      });
    }
  } else if (first && first.keyword !== 'OPTION') {
    push({
      code: 'struct.option-not-first',
      message: 'OPTION doit etre la premiere commande de l\'etude : elle fixe les coordonnees et les degres de liberte disponibles.',
      severity: 'warning',
      line: first.line,
      start: 0,
      end: lengthOf(first),
      pages: [43, 44],
    });
  }

  const option = document.option;
  /**
   * Derniere commande reconnue : plusieurs commandes ST1 admettent une « forme
   * bloc » ou les lignes suivantes sont des donnees introduites par un de leurs
   * mots-cles (`OR`/`EX` sous `CARA VAR`, `SE` sous `ETUDE`, `ZONE` sous
   * `CARA PSE`…). Sans ce contexte, ces lignes seraient prises pour des
   * commandes inconnues.
   */
  let lastCommand: CatalogCommand | undefined;

  for (const statement of document.statements) {
    if (!statement.tokens.length) continue;
    const command = statement.command;
    if (command) lastCommand = command;

    // Commande inconnue au premier niveau.
    if (!command && !statement.blockPath.length) {
      unknownCommand(statement, index, push, lastCommand);
    }

    // Sous-commande employee hors de son bloc.
    if (command) {
      const requiredBlock = blockOf(command.context);
      if (requiredBlock && !statement.blockPath.includes(requiredBlock)) {
        push({
          code: 'struct.outside-block',
          message: `« ${command.name} » n'est valide qu'entre ${requiredBlock} et ${index.terminators.get(requiredBlock) ?? 'FIN'}.`,
          severity: 'error',
          line: statement.line,
          start: 0,
          end: lengthOf(statement),
          pages: command.pages,
        });
      }

      // Commande restreinte a certaines options de structure.
      if (option && command.restrictedToOptions?.length && !command.restrictedToOptions.includes(option)) {
        push({
          code: 'struct.option-restricted',
          message: `« ${command.name} » n'est pas disponible en OPTION ${option} (uniquement ${command.restrictedToOptions.join(', ')}).`,
          severity: 'error',
          line: statement.line,
          start: 0,
          end: lengthOf(statement),
          pages: command.pages,
        });
      }
    }

    if (option) optionConsistency(statement, option, index, push);
    knownTypos(statement, push);
  }

  // Blocs non fermes. Les blocs souples n'ont pas de terminateur : ils se
  // referment devant la commande suivante ou en fin de fichier.
  //
  // Un terminateur oublie fait cascader les ouvertures : les commandes qui
  // suivent s'imbriquent dans le bloc reste ouvert. On ne signale donc que le
  // bloc **le plus externe** de chaque cascade — le seul dont l'utilisateur
  // doit s'occuper ; les autres se referment d'eux-memes une fois corrige.
  const unclosed = document.blocks.filter((b) => !b.closed && !b.soft);
  for (const block of unclosed) {
    const nested = unclosed.some(
      (outer) => outer !== block && outer.startLine < block.startLine && block.endLine <= outer.endLine,
    );
    if (nested) continue;
    push({
      code: 'struct.unclosed-block',
      message: `Bloc ${block.name} non ferme par ${block.terminator}.`,
      severity: 'error',
      line: block.startLine,
      start: 0,
      end: 200,
      pages: block.command?.pages,
      fix: {
        title: `Ajouter « ${block.terminator} »`,
        edits: [{ line: block.endLine, start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER, newText: `\n${block.terminator}` }],
      },
    });
  }

  // `FIN` orphelin.
  for (const statement of document.statements) {
    if (statement.keyword !== 'FIN' && statement.keyword !== 'FIN PHASAGE') continue;
    if (statement.blockPath.length) continue;
    push({
      code: 'struct.orphan-fin',
      message: `« ${statement.keyword} » ne ferme aucun bloc ouvert.`,
      severity: 'error',
      line: statement.line,
      start: 0,
      end: lengthOf(statement),
      pages: [42],
    });
  }
}

function unknownCommand(
  statement: Statement,
  index: CatalogIndex,
  push: (d: St1Diagnostic) => void,
  lastCommand?: CatalogCommand,
): void {
  const firstToken = statement.tokens[0];
  if (!firstToken || firstToken.kind !== 'word') return; // ligne de donnees numeriques
  // Une affectation `nom = valeur` est de la pseudo-programmation, pas une commande.
  if (statement.tokens[1]?.kind === 'operator' && statement.tokens[1].text === '=') return;
  const name = firstToken.value;
  if (index.keywords.has(name)) return;
  // Ligne de donnees introduite par un mot-cle de la commande precedente.
  if ((lastCommand?.args ?? []).some((arg) => arg.name.toUpperCase() === name)) return;

  const suggestion = nearestCommand(name, index);
  push({
    code: 'struct.unknown-command',
    message: suggestion
      ? `Commande « ${firstToken.text} » inconnue au catalogue ST1 v24. Vouliez-vous dire « ${suggestion} » ?`
      : `Commande « ${firstToken.text} » inconnue au catalogue ST1 v24.`,
    severity: 'warning',
    line: statement.line,
    start: firstToken.start,
    end: firstToken.end,
    fix: suggestion
      ? { title: `Remplacer par « ${suggestion} »`, edits: [{ line: firstToken.line, start: firstToken.start, end: firstToken.end, newText: suggestion }] }
      : undefined,
  });
}

function nearestCommand(name: string, index: CatalogIndex): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  const budget = name.length <= 4 ? 1 : 2;
  for (const candidate of index.byName.keys()) {
    if (candidate.includes(' ')) continue;
    const score = distance(name, candidate, budget);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore <= budget ? best : undefined;
}

/** Distance de Levenshtein bornee : abandonne des que le budget est depasse. */
function distance(a: string, b: string, budget: number): number {
  if (Math.abs(a.length - b.length) > budget) return budget + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > budget) return budget + 1;
    previous = current;
  }
  return previous[b.length];
}

/** Coherence entre l'OPTION declaree et les mots-cles employes. */
function optionConsistency(
  statement: Statement,
  option: StructureOption,
  index: CatalogIndex,
  push: (d: St1Diagnostic) => void,
): void {
  const spec = index.catalog.structureOptions[option];
  if (!spec) return;

  const flag = (words: string[], allowed: string[], code: string, label: string, pages: number[]) => {
    const invalid = statement.tokens.filter((t) => t.kind === 'word' && words.includes(t.value) && !allowed.includes(t.value));
    for (const token of invalid) {
      push({
        code,
        message: `« ${token.text} » n'existe pas en OPTION ${option}. ${label} : ${allowed.join(', ')}.`,
        severity: 'error',
        line: token.line,
        start: token.start,
        end: token.end,
        pages,
      });
    }
  };

  if (statement.keyword === 'APPUI' && !statement.blockPath.length) {
    flag(DDL_WORDS, spec.ddl, 'struct.invalid-ddl', 'Degres de liberte disponibles', [43, 44, 47, 48]);
  }

  if (statement.keyword === 'CARA' && !statement.words.includes('SPECIAL')) {
    flag(CARA_PROPS, spec.barProperties, 'struct.invalid-bar-property', 'Caracteristiques disponibles', [43, 44, 59, 60]);
  }

  // Composantes de resultat : `EFFORT MZ`, `DEPLA DX`, `CONTR VY`…
  const block = statement.blockPath[statement.blockPath.length - 1];
  if (block && ['SURCH', 'ENV', 'PHASAGE', 'ACCELEROGRAMME', 'RESU'].includes(block)) {
    const familyToken = statement.tokens.find((t) => t.kind === 'word' && COMPONENT_FAMILIES.includes(t.value));
    if (familyToken) {
      const allowed = spec.surchargeComponents[familyToken.value];
      if (allowed?.length) {
        const universe = new Set(
          Object.values(index.catalog.structureOptions).flatMap((s) => s.surchargeComponents[familyToken.value] ?? []),
        );
        const invalid = statement.tokens.filter(
          (t) => t.kind === 'word' && t.start > familyToken.start && universe.has(t.value) && !allowed.includes(t.value),
        );
        for (const token of invalid) {
          push({
            code: 'struct.invalid-component',
            message: `Composante ${familyToken.value} « ${token.text} » invalide en OPTION ${option}. Admises : ${allowed.join(', ')}.`,
            severity: 'error',
            line: token.line,
            start: token.start,
            end: token.end,
            pages: [141, 147],
          });
        }
      }
    }
  }
}

/** Fautes de frappe et interdits ponctuels attestes par le manuel. */
function knownTypos(statement: Statement, push: (d: St1Diagnostic) => void): void {
  const text = statement.text.toUpperCase();
  const full = (code: string, message: string, severity: Severity, pages: number[], fix?: QuickFix) =>
    push({ code, message, severity, line: statement.line, start: 0, end: lengthOf(statement), pages, fix });

  if (/^EXEC\s+MODES\b/.test(text)) {
    const token = statement.tokens.find((t) => t.value === 'MODES');
    full('typo.exec-modes', 'La commande documentee est EXEC MODE, au singulier.', 'error', [197, 198, 199],
      token ? { title: 'Corriger en « EXEC MODE »', edits: [{ line: token.line, start: token.start, end: token.end, newText: 'MODE' }] } : undefined);
  }
  if (/^EXECUTER\b/.test(text)) {
    const token = statement.tokens[0];
    full('typo.executer', 'La commande documentee est EXEC, pas EXECUTER.', 'error', [125],
      { title: 'Corriger en « EXEC »', edits: [{ line: token.line, start: token.start, end: token.end, newText: 'EXEC' }] });
  }
  const method = /^EXEC\s+MODE\b.*\bMETHODE\s+(\d+)/.exec(text);
  if (method && !['1', '2'].includes(method[1])) {
    full('struct.invalid-mode-method', 'EXEC MODE n\'accepte que METHODE 1 (iteration inverse) ou METHODE 2 (sous-espace).', 'error', [198, 199]);
  }
  if (/\bPAS\s+1\/(3|7)\b/.test(text) && !/\bABS\b/.test(text)) {
    full('struct.invalid-relative-step', 'Un pas relatif doit etre une fraction entiere admise (1/2, 1/5, 1/10) : 1/3 et 1/7 sont exclus.', 'error', [101, 102]);
  }
  if (/^CARA\s+PSE\b/.test(text) && /\b(SY|SZ)\b/.test(text)) {
    full('struct.pse-shear-area', 'CARA PSE ne doit definir ni SY ni SZ (barre sur sol elastique).', 'error', [60]);
  }
  if (statement.blockPath.includes('MAT') && /\b(E|NU|RO|G_DYN|TEMP)\s*=/.test(text)) {
    full('struct.material-assignment', 'Dans un bloc MAT, un mot-cle est suivi directement de sa valeur, sans signe « = ».', 'error', [74, 75]);
  }
  if (statement.blockPath[statement.blockPath.length - 1] === 'COMB' && /^SURCH\b/.test(text)) {
    full('struct.comb-surcharge', 'COMB ne combine pas les surcharges : utiliser ENV ou ENV COMB.', 'error', [234]);
  }
  if (/^CARA\s+\d+\s+\d+\s+(SX|SY|SZ|IX|IY|IZ)\b/.test(text)) {
    full('struct.malformed-list', 'Separer les elements d\'une liste par une virgule ou par « a ».', 'error', [31]);
  }
  // Numeros d'element trop grands (retour d'experience support, non documente).
  if (['NOEUD', 'BARRE', 'CABLE'].includes(statement.keyword ?? '')) {
    const big = statement.tokens.find((t) => t.kind === 'number' && Number(t.text) > SAFE_ELEMENT_NUMBER);
    if (big) {
      push({
        code: 'struct.large-element-number',
        message: `Numero ${big.text} eleve : au-dela de ${SAFE_ELEMENT_NUMBER}, des erreurs de base de donnees sont observees en pratique (retour d'experience support), meme si le manuel annonce 8 chiffres. Renumeroter si un incident survient.`,
        severity: 'warning',
        line: big.line,
        start: big.start,
        end: big.end,
        pages: [29],
      });
    }
  }
}

// ==========================================================================
// 3. Contenu obligatoire des blocs
// ==========================================================================

function blockContentRules(document: ParsedDocument, push: (d: St1Diagnostic) => void): void {
  const opened = (name: string, before: number) =>
    document.blocks.some((b) => b.name === name && b.startLine < before);

  for (const block of document.blocks) {
    const has = (pattern: RegExp) => block.statements.some((s) => pattern.test(s.text.toUpperCase()));
    const require = (condition: boolean, code: string, message: string, pages: number[], severity: Severity = 'error') => {
      if (!condition) {
        push({ code, message, severity, line: block.startLine, start: 0, end: 200, pages });
      }
    };

    switch (block.name) {
      case 'MAT':
      case 'MATERIAU':
        require(has(/^E\b/), 'block.mat-missing-e', 'Un bloc MAT requiert une definition du module E.', [74, 75]);
        for (const statement of block.statements) {
          const text = statement.text.toUpperCase();
          if (/^E\s+EC2(_2027)?\b/.test(text) && !(/\b(MPA|TM2|KNM2)\b/.test(text) && /\bFCK\s+[\d.]/.test(text))) {
            push({
              code: 'block.ec2-incomplete',
              message: 'E EC2 / EC2_2027 requiert une unite (MPA, TM2 ou KNM2) et FCK suivi de sa valeur.',
              severity: 'error',
              line: statement.line,
              start: 0,
              end: lengthOf(statement),
              pages: [80, 89, 90],
            });
          }
        }
        break;

      case 'CABLE':
        require(has(/^PREC\s+/), 'block.cable-missing-prec', 'Un bloc CABLE requiert PREC suivi du numero de precontrainte.', [95, 96]);
        require(has(/^TRACE\s+(INTERIEUR|EXTERIEUR)\b/), 'block.cable-missing-trace', 'Un bloc CABLE requiert TRACE INTERIEUR ou TRACE EXTERIEUR.', [95, 96]);
        require(has(/^BARRE\b/), 'block.cable-missing-bars', 'Preciser les barres support du cable : par defaut ST1 les prend toutes, ce qui affecte mal les poussees.', [95, 96], 'warning');
        break;

      case 'PREC':
        require(has(/^SECTION\b/), 'block.prec-missing-section', 'Un bloc PREC requiert SECTION (aire d\'acier).', [92, 93, 94]);
        require(has(/^TENSION\b/), 'block.prec-missing-tension', 'Un bloc PREC requiert TENSION (contrainte de mise en tension).', [92, 93, 94]);
        require(has(/^E\b/), 'block.prec-missing-e', 'Un bloc PREC requiert E (module des aciers).', [92, 93, 94]);
        break;

      case 'TABLIER':
        require(has(/^BARRE\b/), 'block.deck-missing-bars', 'Un bloc TABLIER requiert BARRE avec une suite geometriquement continue.', [130, 133]);
        break;

      case 'SURCH':
        require(opened('TABLIER', block.startLine), 'block.surch-missing-deck', 'SURCH requiert un TABLIER defini auparavant.', [130, 140]);
        break;

      case 'AMORTISSEMENT':
        require(has(/^(AUTOMATIQUE|MODE|ENERGIE)\b/), 'block.damping-undefined', 'AMORTISSEMENT requiert AUTOMATIQUE, MODE ou ENERGIE.', [200, 201]);
        break;

      case 'SPECTRE':
        require(has(/^(ACCELERATION|EUROCODE)\b/), 'block.spectrum-undefined', 'SPECTRE requiert ACCELERATION ou une definition EUROCODE.', [202, 203, 204]);
        break;

      case 'SPECTRE REPONSE':
        require(has(/^SPECTRE\s+\d/) && has(/^(LIN|SRSS|CQC)\b/), 'block.spectrum-response-incomplete',
          'SPECTRE … REPONSE requiert un numero de SPECTRE et une recombinaison LIN, SRSS ou CQC.', [205, 206]);
        if (has(/^CQC\b/) && !opened('AMORTISSEMENT', block.startLine)) {
          push({
            code: 'block.cqc-without-damping',
            message: 'La recombinaison CQC exige un AMORTISSEMENT defini auparavant (sinon elle degenere en SRSS).',
            severity: 'error',
            line: block.startLine,
            start: 0,
            end: 200,
            pages: [205, 206],
          });
        }
        break;

      case 'ACCELEROGRAMME':
        require(has(/^PAS_TEMPS\b/) && has(/^ACCELERATION\b/), 'block.accelerogram-incomplete',
          'ACCELEROGRAMME requiert PAS_TEMPS et ACCELERATION.', [207, 208]);
        break;

      case 'EXPOSITION FEU':
        require(has(/^(CN|HC|HCM|ADIABATIQUE|TEMP|LOI_GAZ|LOI_PAROI)\b/), 'block.fire-exposure-undefined',
          'EXPOSITION FEU requiert une loi d\'exposition documentee (CN, HC, HCM, ADIABATIQUE, TEMP, LOI_GAZ, LOI_PAROI).', [220, 221]);
        break;

      case 'ANALYSE FEU':
        require(has(/^NEWTON_RAPHSON\s+MAX_ITER\s+\d/), 'block.fire-analysis-incomplete',
          'ANALYSE FEU requiert NEWTON_RAPHSON MAX_ITER n.', [230, 231]);
        break;

      case 'INCENDIE':
        require(has(/\bFEU\s+\d/) && has(/\bCHARG\s+\d/), 'block.fire-load-incomplete',
          'INCENDIE requiert FEU j (LOCAL) CHARG k.', [229, 230]);
        break;
    }
  }
}

// ==========================================================================
// 4. Prerequis d'execution
// ==========================================================================

function prerequisiteRules(document: ParsedDocument, model: Model, push: (d: St1Diagnostic) => void): void {
  const blockNames = new Set(document.blocks.map((b) => b.name));
  const keywords = new Set(document.statements.map((s) => s.keyword).filter(Boolean) as string[]);
  const text = document.statements.map((s) => s.text.toUpperCase()).join('\n');

  const hasMass = /\bG_DYN\b/.test(text) || blockNames.has('MASSE PROPRE') || /\bMASSE\b/.test(text);

  const execLine = (pattern: RegExp) => document.statements.find((s) => pattern.test(s.text.toUpperCase()));

  const requireBefore = (
    exec: RegExp,
    ok: boolean,
    code: string,
    message: string,
    pages: number[],
  ) => {
    const statement = execLine(exec);
    if (statement && !ok) {
      push({ code, message, severity: 'error', line: statement.line, start: 0, end: lengthOf(statement), pages });
    }
  };

  requireBefore(/^EXEC\s+SURCH\b/, blockNames.has('TABLIER') && blockNames.has('SURCH'),
    'exec.surch-prerequisite', 'EXEC SURCH requiert un TABLIER et au moins une SURCH definis auparavant.', [130, 140, 178]);

  const execModeLine = execLine(/^EXEC\s+MODE\b/);
  const execSpectreLine = execLine(/^EXEC\s+SPECTRE\s+REPONSE\b/);
  requireBefore(/^EXEC\s+SPECTRE\s+REPONSE\b/,
    Boolean(execModeLine && execSpectreLine && execModeLine.line < execSpectreLine.line) && blockNames.has('SPECTRE REPONSE'),
    'exec.spectrum-prerequisite', 'EXEC SPECTRE REPONSE requiert EXEC MODE prealable et une reponse spectrale definie.', [205, 206]);

  requireBefore(/^EXEC\s+HISTORIQUE\b/,
    (blockNames.has('ACCELEROGRAMME') || blockNames.has('DYNAMIQUE CONVOI') || blockNames.has('DYNAMIQUE CHARGE')) &&
      blockNames.has('AMORTISSEMENT') && hasMass,
    'exec.history-prerequisite', 'EXEC HISTORIQUE requiert des masses dynamiques, un historique (ACCELEROGRAMME ou DYNAMIQUE …) et un AMORTISSEMENT.', [207, 208, 213]);

  requireBefore(/^EXEC\s+INCENDIE\b/, blockNames.has('INCENDIE'),
    'exec.fire-prerequisite', 'EXEC INCENDIE requiert un bloc INCENDIE defini auparavant.', [229, 230, 231]);

  requireBefore(/^EXEC\s+MODE\b/, hasMass,
    'exec.mode-missing-mass', 'EXEC MODE requiert une definition de masse : avec RO, definir aussi G_DYN, ou utiliser MASSE PROPRE.', [197]);

  // Description sans execution : le calcul ne produira rien.
  const hasExec = [...keywords].some((k) => k.startsWith('EXEC'));
  if (blockNames.has('CHARG') && !hasExec) {
    const charg = document.blocks.find((b) => b.name === 'CHARG')!;
    push({
      code: 'exec.charg-without-exec',
      message: 'Un bloc CHARG est defini mais aucun EXEC : sans EXEC CHARG, aucun resultat n\'est calcule.',
      severity: 'warning',
      line: charg.startLine,
      start: 0,
      end: 200,
      pages: [125],
    });
  }
  if (blockNames.has('PHASAGE') && !/\bEXEC\s+PHASAGE\b/.test(text)) {
    const phasage = document.blocks.find((b) => b.name === 'PHASAGE')!;
    push({
      code: 'exec.phasage-without-exec',
      message: 'PHASAGE decrit sans EXEC PHASAGE : la description seule ne produit aucun resultat.',
      severity: 'warning',
      line: phasage.startLine,
      start: 0,
      end: 200,
      pages: [196],
    });
  }

  // Interdits lies a l'option de structure.
  if (document.option === 'GRILL') {
    for (const statement of document.statements) {
      if (/^POIDS\s+PROPRE\b/.test(statement.text.toUpperCase())) {
        push({
          code: 'exec.grill-self-weight',
          message: 'POIDS PROPRE est interdit en OPTION GRILL : la section n\'y est pas definie.',
          severity: 'error',
          line: statement.line,
          start: 0,
          end: lengthOf(statement),
          pages: [108],
        });
      }
    }
    if (blockNames.has('INCENDIE') || /\bEXEC\s+INCENDIE\b/.test(text)) {
      const block = document.blocks.find((b) => b.name === 'INCENDIE');
      const line = block?.startLine ?? document.statements.find((s) => /^EXEC\s+INCENDIE\b/.test(s.text.toUpperCase()))?.line ?? 0;
      push({
        code: 'exec.fire-grill-forbidden',
        message: 'Le calcul au feu est limite aux options PLANE et SPATIALE : GRILL est exclu.',
        severity: 'error',
        line,
        start: 0,
        end: 200,
        pages: [217, 218],
      });
    }
  }

  // Precontrainte : un seul appui bloque en DX, sinon elle est sans effet.
  if (blockNames.has('PREC')) {
    const blocking = model.supports.filter((s) => s.ddl.includes('DX') && !s.elastic);
    if (blocking.length > 1) {
      push({
        code: 'model.prestress-x-restraints',
        message: `Avec une precontrainte, un seul appui doit bloquer DX (${blocking.length} le font) : sinon la precontrainte reste sans effet.`,
        severity: 'warning',
        line: anchorLine(model, blocking[1]),
        start: 0,
        end: 200,
        pages: [48],
      });
    }
  }

  // DECOL avec charges mobiles : combinaison interdite.
  if (model.supports.some((s) => s.decol) && blockNames.has('SURCH')) {
    const support = model.supports.find((s) => s.decol)!;
    push({
      code: 'model.decol-with-mobile-loads',
      message: 'DECOL (decollement d\'appui) est reserve a la statique : il ne doit pas etre employe avec des charges mobiles.',
      severity: 'error',
      line: anchorLine(model, support),
      start: 0,
      end: 200,
      pages: [48],
    });
  }
}

// ==========================================================================
// 5. Coherence du modele
// ==========================================================================

function modelRules(document: ParsedDocument, model: Model, push: (d: St1Diagnostic) => void): void {
  const text = document.statements.map((s) => s.text.toUpperCase()).join('\n');

  // Une inclusion `LIRE` non resolue ou un modele tronque rendent les regles
  // d'existence indecidables : les elements manquants peuvent etre definis
  // dans la partie du modele qu'on n'a pas pu lire. On ne signale alors rien.
  const complete = !model.truncated && model.includes.every((include) => include.resolved);

  // Barres appuyees sur des noeuds inexistants.
  for (const bar of model.bars.values()) {
    if (complete) {
      for (const [role, node] of [['origine', bar.from], ['extremite', bar.to]] as const) {
        if (!model.nodes.has(node)) {
          push({
            code: 'model.undefined-node',
            message: `La barre ${bar.id} reference le noeud ${node} (${role}), qui n'est defini par aucune commande NOEUD.`,
            severity: 'error',
            line: anchorLine(model, bar),
            start: 0,
            end: 200,
            pages: [46, 52],
          });
        }
      }
    }
    if (bar.from === bar.to) {
      push({
        code: 'model.degenerate-bar',
        message: `La barre ${bar.id} a la meme origine et la meme extremite (noeud ${bar.from}) : longueur nulle.`,
        severity: 'error',
        line: anchorLine(model, bar),
        start: 0,
        end: 200,
        pages: [52],
      });
    }
  }

  if (complete) {
    for (const support of model.supports) {
      if (!model.nodes.has(support.node)) {
        push({
          code: 'model.undefined-support-node',
          message: `L'appui ${support.id} porte sur le noeud ${support.node}, qui n'est defini par aucune commande NOEUD.`,
          severity: 'error',
          line: anchorLine(model, support),
          start: 0,
          end: 200,
          pages: [47, 48],
        });
      }
    }
  }

  if (model.bars.size && complete) {
    // Barres sans caracteristiques RDM : ST1 n'a pas de valeurs par defaut.
    const withoutCara = [...model.bars.values()].filter((b) => !model.caraByBar.has(b.id) && !model.eccentric.has(b.id));
    if (withoutCara.length) {
      push({
        code: 'model.bar-without-cara',
        message: `${withoutCara.length} barre(s) sans CARA (${preview(withoutCara.map((b) => b.id))}) : ST1 n'a pas de caracteristiques par defaut.`,
        severity: 'error',
        line: anchorLine(model, withoutCara[0]),
        start: 0,
        end: 200,
        pages: [59, 60],
      });
    }

    const withoutConstants = [...model.bars.values()].filter((b) => !model.constantsByBar.has(b.id));
    if (withoutConstants.length) {
      push({
        code: 'model.bar-without-constants',
        message: `${withoutConstants.length} barre(s) sans CONS ni MAT (${preview(withoutConstants.map((b) => b.id))}) : il n'existe aucune constante physique par defaut.`,
        severity: 'error',
        line: anchorLine(model, withoutConstants[0]),
        start: 0,
        end: 200,
        pages: [72, 73],
      });
    }

    // Une barre sur sol elastique (`CARA PSE`) est tenue par les raideurs du
    // sol : elle se passe d'appui, et les controles de stabilite ne
    // s'appliquent pas — l'exemple 19.1 du manuel est un cadre ferme sans
    // aucune commande APPUI.
    const surSol = [...model.caraByBar.values()].some((cara) => cara.pse);

    // Stabilite : au moins un appui doit bloquer la translation longitudinale.
    if (!surSol && model.supports.length && !model.supports.some((s) => s.ddl.includes('DX') || s.elastic)) {
      push({
        code: 'model.no-x-restraint',
        message: 'Aucun appui ne bloque DX : la structure est libre en translation longitudinale et le calcul ne convergera pas.',
        severity: 'warning',
        line: anchorLine(model, model.supports[0]),
        start: 0,
        end: 200,
        pages: [48],
      });
    }
    if (!surSol && !model.supports.length) {
      const bar = [...model.bars.values()][0];
      push({
        code: 'model.no-support',
        message: 'Aucun appui defini : la structure est un mecanisme libre. Une barre sur sol elastique (CARA PSE) est la seule a pouvoir s\'en passer.',
        severity: 'error',
        line: anchorLine(model, bar),
        start: 0,
        end: 200,
        pages: [47, 48],
      });
    }
  }

  // Contraintes demandees sans fibres extremes : piege documente.
  const wantsContr = document.statements.some(
    (s) => s.blockPath.includes('RESU') && /\bCONTR\b/.test(s.text.toUpperCase()),
  );
  if (wantsContr) {
    const missing = [...model.caraByBar.entries()].filter(
      ([, cara]) => !cara.props.has('VY') && !cara.props.has('WY') && !cara.props.has('VZ') && !cara.props.has('WZ'),
    );
    if (missing.length) {
      push({
        code: 'model.contr-without-fibres',
        message: `CONTR est demande dans RESU mais ${missing.length} barre(s) n'ont pas de fibres extremes (VY/WY, VZ/WZ en spatial) dans CARA : aucune contrainte ne sera editee.`,
        severity: 'warning',
        line: anchorLine(model, missing[0][1]),
        start: 0,
        end: 200,
        pages: [59, 60, 66, 244],
      });
    }
  }

  // Deplacements demandes sans les avoir declares dans ETUDE : piege documente.
  const wantsDepla = document.statements.some(
    (s) => s.blockPath.includes('RESU') && /\bDEPLA\b/.test(s.text.toUpperCase()),
  );
  const etudeDeclaresDepla = /\bETUDE\b[^\n]*\bDEPLA\b/.test(text);
  if (wantsDepla && model.studiedBars.size && !etudeDeclaresDepla) {
    const statement = document.statements.find((s) => s.keyword === 'ETUDE')!;
    push({
      code: 'model.depla-not-studied',
      message: 'RESU demande DEPLA mais ETUDE ne declare pas DEPLA : par defaut, seuls les efforts sont etudies et aucun deplacement ne sera edite.',
      severity: 'warning',
      line: statement.line,
      start: 0,
      end: lengthOf(statement),
      pages: [101, 102],
      fix: {
        title: 'Ajouter DEPLA a la commande ETUDE',
        edits: [{ line: statement.line, start: 5, end: 5, newText: ' DEPLA' }],
      },
    });
  }

  // Barres chargees, etudiees ou de tablier qui n'existent pas.
  const referenced = new Map<string, Set<number>>([
    ['chargee', model.loadedBars],
    ['etudiee', model.studiedBars],
    ['de tablier', new Set(model.deckBars)],
  ]);
  for (const [role, ids] of referenced) {
    const unknown = [...ids].filter((id) => !model.bars.has(id));
    if (unknown.length && model.bars.size && complete) {
      push({
        code: 'model.undefined-bar',
        message: `Barre(s) ${preview(unknown)} referencee(s) comme ${role} mais jamais definie(s) par BARRE.`,
        severity: 'error',
        line: 0,
        start: 0,
        end: 200,
        pages: [52],
      });
    }
  }

  // Continuite geometrique du tablier.
  if (model.deckBars.length > 1) {
    const chain = model.deckBars.map((id) => model.bars.get(id)).filter(Boolean);
    for (let i = 1; i < chain.length; i++) {
      const previous = chain[i - 1]!;
      const current = chain[i]!;
      if (previous.to !== current.from && previous.from !== current.to && previous.to !== current.to && previous.from !== current.from) {
        push({
          code: 'model.deck-not-continuous',
          message: `Le tablier n'est pas geometriquement continu : les barres ${previous.id} et ${current.id} ne partagent aucun noeud.`,
          severity: 'warning',
          line: anchorLine(model, current),
          start: 0,
          end: 200,
          pages: [130, 133],
        });
        break;
      }
    }
  }

  // Aucun resultat edite.
  if (model.bars.size && !document.blocks.some((b) => b.name === 'RESU') && !/^\s*DESS\b/m.test(text)) {
    push({
      code: 'model.no-output',
      message: 'Le script ne contient ni bloc RESU ni commande graphique : aucun resultat ne sera edite.',
      severity: 'info',
      line: document.statements[document.statements.length - 1]?.line ?? 0,
      start: 0,
      end: 200,
      pages: [244, 245, 246],
    });
  }
}

// ==========================================================================
// Utilitaires
// ==========================================================================

function lengthOf(statement: Statement): number {
  const last = statement.tokens[statement.tokens.length - 1];
  return last ? last.end : 200;
}

/**
 * Ligne d'ancrage d'un diagnostic : la ligne de l'element s'il est defini dans
 * le fichier courant, sinon celle de la commande `LIRE` qui l'a introduit —
 * la ligne d'un autre fichier n'aurait aucun sens dans ce document.
 */
function anchorLine(model: Model, element: { line: number; file: number }): number {
  return element.file === 0 ? element.line : model.fileAnchors[element.file] ?? 0;
}

function preview(ids: number[], limit = 6): string {
  const head = ids.slice(0, limit).join(', ');
  return ids.length > limit ? `${head}, …` : head;
}

export type { Block, ParsedDocument, Statement };
export { normalize };
