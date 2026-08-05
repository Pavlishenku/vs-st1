// @ts-check
/**
 * Rendu du rapport de coherence de l'etude.
 *
 * La webview ne fait qu'afficher : toute l'analyse vient du serveur
 * (`st1/report`). Construction en DOM pur (`textContent`) — les titres des
 * objets viennent du fichier de l'utilisateur, rien n'est interprete.
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const summary = /** @type {HTMLElement} */ (document.getElementById('summary'));
  const inventory = /** @type {HTMLElement} */ (document.getElementById('inventory'));
  const familiesRoot = /** @type {HTMLElement} */ (document.getElementById('families'));

  /** @type {HTMLElement} */ (document.getElementById('refresh')).addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });

  const GLYPHS = { ok: '✓', warn: '⚠', error: '✗', na: '—' };

  function render(report) {
    summary.textContent = '';
    const parts = [];
    if (report.summary.errors) parts.push({ text: `${report.summary.errors} non conforme(s)`, cls: 'error' });
    if (report.summary.warns) parts.push({ text: `${report.summary.warns} a verifier`, cls: 'warn' });
    parts.push({ text: `${report.summary.checks - report.summary.errors - report.summary.warns} conforme(s)`, cls: '' });
    parts.forEach((part, i) => {
      if (i) summary.appendChild(document.createTextNode(' · '));
      const span = document.createElement('span');
      if (part.cls) span.className = part.cls;
      span.textContent = part.text;
      summary.appendChild(span);
    });

    inventory.textContent = report.inventory + (report.silenced
      ? ' · ⚠ LIRE non resolu ou modele tronque : les controles d’existence sont suspendus'
      : '');

    familiesRoot.textContent = '';
    for (const family of report.families) {
      const details = document.createElement('details');
      details.open = family.errors + family.warns > 0;

      const summaryEl = document.createElement('summary');
      const name = document.createElement('span');
      name.className = 'family-name';
      name.textContent = family.title;
      summaryEl.appendChild(name);
      const meta = document.createElement('span');
      meta.className = 'family-meta';
      meta.textContent = `${family.rows.length} ligne(s)`;
      summaryEl.appendChild(meta);
      if (family.errors) summaryEl.appendChild(badge(String(family.errors), 'error'));
      if (family.warns) summaryEl.appendChild(badge(String(family.warns), 'warn'));
      if (!family.errors && !family.warns) summaryEl.appendChild(badge(GLYPHS.ok, 'ok'));
      details.appendChild(summaryEl);

      const table = document.createElement('table');
      for (const row of family.rows) {
        const tr = document.createElement('tr');
        const worst = row.checks.some((c) => c.verdict === 'error')
          ? 'error'
          : row.checks.some((c) => c.verdict === 'warn') ? 'warn' : '';
        if (worst) tr.className = worst;

        const labelCell = document.createElement('td');
        labelCell.className = 'label';
        labelCell.textContent = row.label;
        tr.appendChild(labelCell);

        const checksCell = document.createElement('td');
        checksCell.className = 'checks';
        row.checks.forEach((check, i) => {
          if (i) checksCell.appendChild(document.createTextNode('  '));
          const chip = document.createElement('span');
          chip.className = 'chip ' + check.verdict;
          chip.textContent = `${GLYPHS[check.verdict]} ${check.label}`;
          if (check.detail) chip.title = check.detail;
          checksCell.appendChild(chip);
          if (check.detail && check.verdict !== 'ok') {
            const detail = document.createElement('span');
            detail.className = 'detail ' + check.verdict;
            detail.textContent = ` ${check.detail}`;
            checksCell.appendChild(detail);
          }
        });
        tr.appendChild(checksCell);

        const lineCell = document.createElement('td');
        lineCell.className = 'line';
        if (row.line !== undefined) {
          lineCell.textContent = `ligne ${row.line + 1}`;
          tr.classList.add('clickable');
          tr.addEventListener('click', () => {
            vscode.postMessage({ type: 'reveal', line: row.line, file: row.file || 0 });
          });
        }
        tr.appendChild(lineCell);
        table.appendChild(tr);
      }
      details.appendChild(table);
      familiesRoot.appendChild(details);
    }

    if (!report.families.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Aucun objet a controler dans ce fichier.';
      familiesRoot.appendChild(empty);
    }
  }

  function badge(text, cls) {
    const span = document.createElement('span');
    span.className = 'badge ' + cls;
    span.textContent = text;
    return span;
  }

  window.addEventListener('message', (event) => {
    const payload = event.data;
    if (payload.type === 'error') {
      summary.textContent = payload.message;
      return;
    }
    if (payload.type === 'report' && payload.report) render(payload.report);
  });

  vscode.postMessage({ type: 'ready' });
})();
