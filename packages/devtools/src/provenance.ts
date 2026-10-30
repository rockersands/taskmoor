import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REQUIRED_KEYS = ['spec', 'title', 'sources', 'accessed', 'attestation'] as const;

/**
 * Reads simple `key: value` front matter between `---` lines at the top of a Markdown file.
 * Values may be wrapped in double quotes. Returns undefined when there is no front matter.
 */
export function readFrontMatter(markdown: string): Record<string, string> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv?.[1]) continue;
    let value = (kv[2] ?? '').trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replaceAll('\\"', '"');
    }
    fields[kv[1]] = value;
  }
  return fields;
}

/**
 * Clean-room provenance rule (ADR-003, M0-006): every spec names its sources, when they were
 * read, and attests that it is written in our own words.
 */
export function checkSpecProvenance(
  root: string,
  file: string,
  today = new Date().toISOString().slice(0, 10),
): string[] {
  const fm = readFrontMatter(readFileSync(join(root, file), 'utf8'));
  if (!fm) return [`${file}: no provenance front matter`];
  const problems: string[] = [];
  for (const key of REQUIRED_KEYS) {
    if (!fm[key]) problems.push(`${file}: front matter has no "${key}"`);
  }
  problems.push(...checkAccessedAndAttestation(file, fm, today));
  if (fm.sources && !/^https?:\/\//.test(fm.sources) && !existsSync(join(root, fm.sources))) {
    problems.push(`${file}: sources file ${fm.sources} does not exist`);
  }
  return problems;
}

export function checkAllSpecs(root: string, dir = 'docs/specs'): string[] {
  return readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.md'))
    .flatMap((f) => checkSpecProvenance(root, `${dir}/${f}`));
}

function checkAccessedAndAttestation(
  file: string,
  fm: Record<string, string>,
  today: string,
): string[] {
  const problems: string[] = [];
  if (fm.accessed && !/^\d{4}-\d{2}-\d{2}$/.test(fm.accessed)) {
    problems.push(`${file}: "accessed" must be a YYYY-MM-DD date`);
  } else if (fm.accessed && fm.accessed > today) {
    problems.push(`${file}: "accessed" is in the future`);
  }
  if (fm.attestation && fm.attestation !== 'own-words') {
    problems.push(`${file}: "attestation" must be own-words`);
  }
  return problems;
}

export const MANUAL_KEYS = ['title', 'audience', 'sources', 'accessed', 'attestation'] as const;
export const AUDIENCES = new Set(['admins', 'users', 'everyone']);

/** Sites the manual never cites: it is written from our own specs and code (ADR-003). */
const ATLASSIAN_HOST = /(^|\.)(atlassian\.(com|net|design)|jira\.com|bitbucket\.org|trello\.com)$/i;

export function isAtlassianUrl(url: string): boolean {
  try {
    return ATLASSIAN_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Clean-room provenance for a page of the manual (M1-114, ADR-003): it names its audience, the
 * repository files and public non-Atlassian pages it was written from (comma-separated), when
 * they were read, and attests that it is in our own words. Its H1 repeats its title.
 */
export function checkManualProvenance(
  root: string,
  file: string,
  today = new Date().toISOString().slice(0, 10),
): string[] {
  const text = readFileSync(join(root, file), 'utf8');
  const fm = readFrontMatter(text);
  if (!fm) return [`${file}: no provenance front matter`];
  const problems: string[] = [];
  for (const key of MANUAL_KEYS) {
    if (!fm[key]) problems.push(`${file}: front matter has no "${key}"`);
  }
  if (fm.audience && !AUDIENCES.has(fm.audience)) {
    problems.push(`${file}: "audience" must be one of ${[...AUDIENCES].join(', ')}`);
  }
  problems.push(...checkAccessedAndAttestation(file, fm, today));
  for (const source of (fm.sources ?? '').split(',').map((s) => s.trim())) {
    if (source === '') continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
      if (!source.startsWith('https://')) {
        problems.push(`${file}: source ${source} is not an https URL`);
      } else if (isAtlassianUrl(source)) {
        problems.push(`${file}: source ${source} is an Atlassian page; cite our specs instead`);
      }
    } else if (!existsSync(join(root, source))) {
      problems.push(`${file}: source ${source} does not exist`);
    }
  }
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text)?.[0] ?? '';
  const firstLine = text
    .slice(front.length)
    .split(/\r?\n/)
    .find((line) => line.trim() !== '');
  if (fm.title && firstLine?.trim() !== `# ${fm.title}`) {
    problems.push(`${file}: the first heading must be "# ${fm.title}"`);
  }
  return problems;
}
