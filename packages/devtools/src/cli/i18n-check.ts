// pnpm i18n:check
//
// Lists every hard-coded user-facing string in the web app's components (M1-116; NFR-006):
// text between JSX tags and literal attributes people read. Then every English message that
// breaks the catalogue's house style: a straight apostrophe or an American spelling. Exit code 1
// on any finding.

import { fileURLToPath } from 'node:url';
import { checkCatalogueStyle, checkWebStrings } from '../i18n-check';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const findings = checkWebStrings(ROOT);
for (const f of findings) process.stdout.write(`${f.file}:${f.line}  ${f.text}\n`);
process.stdout.write(
  findings.length === 0
    ? 'No hard-coded strings: every text comes from the catalogue.\n'
    : `${findings.length} hard-coded string(s). Add an ID to messages.en.ts and read it with useT().\n`,
);
const style = checkCatalogueStyle(ROOT);
for (const f of style) process.stdout.write(`${f.file}:${f.line}  ${f.text}\n`);
process.stdout.write(
  style.length === 0
    ? 'The English catalogue keeps its house style: curly apostrophes and British spellings.\n'
    : `${style.length} English message(s) off the house style. Use ’ and the British spelling.\n`,
);
if (findings.length > 0 || style.length > 0) process.exitCode = 1;
