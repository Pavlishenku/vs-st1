// Build de l'extension et du serveur de langage (esbuild).
//
// Deux bundles CJS distincts : l'extension host et le serveur, qui tournent
// dans deux process. `vscode` est fourni par l'hote, jamais bundle.

import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { globSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const tests = process.argv.includes('--tests');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
  absWorkingDir: root,
};

// Les tests sont bundles en ESM pour etre executables par `node --test` : le
// code partage est ecrit en TypeScript et n'est pas transpilable directement.
if (tests) {
  await build({
    ...common,
    entryPoints: globSync('test/*.test.ts', { cwd: root }),
    outdir: 'dist/test',
    outExtension: { '.js': '.mjs' },
    format: 'esm',
    sourcemap: 'inline',
    minify: false,
    bundle: true,
    // Le module `vscode` n'existe qu'a l'interieur de VS Code : les tests du
    // code host (`src/`) passent par une doublure minimale.
    alias: { vscode: resolve(root, 'test/stubs/vscode.ts') },
  });
  console.log('Tests compiles dans dist/test.');
  process.exit(0);
}

const targets = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['server/src/server.ts'], outfile: 'dist/server.js', external: ['vscode'] },
];

if (watch) {
  const contexts = await Promise.all(targets.map((options) => context(options)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('Build incremental actif — Ctrl+C pour arreter.');
} else {
  await Promise.all(targets.map((options) => build(options)));
  console.log(`Build ${production ? 'production' : 'developpement'} termine.`);
}
