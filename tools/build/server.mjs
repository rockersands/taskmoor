// node tools/build/server.mjs: bundles the server into apps/server/dist/server.mjs.
//
// The workspace consumes packages from TypeScript source with extensionless imports, which
// Node cannot run directly, so the image ships one bundled ES module instead of node_modules.
// Only pg's optional native binding stays external; everything else is inlined.

import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const outfile = join(ROOT, 'apps', 'server', 'dist', 'server.mjs');
mkdirSync(join(ROOT, 'apps', 'server', 'dist'), { recursive: true });

await build({
  entryPoints: [join(ROOT, 'apps', 'server', 'src', 'main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'linked',
  external: ['pg-native'],
  // CommonJS dependencies (pg, fastify's plugins) call require(); give the ES module one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});

const kb = Math.round(statSync(outfile).size / 1024);
console.log(`apps/server/dist/server.mjs: ${kb} KB`);
