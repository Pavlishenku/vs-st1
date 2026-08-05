/**
 * Rapport de coherence de l'etude — moteur de controles.
 *
 * Repond, a la demande, a la question « l'etude est-elle complete et
 * coherente, prete a calculer ? ». Chaque objet numerote de l'etude est
 * verifie dans les deux sens (cf. `docs/plan-rapport-etude.md`) :
 *
 *  - **reference -> defini ?** Une reference brisee est une erreur : le
 *    calcul echouera ou sera faux.
 *  - **defini -> utilise ?** Un objet inerte est un avertissement : c'est
 *    presque toujours un oubli (cas jamais execute, cable jamais tendu…).
 *
 * Fonction pure, sans `vscode` : elle ne fait que croiser l'index
 * `model.study` et le modele — aucune relecture du texte. Regle de silence
 * heritee du validateur : un `LIRE` non resolu ou un modele tronque rend les
 * controles d'existence indecidables, ils se taisent alors.
 */

import type { Model, StudyDef, StudyKind } from './model.js';
import type { ParsedDocument } from './parser.js';

export type Verdict = 'ok' | 'warn' | 'error' | 'na';

export interface ReportCheck {
  /** Code stable du controle (R5, I7, G2…), cf. plan. */
  code: string;
  /** Libelle court affiche a cote de la pastille. */
  label: string;
  verdict: Verdict;
  /** Complement affiche pour un verdict non conforme (« PREC 9 non definie »). */
  detail?: string;
}

export interface ReportRow {
  label: string;
  line?: number;
  file?: number;
  checks: ReportCheck[];
}

export interface ReportFamily {
  id: string;
  title: string;
  rows: ReportRow[];
  errors: number;
  warns: number;
}

export interface StudyReport {
  families: ReportFamily[];
  summary: { checks: number; errors: number; warns: number };
  /** Inventaire informatif : option, comptes, fichiers. */
  inventory: string;
  files: string[];
  /** Vrai si les controles d'existence sont tus (LIRE non resolu / tronque). */
  silenced: boolean;
}

const KIND_LABELS: Record<StudyKind, string> = {
  CHARG: 'CHARG', SURCH: 'SURCH', COMB: 'COMB', ENV: 'ENV', PHASAGE: 'PHASAGE',
  ETAT: 'ETAT', MAT: 'materiau', PREC: 'PREC', CABLE: 'cable',
  SPECTRE: 'SPECTRE', 'SPECTRE REPONSE': 'SPECTRE REPONSE',
  SECTION: 'SECTION', 'EXPOSITION FEU': 'EXPOSITION FEU', INCENDIE: 'INCENDIE',
};

function preview(ids: number[], limit = 6): string {
  const head = ids.slice(0, limit).join(', ');
  return ids.length > limit ? `${head}, …` : head;
}

export function buildStudyReport(document: ParsedDocument, model: Model): StudyReport {
  const study = model.study;
  const silenced = model.truncated || model.includes.some((include) => !include.resolved);

  const defs = (kind: StudyKind): Map<number, StudyDef> => study.defs.get(kind) ?? new Map();
  const defined = (kind: StudyKind, id: number): boolean => defs(kind).has(id);
  /** Objets d'un type references quelque part (utilisation directe). */
  const usedIds = (kind: StudyKind): Set<number> =>
    new Set(study.refs.filter((r) => r.kind === kind).map((r) => r.id));
  const usedAll = (kind: StudyKind): boolean => study.allRefs.some((r) => r.kind === kind);
  /** L'objet est-il couvert par un `EXEC` (liste explicite ou sans liste) ? */
  const executed = (kind: string, id: number): boolean =>
    study.execs.some((e) => e.kind === kind && (e.list === null || e.list.includes(id)));
  const anyExec = (kind: string): boolean => study.execs.some((e) => e.kind === kind);

  const families: ReportFamily[] = [];

  const check = (code: string, label: string, bad: boolean, verdict: Exclude<Verdict, 'ok' | 'na'>, detail?: string): ReportCheck =>
    bad ? { code, label, verdict, detail } : { code, label, verdict: 'ok' };
  const na = (code: string, label: string): ReportCheck => ({ code, label, verdict: 'na' });

  // ---- Structure ----------------------------------------------------------
  {
    const rows: ReportRow[] = [];
    const bars = [...model.bars.values()];
    const surSol = [...model.caraByBar.values()].some((cara) => cara.pse);

    const isolated = [...model.nodes.values()].filter(
      (node) =>
        !bars.some((bar) => bar.from === node.id || bar.to === node.id) &&
        !model.supports.some((support) => support.node === node.id),
    );
    if (model.nodes.size) {
      rows.push({
        label: `Noeuds (${model.nodes.size})`,
        line: [...model.nodes.values()][0].line,
        file: [...model.nodes.values()][0].file,
        checks: [
          check('I1', 'aucun noeud isole', isolated.length > 0, 'warn',
            `noeud(s) ${preview(isolated.map((n) => n.id))} sans barre ni appui`),
        ],
      });
    }

    if (bars.length) {
      const missingNode = silenced ? [] : bars.filter((b) => !model.nodes.has(b.from) || !model.nodes.has(b.to));
      const withoutCara = silenced ? [] : bars.filter((b) => !model.caraByBar.has(b.id) && !model.eccentric.has(b.id));
      // Une barre dont les CARA viennent d'une SECTION (calcul au feu) tient
      // son materiau de la section : elle se passe de CONS (exemple 19.10).
      const withoutCons = silenced ? [] : bars.filter(
        (b) => !model.constantsByBar.has(b.id)
          && model.caraByBar.get(b.id)?.section === undefined
          && !model.eccentric.has(b.id), // liaison rigide : ni CONS ni etude
      );
      const degenerate = bars.filter((b) => b.from === b.to);
      const unstudied = model.studiedBars.size
        ? bars.filter((b) => !model.studiedBars.has(b.id))
        : [];
      rows.push({
        label: `Barres (${bars.length})`,
        line: bars[0].line,
        file: bars[0].file,
        checks: [
          silenced ? na('R1', 'noeuds definis') : check('R1', 'noeuds definis', missingNode.length > 0, 'error',
            `barre(s) ${preview(missingNode.map((b) => b.id))} sur noeud inexistant`),
          silenced ? na('C2', 'CARA') : check('C2', 'CARA', withoutCara.length > 0, 'error',
            `barre(s) ${preview(withoutCara.map((b) => b.id))} sans caracteristiques`),
          silenced ? na('C3', 'CONS/MAT') : check('C3', 'CONS/MAT', withoutCons.length > 0, 'error',
            `barre(s) ${preview(withoutCons.map((b) => b.id))} sans constantes`),
          check('G5', 'longueur non nulle', degenerate.length > 0, 'error',
            `barre(s) ${preview(degenerate.map((b) => b.id))} de longueur nulle`),
          model.studiedBars.size
            ? check('I2', 'etudiees', unstudied.length > 0, 'warn',
              `barre(s) ${preview(unstudied.map((b) => b.id))} sans section d'etude`)
            : na('I2', 'etudiees'),
        ],
      });
    }

    if (model.supports.length) {
      const badNode = silenced ? [] : model.supports.filter((s) => !model.nodes.has(s.node));
      const dxBlocked = model.supports.some((s) => s.ddl.includes('DX') || s.elastic);
      rows.push({
        label: `Appuis (${model.supports.length})`,
        line: model.supports[0].line,
        file: model.supports[0].file,
        checks: [
          silenced ? na('R2', 'noeuds definis') : check('R2', 'noeuds definis', badNode.length > 0, 'error',
            `appui(s) ${preview(badNode.map((s) => s.id))} sur noeud inexistant`),
          surSol ? na('G1', 'DX bloque') : check('G1', 'DX bloque', !dxBlocked, 'warn',
            'aucun appui ne bloque la translation longitudinale'),
        ],
      });
    } else if (bars.length && !surSol) {
      rows.push({
        label: 'Appuis',
        checks: [check('C4', 'au moins un appui', true, 'error',
          'aucun appui defini : mecanisme libre (seul CARA PSE s\'en passe)')],
      });
    }
    pushFamily(families, 'structure', 'Structure', rows);
  }

  // ---- Materiaux et precontrainte -----------------------------------------
  {
    const rows: ReportRow[] = [];
    const usedMats = new Set([
      ...usedIds('MAT'),
      ...[...model.constantsByBar.values()].map((c) => c.material).filter((m): m is number => m !== undefined),
    ]);
    for (const def of defs('MAT').values()) {
      rows.push({
        label: title('MAT', def),
        line: def.line,
        file: def.file,
        checks: [check('I3', 'affecte', !usedMats.has(def.id), 'warn', 'affecte a aucune barre ni section')],
      });
    }
    const cablePrecs = new Set(model.cables.map((c) => c.prec).filter((p): p is number => p !== undefined));
    for (const def of defs('PREC').values()) {
      rows.push({
        label: title('PREC', def),
        line: def.line,
        file: def.file,
        checks: [check('I4', 'reprise par un cable', !cablePrecs.has(def.id), 'warn', 'referencee par aucun cable')],
      });
    }
    const tensioned = new Set<number>([
      ...study.refs.filter((r) => r.kind === 'CABLE' && r.via !== 'RESU' && r.via !== 'GET').map((r) => r.id),
      ...model.phasages.flatMap((p) => p.states.flatMap((s) => s.tensioned)),
    ]);
    for (const cable of model.cables) {
      rows.push({
        label: title('CABLE', { id: cable.id, title: cable.name }),
        line: cable.line,
        file: cable.file,
        checks: [
          silenced || cable.prec === undefined
            ? (cable.prec === undefined ? check('R5', 'PREC definie', true, 'error', 'aucune PREC associee') : na('R5', 'PREC definie'))
            : check('R5', 'PREC definie', !defined('PREC', cable.prec), 'error', `PREC ${cable.prec} non definie`),
          check('I5', 'tendu ou charge', !tensioned.has(cable.id) && !usedAll('CABLE'), 'warn',
            'jamais tendu (phasage) ni charge (CHARG CABLE)'),
          cable.traceDeclared
            ? check('I16', 'trace lisible', cable.points.length < 2, 'warn', 'TRACE declare mais aucun point lisible')
            : na('I16', 'trace lisible'),
        ],
      });
    }
    pushFamily(families, 'materiaux', 'Materiaux et precontrainte', rows);
  }

  // ---- Cas de charge -------------------------------------------------------
  {
    const rows: ReportRow[] = [];
    for (const kind of ['CHARG', 'SURCH'] as const) {
      const reused = usedIds(kind);
      const reusedAll = usedAll(kind);
      for (const def of defs(kind).values()) {
        rows.push({
          label: title(kind, def),
          line: def.line,
          file: def.file,
          checks: [
            anyExec(kind)
              ? check('I6', 'execute', !executed(kind, def.id), 'warn', `hors de tout EXEC ${kind}`)
              : check('I6', 'execute', true, 'warn', `aucun EXEC ${kind} dans l'etude`),
            check('I7', 'repris', !reused.has(def.id) && !reusedAll, 'warn',
              'repris dans aucune combinaison, enveloppe ni edition'),
          ],
        });
      }
    }
    pushFamily(families, 'charges', 'Cas de charge', rows);
  }

  // ---- Combinaisons et enveloppes -----------------------------------------
  {
    const rows: ReportRow[] = [];
    for (const kind of ['COMB', 'ENV'] as const) {
      const reused = usedIds(kind);
      const reusedAll = usedAll(kind);
      for (const def of defs(kind).values()) {
        const broken = silenced ? [] : study.refs.filter(
          (r) => r.owner?.kind === kind && r.owner.id === def.id && !defined(r.kind, r.id)
            && !(r.kind === 'ETAT' && !defs('ETAT').size),
        );
        rows.push({
          label: title(kind, def),
          line: def.line,
          file: def.file,
          checks: [
            silenced ? na('R8', 'references definies') : check('R8', 'references definies', broken.length > 0, 'error',
              broken.map((r) => `${KIND_LABELS[r.kind]} ${r.id} non defini(e)`).slice(0, 4).join(' ; ')),
            check('I8', 'editee ou reprise', !reused.has(def.id) && !reusedAll, 'warn',
              'reprise dans aucun RESU ni aucune autre combinaison'),
          ],
        });
      }
    }
    pushFamily(families, 'combinaisons', 'Combinaisons et enveloppes', rows);
  }

  // ---- Phasage -------------------------------------------------------------
  {
    const rows: ReportRow[] = [];
    for (const phasage of model.phasages) {
      const activatedBars = new Set(phasage.states.flatMap((s) => s.bars));
      const activatedSupports = new Set(phasage.states.flatMap((s) => s.supports));
      const neverBars = [...model.bars.keys()].filter((id) => !activatedBars.has(id));
      const neverSupports = model.supports.map((s) => s.id).filter((id) => !activatedSupports.has(id));
      const suiteBroken = silenced ? [] : study.refs.filter(
        (r) => r.kind === 'PHASAGE' && r.via === 'SUITE PHASAGE' && r.line >= phasage.line && !defined('PHASAGE', r.id),
      );
      rows.push({
        label: title('PHASAGE', { id: phasage.id ?? 0, title: phasage.title }),
        line: phasage.line,
        file: phasage.file,
        checks: [
          check('I9', 'EXEC PHASAGE', !anyExec('PHASAGE'), 'warn', 'decrit sans EXEC PHASAGE'),
          silenced ? na('R9', 'SUITE definie') : check('R9', 'SUITE definie', suiteBroken.length > 0, 'error',
            `SUITE PHASAGE ${preview(suiteBroken.map((r) => r.id))} non defini`),
          check('I10', 'barres toutes activees', neverBars.length > 0, 'warn',
            `barre(s) ${preview(neverBars)} jamais activee(s)`),
          check('I10', 'appuis tous actives', neverSupports.length > 0, 'warn',
            `appui(s) ${preview(neverSupports)} jamais active(s)`),
        ],
      });
    }
    pushFamily(families, 'phasage', 'Phasage', rows);
  }

  // ---- Dynamique et feu ----------------------------------------------------
  {
    const rows: ReportRow[] = [];
    const spectreUsed = usedIds('SPECTRE');
    for (const def of defs('SPECTRE').values()) {
      rows.push({
        label: title('SPECTRE', def),
        line: def.line,
        file: def.file,
        checks: [check('I11', 'repris', !spectreUsed.has(def.id) && !usedAll('SPECTRE'), 'warn',
          'repris par aucune reponse spectrale ni combinaison')],
      });
    }
    for (const def of defs('SPECTRE REPONSE').values()) {
      rows.push({
        label: title('SPECTRE REPONSE', def),
        line: def.line,
        file: def.file,
        checks: [check('I12', 'EXEC SPECTRE REPONSE', !executed('SPECTRE REPONSE', def.id), 'warn', 'jamais executee')],
      });
    }
    const sectionUsed = usedIds('SECTION');
    for (const def of defs('SECTION').values()) {
      rows.push({
        label: title('SECTION', def),
        line: def.line,
        file: def.file,
        checks: [check('I13', 'affectee (CARA SECTION)', !sectionUsed.has(def.id), 'warn', 'affectee a aucune barre')],
      });
    }
    const expoUsed = usedIds('EXPOSITION FEU');
    for (const def of defs('EXPOSITION FEU').values()) {
      rows.push({
        label: title('EXPOSITION FEU', def),
        line: def.line,
        file: def.file,
        checks: [check('I14', 'reprise', !expoUsed.has(def.id), 'warn', 'reprise par aucune section ni incendie')],
      });
    }
    for (const def of defs('INCENDIE').values()) {
      rows.push({
        label: title('INCENDIE', def),
        line: def.line,
        file: def.file,
        checks: [check('I15', 'EXEC INCENDIE', !executed('INCENDIE', def.id), 'warn', 'jamais execute')],
      });
    }
    pushFamily(families, 'dynamique-feu', 'Dynamique et feu', rows);
  }

  // ---- References brisees hors combinaisons -------------------------------
  {
    const rows: ReportRow[] = [];
    if (!silenced) {
      const orphan = study.refs.filter((r) => !defined(r.kind, r.id) && !r.owner
        && !(r.kind === 'ETAT' && !defs('ETAT').size)
        && !(r.kind === 'PHASAGE' && r.via === 'SUITE PHASAGE')
        && r.via !== 'CABLE'); // la PREC manquante est deja portee par R5 sur la ligne du cable
      for (const ref of orphan) {
        rows.push({
          label: `${ref.via} → ${KIND_LABELS[ref.kind]} ${ref.id}`,
          line: ref.line,
          file: ref.file,
          checks: [check('R8', 'reference definie', true, 'error',
            `${KIND_LABELS[ref.kind]} ${ref.id} n'est defini(e) nulle part`)],
        });
      }
      const execBroken = study.execs.filter((e) =>
        e.list !== null && ['CHARG', 'SURCH', 'PHASAGE', 'SPECTRE REPONSE', 'INCENDIE'].includes(e.kind)
        && e.list.some((id) => !defined(e.kind as StudyKind, id)));
      for (const exec of execBroken) {
        const missing = exec.list!.filter((id) => !defined(exec.kind as StudyKind, id));
        rows.push({
          label: `EXEC ${exec.kind} ${preview(exec.list!)}`,
          line: exec.line,
          file: exec.file,
          checks: [check('R12', 'liste definie', true, 'error',
            `${exec.kind} ${preview(missing)} non defini(e)`)],
        });
      }
    }
    pushFamily(families, 'references', 'References brisees', rows);
  }

  // ---- Resultats et fichiers -----------------------------------------------
  {
    const rows: ReportRow[] = [];
    const text = document.statements.map((s) => s.text.toUpperCase()).join('\n');
    const wantsDepla = document.statements.some(
      (s) => s.blockPath.includes('RESU') && /\bDEPLA\b/.test(s.text.toUpperCase()),
    );
    const etudeDepla = /\bETUDE\b[^\n]*\bDEPLA\b/.test(text);
    const dessPresent = /^\s*DESS\b/m.test(text);

    rows.push({
      label: 'Editions',
      checks: [
        check('G4', 'RESU ou DESS present', !study.resuPresent && !dessPresent, 'warn',
          'aucun resultat ne sera edite'),
        wantsDepla && model.studiedBars.size
          ? check('G2', 'DEPLA etudie', !etudeDepla, 'warn', 'RESU demande DEPLA mais ETUDE ne le declare pas')
          : na('G2', 'DEPLA etudie'),
      ],
    });

    for (const include of model.includes) {
      rows.push({
        label: `LIRE '${include.file}'`,
        line: include.line,
        file: 0,
        checks: [check('R14', 'resolu', !include.resolved, 'error', 'fichier introuvable depuis le fichier hote')],
      });
    }
    if (model.truncated) {
      rows.push({
        label: 'Executeur',
        checks: [check('R15', 'modele complet', true, 'error', 'boucle demesuree : le modele est tronque')],
      });
    }
    if (!model.option) {
      // Des exemples officiels du manuel omettent l'OPTION : avertissement,
      // pas erreur — ST1 accepte le fichier.
      rows.push({ label: 'OPTION', checks: [check('C1', 'declaree', true, 'warn', 'aucune OPTION declaree')] });
    }
    pushFamily(families, 'fichiers', 'Resultats et fichiers', rows);
  }

  let checks = 0;
  let errors = 0;
  let warns = 0;
  for (const family of families) {
    for (const row of family.rows) {
      for (const c of row.checks) {
        if (c.verdict === 'na') continue;
        checks++;
        if (c.verdict === 'error') errors++;
        else if (c.verdict === 'warn') warns++;
      }
    }
  }

  const inventory = [
    model.option ? `OPTION ${model.option}` : 'OPTION non declaree',
    `${model.nodes.size} noeuds`,
    `${model.bars.size} barres`,
    `${model.supports.length} appuis`,
    model.cables.length ? `${model.cables.length} cables` : '',
    defs('CHARG').size ? `${defs('CHARG').size} cas de charge` : '',
    model.phasages.length ? `${model.phasages.length} phasage(s)` : '',
    model.files.length > 1 ? `${model.files.length} fichiers` : '',
  ].filter(Boolean).join(' · ');

  return {
    families: families.filter((f) => f.rows.length),
    summary: { checks, errors, warns },
    inventory,
    files: model.files,
    silenced,
  };
}

function title(kind: StudyKind, def: { id: number; title?: string }): string {
  return `${KIND_LABELS[kind]} ${def.id}${def.title ? ` — '${def.title}'` : ''}`;
}

function pushFamily(families: ReportFamily[], id: string, titleText: string, rows: ReportRow[]): void {
  let errors = 0;
  let warns = 0;
  for (const row of rows) {
    for (const c of row.checks) {
      if (c.verdict === 'error') errors++;
      else if (c.verdict === 'warn') warns++;
    }
  }
  families.push({ id, title: titleText, rows, errors, warns });
}
