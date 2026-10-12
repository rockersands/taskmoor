// pnpm status-report [--date YYYY-MM-DD] [--ci "<one line>"]: writes docs/status/<date>.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildStatusReport, loadStatusInputs } from '../status-report';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const { values } = parseArgs({
  options: {
    date: { type: 'string', default: new Date().toISOString().slice(0, 10) },
    ci: { type: 'string' },
  },
});

const text = buildStatusReport(loadStatusInputs(ROOT, values.date, values.ci));
const dir = join(ROOT, 'docs', 'status');
mkdirSync(dir, { recursive: true });
const path = join(dir, `${values.date}.md`);
writeFileSync(path, text);
console.log(`Wrote docs/status/${values.date}.md`);
