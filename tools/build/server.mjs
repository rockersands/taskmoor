// node tools/build/server.mjs: bundles the server into apps/server/dist/server.mjs.
//
// The workspace consumes packages from TypeScript source with extensionless imports, which
// Node cannot run directly, so the image ships one bundled ES module instead of node_modules.
// Only pg's optional native binding stays external; everything else is inlined.
//
// The bundle carries the version from TASKMOOR_VERSION, as the frontend artefact does
// (M1-105, ADR-066); `pnpm build` runs this after the frontend build and stops when the two
// disagree, so a server never ships next to a frontend of another version.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

async function bundle(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
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
