// pnpm builder --project <file> [--web apps/web/dist] [--out kits] [--seed <seed>]
//               [--passphrase-env <NAME>] [--version <x.y.z>] [--image <repository>]
//               (--version defaults to the web build's own, from its version.json)
// pnpm builder --backend-url <url> --frontend-url <url> [--routing path|hash] [...]
//               (no project file: defaults; hash routing for a host without rewrites)
//
// The Taskmoor Builder on the command line (OPS-016): the backend kit's core and the frontend
// kit (zip and single file) from a project file. A seed makes the run reproducible; a
// passphrase (read from the environment variable named, never from the command line) opens
// secrets the project keeps encrypted.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { saveProject, validateInputs, webBuildVersion } from '@taskmoor/builder-core';
import { readTree, runBuilder } from '../builder';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    web: { type: 'string', default: `${ROOT}apps/web/dist` },
    out: { type: 'string', default: 'kits' },
    seed: { type: 'string' },
    'passphrase-env': { type: 'string' },
    version: { type: 'string' },
    image: { type: 'string' },
    'backend-url': { type: 'string' },
    'frontend-url': { type: 'string' },
    /** `hash` for a plain static host that cannot send deep links to index.html (M1-113). */
    routing: { type: 'string' },
  },
});
// The kits are for the version of the web build they carry, as the Builder page's are (M1-112).
const version =
  values.version ??
  webBuildVersion(readTree(values.web)) ??
  process.env.TASKMOOR_VERSION ??
  '0.0.0-dev';
let project = values.project ? readFileSync(values.project, 'utf8') : '';
if (!project) {
  const form = validateInputs({
    backendUrl: values['backend-url'],
    frontendUrl: values['frontend-url'],
    ...(values.routing ? { routing: values.routing } : {}),
  });
  if (!form.ok) {
    for (const p of form.problems) process.stderr.write(`${p.field}: ${p.message}\n`);
    process.stderr.write(
      'Name a project file (--project) or both URLs (--backend-url, --frontend-url).\n',
    );
    process.exit(2);
  }
  project = await saveProject(form.inputs, { builderVersion: version });
}
const passphraseEnv = values['passphrase-env'];
const out = await runBuilder({
  project,
  ...(values.image ? { image: values.image } : {}),
  webDir: values.web,
  outDir: values.out,
  ...(values.seed ? { seed: values.seed } : {}),
  ...(passphraseEnv ? { passphrase: process.env[passphraseEnv] ?? '' } : {}),
  versions: { backendVersion: version, kitVersion: version },
});
for (const path of Object.values(out)) process.stdout.write(`wrote ${path}\n`);
