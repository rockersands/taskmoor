import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildVersion } from '@taskmoor/webconfig';
import { micromark } from 'micromark';
import {
  gfmAutolinkLiteral,
  gfmAutolinkLiteralHtml,
} from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethrough, gfmStrikethroughHtml } from 'micromark-extension-gfm-strikethrough';
import { gfmTable, gfmTableHtml } from 'micromark-extension-gfm-table';
import { gfmTaskListItem, gfmTaskListItemHtml } from 'micromark-extension-gfm-task-list-item';
import { anchorFor } from './docs-check';
import { readFrontMatter } from './provenance';

/** The manual's Markdown (M1-114), from the repository root. */
export const MANUAL_DIR = 'docs/manual';
/** Where `pnpm run docs` writes the offline bundle, from the repository root. */
export const MANUAL_OUT = 'dist/docs';
/** A build leaves this file in its folder, so a rebuild only ever clears its own output. */
const MARKER = '.taskmoor-docs';

export interface ManualPage {
  /** Path under the manual folder with forward slashes, such as `admin/install.md`. */
  path: string;
  /** The provenance front matter (title, audience, sources, accessed, attestation). */
  fields: Record<string, string>;
  /** The Markdown after the front matter. */
  body: string;
}

export interface ManualNav {
  title: string;
  sections: { title: string; pages: string[] }[];
}

export interface Manual {
  nav: ManualNav;
  /** Every Markdown file under the manual folder, sorted by path. */
  pages: ManualPage[];
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

/** Markdown files under a folder, as sorted forward-slash paths relative to it. */
export function manualFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...manualFiles(dir, path));
    else if (entry.name.endsWith('.md')) out.push(path);
  }
  return out.sort();
}

export function readManual(root: string, dir = MANUAL_DIR): Manual {
  const base = join(root, dir);
  const nav = JSON.parse(readFileSync(join(base, 'nav.json'), 'utf8')) as ManualNav;
  const pages = manualFiles(base).map((path) => {
    const text = readFileSync(join(base, path), 'utf8');
    const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
    return {
      path,
      fields: readFrontMatter(text) ?? {},
      body: front ? text.slice(front[0].length) : text,
    };
  });
  return { nav, pages };
}

/** The pages in navigation order; a path the nav names but no file has is left out. */
export function orderedPages(manual: Manual): ManualPage[] {
  const byPath = new Map(manual.pages.map((p) => [p.path, p]));
  return manual.nav.sections
    .flatMap((s) => s.pages)
    .flatMap((path) => {
      const page = byPath.get(path);
      return page ? [page] : [];
    });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The text of an HTML fragment: tags dropped, entities decoded, white space collapsed. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith('#x') || name.startsWith('#X')) {
        return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      }
      if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** A link between pages points at the built page: `install.md#x` becomes `install.html#x`. */
export function bundleHref(href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) {
    return href;
  }
  const hash = href.indexOf('#');
  const path = hash === -1 ? href : href.slice(0, hash);
  const anchor = hash === -1 ? '' : href.slice(hash);
  return path.endsWith('.md') ? `${path.slice(0, -3)}.html${anchor}` : href;
}

/**
 * Markdown to HTML with GitHub's tables, strikethrough, autolinks and task lists. Raw HTML in
 * the Markdown is shown as text. Headings get the same anchors the link check expects
 * (`anchorFor`), links to other pages point at their HTML, and tables scroll on their own.
 */
export function renderMarkdown(markdown: string): { html: string; headings: Heading[] } {
  const headings: Heading[] = [];
  const html = micromark(markdown, {
    extensions: [gfmTable(), gfmStrikethrough(), gfmAutolinkLiteral(), gfmTaskListItem()],
    htmlExtensions: [
      gfmTableHtml(),
      gfmStrikethroughHtml(),
      gfmAutolinkLiteralHtml(),
      gfmTaskListItemHtml(),
    ],
  })
    .replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, level: string, inner: string) => {
      const text = plainText(inner);
      const id = anchorFor(text);
      headings.push({ level: Number(level), text, id });
      return `<h${level} id="${id}">${inner}</h${level}>`;
    })
    .replace(/<a href="([^"]*)"/g, (_, href: string) => `<a href="${bundleHref(href)}"`)
    .replaceAll('<table>', '<div class="table-wrap"><table>')
    .replaceAll('</table>', '</table></div>');
  return { html, headings };
}

export interface SearchEntry {
  /** The page's path in the bundle, such as `admin/install.html`. */
  page: string;
  title: string;
  /** The section's H2, or empty for the part before the first one. */
  heading: string;
  anchor: string;
  text: string;
}

/** One search entry per section: the page's introduction, then each H2 with what follows it. */
export function searchEntries(page: string, title: string, html: string): SearchEntry[] {
  const parts = html.replace(/<h1 [\s\S]*?<\/h1>/, '').split(/(?=<h2 id=")/);
  return parts.flatMap((part) => {
    const head = /^<h2 id="([^"]*)">([\s\S]*?)<\/h2>/.exec(part);
    const text = plainText(head ? part.slice(head[0].length) : part);
    if (!head && text === '') return [];
    return [
      {
        page,
        title,
        heading: head ? plainText(head[2] ?? '') : '',
        anchor: head?.[1] ?? '',
        text,
      },
    ];
  });
}

const ASSETS = new URL('./manual-assets/', import.meta.url);
const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

interface Shell {
  siteTitle: string;
  version: string;
  css: string;
  js: string;
  csp: string;
  nav: ManualNav;
  titles: Map<string, string>;
}

const htmlPath = (path: string) => `${path.slice(0, -3)}.html`;

function navHtml(shell: Shell, current: string, rel: string): string {
  return shell.nav.sections
    .map((section) => {
      const items = section.pages
        .map((path) => {
          const here = path === current ? ' aria-current="page"' : '';
          const title = escapeHtml(shell.titles.get(path) ?? path);
          return `<li><a href="${rel}${htmlPath(path)}"${here}>${title}</a></li>`;
        })
        .join('');
      return `<h2>${escapeHtml(section.title)}</h2><ul>${items}</ul>`;
    })
    .join('\n');
}

function tocHtml(headings: Heading[]): string {
  const entries = headings.filter((h) => h.level === 2 || h.level === 3);
  if (entries.length < 2) return '';
  const items = entries
    .map((h) => `<li><a class="level-${h.level}" href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join('');
  return `<nav class="toc" aria-label="On this page"><h2>On this page</h2><ul>${items}</ul></nav>`;
}

function pagerHtml(shell: Shell, current: string, rel: string): string {
  const order = shell.nav.sections.flatMap((s) => s.pages);
  const at = order.indexOf(current);
  if (at === -1) return '';
  const link = (path: string | undefined, kind: 'prev' | 'next') => {
    if (!path) return '';
    const label = kind === 'prev' ? 'Previous' : 'Next';
    const title = escapeHtml(shell.titles.get(path) ?? path);
    return `<a class="${kind}" href="${rel}${htmlPath(path)}" rel="${kind}"><small>${label}</small>${title}</a>`;
  };
  return `<nav class="pager" aria-label="Previous and next">${link(order[at - 1], 'prev')}${link(order[at + 1], 'next')}</nav>`;
}

function documentHtml(
  shell: Shell,
  o: { title: string; rel: string; current: string; main: string; toc: string; data?: string },
): string {
  const title = o.title === shell.siteTitle ? o.title : `${o.title} · ${shell.siteTitle}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${shell.csp}">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${shell.css}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
<a class="brand" href="${o.rel}index.html">Taskmoor <span>documentation</span></a>
<button class="menu-toggle" type="button" aria-controls="site-nav" aria-expanded="false">Menu</button>
<form role="search" action="${o.rel}search.html" method="get">
<label class="visually-hidden" for="q">Search the documentation</label>
<input id="q" name="q" type="search" placeholder="Search (press /)" autocomplete="off">
</form>
</header>
<div class="layout">
<nav class="site-nav" id="site-nav" aria-label="Documentation">
${navHtml(shell, o.current, o.rel)}
</nav>
<main id="main">
${o.main}
</main>
${o.toc}
</div>
<footer>Taskmoor ${escapeHtml(shell.version)}. This manual works offline: it loads nothing from the network.</footer>
${o.data ?? ''}<script>${shell.js}</script>
</body>
</html>
`;
}

const SEARCH_PAGE = `<article>
<h1 id="search">Search</h1>
<p id="search-status" role="status" data-empty="Type in the search box to search every page." data-one="1 result for “{query}”." data-some="{count} results for “{query}”." data-none="No results for “{query}”. Try fewer or shorter words.">Searching needs JavaScript. Every page is listed in the navigation.</p>
<ol id="results" class="results"></ol>
</article>`;

/**
 * Builds the offline bundle: one HTML page per Markdown page in navigation order, keeping the
 * folder structure so relative links work from disk (file://) and from any web server, plus
 * search.html with the search index inside it. Every page carries its stylesheet and script
 * inline under a Content-Security-Policy that allows exactly those two and nothing else, so the
 * bundle makes no network request. The output is the same bytes for the same input.
 */
export function buildManual(
  root: string,
  out: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const manual = readManual(root);
  const pages = orderedPages(manual);
  const css = readFileSync(new URL('manual.css', ASSETS), 'utf8').trim();
  const js = readFileSync(new URL('manual.js', ASSETS), 'utf8').trim();
  const shell: Shell = {
    siteTitle: manual.nav.title,
    version: buildVersion(env),
    css,
    js,
    csp: `default-src 'none'; style-src ${sha256(css)}; script-src ${sha256(js)}; img-src data:; base-uri 'none'`,
    nav: manual.nav,
    titles: new Map(pages.map((p) => [p.path, p.fields.title ?? p.path])),
  };

  clearOutput(out);
  const written: string[] = [];
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), text);
    written.push(path);
  };

  const index: SearchEntry[] = [];
  for (const page of pages) {
    const { html, headings } = renderMarkdown(page.body);
    const rel = '../'.repeat(page.path.split('/').length - 1);
    const title = page.fields.title ?? page.path;
    index.push(...searchEntries(htmlPath(page.path), title, html));
    const main = `<article>\n${html}</article>\n${pagerHtml(shell, page.path, rel)}`;
    write(
      htmlPath(page.path),
      documentHtml(shell, { title, rel, current: page.path, main, toc: tocHtml(headings) }),
    );
  }
  // A JSON data block is not script: the CSP's script hash does not need to cover it.
  const data = `<script type="application/json" id="search-index">${JSON.stringify(index).replaceAll('<', '\\u003c')}</script>\n`;
  write(
    'search.html',
    documentHtml(shell, {
      title: 'Search',
      rel: '',
      current: '',
      main: SEARCH_PAGE,
      toc: '',
      data,
    }),
  );
  write(MARKER, `Built by pnpm run docs from ${MANUAL_DIR}. A rebuild replaces this folder.\n`);
  return written;
}

/** Empties the output folder, refusing a non-empty folder that an earlier build did not write. */
function clearOutput(out: string) {
  if (existsSync(out)) {
    const entries = readdirSync(out);
    if (entries.length > 0 && !entries.includes(MARKER)) {
      throw new Error(
        `${out} is not empty and was not written by pnpm run docs; choose another --out`,
      );
    }
    rmSync(out, { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
}
