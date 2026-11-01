// node tools/build/server.mjs: bundles the server into apps/server/dist/server.mjs.
//
// The workspace consumes packages from TypeScript source with extensionless imports, which
// Node cannot run directly, so the image ships one bundled ES module instead of node_modules.
// Only pg's optional native binding stays external; everything else is inlined.
//
// The bundle carries the version from TASKMOOR_VERSION, as the frontend artefact does
// (M1-105, ADR-066); `pnpm build` runs this after the frontend build and stops when the two
// disagree, so a server never ships next to a frontend of another version.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const dist = join(ROOT, 'apps', 'server', 'dist');
mkdirSync(dist, { recursive: true });

// The same rule as buildVersion in @taskmoor/webconfig, which the frontend build applies.
const version = process.env.TASKMOOR_VERSION?.trim() || '0.0.0-dev';
const manifest = join(ROOT, 'apps', 'web', 'dist', 'version.json');
if (existsSync(manifest)) {
  const web = JSON.parse(readFileSync(manifest, 'utf8')).version;
  if (web !== version) {
    console.error(`apps/web/dist is frontend ${web}, the server would be ${version}: rebuild both`);
    process.exit(1);
  }
}

// server.mjs runs the roles; cli.mjs is the operator's command line (check-upgrade, migrate).
for (const [entry, name] of [
  ['main.ts', 'server.mjs'],
  ['cli.ts', 'cli.mjs'],
]) {
  await bundle(join(ROOT, 'apps', 'server', 'src', entry), join(dist, name));
}

// The bundled embedding model (M1-078, ADR-106): its inference thread with ONNX Runtime's
// WebAssembly build inlined, the runtime's two files it loads, and the model's weights,
// vocabulary and licence. Nothing else of the 150 MB package ships; nothing is downloaded.
await bundle(
  join(ROOT, 'packages', 'ai', 'src', 'embed', 'ort-worker.mjs'),
  join(dist, 'embed-worker.mjs'),
);
const ortDist = dirname(
  createRequire(join(ROOT, 'packages', 'ai', 'package.json')).resolve(
    'onnxruntime-web/ort-wasm-simd-threaded.wasm',
  ),
);
mkdirSync(join(dist, 'ort'), { recursive: true });
for (const file of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
  copyFileSync(join(ortDist, file), join(dist, 'ort', file));
}
const model = 'all-MiniLM-L6-v2';
const modelSource = join(ROOT, 'packages', 'ai', 'models', model);
mkdirSync(join(dist, 'models', model), { recursive: true });
for (const file of ['model_qint8.onnx', 'vocab.txt', 'LICENSE', 'SOURCE.md']) {
  copyFileSync(join(modelSource, file), join(dist, 'models', model, file));
}
console.log(`${join(dist, 'models', model)}: the embedding model and its licence`);

async function bundle(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    // Maps give stack traces their source lines; the sources themselves are in the repository
    // (leaving them out keeps the image under its 400 MB budget, M1-078).
    sourcesContent: false,
    legalComments: 'linked',
    external: ['pg-native'],
    define: { __TASKMOOR_BUILD_VERSION__: JSON.stringify(version) },
    // CommonJS dependencies (pg, fastify's plugins) call require(); give the ES module one.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'info',
  });
  const kb = Math.round(statSync(outfile).size / 1024);
  console.log(`${outfile}: ${kb} KB, version ${version}`);
}
