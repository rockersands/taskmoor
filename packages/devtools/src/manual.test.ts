import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableJson } from '@taskmoor/testkit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildManual,
  bundleHref,
  orderedPages,
  plainText,
  readManual,
  renderMarkdown,
  type SearchEntry,
  searchEntries,
} from './manual';
import {
  checkBundle,
  checkManual,
  checkManualLinks,
  checkManualNav,
  checkManualStructure,
  checkManualTerms,
  manualExternalLinks,
} from './manual-check';
import { checkManualProvenance } from './provenance';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

describe('the manual in docs/manual', () => {
  let out: string;
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), 'ts-manual-'));
    buildManual(REPO, out, { TASKMOOR_VERSION: '1.2.3' });
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('has provenance on every page, Taskmoor terms, and links and anchors that resolve', () => {
    expect(checkManual(REPO)).toEqual([]);
  });

  it('lists its external links, which are never fetched', async () => {
    await expect(stableJson(manualExternalLinks(readManual(REPO)))).toMatchFileSnapshot(
      './__golden__/manual-external-links.json',
    );
  });

  it('builds a bundle that loads nothing from the network and whose links all resolve', () => {
    expect(checkBundle(out)).toEqual([]);
  });

  it('builds a page for every page in the navigation, and search covers them all', () => {
    const manual = readManual(REPO);
    const pages = orderedPages(manual).map((p) => p.path.replace(/\.md$/, '.html'));
    expect(pages.length).toBe(manual.pages.length);
    for (const page of pages) expect(readFileSync(join(out, page), 'utf8')).toContain('<main');
    const search = readFileSync(join(out, 'search.html'), 'utf8');
    const json = /<script type="application\/json" id="search-index">([\s\S]*?)<\/script>/.exec(
      search,
    )?.[1];
    const index = JSON.parse(json ?? '[]') as SearchEntry[];
    expect(new Set(index.map((e) => e.page))).toEqual(new Set(pages));
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('Taskmoor 1.2.3');
  });

  it('builds the same bytes from the same input', () => {
    const again = mkdtempSync(join(tmpdir(), 'ts-manual-'));
    try {
      const files = buildManual(REPO, again, { TASKMOOR_VERSION: '1.2.3' });
      for (const file of files) {
        expect(readFileSync(join(again, file), 'utf8'), file).toBe(
          readFileSync(join(out, file), 'utf8'),
        );
      }
    } finally {
      rmSync(again, { recursive: true, force: true });
    }
  });
});

describe('rendering', () => {
  it('gives headings the anchors the link check expects and points links at HTML pages', () => {
    const { html, headings } = renderMarkdown(
      [
        '# Backups & restore',
        '## Use `cli.mjs backup`',
        'See [upgrades](../admin/upgrades.md#rolling-back), [here](#use-climjs-backup) and',
        '[the RFC](https://www.rfc-editor.org/rfc/rfc7644).',
        '',
        '| A | B |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '<script>alert(1)</script>',
      ].join('\n'),
    );
    expect(headings).toEqual([
      { level: 1, text: 'Backups & restore', id: 'backups--restore' },
      { level: 2, text: 'Use cli.mjs backup', id: 'use-climjs-backup' },
    ]);
    expect(html).toContain('<h2 id="use-climjs-backup">Use <code>cli.mjs backup</code></h2>');
    expect(html).toContain('href="../admin/upgrades.html#rolling-back"');
    expect(html).toContain('href="#use-climjs-backup"');
    expect(html).toContain('href="https://www.rfc-editor.org/rfc/rfc7644"');
    expect(html).toContain('<div class="table-wrap"><table>');
    expect(html).not.toContain('<script>');
  });

  it('rewrites only links between pages', () => {
    expect(bundleHref('install.md')).toBe('install.html');
    expect(bundleHref('../use/search.md#operators')).toBe('../use/search.html#operators');
    expect(bundleHref('https://example.com/a.md')).toBe('https://example.com/a.md');
    expect(bundleHref('#here')).toBe('#here');
  });

  it('splits a page into search entries by section', () => {
    const { html } = renderMarkdown('# T\nIntro text.\n## First\nOne &amp; two.\n## Second\nMore.');
    expect(searchEntries('t.html', 'T', html)).toEqual([
      { page: 't.html', title: 'T', heading: '', anchor: '', text: 'Intro text.' },
      { page: 't.html', title: 'T', heading: 'First', anchor: 'first', text: 'One & two.' },
      { page: 't.html', title: 'T', heading: 'Second', anchor: 'second', text: 'More.' },
    ]);
    expect(plainText('<p>a&lt;b &#x41; &#66;</p>')).toBe('a<b A B');
  });
});

describe('checks catch problems', () => {
  let dir: string;
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const page = (title: string, body: string, extra = '') =>
    [
      '---',
      `title: "${title}"`,
      'audience: admins',
      'sources: docs/specs/a.md, https://www.rfc-editor.org/rfc/rfc7644',
      'accessed: 2026-10-30',
      'attestation: own-words',
      ...(extra ? [extra] : []),
      '---',
      `# ${title}`,
      body,
    ].join('\n');
  const nav = (pages: string[]) =>
    JSON.stringify({ title: 'Docs', sections: [{ title: 'All', pages }] });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const fresh = () => {
    dir = mkdtempSync(join(tmpdir(), 'ts-manual-check-'));
    write('docs/specs/a.md', '# A\n');
  };

  it('passes a clean manual', () => {
    fresh();
    write('docs/manual/nav.json', nav(['index.md', 'admin/b.md']));
    write('docs/manual/index.md', page('Home', 'See [b](admin/b.md#part-two).'));
    write('docs/manual/admin/b.md', page('B', '## Part two\n```bash\nls\n```\n'));
    expect(checkManual(dir, '2026-10-30')).toEqual([]);
  });

  it('reports missing provenance, a future date, missing and Atlassian sources, a wrong H1', () => {
    fresh();
    write('docs/manual/bare.md', '# Bare\n');
    write(
      'docs/manual/bad.md',
      page('Bad', '')
        .replace('audience: admins', 'audience: robots')
        .replace('2026-10-30', '2099-01-01')
        .replace('own-words', 'copied')
        .replace('docs/specs/a.md', 'docs/specs/gone.md, https://support.atlassian.com/x')
        .replace('# Bad', '# Other'),
    );
    expect(checkManualProvenance(dir, 'docs/manual/bare.md')).toEqual([
      'docs/manual/bare.md: no provenance front matter',
    ]);
    expect(checkManualProvenance(dir, 'docs/manual/bad.md', '2026-10-30')).toEqual([
      'docs/manual/bad.md: "audience" must be one of admins, users, everyone',
      'docs/manual/bad.md: "accessed" is in the future',
      'docs/manual/bad.md: "attestation" must be own-words',
      'docs/manual/bad.md: source docs/specs/gone.md does not exist',
      'docs/manual/bad.md: source https://support.atlassian.com/x is an Atlassian page; cite our specs instead',
      'docs/manual/bad.md: the first heading must be "# Bad"',
    ]);
  });

  it('reports pages missing from the nav and nav entries without a page', () => {
    fresh();
    write('docs/manual/nav.json', nav(['a.md', 'index.md', 'a.md']));
    write('docs/manual/index.md', page('Home', ''));
    write('docs/manual/orphan.md', page('Orphan', ''));
    expect(checkManualNav(readManual(dir))).toEqual([
      'docs/manual/nav.json must start with index.md',
      'docs/manual/nav.json lists missing page a.md',
      'docs/manual/nav.json lists a.md twice',
      'docs/manual/nav.json lists missing page a.md',
      'docs/manual/orphan.md is not in nav.json',
    ]);
  });

  it('reports broken links, links outside the manual, images and Atlassian links', () => {
    fresh();
    write('docs/manual/nav.json', nav(['index.md']));
    write(
      'docs/manual/index.md',
      page(
        'Home',
        [
          '## Here',
          '[ok](#here) [gone](missing.md) [anchor](index.md#nowhere)',
          '[repo](../adr/x.md) [file](../../README.md) ![pic](pic.png)',
          '[vendor](https://confluence.atlassian.com/x) `[in code](nowhere.md)`',
        ].join('\n'),
      ),
    );
    expect(checkManualLinks(readManual(dir))).toEqual([
      'docs/manual/index.md:3: links to missing page missing.md',
      'docs/manual/index.md:3: links to missing heading index.md#nowhere',
      'docs/manual/index.md:4: links outside the manual (../adr/x.md); the bundle holds only its pages',
      'docs/manual/index.md:4: links outside the manual (../../README.md); the bundle holds only its pages',
      'docs/manual/index.md:4: images are not bundled (pic.png)',
      'docs/manual/index.md:5: links to an Atlassian page (https://confluence.atlassian.com/x)',
    ]);
  });

  it("reports Atlassian terms unless the page declares why it needs Jira's names", () => {
    fresh();
    write('docs/manual/nav.json', nav(['index.md', 'import.md']));
    write(
      'docs/manual/index.md',
      page('Home', 'A Jira-compatible API.\nOpen the Epic and its sub-tasks in JQL, like Jira.'),
    );
    write(
      'docs/manual/import.md',
      page('Import', 'Jira Cloud epics become outcomes.', 'jira-names: import mapping'),
    );
    expect(checkManualTerms(readManual(dir))).toEqual([
      'docs/manual/index.md:3: "Epic" is not a Taskmoor term (docs/specs/00-terminology.md; jira-names in the front matter if the page needs Jira\'s names)',
      'docs/manual/index.md:3: "sub-tasks" is not a Taskmoor term (docs/specs/00-terminology.md; jira-names in the front matter if the page needs Jira\'s names)',
      'docs/manual/index.md:3: "JQL" is not a Taskmoor term (docs/specs/00-terminology.md; jira-names in the front matter if the page needs Jira\'s names)',
      'docs/manual/index.md:3: "Jira" is not a Taskmoor term (docs/specs/00-terminology.md; jira-names in the front matter if the page needs Jira\'s names)',
    ]);
  });

  it('reports two H1s, duplicate anchors and code blocks without a language', () => {
    fresh();
    write('docs/manual/nav.json', nav(['index.md']));
    write(
      'docs/manual/index.md',
      page(
        'Home',
        '# Again\n## Same\n## Same\n```\nplain\n```\n```text\n# not a heading\n```\n1. Step\n   ```\n   # nested\n   ```',
      ),
    );
    expect(checkManualStructure(readManual(dir))).toEqual([
      'docs/manual/index.md: has 2 H1 headings; use exactly one',
      'docs/manual/index.md: two headings share the anchor #same',
      'docs/manual/index.md:5: code block without a language',
      'docs/manual/index.md:12: code block without a language',
    ]);
  });

  it('reports a bundle that loads resources, makes requests or has broken links', () => {
    fresh();
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'">`;
    write(
      'out/index.html',
      [
        csp,
        '<script src="https://cdn.example.com/x.js"></script>',
        '<link rel="stylesheet" href="https://fonts.example.com/f.css">',
        '<style>@font-face { src: url(https://fonts.example.com/f.woff2) }</style>',
        '<script>fetch("/x")</script>',
        '<h1 id="top">Top</h1><a href="a/b.html#nope">x</a><a href="gone.html">y</a>',
        '<a href="#top">ok</a><a href="https://example.com">out</a>',
      ].join('\n'),
    );
    write('out/a/b.html', `${csp}<h1 id="b">B</h1><a href="../index.html#top">back</a>`);
    write('out/a/c.html', '<p>no policy</p>');
    expect(checkBundle(join(dir, 'out'))).toEqual([
      'a/c.html: no Content-Security-Policy that blocks the network',
      'index.html: <script> loads a resource; the bundle inlines everything',
      'index.html: <link> loads a resource; the bundle inlines everything',
      'index.html: the stylesheet loads a resource',
      'index.html: a script can make network requests',
      'index.html: link to missing anchor a/b.html#nope',
      'index.html: link to missing file gone.html',
    ]);
  });

  it('refuses to clear an output folder it did not write', () => {
    fresh();
    write('docs/manual/nav.json', nav(['index.md']));
    write('docs/manual/index.md', page('Home', ''));
    write('elsewhere/keep.txt', 'mine');
    expect(() => buildManual(dir, join(dir, 'elsewhere'))).toThrow(/not written by pnpm run docs/);
    expect(buildManual(dir, join(dir, 'out'))).toContain('index.html');
    expect(buildManual(dir, join(dir, 'out'))).toContain('search.html');
  });
});
