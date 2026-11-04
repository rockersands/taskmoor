import { adfDoc } from './adf';
import { fromAdfJson, type PmJson } from './convert';

/**
 * The wiki-markup round-trip corpus (M1-071, API-011): documents written by hand in our own
 * words, plus families built from lists of marks, characters and blocks so that every mark,
 * node and container meets every other one. Nothing comes from a real tracker.
 *
 * - `DOCUMENTS` start as documents. `lossless` ones must come back from their wiki markup
 *   exactly; the others lose what the module comment of `wiki.ts` documents, and their
 *   read-back is a golden file.
 * - `SOURCES` start as wiki markup, the way scripts and people send it.
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
const ol = (...items: PmJson[][]): PmJson => ({
  type: 'orderedList',
  attrs: { start: 1 },
  content: items.map((blocks) => item(...blocks)),
});
const olFrom = (start: number, ...items: PmJson[][]): PmJson => ({
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
/** A mention as wiki markup carries it: by id, without a display name. */
const mention = (id: string): PmJson => ({ type: 'mention', attrs: { id, label: null } });
const named = (id: string, label: string): PmJson => ({ type: 'mention', attrs: { id, label } });
const doc = (...content: PmJson[]): PmJson => ({ type: 'doc', content });

const bold: Mark = { type: 'bold' };
const italic: Mark = { type: 'italic' };
const strike: Mark = { type: 'strike' };
const mono: Mark = { type: 'code' };
const underline: Mark = { type: 'underline' };
const sub: Mark = { type: 'subsup', attrs: { type: 'sub' } };
const sup: Mark = { type: 'subsup', attrs: { type: 'sup' } };
const color = (value: string): Mark => ({ type: 'textColor', attrs: { color: value } });
const red = color('#ff5630');
const link = (href: string): Mark => ({
  type: 'link',
  attrs: { href, target: null, rel: null, class: null },
});
const site = link('https://example.test/runbook');

export interface CorpusDocument {
  name: string;
  doc: PmJson;
  /** True when the document comes back from its wiki markup unchanged. */
  lossless: boolean;
}

const HAND: CorpusDocument[] = [
  // The new blocks (NTF-014) ---------------------------------------------------------------------
  {
    name: 'expand',
    lossless: true,
    doc: doc(
      {
        type: 'expand',
        attrs: { title: 'Steps to reproduce' },
        content: [p(t('First open the page.')), panel('note', p(t('Then wait.')))],
      },
      { type: 'expand', attrs: { title: '' }, content: [p(t('No title here.'))] },
    ),
  },
  {
    name: 'expand-in-panel',
    lossless: true,
    doc: doc(
      panel('info', { type: 'expand', attrs: { title: 'Inside' }, content: [p(t('Body.'))] }),
    ),
  },
  {
    name: 'expand-in-expand',
    lossless: false,
    doc: doc({
      type: 'expand',
      attrs: { title: 'Outer' },
      content: [{ type: 'expand', attrs: { title: 'Inner' }, content: [p(t('Body.'))] }],
    }),
  },
  {
    name: 'expand-title-brace',
    lossless: false,
    doc: doc({ type: 'expand', attrs: { title: 'a } b' }, content: [p(t('Body.'))] }),
  },
  {
    // Columns are `{section}` holding `{column}` blocks (ADR-120, TT-3).
    name: 'columns',
    lossless: true,
    doc: doc({
      type: 'columnLayout',
      content: [
        { type: 'column', content: [h(2, t('Left')), p(t('One.'))] },
        { type: 'column', content: [p(t('Two.'))] },
      ],
    }),
  },
  {
    // A width as `{column:width=40%}` (TT-2); an empty column; blocks of every kind inside.
    name: 'columns-with-widths',
    lossless: true,
    doc: doc(
      p(t('Before.')),
      {
        type: 'columnLayout',
        content: [
          { type: 'column', attrs: { width: 25 }, content: [p()] },
          {
            type: 'column',
            attrs: { width: 41.5 },
            content: [
              ul([p(t('one'))], [p(t('two'))]),
              code('sql', 'select 1;'),
              panel('note', p(t('Mind it.'))),
              { type: 'expand', attrs: { title: 'More' }, content: [p(t('Hidden.'))] },
              quote(p(t('Quoted.'))),
            ],
          },
          { type: 'column', attrs: { width: 33.5 }, content: [p(t('{section} and {column}'))] },
        ],
      },
      p(t('After.')),
    ),
  },
  {
    // A layout in a column loses its frame, and so does a width the markup does not write.
    name: 'columns-in-column',
    lossless: false,
    doc: doc({
      type: 'columnLayout',
      content: [
        {
          type: 'column',
          attrs: { width: 150 },
          content: [
            {
              type: 'columnLayout',
              content: [
                { type: 'column', content: [p(t('Inner left.'))] },
                { type: 'column', content: [p(t('Inner right.'))] },
              ],
            },
          ],
        },
        { type: 'column', attrs: { width: 1e-11 }, content: [p(t('Right.'))] },
      ],
    }),
  },
  {
    // `!name!` for a picture and `[^name]` for another file (TT-3), the markup's own forms.
    name: 'attachment-reference',
    lossless: true,
    doc: doc(
      { type: 'attachmentRef', attrs: { name: 'screen shot (1).png', image: true } },
      { type: 'attachmentRef', attrs: { name: 'notes.pdf', image: false } },
      panel('info', { type: 'attachmentRef', attrs: { name: 'my_file*v2*.pdf', image: false } }),
    ),
  },
  {
    // Names the markup cannot hold read back as text; a digest is not written (TT-4).
    name: 'attachment-names-as-text',
    lossless: false,
    doc: doc(
      { type: 'attachmentRef', attrs: { name: 'wow!.png', image: true } },
      { type: 'attachmentRef', attrs: { name: 'a [b].pdf', image: false } },
      { type: 'attachmentRef', attrs: { name: 'http:x.pdf', image: false } },
      { type: 'attachmentRef', attrs: { name: ' lead.pdf', image: false } },
      {
        type: 'attachmentRef',
        attrs: { name: 'shot.png', image: true, digest: '3f2a9c0d1e4b5a67' },
      },
    ),
  },
  {
    // `[PAY-42|/browse/PAY-42]`: a link to the ticket by its key (TT-3).
    name: 'ticket-reference',
    lossless: true,
    doc: doc(
      p(t('Blocked by '), { type: 'ticketRef', attrs: { key: 'PAY-42' } }, t('.')),
      h(3, { type: 'ticketRef', attrs: { key: 'OPS_2-7' } }),
      ul([p(t('see '), { type: 'ticketRef', attrs: { key: 'A-1' } })]),
      table(row(td({ type: 'ticketRef', attrs: { key: 'B-2' } }), td(t('x')))),
    ),
  },
  // Text and paragraphs -----------------------------------------------------------------------
  { name: 'empty-document', lossless: true, doc: doc(p()) },
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
    name: 'long-paragraph',
    lossless: true,
    doc: doc(
      p(
        t(
          'The nightly job reads every open ticket, recomputes its rank, writes the new rank in batches of five hundred and then refreshes the board caches; when a batch fails it retries twice and then stops, leaving the remaining tickets with their old rank until the next night.',
        ),
      ),
    ),
  },
  {
    name: 'unicode',
    lossless: true,
    doc: doc(
      p(t('Grüße aus Zürich, ¿qué tal? Ça marche.')),
      p(t('日本語のテキストと한국어 텍스트')),
      p(t('Emoji in text: 🚀 🐛 ✅ and a flag 🇳🇴')),
    ),
  },
  {
    name: 'right-to-left',
    lossless: true,
    doc: doc(p(t('مرحبا بالعالم')), p(t('שלום עולם'), t(' and '), t('mixed', bold))),
  },
  {
    name: 'whitespace',
    lossless: true,
    doc: doc(
      p(t('  two leading spaces')),
      p(t('trailing spaces  ')),
      p(t('a\ttab and a\u00a0no-break space')),
      p(t('   ')),
    ),
  },
  {
    name: 'numbers-and-dashes',
    lossless: true,
    doc: doc(
      p(t('Range 10-20, dash -- and em --- dash, minus -5 and 3 - 2 = 1.')),
      p(t('Version 2.4.1-rc.3 and well-known-thing.')),
    ),
  },
  {
    name: 'programmer-text',
    lossless: true,
    doc: doc(
      p(t('C++ and C# and snake_case_name and a*b*c and 2^10 and ~/home and x+y+z.')),
      p(t('A path C:\\Users\\ana\\file.txt and a regex ^a+b*$.')),
      p(t('Braces {like this} and [brackets] and a|pipe and wow!')),
    ),
  },
  {
    name: 'special-characters',
    lossless: true,
    doc: doc(
      p(t('Stars *not bold* and _not italic_ and -not struck- and +not under+.')),
      p(t('Carets ^not sup^ and tildes ~not sub~ and {{not code}}.')),
      p(t('Not a link [text|page] and not a mention [~accountid:1].')),
      p(t('Not an image !picture.png! and not a colour {color:red}x{color}.')),
      p(t('Not a break \\\\ and not a reference &#92; and &amp; stays.')),
    ),
  },
  {
    name: 'markers-at-edges',
    lossless: true,
    doc: doc(
      p(t('*')),
      p(t('_')),
      p(t('-')),
      p(t('*leading star')),
      p(t('trailing star*')),
      p(t('a *b')),
      p(t('a* b')),
    ),
  },
  {
    name: 'backslashes',
    lossless: true,
    doc: doc(
      p(t('one \\ alone')),
      p(t('ends with \\')),
      p(t('\\\\server\\share')),
      p(t('before a star \\* and before a brace \\{')),
    ),
  },
  {
    name: 'references-in-text',
    lossless: true,
    doc: doc(p(t('&#65; is not A, &#x41; neither, and && or & # stay.'))),
  },
  // Line starts that look like markup ---------------------------------------------------------
  {
    name: 'line-starts',
    lossless: true,
    doc: doc(
      p(t('h1. is not a heading')),
      p(t('bq. is not a quote')),
      p(t('* is not a list')),
      p(t('# is not a numbered list')),
      p(t('- is not a bullet')),
      p(t('----')),
      p(t('|not|a|table|')),
      p(t('{code}not code{code}')),
    ),
  },
  {
    name: 'line-starts-after-breaks',
    lossless: true,
    doc: doc(
      p(
        t('first line'),
        br,
        t('h2. second line'),
        br,
        t('** third line'),
        br,
        t('||fourth line'),
        br,
        t('-----'),
      ),
    ),
  },
  {
    name: 'indented-line-starts',
    lossless: true,
    doc: doc(p(t('  * indented star')), p(t('\th3. indented heading'))),
  },
  // Marks ---------------------------------------------------------------------------------------
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
    name: 'marks-inside-words',
    lossless: true,
    doc: doc(
      p(t('un'), t('break', bold), t('able')),
      p(t('H'), t('2', sub), t('O and x'), t('2', sup), t(' and E=mc'), t('2', sup)),
      p(t('re'), t('do', italic), t('ne and pre'), t('view', underline), t('ed')),
    ),
  },
  {
    name: 'marks-with-spaces-inside',
    lossless: true,
    doc: doc(p(t('a'), t(' spaced bold ', bold), t('b')), p(t(' leading', italic), t(' end'))),
  },
  {
    name: 'marks-next-to-punctuation',
    lossless: true,
    doc: doc(
      p(
        t('('),
        t('bold', bold),
        t('), "'),
        t('quoted', italic),
        t('", '),
        t('end', strike),
        t('.'),
      ),
      p(t('bold', bold), t(':'), t('italic', italic), t(';'), t('under', underline), t('!')),
    ),
  },
  {
    name: 'adjacent-different-marks',
    lossless: true,
    doc: doc(
      p(t('bold', bold), t('italic', italic), t('struck', strike), t('under', underline)),
      p(t('a', sup), t('b', sub), t('c', bold)),
    ),
  },
  {
    name: 'every-mark-at-once',
    lossless: true,
    doc: doc(p(t('Everything', bold, italic, strike, underline, sup, red, site))),
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
    doc: doc(
      p(t('Status: '), t('red', color('#ff5630')), t(', '), t('green', color('#36b37e'))),
      p(t('named', color('purple')), t(' and short '), t('hex', color('#0af'))),
      p(t('bold red', bold, red), t(' then plain')),
    ),
  },
  {
    name: 'inline-code',
    lossless: true,
    doc: doc(
      p(t('Run '), t('pnpm verify', mono), t(' before pushing.')),
      p(t('Braces inside: '), t('{a: [1, 2]}', mono), t(' and '), t('a}}b', mono), t('.')),
      p(t('Markup inside: '), t('*not bold* _no_ -no-', mono)),
      p(t('Back'), t('slash\\', mono), t(' and '), t('x|y', mono)),
    ),
  },
  {
    name: 'inline-code-in-marks-context',
    lossless: true,
    doc: doc(p(t('Bold ', bold), t('code', mono), t(' again', bold))),
  },
  // Links and mentions -----------------------------------------------------------------------
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
      p(t('Write to '), t('support', link('mailto:support@example.test')), t('.')),
      p(t('Call '), t('the desk', link('tel:+4712345678')), t('.')),
    ),
  },
  {
    name: 'link-shorthand',
    lossless: true,
    doc: doc(
      p(t('https://example.test/plain', link('https://example.test/plain'))),
      p(t('mailto:ops@example.test', link('mailto:ops@example.test'))),
    ),
  },
  {
    name: 'relative-links',
    lossless: true,
    doc: doc(
      p(t('Board', link('/boards/12')), t(' and '), t('section', link('#install'))),
      p(t('Ticket', link('../tickets/PAY-12'))),
    ),
  },
  {
    name: 'link-with-special-text',
    lossless: true,
    doc: doc(
      p(t('a [bracketed] | piped ~ text', link('https://example.test/x'))),
      p(t('~tilde first', link('https://example.test/y'))),
      p(t('^caret first', link('https://example.test/z'))),
      p(t('ends with \\', link('https://example.test/w'))),
    ),
  },
  {
    name: 'link-address-characters',
    lossless: true,
    doc: doc(
      p(t('query', link('https://example.test/s?q=a*b&sort=-created#top'))),
      p(t('under_scores', link('https://example.test/a_b_c/d-e-f'))),
      p(t('encoded', link('https://example.test/a%20b'))),
    ),
  },
  {
    name: 'marks-across-links',
    lossless: true,
    doc: doc(
      p(t('bold '), t('start', bold, site), t(' rest of link', site), t(' after')),
      p(t('before ', bold), t('linked', bold, site), t(' after', bold)),
      p(t('in', site), t('side', site, italic), t(' out', italic)),
      p(t('red ', red), t('link', red, site), t(' red', red)),
    ),
  },
  {
    name: 'adjacent-links',
    lossless: true,
    doc: doc(
      p(t('one', link('https://example.test/1')), t('two', link('https://example.test/2'))),
      p(t('a', site), t(' '), t('b', site)),
    ),
  },
  {
    name: 'link-next-to-code',
    lossless: true,
    doc: doc(p(t('See '), t('the config', site), t(' or '), t('config.yml', mono), t('.'))),
  },
  {
    name: 'mentions',
    lossless: true,
    doc: doc(
      p(mention('42'), t(' and '), mention('7'), t(', please review.')),
      p(t('Assigned to ', bold), mention('9'), t('.', bold)),
      p(mention('557058:0f6c4a3e-acde-4f7b-9a1e-2f8d1c0b9a77'), t(' imported id')),
    ),
  },
  {
    name: 'mentions-everywhere',
    lossless: true,
    doc: doc(
      h(3, t('Owner '), mention('3')),
      ul([p(mention('4'), t(' backend'))], [p(t('frontend '), mention('5'))]),
      table(row(th(t('Who')), th(t('Role'))), row(td(mention('6')), td(t('reviewer')))),
      quote(p(mention('7'), t(' said so.'))),
    ),
  },
  // Headings ------------------------------------------------------------------------------------
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
    name: 'heading-marks',
    lossless: true,
    doc: doc(
      h(2, t('The '), t('new', italic), t(' importer '), t('(beta)', bold)),
      h(3, t('Link in '), t('heading', site)),
      h(4, t('Code '), t('flag', mono)),
    ),
  },
  {
    name: 'heading-edges',
    lossless: true,
    doc: doc(h(2), h(3, t('  spaced')), h(4, t('one'), br, t('two')), h(5, t('* star'))),
  },
  // Line breaks ---------------------------------------------------------------------------------
  {
    name: 'hard-breaks',
    lossless: true,
    doc: doc(p(t('First line'), br, t('second line'), br, t('third line'))),
  },
  {
    name: 'hard-breaks-edges',
    lossless: true,
    doc: doc(
      p(br, t('starts with a break')),
      p(t('ends with a break'), br),
      p(t('two'), br, br, t('breaks')),
      p(t('space after'), br, t(' indented line')),
      p(br),
    ),
  },
  {
    name: 'hard-breaks-in-marks',
    lossless: true,
    doc: doc(
      p(t('bold', bold), br, t('still bold', bold)),
      p(t('link', site), br, t('next', site)),
    ),
  },
  // Lists ---------------------------------------------------------------------------------------
  {
    name: 'bullet-list',
    lossless: true,
    doc: doc(ul([p(t('Login page'))], [p(t('Settings page'))], [p(t('Reports page'))])),
  },
  {
    name: 'ordered-list',
    lossless: true,
    doc: doc(ol([p(t('Open the board'))], [p(t('Pick a sprint'))], [p(t('Start it'))])),
  },
  {
    name: 'nested-lists',
    lossless: true,
    doc: doc(
      ul(
        [p(t('Backend')), ol([p(t('Migrate'))], [p(t('Backfill'))])],
        [p(t('Frontend')), ul([p(t('Forms')), ul([p(t('Validation'))])], [p(t('Tables'))])],
      ),
    ),
  },
  {
    name: 'deep-list',
    lossless: true,
    doc: doc(
      ul([
        p(t('one')),
        ul([p(t('two')), ul([p(t('three')), ul([p(t('four')), ul([p(t('five'))])])])]),
      ]),
    ),
  },
  {
    name: 'mixed-nesting',
    lossless: true,
    doc: doc(
      ol(
        [p(t('step')), ul([p(t('detail a'))], [p(t('detail b'))])],
        [p(t('next step')), ol([p(t('sub-step'))])],
      ),
    ),
  },
  {
    name: 'list-item-with-two-lists',
    lossless: true,
    doc: doc(ul([p(t('parent')), ul([p(t('bullets'))]), ol([p(t('numbers'))])])),
  },
  {
    name: 'adjacent-lists',
    lossless: true,
    doc: doc(
      ul([p(t('first list'))]),
      ul([p(t('second list'))]),
      ol([p(t('first numbered'))]),
      ol([p(t('second numbered'))]),
    ),
  },
  {
    name: 'list-after-paragraph',
    lossless: true,
    doc: doc(p(t('Affected:')), ul([p(t('web'))], [p(t('mobile'))]), p(t('Nothing else.'))),
  },
  {
    name: 'list-item-marks',
    lossless: true,
    doc: doc(
      ul(
        [p(t('bold item', bold))],
        [p(t('item with '), t('code', mono))],
        [p(t('item with '), t('link', site))],
        [p(t('first'), br, t('second line'))],
      ),
    ),
  },
  {
    name: 'list-item-edges',
    lossless: true,
    doc: doc(
      ul([p()], [p(t('  indented'))], [p(t('* star text'))], [p(t('[x] looks like a box'))]),
      ol([p(t('[ ] also looks like one'))]),
    ),
  },
  {
    name: 'task-list',
    lossless: true,
    doc: doc(
      tasks(
        [true, p(t('Write the migration'))],
        [false, p(t('Review with '), mention('7'))],
        [false, p(t('Ship it')), ul([p(t('after the freeze'))])],
      ),
    ),
  },
  {
    name: 'task-list-edges',
    lossless: true,
    doc: doc(
      tasks([false, p()], [true, p(t(' leading space'))], [false, p(t('done', bold), t(' later'))]),
    ),
  },
  {
    name: 'nested-task-lists',
    lossless: true,
    doc: doc(
      tasks([
        false,
        p(t('parent')),
        tasks([true, p(t('child done'))], [false, p(t('child open'))]),
      ]),
      ul([p(t('plain')), tasks([true, p(t('task under a bullet'))])]),
      ol([p(t('numbered')), tasks([false, p(t('task under a number'))])]),
    ),
  },
  // Code blocks ---------------------------------------------------------------------------------
  {
    name: 'code-block',
    lossless: true,
    doc: doc(
      p(t('The failing query:')),
      code('sql', 'SELECT id, key\n  FROM ticket\n WHERE deleted_at IS NULL;'),
    ),
  },
  { name: 'code-block-plain', lossless: true, doc: doc(code(null, 'plain text\n  indented')) },
  { name: 'code-block-empty', lossless: true, doc: doc(code('bash', ''), code(null, '')) },
  {
    name: 'code-block-languages',
    lossless: true,
    doc: doc(
      code('java', 'class A {}'),
      code('c++', 'int main() { return 0; }'),
      code('c#', 'var x = 1;'),
      code('objective-c', '@interface A @end'),
      code('shell', 'echo "$HOME"'),
    ),
  },
  {
    name: 'code-block-markup-inside',
    lossless: true,
    doc: doc(
      code(null, 'h1. not a heading\n* not a list\n*not bold* {quote} {panel}\n[not|link] \\\\'),
      code('xml', '<a>{noformat}</a>'),
    ),
  },
  {
    name: 'code-block-newlines',
    lossless: true,
    doc: doc(
      code('text', '\nstarts with a newline'),
      code('text', 'ends with one\n'),
      code(null, '\n\n'),
    ),
  },
  {
    name: 'code-block-whitespace',
    lossless: true,
    doc: doc(code('python', 'def f():\n\treturn 1\n    # spaces   ')),
  },
  // Quotes ---------------------------------------------------------------------------------------
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
    name: 'blockquote-blocks',
    lossless: true,
    doc: doc(
      quote(
        h(3, t('Quoted heading')),
        p(t('Quoted '), t('text', bold)),
        code('js', 'quoted()'),
        table(row(th(t('a'))), row(td(t('1')))),
        hr,
      ),
    ),
  },
  {
    name: 'nested-blockquote',
    lossless: true,
    doc: doc(quote(p(t('Outer')), quote(p(t('Inner, one paragraph'))), p(t('Outer again')))),
  },
  { name: 'empty-blockquote', lossless: true, doc: doc(quote(p())) },
  {
    name: 'blockquote-with-breaks',
    lossless: true,
    doc: doc(
      quote(p(t('line one'), br, t('line two'))),
      quote(p(t('x')), quote(p(t('a'), br, t('b')))),
    ),
  },
  {
    name: 'adjacent-blockquotes',
    lossless: true,
    doc: doc(quote(p(t('first'))), quote(p(t('second')))),
  },
  // Rules ---------------------------------------------------------------------------------------
  {
    name: 'horizontal-rule',
    lossless: true,
    doc: doc(p(t('Above')), hr, p(t('Below')), hr),
  },
  { name: 'only-a-rule', lossless: true, doc: doc(hr) },
  // Panels --------------------------------------------------------------------------------------
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
      panel('custom', p(t('A custom panel.'))),
    ),
  },
  {
    name: 'panel-blocks',
    lossless: true,
    doc: doc(
      panel(
        'warning',
        h(4, t('Before you upgrade')),
        quote(p(t('Back up first.'))),
        code('bash', 'cli.mjs backup'),
        table(row(td(t('step')), td(t('1')))),
      ),
    ),
  },
  { name: 'empty-panel', lossless: true, doc: doc(panel('note', p())) },
  {
    name: 'quote-and-panel-nesting',
    lossless: true,
    doc: doc(
      quote(panel('info', p(t('panel in a quote')))),
      panel('tip', quote(p(t('quote in a panel')))),
    ),
  },
  // Tables --------------------------------------------------------------------------------------
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
        row(td(t('timeout', mono)), td(t('30 s', bold)), td(t('see '), t('docs', site))),
        row(td(t('pipe | inside')), td(t('a'), br, t('b')), td(mention('3'))),
      ),
    ),
  },
  {
    name: 'table-empty-cells',
    lossless: true,
    doc: doc(table(row(th(t('A')), th(), th(t('C'))), row(td(), td(t('only middle')), td()))),
  },
  {
    name: 'table-without-header',
    lossless: true,
    doc: doc(table(row(td(t('a')), td(t('b'))), row(td(t('c')), td(t('d'))))),
  },
  {
    name: 'table-header-column',
    lossless: true,
    doc: doc(
      table(
        row(th(t('Region')), td(t('north')), td(t('south'))),
        row(th(t('Load')), td(t('40%')), td(t('70%'))),
      ),
    ),
  },
  {
    name: 'table-ragged-rows',
    lossless: true,
    doc: doc(table(row(th(t('one')), th(t('two')), th(t('three'))), row(td(t('short'))))),
  },
  {
    name: 'table-cell-edges',
    lossless: true,
    doc: doc(
      table(
        row(td(t(' padded ')), td(t('ends with \\')), td(t('|starts with pipe'))),
        row(td(t('[link-like]|x')), td(t('{{not code}}')), td(t('!not image!'))),
      ),
    ),
  },
  {
    name: 'table-links',
    lossless: true,
    doc: doc(
      table(
        row(
          td(t('a', link('https://example.test/a?b=c'))),
          td(t('b', site), t(' | ')),
          td(t('https://example.test/s', link('https://example.test/s'))),
        ),
      ),
    ),
  },
  {
    name: 'adjacent-tables',
    lossless: true,
    doc: doc(table(row(td(t('1')))), table(row(td(t('2'))))),
  },
  // Realistic documents ------------------------------------------------------------------------
  {
    name: 'bug-report',
    lossless: true,
    doc: doc(
      h(2, t('Summary')),
      p(
        t('Saving a filter with a '),
        t('long', italic),
        t(' name fails with '),
        t('413', mono),
        t('.'),
      ),
      h(3, t('Steps')),
      ol(
        [p(t('Open '), t('Filters', bold))],
        [p(t('Type a name of 300 characters'))],
        [p(t('Save'))],
      ),
      h(3, t('Expected')),
      p(t('The filter is saved, or the form says the name is too long.')),
      h(3, t('Logs')),
      code('text', 'POST /api/v1/filters 413\n  body: 2.1 MB'),
      p(t('Reported by '), mention('12'), t(' — see '), t('the thread', site), t('.')),
    ),
  },
  {
    name: 'release-notes',
    lossless: true,
    doc: doc(
      h(1, t('Release 1.4')),
      panel('info', p(t('Upgrade with '), t('upgrade.sh', mono), t('; it backs up first.'))),
      h(2, t('New')),
      ul(
        [p(t('Boards: ')), ul([p(t('swimlanes by '), t('assignee', italic))])],
        [p(t('Search: saved filters can be shared'))],
      ),
      h(2, t('Fixed')),
      ul([p(t('Exports of 10,000+ tickets no longer time out'))]),
      hr,
      p(t('Thanks to everyone who reported issues.', italic)),
    ),
  },
  {
    name: 'meeting-notes',
    lossless: true,
    doc: doc(
      h(2, t('Planning, week 44')),
      table(
        row(th(t('Item')), th(t('Owner')), th(t('Due'))),
        row(td(t('Importer')), td(mention('5')), td(t('Fri'))),
      ),
      h(3, t('Decisions')),
      quote(p(t('We freeze the schema on Thursday.'))),
      h(3, t('Actions')),
      tasks([false, p(t('Write the ADR'))], [true, p(t('Book the room'))]),
    ),
  },
  {
    name: 'runbook',
    lossless: true,
    doc: doc(
      panel('warning', p(t('Only on-call engineers run these steps.', bold))),
      ol(
        [
          p(t('Check the queue depth:')),
          ul([p(t('below 1,000: wait'))], [p(t('above: page the owner'))]),
        ],
        [p(t('Restart the worker'))],
      ),
      code('bash', 'kubectl rollout restart deploy/worker\nkubectl get pods -w'),
      p(t('If it fails again, open an incident and link it here: '), t('incidents', site)),
    ),
  },
  {
    name: 'support-reply',
    lossless: true,
    doc: doc(
      p(t('Hi,')),
      p(t('Thanks for the details. The fix is in '), t('1.4.2', bold), t(', out on Monday.')),
      p(t('Until then:'), br, t('1. turn off the sync'), br, t('2. export by hand')),
      p(t('Regards,'), br, t('Support')),
    ),
  },
  {
    name: 'spec-excerpt',
    lossless: true,
    doc: doc(
      h(2, t('Ranking')),
      p(
        t('Each ticket has a rank '),
        t('r', italic),
        t(' with 0 ≤ r < 1; moving a ticket sets r to the mean of its neighbours.'),
      ),
      p(t('Complexity is O(n'), t('2', sup), t(') in the worst case, O(log n) on average.')),
      table(
        row(th(t('Case')), th(t('Cost'))),
        row(td(t('best')), td(t('O(1)', mono))),
        row(td(t('worst')), td(t('O(n)', mono))),
      ),
    ),
  },
  // Documented losses --------------------------------------------------------------------------
  {
    name: 'empty-paragraphs',
    lossless: false,
    doc: doc(p(), p(t('between')), p(), p()),
  },
  {
    name: 'mention-labels',
    lossless: false,
    doc: doc(p(named('42', 'Kalo Smith'), t(' and '), named('7', 'Mi'))),
  },
  {
    name: 'mention-odd-id',
    lossless: false,
    doc: doc(p(named('user:odd id/1', 'Odd'), t(' has an id the markup cannot carry.'))),
  },
  {
    name: 'emoji-date-status',
    lossless: false,
    doc: fromAdfJson(
      adfDoc([
        {
          type: 'paragraph',
          content: [
            { type: 'emoji', attrs: { shortName: ':slight_smile:', text: '🙂' } },
            { type: 'text', text: ' due ' },
            { type: 'date', attrs: { timestamp: '1772582400000' } },
            { type: 'text', text: ' ' },
            { type: 'status', attrs: { text: 'OPEN', color: 'blue' } },
            { type: 'emoji', attrs: { shortName: ':party:' } },
          ],
        },
      ]),
    ),
  },
  {
    name: 'ordered-list-start',
    lossless: false,
    doc: doc(olFrom(3, [p(t('Third step'))], [p(t('Fourth step'))])),
  },
  {
    name: 'list-item-blocks',
    lossless: false,
    doc: doc(
      ul(
        [p(t('First paragraph')), p(t('Second paragraph'))],
        [p(t('With code')), code('js', 'run()\nstop()')],
        [p(t('With a quote')), quote(p(t('quoted'))), ul([p(t('and a nested list'))])],
      ),
    ),
  },
  {
    name: 'table-merged-cells',
    lossless: false,
    doc: doc(
      table(
        row(cell('tableHeader', [p(t('Merged'))], { colspan: 2 }), th(t('C'))),
        row(td(t('a')), td(t('b')), cell('tableCell', [p(t('tall'))], { rowspan: 2 })),
        row(td(t('c')), td(t('d'))),
      ),
    ),
  },
  {
    name: 'table-block-cells',
    lossless: false,
    doc: doc(
      table(
        row(
          cell('tableCell', [p(t('first')), p(t('second'))]),
          cell('tableCell', [ul([p(t('one'))], [p(t('two'))])]),
          cell('tableCell', [code('sql', 'SELECT 1;\nSELECT 2;')]),
        ),
      ),
    ),
  },
  {
    name: 'table-column-widths',
    lossless: false,
    doc: doc(table(row(cell('tableHeader', [p(t('Wide'))], { colwidth: [300] }), th(t('Narrow'))))),
  },
  {
    name: 'nested-quote-blocks',
    lossless: false,
    doc: doc(quote(p(t('outer')), quote(p(t('inner one')), p(t('inner two'))))),
  },
  {
    name: 'panel-in-panel',
    lossless: false,
    doc: doc(panel('warning', p(t('outer')), panel('info', p(t('inner'))))),
  },
  {
    name: 'code-with-marks',
    lossless: false,
    doc: doc(
      p(t('bold code', mono, bold)),
      p(t('linked code', mono, site)),
      p(t('struck code', mono, strike), t(' plain')),
    ),
  },
  {
    name: 'marked-breaks',
    lossless: false,
    doc: doc(p(t('a', bold), { type: 'hardBreak', marks: [bold] }, t('b', bold))),
  },
  {
    name: 'text-line-feeds',
    lossless: false,
    doc: doc(p(t('a line feed\ninside text')), h(2, t('heading\nwith one'))),
  },
  {
    name: 'addresses-in-text',
    lossless: false,
    doc: doc(p(t('See https://example.test/page and mailto:ops@example.test for more.'))),
  },
  {
    name: 'link-details',
    lossless: false,
    doc: fromAdfJson(
      adfDoc([
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'titled',
              marks: [
                { type: 'link', attrs: { href: 'https://example.test/t', title: 'A title' } },
              ],
            },
            { type: 'text', text: ' and ' },
            {
              type: 'text',
              text: 'odd address',
              marks: [{ type: 'link', attrs: { href: ' https://example.test/a [b] ' } }],
            },
          ],
        },
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
        t('script', link('javascript:alert(1)')),
        t(' and '),
        t('styled', color('expression(alert(1))')),
        t(' and '),
        t('empty', link('')),
      ),
      code('two words', 'echo hi'),
      code('a}b', 'echo there'),
    ),
  },
  {
    name: 'code-block-own-tags',
    lossless: false,
    doc: doc(code('wiki', 'use {code} to start'), code(null, 'both {code} and {noformat}')),
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
            { type: 'inlineCard', attrs: { url: 'https://example.test/card', localId: 'c1' } },
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
          type: 'panel',
          attrs: { panelType: 'note', localId: 'pn' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Kept as a panel.' }] }],
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
  {
    // The media node's size, alt text and marks are the other format's own: the markup drops them.
    name: 'imported-attachment',
    lossless: false,
    doc: fromAdfJson(
      adfDoc([
        {
          type: 'mediaSingle',
          attrs: { layout: 'center' },
          content: [
            {
              type: 'media',
              attrs: {
                type: 'file',
                id: 'login.png',
                collection: 'taskmoor-attachments',
                width: 640,
                height: 480,
                alt: 'Login',
              },
              marks: [{ type: 'border', attrs: { size: 2 } }],
            },
          ],
        },
      ]),
    ),
  },
];

// Families ---------------------------------------------------------------------------------------

const MARKS: [string, Mark][] = [
  ['bold', bold],
  ['italic', italic],
  ['strike', strike],
  ['underline', underline],
  ['sup', sup],
  ['sub', sub],
  ['color', red],
  ['link', site],
];

/** Each mark alone: on a whole paragraph, at its start, inside a word and at its end. */
const MARK_POSITIONS: CorpusDocument[] = [...MARKS, ['code', mono] as [string, Mark]].flatMap(
  ([name, mark]) => [
    { name: `mark-${name}-whole`, lossless: true, doc: doc(p(t('the whole paragraph', mark))) },
    {
      name: `mark-${name}-start`,
      lossless: true,
      doc: doc(p(t('Start', mark), t(' of the line and more.'))),
    },
    {
      name: `mark-${name}-in-word`,
      lossless: true,
      doc: doc(p(t('word'), t('inside', mark), t('word and '), t('9', mark), t('9'))),
    },
    {
      name: `mark-${name}-end`,
      lossless: true,
      doc: doc(
        p(t('The line ends with '), t('it', mark)),
        p(t('Then '), t('punctuation', mark), t('.')),
      ),
    },
  ],
);

/** Every pair of marks: overlapping on one run, then one of them continuing alone. */
const MARK_PAIRS: CorpusDocument[] = MARKS.flatMap(([a, ma], i) =>
  MARKS.slice(i + 1)
    .filter(([b]) => !((a === 'sup' && b === 'sub') || (a === 'sub' && b === 'sup')))
    .map(([b, mb]) => ({
      name: `marks-${a}-${b}`,
      lossless: true,
      doc: doc(
        p(t('plain '), t('first', ma), t(' both', ma, mb), t(' second', mb), t(' end')),
        p(t('together', ma, mb)),
      ),
    })),
);

/** Characters the markup uses, in every place text can be. */
const CHARACTERS: [string, string][] = [
  ['star', '*'],
  ['underscore', '_'],
  ['dash', '-'],
  ['plus', '+'],
  ['caret', '^'],
  ['tilde', '~'],
  ['open-brace', '{'],
  ['close-brace', '}'],
  ['open-bracket', '['],
  ['close-bracket', ']'],
  ['pipe', '|'],
  ['bang', '!'],
  ['hash', '#'],
  ['ampersand', '&'],
  ['backslash', '\\'],
  ['question', '?'],
];

const CHARACTER_PLACES: CorpusDocument[] = CHARACTERS.map(([name, c]) => ({
  name: `character-${name}`,
  lossless: true,
  doc: doc(
    p(t(`${c}start, mid${c}word, spaced ${c} out, double ${c}${c}, around ${c}x${c}, end${c}`)),
    p(t(`${c} `), t(`bold ${c}inside${c}`, bold), t(` ${c}`), t(`it${c}`, italic), t(`${c}`)),
    h(3, t(`${c}heading ${c}`)),
    ul([p(t(`${c}item${c}`))], [p(t(`${c} spaced`))]),
    table(row(th(t(`${c}head${c}`)), td(t(`${c}cell${c}`)))),
    p(t(`link ${c}text${c}`, site), t(' and '), t(`code ${c}${c}`, mono)),
    quote(p(t(`${c}quoted${c}`))),
  ),
}));

/** Text that looks like a block start, as a paragraph and after a line break. */
const LOOKALIKES: [string, string][] = [
  ['h1', 'h1. text'],
  ['h6', 'h6.'],
  ['bq', 'bq. text'],
  ['star-item', '* text'],
  ['stars-item', '*** text'],
  ['hash-item', '# text'],
  ['mixed-item', '#* text'],
  ['dash-item', '- text'],
  ['rule', '----'],
  ['long-rule', '--------'],
  ['row', '|a|b|'],
  ['header-row', '||a||'],
  ['code-tag', '{code:java}'],
  ['quote-tag', '{quote}'],
  ['panel-tag', '{panel:title=x}'],
  ['noformat-tag', '{noformat}'],
  ['info-tag', '{info}'],
];

const LINE_LOOKALIKES: CorpusDocument[] = LOOKALIKES.map(([name, text]) => ({
  name: `lookalike-${name}`,
  lossless: true,
  doc: doc(p(t(text)), p(t('before'), br, t(text)), quote(p(t(text))), panel('info', p(t(text)))),
}));

/** Each kind of block inside each container. */
const BLOCKS: [string, PmJson][] = [
  ['paragraph', p(t('a '), t('marked', bold), t(' paragraph'))],
  ['heading', h(2, t('a heading'))],
  ['bullets', ul([p(t('one'))], [p(t('two')), ul([p(t('nested'))])])],
  ['numbers', ol([p(t('one'))], [p(t('two'))])],
  ['checklist', tasks([true, p(t('done'))], [false, p(t('open'))])],
  ['code', code('ts', 'const a = 1;')],
  ['table', table(row(th(t('h'))), row(td(t('c'))))],
  ['rule', hr],
];

const CONTAINERS: [string, (block: PmJson) => PmJson][] = [
  ['quote', (b) => quote(p(t('before')), b, p(t('after')))],
  ['panel', (b) => panel('note', p(t('before')), b, p(t('after')))],
];

const IN_CONTAINERS: CorpusDocument[] = CONTAINERS.flatMap(([container, wrap]) =>
  BLOCKS.map(([block, node]) => ({
    name: `${block}-in-${container}`,
    lossless: true,
    doc: doc(wrap(node)),
  })),
);

/** Each panel type alone, with a list in it. */
const PANEL_TYPES: CorpusDocument[] = [
  'info',
  'note',
  'tip',
  'warning',
  'error',
  'success',
  'custom',
].map((type) => ({
  name: `panel-${type}`,
  lossless: true,
  doc: doc(panel(type, p(t(`A ${type} panel.`)), ul([p(t('with a list'))]))),
}));

/** Each heading level with marks and a link. */
const HEADING_LEVELS: CorpusDocument[] = [1, 2, 3, 4, 5, 6].map((level) => ({
  name: `heading-level-${level}`,
  lossless: true,
  doc: doc(
    h(level, t('Level '), t(String(level), bold), t(' see '), t('docs', site)),
    p(t('body')),
  ),
}));

/** List shapes: depth, kind and mixtures. */
const LIST_SHAPES: CorpusDocument[] = [
  {
    name: 'list-numbered-in-bullet',
    lossless: true,
    doc: doc(ul([p(t('a')), ol([p(t('1'))], [p(t('2'))])])),
  },
  {
    name: 'list-bullet-in-numbered',
    lossless: true,
    doc: doc(ol([p(t('1')), ul([p(t('a'))], [p(t('b'))])])),
  },
  {
    name: 'list-alternating-depth',
    lossless: true,
    doc: doc(ol([p(t('1')), ul([p(t('a')), ol([p(t('i')), ul([p(t('x'))])])])], [p(t('2'))])),
  },
  {
    name: 'list-back-to-top',
    lossless: true,
    doc: doc(
      ul([p(t('a')), ul([p(t('b')), ul([p(t('c'))])])], [p(t('d'))], [p(t('e')), ul([p(t('f'))])]),
    ),
  },
  {
    name: 'list-many-items',
    lossless: true,
    doc: doc(ol(...Array.from({ length: 25 }, (_, i) => [p(t(`item ${i + 1}`))]))),
  },
  {
    name: 'list-empty-parent',
    lossless: true,
    doc: doc(ul([p(), ul([p(t('child of an empty item'))])])),
  },
  {
    name: 'checklist-in-checklist-in-numbered',
    lossless: true,
    doc: doc(ol([p(t('n')), tasks([false, p(t('t')), tasks([true, p(t('tt'))])])])),
  },
  {
    name: 'list-then-checklist',
    lossless: true,
    doc: doc(ul([p(t('bullet'))]), tasks([true, p(t('task'))]), ol([p(t('number'))])),
  },
];

/** Tables with every mark in a cell, header and body. */
const TABLE_MARKS: CorpusDocument[] = MARKS.map(([name, mark]) => ({
  name: `table-cell-${name}`,
  lossless: true,
  doc: doc(table(row(th(t('h '), t(name, mark))), row(td(t(name, mark), t(' c'))))),
}));

export const DOCUMENTS: CorpusDocument[] = [
  ...HAND,
  ...MARK_POSITIONS,
  ...MARK_PAIRS,
  ...CHARACTER_PLACES,
  ...LINE_LOOKALIKES,
  ...IN_CONTAINERS,
  ...PANEL_TYPES,
  ...HEADING_LEVELS,
  ...LIST_SHAPES,
  ...TABLE_MARKS,
];

export interface CorpusSource {
  name: string;
  wiki: string;
}

export const SOURCES: CorpusSource[] = [
  {
    name: 'ticket-description',
    wiki: [
      'h2. Problem',
      '',
      'The *export* fails for _large_ boards.',
      'It started on Monday.',
      '',
      '* Chrome',
      '* Firefox',
      '** only on Linux',
      '',
      '{code:java}',
      'throw new IllegalStateException("too big");',
      '{code}',
    ].join('\n'),
  },
  { name: 'bare-code', wiki: '{code}\nplain\n{code}' },
  {
    name: 'code-params',
    wiki: '{code:title=Main.java|borderStyle=solid|language=java}\nclass Main {}\n{code}',
  },
  { name: 'code-one-line', wiki: 'Before\n{code:sql}SELECT 1;{code} after on the same line' },
  { name: 'noformat-params', wiki: '{noformat:nopanel=true}\n  keep   spacing\n{noformat}' },
  { name: 'unclosed-code', wiki: '{code:js}\nconst a = 1;' },
  { name: 'bq-lines', wiki: 'bq. A quoted paragraph\nthat goes on.\n\nNot quoted.' },
  { name: 'quote-inline-tags', wiki: '{quote}quoted on one line{quote}' },
  {
    name: 'panel-title',
    wiki: '{panel:title=Heads up|borderStyle=dashed}\nRead this first.\n{panel}',
  },
  {
    name: 'panel-colors',
    wiki: '{panel:bgColor=#FFEBE6}\nred\n{panel}\n\n{panel:bgColor=#e3fcef}\ngreen\n{panel}',
  },
  {
    name: 'confluence-style-panels',
    wiki: '{info}info{info}\n{note}note{note}\n{tip}tip{tip}\n{warning}warning{warning}',
  },
  { name: 'nested-panels', wiki: '{panel}\nouter\n{info}\ninner\n{info}\n{panel}' },
  { name: 'dash-bullets', wiki: '- first\n- second' },
  { name: 'mixed-markers', wiki: '# one\n#* bullet under one\n#*# number under that\n# two' },
  { name: 'skipped-levels', wiki: '* top\n*** three levels down' },
  { name: 'list-continuation', wiki: '* item\ncontinues here\n* next' },
  { name: 'checklists', wiki: '* [ ] open\n* [x] done\n* [X] also done' },
  { name: 'half-checklist', wiki: '* [x] done\n* plain' },
  { name: 'tables', wiki: '||Name||Value||\n|a|1|\n| b | 2 |\n|c|[link|https://example.test/c]|' },
  { name: 'table-unclosed-row', wiki: '|a|b\n|c|d|' },
  { name: 'table-image-cell', wiki: '|!shot.png|thumbnail!|x|' },
  {
    name: 'link-forms',
    wiki: '[https://example.test] [Text|https://example.test/t] [mailto:a@example.test] [#anchor] [^attachment.pdf]',
  },
  { name: 'link-tooltip', wiki: '[Docs|https://example.test/docs|The docs]' },
  { name: 'unsafe-link', wiki: '[click|javascript:alert(1)] and [vbscript:x]' },
  { name: 'mention-forms', wiki: '[~accountid:557058:abc] and [~kalo] and [~]' },
  { name: 'images', wiki: '!https://example.test/a.png! and !screenshot.png|width=300!' },
  {
    name: 'colors',
    wiki: '{color:red}red{color} {color:#36B37E}green{color} {color:url(x)}not{color}',
  },
  { name: 'braced-marks', wiki: 'intra{*}word{*} and {_}it{_}alic and x{^}2{^}' },
  { name: 'intraword-markers', wiki: 'snake_case_name and a*b*c and 2^3^ and H~2~O' },
  { name: 'citation-and-dashes', wiki: '??cited?? text -- and --- dashes' },
  { name: 'breaks', wiki: 'one\\\\two\nthree\n\n\\\\' },
  { name: 'escapes', wiki: '\\*not bold\\* \\[not link\\] \\{not macro\\} \\\\ \\x' },
  { name: 'references', wiki: '&#65;&#x42; &#0; &#xD800; &amp;' },
  {
    name: 'addresses',
    wiki: 'See https://example.test/a_b, then (https://example.test/c). Mail mailto:x@example.test!',
  },
  { name: 'windows-newlines', wiki: 'h1. Title\r\n\r\nline one\r\nline two\r\n' },
  { name: 'stray-tags', wiki: '{quote} alone\n\nthen {code} mid-line and {panel}' },
  {
    name: 'monospace-edges',
    wiki: '{{}} and {{ spaced }} and {{*bold*}} and {{[x|https://example.test]}}',
  },
  { name: 'unclosed-markers', wiki: '*open bold and _open italic and {color:red}open colour' },
  { name: 'empty', wiki: '' },
  { name: 'only-blank-lines', wiki: '\n\n   \n\t\n' },
  // A tab and other control characters in a section title read as spaces (NTF-014).
  { name: 'section-title-controls', wiki: '{expand:Step\t1\u0007 of\u001b 2}\nBody.\n{expand}' },
  // Columns written by hand (TT-3): upper case, widths without `%`, no blank lines.
  {
    name: 'section-by-hand',
    wiki: '{SECTION}\n{column:width=30}\nLeft\n{column}\n{Column}\nRight\n{column}\n{section}',
  },
  // A section with text beside its columns, a column alone, and seven columns: no layout.
  {
    name: 'sections-that-are-not-layouts',
    wiki: [
      '{section}\nText first.\n{column}\nA\n{column}\n{section}',
      '{column}\nAlone.\n{column}',
      `{section}\n${Array.from({ length: 7 }, (_, i) => `{column}\n${i}\n{column}`).join('\n')}\n{section}`,
    ].join('\n\n'),
  },
  // Files of the ticket, alone in a paragraph; an address and a file among text stay links.
  {
    name: 'file-forms',
    wiki: '!shot.png|thumbnail!\n\n[^report.pdf]\n\n!https://example.test/a.png!\n\nSee [^notes.pdf] and !b.png!',
  },
  // A link to a ticket whose text is not its key stays a link.
  {
    name: 'ticket-links',
    wiki: '[PAY-42|/browse/PAY-42] [the bug|/browse/PAY-43] [PAY-44|/browse/X-1]',
  },
];
