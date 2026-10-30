// pnpm i18n:check
//
// Lists every hard-coded user-facing string in the web app's components (M1-116; NFR-006):
// text between JSX tags and literal attributes people read. Exit code 1 on any finding.

import { fileURLToPath } from 'node:url';
import { checkWebStrings } from '../i18n-check';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const findings = checkWebStrings(ROOT);
for (const f of findings) process.stdout.write(`${f.file}:${f.line}  ${f.text}\n`);
process.stdout.write(
  findings.length === 0
    ? 'No hard-coded strings: every text comes from the catalogue.\n'
    : `${findings.length} hard-coded string(s). Add an ID to messages.en.ts and read it with useT().\n`,
);
if (findings.length > 0) process.exitCode = 1;
