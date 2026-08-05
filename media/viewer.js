// @ts-check
/**
 * Rendu du modele ST1 dans la webview.
 *
 * Le modele n'ayant que des elements 1D, un canvas 2D avec projection
 * orthographique suffit : pas de WebGL, pas de bibliotheque tierce, donc rien
 * qui puisse casser en Remote-SSH, en Codespaces ou sur un CPU sans jeu
 * d'instructions particulier.
 *
 * Le modele recu agrege les fichiers inclus par `LIRE`, les cables de
 * precontrainte (`CABLE … TRACE`) et les instantanes du phasage : la webview
 * ne fait que dessiner et filtrer, toute l'analyse reste cote serveur.
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const tooltip = /** @type {HTMLElement} */ (document.getElementById('tooltip'));
  const summary = /** @type {HTMLElement} */ (document.getElementById('summary'));
  const phaseGroup = /** @type {HTMLElement} */ (document.getElementById('phaseGroup'));
  const phaseSelect = /** @type {HTMLSelectElement} */ (document.getElementById('phaseSelect'));
  const cablesToggle = /** @type {HTMLElement} */ (document.getElementById('cablesToggle'));
  const releasesToggle = /** @type {HTMLElement} */ (document.getElementById('releasesToggle'));

  /** @type {any} */
  let model = null;
  const view = {
    mode: 'XY',
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    yaw: -0.6,
    pitch: 0.5,
    fitted: false,
  };
  const options = { nodeNumbers: false, barNumbers: false, supports: true, loads: true, cables: true, releases: true };

  /**
   * Etat de phasage visualise : `null` = modele complet, sinon un instantane
   * `{ bars: Set, supports: Set, tensioned: Set, label }`. Les elements hors de
   * l'instantane restent visibles mais estompes : on voit ce qui n'est pas
   * encore construit.
   */
  let phase = null;

  /**
   * Position du curseur de l'editeur (`{ line, file }`) : l'element defini a
   * cette ligne se surligne dans le dessin — sens inverse du clic-navigation.
   */
  let cursor = null;

  /** Coordonnees ecran des noeuds, recalculees a chaque rendu. */
  let projected = new Map();

  // ---------------------------------------------------------------- couleurs
  function palette() {
    const style = getComputedStyle(document.body);
    const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return {
      background: read('--vscode-editor-background', '#1e1e1e'),
      bar: read('--vscode-editor-foreground', '#d4d4d4'),
      node: read('--vscode-charts-blue', '#4fc1ff'),
      support: read('--vscode-charts-green', '#89d185'),
      load: read('--vscode-charts-orange', '#e9a700'),
      deck: read('--vscode-charts-purple', '#b180d7'),
      cable: read('--vscode-charts-red', '#f14c4c'),
      text: read('--vscode-descriptionForeground', '#9d9d9d'),
      grid: read('--vscode-editorIndentGuide-background', '#404040'),
      highlight: read('--vscode-focusBorder', '#007fd4'),
    };
  }

  // -------------------------------------------------------------- projection
  /** Projette un point du modele vers un repere « monde plan » (avant zoom). */
  function project(node) {
    switch (view.mode) {
      case 'XZ':
        return [node.x, -node.z];
      case 'YZ':
        return [node.y, -node.z];
      case '3D': {
        const cy = Math.cos(view.yaw);
        const sy = Math.sin(view.yaw);
        const cp = Math.cos(view.pitch);
        const sp = Math.sin(view.pitch);
        const x = node.x * cy + node.z * sy;
        const z = -node.x * sy + node.z * cy;
        const y = node.y * cp - z * sp;
        return [x, -y];
      }
      default:
        return [node.x, -node.y];
    }
  }

  function toScreen(point) {
    return [point[0] * view.scale + view.offsetX, point[1] * view.scale + view.offsetY];
  }

  function projectToScreen(point) {
    return toScreen(project(point));
  }

  function fit() {
    if (!model || !model.nodes.length) return;
    // Panneau pas encore mis en page (webview en arriere-plan) : cadrer
    // maintenant fixerait une echelle absurde. Le `resize` refera l'essai.
    if (canvas.clientWidth <= 0 || canvas.clientHeight <= 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const extend = (point) => {
      const [x, y] = project(point);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    };
    for (const node of model.nodes) extend(node);
    for (const cable of model.cables || []) for (const point of cable.points) extend(point);
    const width = Math.max(maxX - minX, 1e-6);
    const height = Math.max(maxY - minY, 1e-6);
    const margin = 60;
    view.scale = Math.min((canvas.clientWidth - 2 * margin) / width, (canvas.clientHeight - 2 * margin) / height);
    if (!isFinite(view.scale) || view.scale <= 0) view.scale = 1;
    view.offsetX = canvas.clientWidth / 2 - ((minX + maxX) / 2) * view.scale;
    view.offsetY = canvas.clientHeight / 2 - ((minY + maxY) / 2) * view.scale;
    view.fitted = true;
  }

  // ------------------------------------------------------------------ rendu
  function draw() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * ratio;
    canvas.height = canvas.clientHeight * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const colors = palette();
    context.fillStyle = colors.background;
    context.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    if (!model || !model.nodes.length) {
      context.fillStyle = colors.text;
      context.font = '13px var(--vscode-font-family, sans-serif)';
      context.textAlign = 'center';
      context.fillText(
        model ? 'Aucun noeud defini dans ce fichier.' : 'Analyse du modele…',
        canvas.clientWidth / 2,
        canvas.clientHeight / 2,
      );
      return;
    }

    projected = new Map();
    for (const node of model.nodes) projected.set(node.id, projectToScreen(node));

    drawAxes(colors);

    const loaded = new Set(model.loadedBars || []);
    const deck = new Set(model.deckBars || []);

    // Barres. En mode phasage, les barres non activees restent visibles mais
    // estompees : le squelette complet situe ce qui reste a construire.
    context.lineCap = 'round';
    for (const bar of model.bars) {
      const a = projected.get(bar.from);
      const b = projected.get(bar.to);
      if (!a || !b) continue;
      const ghost = phase && !phase.bars.has(bar.id);
      const isDeck = deck.has(bar.id);
      const isLoaded = options.loads && loaded.has(bar.id);
      context.globalAlpha = ghost ? 0.18 : 1;
      context.strokeStyle = isDeck ? colors.deck : isLoaded ? colors.load : colors.bar;
      context.lineWidth = ghost ? 1 : isDeck || isLoaded ? 3 : 2;
      context.beginPath();
      context.moveTo(a[0], a[1]);
      context.lineTo(b[0], b[1]);
      context.stroke();
      context.globalAlpha = 1;

      if (options.barNumbers && !ghost) {
        context.fillStyle = colors.text;
        context.font = '10px var(--vscode-editor-font-family, monospace)';
        context.textAlign = 'center';
        context.fillText(String(bar.id), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 5);
      }
    }

    // Articulations (rotules) et excentrements : conventions de dessin RDM.
    if (options.releases) drawReleases(colors);

    // Cables de precontrainte.
    if (options.cables) {
      for (const cable of model.cables || []) drawCable(cable, colors);
    }

    // Appuis.
    if (options.supports) {
      for (const support of model.supports) {
        const point = projected.get(support.node);
        if (!point) continue;
        const ghost = phase && !phase.supports.has(support.id);
        context.globalAlpha = ghost ? 0.18 : 1;
        drawSupport(point, support, colors);
        context.globalAlpha = 1;
      }
    }

    // Noeuds.
    for (const node of model.nodes) {
      const point = projected.get(node.id);
      if (!point) continue;
      context.fillStyle = colors.node;
      context.beginPath();
      context.arc(point[0], point[1], 3, 0, Math.PI * 2);
      context.fill();

      if (options.nodeNumbers) {
        context.fillStyle = colors.text;
        context.font = '10px var(--vscode-editor-font-family, monospace)';
        context.textAlign = 'left';
        context.fillText(String(node.id), point[0] + 6, point[1] - 4);
      }
    }

    drawCursorHighlight(colors);
    drawScaleBar(colors);
  }

  /**
   * Rotules et excentrements. Conventions classiques de la RDM :
   *  - articulation (`ART … OR/EX`) : petit cercle vide a l'extremite liberee ;
   *  - excentrement (`EXC`) : double trait perpendiculaire au milieu de la
   *    barre (liaison rigide, sans chargement ni section d'etude).
   */
  function drawReleases(colors) {
    context.lineWidth = 1.5;

    for (const articulation of model.articulations || []) {
      const bar = model.bars.find((b) => b.id === articulation.bar);
      if (!bar) continue;
      const a = projected.get(bar.from);
      const b = projected.get(bar.to);
      if (!a || !b) continue;
      const ghost = phase && !phase.bars.has(bar.id);
      context.globalAlpha = ghost ? 0.18 : 1;
      context.strokeStyle = colors.bar;
      context.fillStyle = colors.background;
      const ends = [];
      if (articulation.or && articulation.or.length) ends.push([a, b]);
      if (articulation.ex && articulation.ex.length) ends.push([b, a]);
      for (const [end, other] of ends) {
        // Cercle pose sur la barre, decale du noeud vers l'interieur.
        const dx = other[0] - end[0];
        const dy = other[1] - end[1];
        const norm = Math.hypot(dx, dy) || 1;
        const offset = Math.min(9, norm / 3);
        const cx = end[0] + (dx / norm) * offset;
        const cy = end[1] + (dy / norm) * offset;
        context.beginPath();
        context.arc(cx, cy, 3.5, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
      context.globalAlpha = 1;
    }

    for (const id of model.eccentric || []) {
      const bar = model.bars.find((b) => b.id === id);
      if (!bar) continue;
      const a = projected.get(bar.from);
      const b = projected.get(bar.to);
      if (!a || !b) continue;
      const ghost = phase && !phase.bars.has(id);
      context.globalAlpha = ghost ? 0.18 : 1;
      context.strokeStyle = colors.bar;
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const norm = Math.hypot(dx, dy) || 1;
      // Perpendiculaire a la barre, deux traits espaces le long de la barre.
      const px = -dy / norm;
      const py = dx / norm;
      const ux = dx / norm;
      const uy = dy / norm;
      context.beginPath();
      for (const shift of [-2.5, 2.5]) {
        context.moveTo(mx + ux * shift - px * 5, my + uy * shift - py * 5);
        context.lineTo(mx + ux * shift + px * 5, my + uy * shift + py * 5);
      }
      context.stroke();
      context.globalAlpha = 1;
    }
  }

  /** Surligne les elements definis a la ligne du curseur de l'editeur. */
  function drawCursorHighlight(colors) {
    if (!cursor) return;
    const at = (element) => element.line === cursor.line && (element.file || 0) === cursor.file;

    context.strokeStyle = colors.highlight;
    context.globalAlpha = 0.45;
    context.lineCap = 'round';

    for (const bar of model.bars.filter(at)) {
      const a = projected.get(bar.from);
      const b = projected.get(bar.to);
      if (!a || !b) continue;
      context.lineWidth = 8;
      context.beginPath();
      context.moveTo(a[0], a[1]);
      context.lineTo(b[0], b[1]);
      context.stroke();
    }
    if (options.cables) {
      for (const cable of (model.cables || []).filter(at)) {
        const path = cablePath(cable);
        if (path.length < 2) continue;
        context.lineWidth = 7;
        context.beginPath();
        context.moveTo(path[0][0], path[0][1]);
        for (let i = 1; i < path.length; i++) context.lineTo(path[i][0], path[i][1]);
        context.stroke();
      }
    }
    context.globalAlpha = 1;
    context.lineWidth = 2;
    const ringed = new Set();
    for (const node of model.nodes.filter(at)) ringed.add(node.id);
    // Un appui surligne son noeud porteur.
    for (const support of model.supports.filter(at)) ringed.add(support.node);
    for (const id of ringed) {
      const point = projected.get(id);
      if (!point) continue;
      context.beginPath();
      context.arc(point[0], point[1], 7, 0, Math.PI * 2);
      context.stroke();
    }
  }

  /**
   * Trace d'un cable : la polyligne de ses points `TRACE`. Sans trace declare,
   * on suit les barres du cable en pointilles — le rattachement est connu, la
   * geometrie exacte non. En mode phasage, un cable non tendu est estompe.
   */
  function drawCable(cable, colors) {
    const ghost = phase && !phase.tensioned.has(cable.id);
    const path = cablePath(cable);
    if (path.length < 2) return;

    context.globalAlpha = ghost ? 0.25 : 1;
    context.strokeStyle = colors.cable;
    context.lineWidth = ghost ? 1 : 2;
    context.setLineDash(cable.points.length >= 2 && !ghost ? [] : [6, 4]);
    context.beginPath();
    context.moveTo(path[0][0], path[0][1]);
    for (let i = 1; i < path.length; i++) context.lineTo(path[i][0], path[i][1]);
    context.stroke();
    context.setLineDash([]);

    // Ancrages : un petit trait perpendiculaire a chaque extremite.
    for (const end of [path[0], path[path.length - 1]]) {
      context.beginPath();
      context.arc(end[0], end[1], 2.5, 0, Math.PI * 2);
      context.fillStyle = colors.cable;
      context.fill();
    }
    context.globalAlpha = 1;
  }

  /**
   * Points 3D interpoles du trace d'un cable. ST1 construit le trace par des
   * **cubiques** entre les points de passage (methode externe, p.334) : relier
   * les points par des segments droits donnerait au cable l'allure d'une barre.
   * On interpole donc en Hermite : tangentes imposees par `PENTE`/`GIS` quand
   * elles sont declarees, differences finies (Catmull-Rom) sinon. `ALIGNE`
   * impose un troncon droit ; un cable `EXTERIEUR` reste une ligne brisee
   * (deviateurs et entretoises).
   */
  function cableCurve(cable) {
    const points = cable.points;
    if (points.length < 2) return null;
    if (cable.exterior) return points;

    // Axe vertical du repere global : y en PLANE, z en GRILL / SPATIALE —
    // c'est l'axe auquel la PENTE (angle avec le plan horizontal) se rapporte.
    const verticalIsY = model.option !== 'SPATIALE' && model.option !== 'GRILL';
    const tangentAt = (index) => {
      const point = points[index];
      if (point.pente !== undefined) {
        const cp = Math.cos(point.pente);
        const sp = Math.sin(point.pente);
        const gis = point.gis || 0;
        return verticalIsY
          ? { x: cp * Math.cos(gis), y: sp, z: cp * Math.sin(gis) }
          : { x: cp * Math.cos(gis), y: cp * Math.sin(gis), z: sp };
      }
      const before = points[Math.max(0, index - 1)];
      const after = points[Math.min(points.length - 1, index + 1)];
      const d = { x: after.x - before.x, y: after.y - before.y, z: after.z - before.z };
      const norm = Math.hypot(d.x, d.y, d.z) || 1;
      return { x: d.x / norm, y: d.y / norm, z: d.z / norm };
    };

    const curve = [points[0]];
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const chord = { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z };
      const length = Math.hypot(chord.x, chord.y, chord.z);
      if (p0.aligne || length === 0) {
        curve.push(p1);
        continue;
      }
      // Tangentes orientees dans le sens du parcours (PENTE ne donne qu'un angle).
      const orient = (t) => {
        const dot = t.x * chord.x + t.y * chord.y + t.z * chord.z;
        const sign = dot < 0 ? -1 : 1;
        return { x: t.x * length * sign, y: t.y * length * sign, z: t.z * length * sign };
      };
      const m0 = orient(tangentAt(i));
      const m1 = orient(tangentAt(i + 1));
      const steps = 16;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1;
        const h10 = t3 - 2 * t2 + t;
        const h01 = -2 * t3 + 3 * t2;
        const h11 = t3 - t2;
        curve.push({
          x: h00 * p0.x + h10 * m0.x + h01 * p1.x + h11 * m1.x,
          y: h00 * p0.y + h10 * m0.y + h01 * p1.y + h11 * m1.y,
          z: h00 * p0.z + h10 * m0.z + h01 * p1.z + h11 * m1.z,
        });
      }
    }
    return curve;
  }

  /** Points ecran du trace d'un cable (courbe du `TRACE`, sinon chaine des barres). */
  function cablePath(cable) {
    const curve = cableCurve(cable);
    if (curve) return curve.map(projectToScreen);
    const path = [];
    for (const id of cable.bars || []) {
      const bar = model.bars.find((b) => b.id === id);
      if (!bar) continue;
      const a = projected.get(bar.from);
      const b = projected.get(bar.to);
      if (!a || !b) continue;
      if (!path.length) path.push(a);
      path.push(b);
    }
    return path;
  }

  /** Symbole d'appui : triangle + hachures, ou ressort si l'appui est elastique. */
  function drawSupport(point, support, colors) {
    const size = 9;
    context.strokeStyle = colors.support;
    context.fillStyle = colors.support;
    context.lineWidth = 1.5;

    if (support.elastic) {
      // Ressort : zigzag vertical sous le noeud.
      context.beginPath();
      context.moveTo(point[0], point[1]);
      for (let i = 1; i <= 8; i++) {
        const y = point[1] + (i / 8) * size * 1.6;
        const x = point[0] + (i === 8 ? 0 : i % 2 === 0 ? -4 : 4);
        context.lineTo(x, y);
      }
      context.stroke();
    } else {
      context.beginPath();
      context.moveTo(point[0], point[1]);
      context.lineTo(point[0] - size, point[1] + size * 1.4);
      context.lineTo(point[0] + size, point[1] + size * 1.4);
      context.closePath();
      support.ddl && support.ddl.length >= 3 ? context.fill() : context.stroke();
    }

    context.beginPath();
    for (let i = -size; i <= size; i += 4) {
      context.moveTo(point[0] + i, point[1] + size * 1.4);
      context.lineTo(point[0] + i - 4, point[1] + size * 1.4 + 4);
    }
    context.stroke();
  }

  function drawAxes(colors) {
    const labels = { XY: ['X', 'Y'], XZ: ['X', 'Z'], YZ: ['Y', 'Z'], '3D': ['X', 'Y'] };
    const [horizontal, vertical] = labels[view.mode] || labels.XY;
    const originX = 34;
    const originY = canvas.clientHeight - 34;
    context.strokeStyle = colors.grid;
    context.fillStyle = colors.text;
    context.lineWidth = 1;
    context.font = '11px var(--vscode-font-family, sans-serif)';
    context.textAlign = 'center';

    context.beginPath();
    context.moveTo(originX, originY);
    context.lineTo(originX + 26, originY);
    context.moveTo(originX, originY);
    context.lineTo(originX, originY - 26);
    context.stroke();
    context.fillText(horizontal, originX + 34, originY + 4);
    context.fillText(vertical, originX, originY - 32);
  }

  /** Echelle graphique : indispensable pour verifier un modele d'un coup d'oeil. */
  function drawScaleBar(colors) {
    const target = 120;
    const raw = target / view.scale;
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * magnitude).find((v) => v * view.scale >= 60) || magnitude;
    const width = step * view.scale;
    const x = canvas.clientWidth - width - 24;
    const y = canvas.clientHeight - 24;

    context.strokeStyle = colors.text;
    context.fillStyle = colors.text;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, y - 4);
    context.lineTo(x, y);
    context.lineTo(x + width, y);
    context.lineTo(x + width, y - 4);
    context.stroke();
    context.font = '11px var(--vscode-font-family, sans-serif)';
    context.textAlign = 'center';
    context.fillText(formatNumber(step), x + width / 2, y - 8);
  }

  function formatNumber(value) {
    if (value >= 1000 || (value > 0 && value < 0.01)) return value.toExponential(2).replace(/\.?0+e/, 'e');
    return String(Number(value.toFixed(3)));
  }

  // ------------------------------------------------------------ interactions
  let dragging = null;

  canvas.addEventListener('mousedown', (event) => {
    dragging = { x: event.clientX, y: event.clientY, button: event.button };
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mouseup', () => {
    dragging = null;
    canvas.style.cursor = 'default';
  });

  window.addEventListener('mousemove', (event) => {
    if (dragging) {
      const dx = event.clientX - dragging.x;
      const dy = event.clientY - dragging.y;
      dragging.x = event.clientX;
      dragging.y = event.clientY;
      if (dragging.button === 2 && view.mode === '3D') {
        view.yaw += dx * 0.01;
        view.pitch = Math.max(-1.5, Math.min(1.5, view.pitch + dy * 0.01));
      } else {
        view.offsetX += dx;
        view.offsetY += dy;
      }
      draw();
      return;
    }
    hover(event);
  });

  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    view.offsetX = mouseX - (mouseX - view.offsetX) * factor;
    view.offsetY = mouseY - (mouseY - view.offsetY) * factor;
    view.scale *= factor;
    draw();
  }, { passive: false });

  canvas.addEventListener('click', (event) => {
    const target = pick(event);
    if (target && target.line !== undefined) {
      vscode.postMessage({ type: 'reveal', line: target.line, file: target.file || 0 });
    }
  });

  function pick(event) {
    if (!model) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    for (const node of model.nodes) {
      const point = projected.get(node.id);
      if (point && Math.hypot(point[0] - x, point[1] - y) < 7) {
        return { kind: 'noeud', id: node.id, line: node.line, file: node.file, node };
      }
    }
    if (options.cables) {
      for (const cable of model.cables || []) {
        const path = cablePath(cable);
        for (let i = 1; i < path.length; i++) {
          if (distanceToSegment(x, y, path[i - 1], path[i]) < 5) {
            return { kind: 'cable', id: cable.id, line: cable.line, file: cable.file, cable };
          }
        }
      }
    }
    for (const bar of model.bars) {
      const a = projected.get(bar.from);
      const b = projected.get(bar.to);
      if (a && b && distanceToSegment(x, y, a, b) < 5) {
        return { kind: 'barre', id: bar.id, line: bar.line, file: bar.file, bar };
      }
    }
    return null;
  }

  function distanceToSegment(px, py, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return Math.hypot(px - a[0], py - a[1]);
    let t = ((px - a[0]) * dx + (py - a[1]) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
  }

  // ---------------------------------------------------------------- infobulle
  function hover(event) {
    const target = pick(event);
    if (!target) {
      tooltip.hidden = true;
      canvas.style.cursor = 'default';
      return;
    }
    canvas.style.cursor = 'pointer';
    tooltip.hidden = false;
    tooltip.style.left = `${event.clientX + 14}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
    // `white-space: pre-line` + textContent : une ligne par information, sans
    // injection possible (les titres viennent du fichier de l'utilisateur).
    tooltip.textContent = tooltipLines(target).join('\n');
  }

  function tooltipLines(target) {
    if (target.kind === 'noeud') return nodeTooltip(target);
    if (target.kind === 'cable') return cableTooltip(target.cable);
    return barTooltip(target.bar);
  }

  function nodeTooltip(target) {
    const spatial = model.option === 'SPATIALE';
    const coordinates = spatial
      ? `${formatNumber(target.node.x)} ; ${formatNumber(target.node.y)} ; ${formatNumber(target.node.z)}`
      : `${formatNumber(target.node.x)} ; ${formatNumber(target.node.y)}`;
    const lines = [`Noeud ${target.id} — ${coordinates}`];
    for (const support of model.supports.filter((s) => s.node === target.id)) {
      const kind = support.elastic ? 'elastique' : support.ddl.join(' ') || 'libre';
      lines.push(`Appui ${support.id} : ${kind}${support.decol ? ' · DECOL' : ''}`);
    }
    lines.push(...originLine(target.node));
    return lines;
  }

  function barTooltip(bar) {
    const lines = [`Barre ${bar.id} — noeuds ${bar.from} → ${bar.to}${barLength(bar)}`];
    const detail = (model.barDetails || {})[bar.id];
    if (detail) {
      if (detail.cara) {
        const parts = Object.entries(detail.cara).map(
          ([name, value]) => (value === undefined || value === null ? name : `${name}=${formatNumber(value)}`),
        );
        if (parts.length) {
          lines.push(`CARA${detail.pse ? ' PSE' : ''}${detail.variable ? ' VAR' : ''} : ${parts.join('  ')}`);
        } else if (detail.pse) {
          lines.push('CARA PSE (sol elastique)');
        }
      }
      if (detail.cons) {
        lines.push(`CONS : ${Object.entries(detail.cons).map(([n, v]) => `${n}=${formatNumber(v)}`).join('  ')}`);
      }
      if (detail.mat) {
        lines.push(`Materiau ${detail.mat.id}${detail.mat.title ? ` — '${detail.mat.title}'` : ''}`);
      }
      if (detail.art) {
        const parts = [];
        if (detail.art.or.length) parts.push(`OR ${detail.art.or.join(' ')}`);
        if (detail.art.ex.length) parts.push(`EX ${detail.art.ex.join(' ')}`);
        lines.push(`Articulation : ${parts.join(' · ')}`);
      }
    }
    const roles = [];
    if ((model.deckBars || []).includes(bar.id)) roles.push('tablier');
    if ((model.loadedBars || []).includes(bar.id)) roles.push('chargee');
    if (phase && !phase.bars.has(bar.id)) roles.push('inactive dans cette phase');
    if (roles.length) lines.push(roles.join(' · '));
    lines.push(...originLine(bar));
    return lines;
  }

  function cableTooltip(cable) {
    const lines = [`Cable ${cable.id}${cable.name ? ` — '${cable.name}'` : ''}`];
    if (cable.prec !== undefined) lines.push(`Precontrainte PREC ${cable.prec}`);
    if (cable.bars && cable.bars.length) lines.push(`Barres ${cable.bars.join(', ')}`);
    if (cable.points.length >= 2) {
      lines.push(`Trace : ${cable.points.length} points${cable.exterior ? ' (exterieur)' : ''}`);
    } else if (cable.traceDeclared) {
      lines.push('Trace declare mais illisible : dessin le long des barres');
    } else {
      lines.push('Pas de TRACE : dessin le long des barres');
    }
    if (phase) lines.push(phase.tensioned.has(cable.id) ? 'Tendu dans cette phase' : 'Non tendu dans cette phase');
    lines.push(...originLine(cable));
    return lines;
  }

  /** Longueur reelle de la barre, calculee sur les coordonnees du modele. */
  function barLength(bar) {
    const a = model.nodes.find((n) => n.id === bar.from);
    const b = model.nodes.find((n) => n.id === bar.to);
    if (!a || !b) return ' · noeud manquant';
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    return ` · L=${formatNumber(length)}`;
  }

  /** Provenance d'un element defini dans un fichier inclus par `LIRE`. */
  function originLine(element) {
    if (!element.file || !model.files || !model.files[element.file]) return [];
    const name = String(model.files[element.file]).split(/[\\/]/).pop();
    return [`Defini dans ${name} (clic pour ouvrir)`];
  }

  // --------------------------------------------------------------- controles
  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => {
      view.mode = button.getAttribute('data-view') || 'XY';
      for (const other of document.querySelectorAll('[data-view]')) other.classList.toggle('active', other === button);
      fit();
      draw();
    });
  }

  /** @type {HTMLElement} */ (document.getElementById('fit')).addEventListener('click', () => {
    fit();
    draw();
  });

  const toggles = [
    ['nodeNumbers', 'nodeNumbers'],
    ['barNumbers', 'barNumbers'],
    ['showSupports', 'supports'],
    ['showLoads', 'loads'],
    ['showCables', 'cables'],
    ['showReleases', 'releases'],
  ];
  for (const [id, key] of toggles) {
    const input = /** @type {HTMLInputElement} */ (document.getElementById(id));
    input.addEventListener('change', () => {
      options[key] = input.checked;
      draw();
    });
  }

  // ---------------------------------------------------------------- phasage
  phaseSelect.addEventListener('change', () => {
    applyPhaseSelection();
    draw();
  });

  /** Reconstruit la liste des phases ; conserve la selection si elle existe encore. */
  function rebuildPhaseSelect() {
    const phasages = model.phasages || [];
    const previous = phaseSelect.value;
    phaseSelect.textContent = '';

    const full = document.createElement('option');
    full.value = '';
    full.textContent = 'Modele complet';
    phaseSelect.appendChild(full);

    phasages.forEach((phasage, p) => {
      const group = document.createElement('optgroup');
      group.label = `PHASAGE${phasage.id !== undefined ? ' ' + phasage.id : ''}${phasage.title ? ` — ${phasage.title}` : ''}`;
      phasage.states.forEach((state, s) => {
        const option = document.createElement('option');
        option.value = `${p}:${s}`;
        const name = state.id !== undefined ? `ETAT ${state.id}` : 'Etat final';
        const date = state.date !== undefined ? ` (date ${formatNumber(state.date)})` : '';
        option.textContent = `${name}${state.title ? ` — ${state.title}` : ''}${date}`;
        group.appendChild(option);
      });
      phaseSelect.appendChild(group);
    });

    phaseGroup.hidden = !phasages.length;
    if ([...phaseSelect.options].some((o) => o.value === previous)) phaseSelect.value = previous;
    else phaseSelect.value = '';
    applyPhaseSelection();
  }

  function applyPhaseSelection() {
    const value = phaseSelect.value;
    if (!value || !model) {
      phase = null;
      return;
    }
    const [p, s] = value.split(':').map(Number);
    const state = model.phasages?.[p]?.states?.[s];
    phase = state
      ? { bars: new Set(state.bars), supports: new Set(state.supports), tensioned: new Set(state.tensioned) }
      : null;
  }

  // ------------------------------------------------------------------ resume
  function updateSummary() {
    summary.textContent = '';
    const plain = document.createElement('span');
    const bits = [
      `${model.counts.nodes} noeuds`,
      `${model.counts.bars} barres`,
      `${model.counts.supports} appuis`,
    ];
    if (model.counts.cables) bits.push(`${model.counts.cables} cables`);
    bits.push(model.option ? `OPTION ${model.option}` : 'OPTION non declaree');
    plain.textContent = bits.join(' · ');
    summary.appendChild(plain);

    // Anomalies : elles expliquent un dessin incomplet, il faut les montrer la
    // ou l'utilisateur regarde — pas seulement dans le panneau Problems.
    const warnings = [];
    if (model.counts.unresolvedBars) warnings.push(`${model.counts.unresolvedBars} barre(s) sans noeud`);
    const missing = (model.includes || []).filter((i) => !i.resolved);
    if (missing.length) warnings.push(`LIRE non resolu : ${missing.map((i) => i.file).join(', ')}`);
    // Un TRACE declare mais sans point lisible explique un cable dessine le
    // long de ses barres : il faut le dire, pas le laisser deviner.
    const unreadable = (model.cables || []).filter((c) => c.traceDeclared && c.points.length < 2);
    if (unreadable.length) warnings.push(`trace illisible : cable ${unreadable.map((c) => c.id).join(', ')}`);
    if (model.truncated) warnings.push('modele tronque (boucle trop longue)');
    if (warnings.length) {
      const warn = document.createElement('span');
      warn.className = 'warn';
      warn.textContent = ` · ⚠ ${warnings.join(' · ')}`;
      summary.appendChild(warn);
    }
  }

  window.addEventListener('resize', () => {
    if (!view.fitted) fit();
    draw();
  });

  window.addEventListener('message', (event) => {
    const payload = event.data;
    if (payload.type === 'error') {
      summary.textContent = payload.message;
      return;
    }
    if (payload.type === 'cursor') {
      cursor = { line: payload.line, file: payload.file };
      if (model) draw();
      return;
    }
    if (payload.type !== 'model') return;

    const previous = model;
    model = payload.model;
    if (!model) return;

    if (payload.settings) {
      options.nodeNumbers = payload.settings.showNodeNumbers;
      options.barNumbers = payload.settings.showBarNumbers;
      /** @type {HTMLInputElement} */ (document.getElementById('nodeNumbers')).checked = options.nodeNumbers;
      /** @type {HTMLInputElement} */ (document.getElementById('barNumbers')).checked = options.barNumbers;

      if (!previous) {
        options.cables = payload.settings.showCables !== false;
        /** @type {HTMLInputElement} */ (document.getElementById('showCables')).checked = options.cables;
        options.releases = payload.settings.showReleases !== false;
        /** @type {HTMLInputElement} */ (document.getElementById('showReleases')).checked = options.releases;
        const requested = payload.settings.defaultView;
        view.mode = requested === 'auto' ? (model.option === 'SPATIALE' ? '3D' : 'XY') : requested;
        for (const button of document.querySelectorAll('[data-view]')) {
          button.classList.toggle('active', button.getAttribute('data-view') === view.mode);
        }
      }
    }

    cablesToggle.hidden = !(model.cables || []).length;
    releasesToggle.hidden = !(model.articulations || []).length && !(model.eccentric || []).length;
    rebuildPhaseSelect();
    updateSummary();

    // On ne recentre qu'au premier modele : l'utilisateur garde son cadrage
    // pendant qu'il edite le fichier.
    if (!view.fitted) fit();
    draw();
  });

  vscode.postMessage({ type: 'ready' });
})();
