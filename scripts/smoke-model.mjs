// Essai de l'extracteur de modele sur un corpus de fichiers reels.
// Usage : node scripts/smoke-model.mjs <dossier>
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = join(mkdtempSync(join(tmpdir(), 'st1-smoke-')), 'bundle.mjs');
await build({
  stdin: {
    contents: `
      export { parse } from './shared/parser.js';
      export { buildModel } from './shared/model.js';
      export { buildIndex } from './shared/catalog.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
});
const { parse, buildModel, buildIndex } = await import(pathToFileURL(out));
const index = buildIndex(JSON.parse(readFileSync('catalog/st1-catalog.json', 'utf8')));

const dir = process.argv[2];
for (const name of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.st1'))) {
  const file = join(dir, name);
  const text = readFileSync(file, 'latin1');
  const document = parse(text, index);
  const model = buildModel(document, {
    index,
    file,
    resolve: (f, from) => {
      try {
        const target = join(from ? dirname(from) : dir, f);
        return { document: parse(readFileSync(target, 'latin1'), index), file: target };
      } catch {
        return null;
      }
    },
  });
  const unresolved = [...model.bars.values()].filter((b) => !model.nodes.has(b.from) || !model.nodes.has(b.to)).length;
  console.log(
    name.padEnd(15),
    `noeuds=${String(model.nodes.size).padStart(4)}`,
    `barres=${String(model.bars.size).padStart(4)}`,
    `appuis=${String(model.supports.length).padStart(3)}`,
    `cables=${model.cables.length}`,
    `pts=${model.cables.reduce((s, c) => s + c.points.length, 0)}`,
    `phasages=${model.phasages.length}`,
    `etats=${model.phasages.reduce((s, p) => s + p.states.length, 0)}`,
    `barres-sans-noeud=${unresolved}`,
    model.truncated ? 'TRONQUE' : '',
  );
}
