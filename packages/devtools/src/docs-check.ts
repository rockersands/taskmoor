import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** Headings each governance file must keep, so every session finds the same structure. */
export const REQUIRED_SECTIONS: Record<string, string[]> = {
  'CLAUDE.md': [
    'Identity (non-negotiable)',
    'Commands',
    'Definition of done',
    'Layout',
    'Conventions',
    'Clean room (ADR-003)',
  ],
  'HANDOFF.md': ['Done', 'Next (in order)', 'Waiting on the user'],
  'STATUS.md': ['Milestones', 'M0 tasks'],
};

export function headings(markdown: string): string[] {
  return [...markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => (m[1] ?? '').trim());
}

/** Lists missing governance files and missing required sections. */
export function checkGovernance(root: string): string[] {
  const problems: string[] = [];
  for (const [file, sections] of Object.entries(REQUIRED_SECTIONS)) {
    const path = join(root, file);
    if (!existsSync(path)) {
      problems.push(`${file} is missing`);
      continue;
    }
    const found = new Set(headings(readFileSync(path, 'utf8')));
    for (const section of sections) {
      if (!found.has(section)) problems.push(`${file} has no "${section}" section`);
    }
  }
  return problems;
}

// `.claude` holds the agents' worktrees: other checkouts, each checked in its own run.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.verify',
  'dist',
  '.tsbuild',
  '.claude',
]);

export function markdownFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...markdownFiles(root, path));
    else if (name.endsWith('.md')) out.push(path);
  }
  return out;
}

/** GitHub-style heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function anchorFor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/**
 * Finds relative links in Markdown files that point at missing files or missing headings.
 * External links are not fetched; tests never use the network.
 */
export function findBrokenLinks(root: string, files = markdownFiles(root)): string[] {
  const problems: string[] = [];
  const anchorCache = new Map<string, Set<string>>();
  const anchorsOf = (path: string) => {
    let set = anchorCache.get(path);
    if (!set) {
      set = new Set(headings(readFileSync(path, 'utf8')).map(anchorFor));
      anchorCache.set(path, set);
    }
    return set;
  };

  for (const file of files) {
    const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1] ?? '';
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:
      const [pathPart = '', anchor] = target.split('#');
      const resolved = pathPart === '' ? file : resolve(dirname(file), decodeURI(pathPart));
      const where = relative(root, file).replaceAll('\\', '/');
      if (!existsSync(resolved)) {
        problems.push(`${where}: link to missing file ${target}`);
        continue;
      }
      if (anchor && resolved.endsWith('.md') && !anchorsOf(resolved).has(anchor)) {
        problems.push(`${where}: link to missing heading ${target}`);
      }
    }
  }
  return problems;
}

/** Every ADR file is listed in docs/adr/README.md with a matching status, and vice versa. */
export function checkAdrIndex(root: string): string[] {
  const dir = join(root, 'docs', 'adr');
  const index = readFileSync(join(dir, 'README.md'), 'utf8');
  const problems: string[] = [];
  const files = readdirSync(dir).filter((f) => /^\d{4}-.+\.md$/.test(f));
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    const status = /^- Status: (\w+)/m.exec(text)?.[1];
    if (!status) problems.push(`${file} has no "- Status:" line`);
    const row = index.split('\n').find((line) => line.includes(`(${file})`));
    if (!row) problems.push(`${file} is not listed in docs/adr/README.md`);
    else if (status && !row.includes(`| ${status} |`)) {
      problems.push(
        `docs/adr/README.md shows a different status for ${file} (file says ${status})`,
      );
    }
  }
  return problems;
}
