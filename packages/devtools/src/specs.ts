import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsvRecords } from './csv';

export interface Requirement {
  id: string;
  title: string;
  milestone: string;
  priority: 'M' | 'S' | 'C';
  file: string;
}

export const REQUIREMENT_ID = /^[A-Z]{2,5}-\d{3}$/;
const PRIORITY_WORDS: Record<string, Requirement['priority']> = {
  Must: 'M',
  Should: 'S',
  Could: 'C',
};

/** Splits a Markdown table row into trimmed cells, honouring escaped pipes. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

/**
 * Reads requirement rows from a spec file: table rows whose first cell is an ID, in the
 * `| ID | Requirement | Acceptance criteria | MS | Pri | Source |` layout.
 */
export function parseRequirements(file: string, markdown: string): Requirement[] {
  const out: Requirement[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const row = cells(line);
    const id = row[0] ?? '';
    if (!REQUIREMENT_ID.test(id)) continue;
    const title = /\*\*(.+?)\.?\*\*/.exec(row[1] ?? '')?.[1] ?? '';
    out.push({
      id,
      title,
      milestone: row[3] ?? '',
      priority: (row[4] ?? '') as Requirement['priority'],
      file,
    });
  }
  return out;
}

export function loadRequirements(root: string, dir = 'docs/specs'): Requirement[] {
  return readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .flatMap((f) => parseRequirements(`${dir}/${f}`, readFileSync(join(root, dir, f), 'utf8')));
}

/**
 * Spec lint (M0-013): unique IDs, valid milestone and priority, acceptance criteria present,
 * and the CSV index in step with the spec files.
 */
export function lintSpecs(root: string, dir = 'docs/specs'): string[] {
  const problems: string[] = [];
  const requirements = loadRequirements(root, dir);
  const byId = new Map<string, Requirement>();

  for (const r of requirements) {
    if (byId.has(r.id))
      problems.push(`${r.id} is defined twice (${byId.get(r.id)?.file}, ${r.file})`);
    byId.set(r.id, r);
    if (!/^M[1-4]$/.test(r.milestone))
      problems.push(`${r.id}: milestone "${r.milestone}" is not M1-M4`);
    if (!['M', 'S', 'C'].includes(r.priority))
      problems.push(`${r.id}: priority "${r.priority}" is not M, S or C`);
    if (!r.title) problems.push(`${r.id}: requirement text has no bold title`);
  }

  const raw = readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.md'))
    .map((f) => readFileSync(join(root, dir, f), 'utf8'))
    .join('\n');
  for (const line of raw.split(/\r?\n/)) {
    const row = line.startsWith('|') ? cells(line) : [];
    if (row[0] && REQUIREMENT_ID.test(row[0]) && !/\(1\)/.test(row[2] ?? '')) {
      problems.push(`${row[0]}: acceptance criteria are not numbered (1), (2), ...`);
    }
  }

  const index = parseCsvRecords(readFileSync(join(root, dir, 'requirements-index.csv'), 'utf8'));
  const indexed = new Set<string>();
  for (const row of index) {
    const id = row.ID ?? '';
    indexed.add(id);
    const spec = byId.get(id);
    if (!spec) {
      problems.push(`requirements-index.csv lists ${id}, which no spec defines`);
      continue;
    }
    if (row.Milestone !== spec.milestone) {
      problems.push(`${id}: index says ${row.Milestone}, spec says ${spec.milestone}`);
    }
    if (PRIORITY_WORDS[row.Priority ?? ''] !== spec.priority) {
      problems.push(`${id}: index priority ${row.Priority} does not match spec ${spec.priority}`);
    }
  }
  for (const id of byId.keys()) {
    if (!indexed.has(id)) problems.push(`${id} is missing from requirements-index.csv`);
  }
  return problems;
}
