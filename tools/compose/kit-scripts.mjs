#!/usr/bin/env node
// The Builder's backend kit carries the same update scripts as deploy/compose (OPS-025, ADR-117).
// The Builder runs in a browser and reads no files, so this writes them into a TypeScript module:
//   node tools/compose/kit-scripts.mjs
// packages/builder-core/src/backend.test.ts fails when the module and the files differ.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const literal = (text) =>
  `\`${text.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${')}\``;

const module = `// Written by tools/compose/kit-scripts.mjs from deploy/compose and tools/airgap; do not edit.
// The backend kit's update scripts are these same files (OPS-025, ADR-117).

export const UPGRADE_SH = ${literal(read('deploy/compose/upgrade.sh'))};

export const UPDATE_SH = ${literal(read('deploy/compose/update.sh'))};

/** The public half of the release key: what update.sh checks a release against. */
export const RELEASE_PUBLIC_KEY = ${literal(read('tools/airgap/taskmoor-release.pub'))};
`;
writeFileSync(join(root, 'packages/builder-core/src/kit-scripts.ts'), module);
