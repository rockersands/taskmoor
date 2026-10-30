import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { anchorFor, headings } from './docs-check';
import { MANUAL_DIR, type Manual, readManual } from './manual';
import { checkManualProvenance, isAtlassianUrl } from './provenance';

/**
 * Atlassian's names for structural concepts, which the manual replaces with Taskmoor's own
 * (docs/specs/00-terminology.md). "Jira" itself is allowed only as "Jira-compatible". A page
 * that must use Jira's names (the importer's mapping, the Jira-compatible dialect) says why in
 * its front matter: `jira-names: <reason>`.
 */
const ATLASSIAN_TERMS =
  /\b(jira(?!-compatible)|atlassian|confluence|rovo|jql|epics?|story points?|issue types?|sub-tasks?|work items?|work types?|post functions?|quick filters?|gadgets?|fix versions?|affects versions?|permission schemes?|issue security|watchers?)\b/gi;

/** Markdown with fenced code blocks (in list items too) blanked out, keeping line numbers. */
function withoutFences(markdown: string): string {
  return markdown.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** The nav lists every page exactly once, starts with index.md and names no missing file. */
export function checkManualNav(manual: Manual): string[] {
  const problems: string[] = [];
  const listed = manual.nav.sections.flatMap((s) => s.pages);
  const files = new Set(manual.pages.map((p) => p.path));
  if (listed[0] !== 'index.md') problems.push(`${MANUAL_DIR}/nav.json must start with index.md`);
  const seen = new Set<string>();
  for (const path of listed) {
    if (seen.has(path)) problems.push(`${MANUAL_DIR}/nav.json lists ${path} twice`);
    seen.add(path);
    if (!files.has(path)) problems.push(`${MANUAL_DIR}/nav.json lists missing page ${path}`);
  }
  for (const path of files) {
    if (!seen.has(path)) problems.push(`${MANUAL_DIR}/${path} is not in nav.json`);
  }
  return problems;
}

/** Taskmoor's own terms (ADR-003): no Atlassian names unless the page declares why. */
export function checkManualTerms(manual: Manual): string[] {
  const problems: string[] = [];
  for (const page of manual.pages) {
    if (page.fields['jira-names']) continue;
    for (const match of page.body.matchAll(ATLASSIAN_TERMS)) {
      problems.push(
        `${MANUAL_DIR}/${page.path}:${lineOf(page.body, match.index)}: "${match[0]}" is not a Taskmoor term (docs/specs/00-terminology.md; jira-names in the front matter if the page needs Jira's names)`,
      );
    }
  }
  return problems;
}

/** One H1, unique heading anchors, and a language on every code block. */
export function checkManualStructure(manual: Manual): string[] {
  const problems: string[] = [];
  for (const page of manual.pages) {
    const where = `${MANUAL_DIR}/${page.path}`;
    const titles = headings(withoutFences(page.body));
    const ones = (withoutFences(page.body).match(/^# /gm) ?? []).length;
    if (ones !== 1) problems.push(`${where}: has ${ones} H1 headings; use exactly one`);
    const seen = new Set<string>();
    for (const title of titles) {
      const anchor = anchorFor(title);
      if (seen.has(anchor)) problems.push(`${where}: two headings share the anchor #${anchor}`);
      seen.add(anchor);
    }
    let open: string | undefined;
    for (const [index, line] of page.body.split('\n').entries()) {
      const fence = /^[ \t]*(`{3,}|~{3,})\s*(\S*)/.exec(line);
      if (!fence) continue;
      if (open === undefined) {
        open = fence[1];
        if (!fence[2]) problems.push(`${where}:${index + 1}: code block without a language`);
      } else if (fence[1] === open && !fence[2]) {
        open = undefined;
      }
    }
  }
  return problems;
}

export interface ExternalLink {
  url: string;
  pages: string[];
}

const LINK = /!?\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;
const BARE_URL = /<?(https?:\/\/[^\s)<>`]+[^\s)<>`.,;:!?'"])>?/g;

/**
 * Links between pages: each stays inside the manual (the bundle holds nothing else), names a
 * page, and an anchor that page has. Images are not bundled. Atlassian pages are not linked.
 */
export function checkManualLinks(manual: Manual): string[] {
  const problems: string[] = [];
  const anchors = new Map(
    manual.pages.map((p) => [p.path, new Set(headings(withoutFences(p.body)).map(anchorFor))]),
  );
  for (const page of manual.pages) {
    const where = `${MANUAL_DIR}/${page.path}`;
    const text = withoutFences(page.body).replace(/`[^`\n]*`/g, (code) => ' '.repeat(code.length));
    for (const match of text.matchAll(LINK)) {
      const target = match[1] ?? '';
      const at = `${where}:${lineOf(text, match.index)}`;
      if (match[0].startsWith('!')) {
        problems.push(`${at}: images are not bundled (${target})`);
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        if (isAtlassianUrl(target) && !page.fields['jira-names']) {
          problems.push(`${at}: links to an Atlassian page (${target})`);
        }
        continue;
      }
      const hash = target.indexOf('#');
      const path = hash === -1 ? target : target.slice(0, hash);
      const anchor = hash === -1 ? '' : target.slice(hash + 1);
      const resolved =
        path === ''
          ? page.path
          : posix.normalize(posix.join(posix.dirname(page.path), decodeURI(path)));
      if (resolved.startsWith('../') || !resolved.endsWith('.md')) {
        problems.push(
          `${at}: links outside the manual (${target}); the bundle holds only its pages`,
        );
        continue;
      }
      const set = anchors.get(resolved);
      if (!set) problems.push(`${at}: links to missing page ${target}`);
      else if (anchor && !set.has(anchor))
        problems.push(`${at}: links to missing heading ${target}`);
    }
  }
  return problems;
}

/** Every external URL the manual links to, with the pages that link it. Never fetched. */
export function manualExternalLinks(manual: Manual): ExternalLink[] {
  const found = new Map<string, Set<string>>();
  for (const page of manual.pages) {
    const text = withoutFences(page.body).replace(/`[^`\n]*`/g, '');
    const urls = [
      ...[...text.matchAll(LINK)].map((m) => m[1] ?? ''),
      ...[...text.replace(LINK, '').matchAll(BARE_URL)].map((m) => m[1] ?? ''),
    ].filter((url) => /^https?:\/\//i.test(url));
    for (const url of urls) {
      const pages = found.get(url) ?? new Set<string>();
      pages.add(page.path);
      found.set(url, pages);
    }
  }
  return [...found]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([url, pages]) => ({ url, pages: [...pages].sort() }));
}

/** Everything `pnpm verify` and `pnpm run docs` require of the manual's sources. */
export function checkManual(root: string, today?: string): string[] {
  const manual = readManual(root);
  return [
    ...checkManualNav(manual),
    ...manual.pages.flatMap((p) => checkManualProvenance(root, `${MANUAL_DIR}/${p.path}`, today)),
    ...checkManualStructure(manual),
    ...checkManualTerms(manual),
    ...checkManualLinks(manual),
  ];
}

function htmlFiles(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix)).flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(dir, path)).isDirectory()) return htmlFiles(dir, path);
    return name.endsWith('.html') ? [path] : [];
  });
}

/**
 * Checks a built bundle as a browser would see it: every page has a CSP that blocks the
 * network, nothing loads a resource (no script, stylesheet, image, frame or font from any
 * address), scripts make no requests, and every relative link and anchor resolves inside the
 * bundle.
 */
export function checkBundle(out: string): string[] {
  const problems: string[] = [];
  const files = htmlFiles(out);
  const ids = new Map(
    files.map((f) => {
      const html = readFileSync(join(out, f), 'utf8');
      return [f, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ''))];
    }),
  );
  for (const file of files) {
    const html = readFileSync(join(out, file), 'utf8');
    if (!/<meta http-equiv="Content-Security-Policy" content="default-src 'none';/.test(html)) {
      problems.push(`${file}: no Content-Security-Policy that blocks the network`);
    }
    for (const m of html.matchAll(
      /<(script|link|img|iframe|frame|object|embed|source|audio|video|track|image|use)\b[^>]*\s(src|href|data|srcset|poster)=/gi,
    )) {
      problems.push(`${file}: <${m[1]}> loads a resource; the bundle inlines everything`);
    }
    for (const style of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
      if (/url\(|@import|@font-face/i.test(style[1] ?? '')) {
        problems.push(`${file}: the stylesheet loads a resource`);
      }
    }
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      if (
        /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b|import\(/.test(
          script[1] ?? '',
        )
      ) {
        problems.push(`${file}: a script can make network requests`);
      }
    }
    for (const m of html.matchAll(/<(?:a|form)\b[^>]*\s(?:href|action)="([^"]*)"/g)) {
      const target = m[1] ?? '';
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      if (target.startsWith('//')) {
        problems.push(`${file}: protocol-relative link ${target}`);
        continue;
      }
      const hash = target.indexOf('#');
      const path = hash === -1 ? target : target.slice(0, hash);
      const anchor = hash === -1 ? '' : target.slice(hash + 1);
      const resolved = path === '' ? file : posix.normalize(posix.join(posix.dirname(file), path));
      const targetIds = ids.get(resolved);
      if (!targetIds) problems.push(`${file}: link to missing file ${target}`);
      else if (anchor && !targetIds.has(anchor))
        problems.push(`${file}: link to missing anchor ${target}`);
    }
  }
  return problems;
}

/** The bundle's size in bytes, for the CLI's summary. */
export function bundleSize(out: string): number {
  const walk = (dir: string): number =>
    readdirSync(dir).reduce((sum, name) => {
      const path = join(dir, name);
      return sum + (statSync(path).isDirectory() ? walk(path) : statSync(path).size);
    }, 0);
  return existsSync(out) ? walk(out) : 0;
}
