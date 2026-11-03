import { adfDoc } from './adf';
import { fromAdfJson, type PmJson } from './convert';

/**
 * The Markdown round-trip corpus (M1-017, NTF-007): documents written by hand in our own words,
 * each exercising part of the mapping in `markdown.ts`.
 *
 * - `DOCUMENTS` start as documents. `lossless` ones must come back from their Markdown exactly;
 *   the others lose what the module comment documents, and their read-back is a golden file.
 * - `SOURCES` start as Markdown, the way people paste or send it.
 */

type Mark = { type: string; attrs?: Record<string, unknown> };

const t = (text: string, ...marks: Mark[]): PmJson =>
  marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text };
const p = (...content: PmJson[]): PmJson =>
  content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
const h = (level: number, ...content: PmJson[]): PmJson => ({
  type: 'heading',
  attrs: { level },
  content,
});
const item = (...content: PmJson[]): PmJson => ({ type: 'listItem', content });
const ul = (...items: PmJson[][]): PmJson => ({
  type: 'bulletList',
  content: items.map((blocks) => item(...blocks)),
});
const ol = (start: number, ...items: PmJson[][]): PmJson => ({
  type: 'orderedList',
  attrs: { start },
  content: items.map((blocks) => item(...blocks)),
});
const tasks = (...items: [boolean, ...PmJson[]][]): PmJson => ({
  type: 'taskList',
  content: items.map(([checked, ...content]) => ({
    type: 'taskItem',
    attrs: { checked },
    content,
  })),
});
const code = (language: string | null, text: string): PmJson => ({
  type: 'codeBlock',
  attrs: { language },
  ...(text ? { content: [t(text)] } : {}),
});
const quote = (...content: PmJson[]): PmJson => ({ type: 'blockquote', content });
const hr: PmJson = { type: 'horizontalRule' };
const br: PmJson = { type: 'hardBreak' };
const panel = (panelType: string, ...content: PmJson[]): PmJson => ({
  type: 'panel',
  attrs: { panelType },
  content,
});
const cell = (type: 'tableHeader' | 'tableCell', content: PmJson[], attrs = {}): PmJson => ({
  type,
  attrs,
  content: content.length > 0 ? content : [p()],
});
const th = (...inline: PmJson[]) => cell('tableHeader', [p(...inline)]);
const td = (...inline: PmJson[]) => cell('tableCell', [p(...inline)]);
const row = (...cells: PmJson[]): PmJson => ({ type: 'tableRow', content: cells });
const table = (...rows: PmJson[]): PmJson => ({ type: 'table', content: rows });
const mention = (id: string, label: string): PmJson => ({
  type: 'mention',
  attrs: { id, label },
});
const doc = (...content: PmJson[]): PmJson => ({ type: 'doc', content });

const bold: Mark = { type: 'bold' };
const italic: Mark = { type: 'italic' };
const strike: Mark = { type: 'strike' };
const mono: Mark = { type: 'code' };
const underline: Mark = { type: 'underline' };
const sub: Mark = { type: 'subsup', attrs: { type: 'sub' } };
const sup: Mark = { type: 'subsup', attrs: { type: 'sup' } };
const color = (value: string): Mark => ({ type: 'textColor', attrs: { color: value } });
const link = (href: string, title?: string): Mark => ({
  type: 'link',
  attrs: {
    href,
    target: null,
    rel: null,
    class: null,
    adfAttrs: title ? { href, title } : null,
  },
});

export interface CorpusDocument {
  name: string;
  doc: PmJson;
  /** True when the document comes back from its Markdown unchanged. */
  lossless: boolean;
}

export const DOCUMENTS: CorpusDocument[] = [
  {
    name: 'expand',
    lossless: true,
    doc: doc(
      {
        type: 'expand',
        attrs: { title: 'Steps to reproduce' },
        content: [p(t('First open the page.')), ul([p(t('then wait'))], [p(t('then look'))])],
      },
      { type: 'expand', attrs: { title: '' }, content: [p(t('No title here.'))] },
    ),
  },
  {
    name: 'expand-title-symbols',
    lossless: true,
    doc: doc({
      type: 'expand',
      attrs: { title: 'Costs *are* [high] & _odd_' },
      content: [p(t('Body.'))],
    }),
  },
  {
    name: 'ticket-reference',
    lossless: true,
    doc: doc(
      p(
        t('Blocked by '),
        { type: 'ticketRef', attrs: { key: 'PAY-42' } },
        t(' and '),
        { type: 'ticketRef', attrs: { key: 'OPS_2-7' } },
        t('.'),
      ),
    ),
  },
  {
    name: 'attachment-reference',
    lossless: true,
    doc: doc(
      { type: 'attachmentRef', attrs: { name: 'screen shot (1).png', image: true } },
      { type: 'attachmentRef', attrs: { name: 'notes [final].pdf', image: false } },
      p(t('After them.')),
    ),
  },
  {
    name: 'columns',
    lossless: false,
    doc: doc({
      type: 'columnLayout',
      content: [
        { type: 'column', content: [h(2, t('Left')), p(t('One.'))] },
        { type: 'column', content: [p(t('Two.'))] },
      ],
    }),
  },
  { name: 'plain-paragraph', lossless: true, doc: doc(p(t('The export button does nothing.'))) },
  {
    name: 'paragraphs',
    lossless: true,
    doc: doc(
      p(t('Steps to reproduce are below.')),
      p(t('It started after the morning deploy.')),
      p(t('Only the reports page is affected.')),
    ),
  },
  {
    name: 'headings',
    lossless: true,
    doc: doc(
      h(1, t('Release plan')),
      h(2, t('Scope')),
      h(3, t('Risks')),
      h(4, t('Mitigation')),
      h(5, t('Owners')),
      h(6, t('Notes')),
    ),
  },
  {
    name: 'emphasis',
    lossless: true,
    doc: doc(
      p(
        t('Use '),
        t('bold', bold),
        t(' for warnings, '),
        t('italic', italic),
        t(' for names and '),
        t('strike', strike),
        t(' for what was dropped.'),
      ),
    ),
  },
  {
    name: 'nested-marks',
    lossless: true,
    doc: doc(
      p(
        t('Retry ', bold),
        t('three', bold, italic),
        t(' times', bold),
        t(', then '),
        t('give up', italic, strike),
        t('.'),
      ),
      p(t('half', italic), t('way', bold, italic), t(' there', bold)),
    ),
  },
  {
    name: 'inline-code',
    lossless: true,
    doc: doc(
      p(t('Run '), t('pnpm verify', mono), t(' before pushing.')),
      p(t('A backtick inside: '), t('a ` b', mono), t(' and '), t('``', mono), t('.')),
    ),
  },
  {
    name: 'links',
    lossless: true,
    doc: doc(
      p(
        t('See the '),
        t('runbook', link('https://example.test/runbook')),
        t(' and the '),
        t('alerts page', bold, link('https://example.test/alerts?team=ops&level=2')),
        t('.'),
      ),
      p(t('https://example.test/plain', link('https://example.test/plain'))),
      p(t('Write to '), t('support', link('mailto:support@example.test')), t('.')),
    ),
  },
  {
    name: 'link-title',
    lossless: true,
    doc: doc(
      p(
        t('The '),
        t('design notes', link('https://example.test/notes', 'Design notes, version 2')),
        t(' explain it.'),
      ),
    ),
  },
  {
    name: 'hard-breaks',
    lossless: true,
    doc: doc(p(t('First line'), br, t('second line'), br, t('third line'))),
  },
  {
    name: 'bullet-list',
    lossless: true,
    doc: doc(ul([p(t('Login page'))], [p(t('Settings page'))], [p(t('Reports page'))])),
  },
  {
    name: 'nested-lists',
    lossless: true,
    doc: doc(
      ul(
        [p(t('Backend')), ol(1, [p(t('Migrate'))], [p(t('Backfill'))])],
        [p(t('Frontend')), ul([p(t('Forms')), ul([p(t('Validation'))])], [p(t('Tables'))])],
      ),
    ),
  },
  {
    name: 'ordered-list-start',
    lossless: true,
    doc: doc(ol(3, [p(t('Third step'))], [p(t('Fourth step'))], [p(t('Fifth step'))])),
  },
  {
    name: 'adjacent-lists',
    lossless: true,
    doc: doc(
      ul([p(t('first list'))]),
      ul([p(t('second list'))]),
      ol(1, [p(t('first numbered'))]),
      ol(1, [p(t('second numbered'))]),
    ),
  },
  {
    name: 'task-list',
    lossless: true,
    doc: doc(
      tasks(
        [true, p(t('Write the migration'))],
        [false, p(t('Review with '), mention('7', 'Kalo'))],
        [false, p(t('Ship it')), ul([p(t('after the freeze'))])],
      ),
    ),
  },
  {
    name: 'code-block',
    lossless: true,
    doc: doc(
      p(t('The failing query:')),
      code('sql', 'SELECT id, key\n  FROM ticket\n WHERE deleted_at IS NULL;'),
    ),
  },
  {
    name: 'code-block-plain',
    lossless: true,
    doc: doc(code(null, '# not a heading\n- not a list\n**not bold**')),
  },
  {
    name: 'code-block-fences',
    lossless: true,
    doc: doc(code('markdown', 'Use fences:\n\n```ts\nconst x = 1;\n```')),
  },
  { name: 'code-block-empty', lossless: true, doc: doc(code('bash', '')) },
  {
    name: 'blockquote',
    lossless: true,
    doc: doc(
      quote(
        p(t('The cache is warm after the first request.')),
        ul([p(t('cold: 900 ms'))], [p(t('warm: 40 ms'))]),
      ),
    ),
  },
  {
    name: 'nested-blockquote',
    lossless: true,
    doc: doc(quote(p(t('Outer')), quote(p(t('Inner')), quote(p(t('Innermost')))))),
  },
  {
    name: 'horizontal-rule',
    lossless: true,
    doc: doc(p(t('Above')), hr, p(t('Below')), hr),
  },
  {
    name: 'panels',
    lossless: true,
    doc: doc(
      panel('info', p(t('Maintenance on Sunday.'))),
      panel('note', p(t('Numbers are rounded.'))),
      panel('tip', p(t('Press '), t('?', mono), t(' for shortcuts.'))),
      panel('warning', p(t('This deletes data.')), ul([p(t('tickets'))], [p(t('comments'))])),
      panel('error', p(t('The import failed.'))),
      panel('success', p(t('All checks passed.'))),
    ),
  },
  {
    name: 'table',
    lossless: true,
    doc: doc(
      table(
        row(th(t('Browser')), th(t('Result'))),
        row(td(t('Firefox')), td(t('passes'))),
        row(td(t('Safari')), td(t('fails'))),
      ),
    ),
  },
  {
    name: 'table-inline-marks',
    lossless: true,
    doc: doc(
      table(
        row(th(t('Setting')), th(t('Default')), th(t('Notes'))),
        row(
          td(t('timeout', mono)),
          td(t('30 s', bold)),
          td(t('see '), t('docs', link('https://example.test/docs'))),
        ),
        row(td(t('pipe | inside')), td(t('a'), br, t('b')), td(mention('3', 'Mi'))),
      ),
    ),
  },
  {
    name: 'table-empty-cells',
    lossless: true,
    doc: doc(table(row(th(t('A')), th(), th(t('C'))), row(td(), td(t('only middle')), td()))),
  },
  {
    name: 'mentions',
    lossless: true,
    doc: doc(
      p(mention('42', 'Kalo Smith'), t(' and '), mention('7', 'Mi'), t(', please review.')),
      p(t('Assigned to ', bold), mention('9', 'Ana'), t('.', bold)),
      p(mention('user:odd id/1', 'Odd'), t(' has an id that needs encoding.')),
    ),
  },
  {
    name: 'underline-sub-sup',
    lossless: true,
    doc: doc(
      p(t('Must', underline), t(' read. Water is H'), t('2', sub), t('O and E = mc'), t('2', sup)),
      p(t('underlined and bold', underline, bold)),
    ),
  },
  {
    name: 'text-color',
    lossless: true,
    doc: doc(p(t('Status: '), t('green', color('#36b37e')), t(' and '), t('red', color('red')))),
  },
  {
    name: 'special-characters',
    lossless: true,
    doc: doc(
      p(t('Literal *stars*, _underscores_, `ticks` and [brackets](not a link).')),
      p(t('Angles <ins> and <script>alert(1)</script> stay text.')),
      p(t('Pipes | and backslashes \\ and hashes # and ~~tildes~~.')),
      p(t('A mention-looking [@Kalo](mention:42) typed as text.')),
      p(t('Ampersands &amp; and &copy; entities as typed.')),
    ),
  },
  {
    name: 'leading-symbols',
    lossless: true,
    doc: doc(
      p(t('1. not a list')),
      p(t('- not a list either')),
      p(t('# not a heading')),
      p(t('> not a quote')),
      p(t('+ plus')),
      p(t('[!NOTE] not a panel')),
      p(t('---')),
      p(t('    indented text')),
    ),
  },
  {
    name: 'unicode',
    lossless: true,
    doc: doc(p(t('Ünïcödé, 日本語, עברית, emoji 🎉 as characters.')), h(2, t('Überschrift'))),
  },
  {
    name: 'list-with-blocks',
    lossless: true,
    doc: doc(
      ol(
        1,
        [p(t('Install')), code('bash', 'pnpm install')],
        [p(t('Configure')), quote(p(t('Set DATABASE_URL first.')))],
        [p(t('Start')), p(t('A second paragraph in the item.'))],
      ),
    ),
  },
  {
    name: 'heading-marks',
    lossless: true,
    doc: doc(h(2, t('Fix '), t('login', mono), t(' for '), t('everyone', italic))),
  },
  {
    name: 'bug-report',
    lossless: true,
    doc: doc(
      h(2, t('Summary')),
      p(
        t('Saving a filter with a '),
        t('long name', bold),
        t(' fails for '),
        mention('12', 'Ana Ruiz'),
        t('.'),
      ),
      h(2, t('Steps')),
      ol(1, [p(t('Open '), t('Filters', italic))], [p(t('Type 300 characters'))], [p(t('Save'))]),
      h(2, t('Expected')),
      p(t('The filter is saved or the form says the name is too long.')),
      h(2, t('Actual')),
      code('text', 'Error 500: value too long for type character varying(255)'),
      panel('warning', p(t('Data is lost when the page reloads.'))),
      table(
        row(th(t('Environment')), th(t('Seen'))),
        row(td(t('staging')), td(t('yes'))),
        row(td(t('production')), td(t('no'))),
      ),
      tasks([false, p(t('Add a length check'))], [false, p(t('Add a test'))]),
      hr,
      p(t('Logs: '), t('build 2041', link('https://example.test/builds/2041'))),
    ),
  },

  // Documented losses.
  {
    name: 'empty-paragraphs',
    lossless: false,
    doc: doc(p(), p(t('Between empty paragraphs')), p(), p()),
  },
  {
    name: 'emoji-date-status',
    lossless: false,
    doc: doc(
      p(
        t('Done '),
        { type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } },
        t(' on '),
        { type: 'date', attrs: { timestamp: '1772582400000' } },
        t(', status '),
        { type: 'status', attrs: { text: 'SHIPPED', color: 'green' } },
        t(', '),
        { type: 'emoji', attrs: { shortName: ':custom-party:', text: null } },
      ),
    ),
  },
  {
    name: 'table-without-header',
    lossless: false,
    doc: doc(table(row(td(t('a')), td(t('b'))), row(td(t('c')), td(t('d'))))),
  },
  {
    name: 'table-merged-cells',
    lossless: false,
    doc: doc(
      table(
        row(cell('tableHeader', [p(t('Wide header'))], { colspan: 2 }), th(t('C'))),
        row(td(t('a')), cell('tableCell', [p(t('tall'))], { rowspan: 2 }), td(t('c'))),
        row(td(t('d')), td(t('f'))),
      ),
    ),
  },
  {
    name: 'table-block-cells',
    lossless: false,
    doc: doc(
      table(
        row(th(t('Item')), th(t('Detail'))),
        row(
          td(t('steps')),
          cell('tableCell', [
            p(t('first paragraph')),
            p(t('second paragraph')),
            ul([p(t('a list item'))]),
          ]),
        ),
      ),
    ),
  },
  {
    name: 'unknown-nodes',
    lossless: false,
    doc: fromAdfJson(
      adfDoc([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Card: ' },
            {
              type: 'inlineCard',
              attrs: { url: 'https://example.test/card', localId: 'c1' },
            },
            {
              type: 'text',
              text: ' annotated',
              marks: [{ type: 'annotation', attrs: { id: 'a1', annotationType: 'inlineComment' } }],
            },
          ],
        },
        {
          type: 'expand',
          attrs: { title: 'Details' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hidden detail.' }] }],
        },
        {
          type: 'decisionList',
          attrs: { localId: 'd1' },
          content: [
            {
              type: 'decisionItem',
              attrs: { localId: 'd2', state: 'DECIDED' },
              content: [{ type: 'text', text: 'We ship on Friday.' }],
            },
          ],
        },
        { type: 'extension', attrs: { extensionKey: 'chart', parameters: { n: 3 } } },
      ]),
    ),
  },
  {
    name: 'editor-link-attributes',
    lossless: false,
    doc: doc(
      p(
        t('Opens in a new tab', {
          type: 'link',
          attrs: { href: 'https://example.test', target: '_blank', rel: 'noopener', class: null },
        }),
      ),
    ),
  },
  {
    name: 'unsafe-and-odd',
    lossless: false,
    doc: doc(
      p(
        t('script', {
          type: 'link',
          attrs: { href: 'javascript:alert(1)', target: null, rel: null, class: null },
        }),
        t(' and '),
        t('styled', color('expression(alert(1))')),
      ),
      code('two words', 'echo hi'),
    ),
  },
  {
    name: 'imported-document',
    lossless: false,
    doc: fromAdfJson(
      adfDoc([
        {
          type: 'heading',
          attrs: { level: 3, localId: 'h1' },
          content: [{ type: 'text', text: 'Imported' }],
        },
        {
          type: 'paragraph',
          attrs: { localId: 'p1' },
          content: [
            { type: 'mention', attrs: { id: 'acc-1', text: '@Riley', accessLevel: 'CONTAINER' } },
            { type: 'text', text: ' see ' },
            {
              type: 'text',
              text: 'docs',
              marks: [{ type: 'link', attrs: { href: 'https://example.test/d', title: 'Docs' } }],
            },
          ],
        },
        {
          type: 'taskList',
          attrs: { localId: 'tl' },
          content: [
            {
              type: 'taskItem',
              attrs: { localId: 'ti', state: 'DONE' },
              content: [{ type: 'text', text: 'checked off' }],
            },
          ],
        },
      ]),
    ),
  },
];

export interface CorpusSource {
  name: string;
  markdown: string;
}

export const SOURCES: CorpusSource[] = [
  {
    name: 'readme-style',
    markdown: [
      '# Taskmoor sync check',
      '',
      'A short tool that **compares** two exports and prints the _differences_.',
      '',
      '## Usage',
      '',
      '```sh',
      'sync-check before.json after.json',
      '```',
      '',
      '| Flag | Meaning | Default |',
      '| :--- | :-----: | ------: |',
      '| `-q` | quiet | off |',
      '| `-n` | limit | 100 |',
      '',
      '* one',
      '* two',
      '',
    ].join('\n'),
  },
  { name: 'setext-headings', markdown: 'Title\n=====\n\nSubtitle\n--------\n\nText.\n' },
  { name: 'indented-code', markdown: 'Before:\n\n    const a = 1;\n    const b = 2;\n\nAfter.\n' },
  {
    name: 'reference-links',
    markdown:
      'See [the guide][guide] and [the FAQ].\n\n[guide]: https://example.test/guide "Guide"\n[the faq]: https://example.test/faq\n',
  },
  {
    name: 'images',
    markdown:
      'A screenshot: ![failing build](https://example.test/build.png) and ![](https://example.test/x.png).\n',
  },
  {
    name: 'html',
    markdown:
      '<div align="center">\n  <b>centered</b>\n</div>\n\nInline <script>alert(1)</script> and <kbd>Ctrl</kbd> and <u>under</u>.\n',
  },
  {
    name: 'github-alerts',
    markdown: [
      '> [!NOTE]',
      '> Useful information.',
      '',
      '> [!IMPORTANT]',
      '> Crucial information.',
      '',
      '> [!CAUTION]',
      '> Negative outcomes.',
      '',
      '> [!UNKNOWN]',
      '> Stays a quote.',
      '',
    ].join('\n'),
  },
  { name: 'mixed-task-list', markdown: '- [x] done\n- plain item\n- [ ] open\n' },
  { name: 'ordered-task-list', markdown: '1. [ ] first\n2. [x] second\n' },
  {
    name: 'loose-list',
    markdown: '- first\n\n- second\n\n  with a second paragraph\n\n- third\n',
  },
  {
    name: 'autolinks',
    markdown:
      'Visit www.example.test or https://example.test/a?b=1, or <https://example.test/c>, or mail ops@example.test.\n',
  },
  {
    name: 'unsafe-links',
    markdown:
      '[click](javascript:alert(1)) and [data](data:text/html,hi) and [ok](https://example.test).\n',
  },
  {
    name: 'emphasis-variants',
    markdown: '__bold__, _em_, ***both***, **mixed _inner_**, and intra*word*emphasis.\n',
  },
  { name: 'hard-break-styles', markdown: 'two spaces  \nbackslash\\\nend\n' },
  {
    name: 'quote-with-list',
    markdown: '> Notes:\n>\n> 1. one\n> 2. two\n>\n> > nested quote\n',
  },
  {
    name: 'escapes-and-entities',
    markdown: '\\*not emphasis\\* &amp; &copy; &#35; \\# \\[x\\] \\`tick\\`\n',
  },
  {
    name: 'taskmoor-conventions',
    markdown: [
      'Ping [@Kalo](mention:42) about <ins>this</ins>, H<sub>2</sub>O and',
      '<span style="color: #ff5630">red</span> text.',
      '',
      '> [!WARNING]',
      '> Read first.',
      '',
    ].join('\n'),
  },
  {
    name: 'code-with-marks',
    markdown:
      'Bold code **`flag`**, linked code [`run()`](https://example.test/run), a bold mention **[@Ana](mention:9)**.\n',
  },
  {
    name: 'soft-breaks',
    markdown: 'One sentence\nwraps onto\n  the next line.\n',
  },
  { name: 'empty', markdown: '' },
];
