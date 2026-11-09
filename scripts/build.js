// Bundles src/extension.js (with acorn, acorn-walk and sucrase) into dist/extension.js and copies the child
// process files (runtime.cjs, loader.mjs) to dist/runtime unchanged: they run in the user's process, not here.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

async function main() {
  const production = process.argv.includes('--production');
  const rt = path.join(root, 'dist', 'runtime');
  fs.mkdirSync(rt, { recursive: true });
  for (const f of ['runtime.cjs', 'loader.mjs']) fs.copyFileSync(path.join(root, 'src', 'runtime', f), path.join(rt, f));
  await esbuild.build({
    entryPoints: { extension: path.join(root, 'src/extension.js'), 'instrument-worker': path.join(root, 'src/core/instrument-worker.js') },
    bundle: true,
    outdir: path.join(root, 'dist'),
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
    minify: production,
    sourcemap: false,
    legalComments: 'external',
    logLevel: 'warning',
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
