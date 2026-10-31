import { expectWithinBudget } from '@taskmoor/testkit/budget';
import { stableJson } from '@taskmoor/testkit/golden';
import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { canonicalAdf } from './adf';
import { fromAdfJson, type PmJson, toAdfFromJson } from './convert';
import { schema } from './schema';
import { generateAdfDocument } from './testing';
import { fromWiki, toPlainText, toWiki } from './wiki';
import { DOCUMENTS, SOURCES } from './wiki-corpus';

/** A document as the schema stores it: defaults filled in, equal text runs merged. */
const normal = (doc: PmJson): PmJson => schema.nodeFromJSON(doc).toJSON() as PmJson;

/** The same document without the other format's own attributes, which wiki markup drops. */
function bare(node: PmJson): PmJson {
  const out: PmJson = { ...node };
  if (node.attrs && 'adfAttrs' in node.attrs) out.attrs = { ...node.attrs, adfAttrs: null };
  if (node.marks) {
    out.marks = node.marks.map((m) =>
      m.attrs && 'adfAttrs' in m.attrs ? { ...m, attrs: { ...m.attrs, adfAttrs: null } } : m,
    );
  }
  if (node.content) out.content = node.content.map(bare);
  return out;
}

/**
 * Documents the document format itself cannot carry whole (a list nested in a checklist item
 * flattens into the item's text there), so the two formats are not compared on them.
 */
const ADF_LOSSY = new Set(
  DOCUMENTS.filter(({ doc }) => {
    const back = bare(fromAdfJson(toAdfFromJson(normal(doc))));
    return JSON.stringify(back) !== JSON.stringify(bare(normal(doc)));
  }).map((d) => d.name),
);

describe('Wiki markup round trip (corpus)', () => {
  it('[API-011] holds at least 200 documents and 30 sources', () => {
    expect(DOCUMENTS.length).toBeGreaterThanOrEqual(200);
    expect(SOURCES.length).toBeGreaterThanOrEqual(30);
    expect(DOCUMENTS.filter((d) => d.lossless).length).toBeGreaterThanOrEqual(180);
    expect(new Set([...DOCUMENTS, ...SOURCES].map((d) => d.name)).size).toBe(
      DOCUMENTS.length + SOURCES.length,
    );
    // Lossless documents are ones the editor can hold; some lossy ones come from imports.
    for (const { doc } of DOCUMENTS.filter((d) => d.lossless)) schema.nodeFromJSON(doc).check();
  });

  for (const entry of DOCUMENTS) {
    it(`[API-011] ${entry.name}: ${entry.lossless ? 'comes back unchanged' : 'loses only what is documented'}`, async () => {
      const wiki = toWiki(entry.doc);
      await expect(wiki).toMatchFileSnapshot(`./__golden__/wiki/${entry.name}.wiki`);
      const back = fromWiki(wiki);
      schema.nodeFromJSON(back).check();
      // Whatever was lost, the markup we write is stable from then on.
      expect(toWiki(back)).toBe(wiki);
      if (entry.lossless) {
        expect(back).toEqual(normal(entry.doc));
      } else {
        await expect(stableJson(back)).toMatchFileSnapshot(`./__golden__/wiki/${entry.name}.json`);
      }
      // Version 2 (wiki markup) and version 3 (the document format) carry the same content:
      // a trip through the document format changes nothing the markup shows, and what comes
      // back from the markup writes the same document as the original.
      const viaAdf = fromAdfJson(toAdfFromJson(normal(entry.doc)));
      if (ADF_LOSSY.has(entry.name)) return;
      expect(toWiki(viaAdf), 'wiki after the document format').toBe(wiki);
      if (entry.lossless) {
        expect(canonicalAdf(toAdfFromJson(back))).toEqual(
          canonicalAdf(toAdfFromJson(normal(entry.doc))),
        );
        expect(bare(fromAdfJson(toAdfFromJson(back)))).toEqual(bare(viaAdf));
      }
    });
  }

  for (const entry of SOURCES) {
    it(`[API-011] reads ${entry.name} and writes it back in a stable form`, async () => {
      const doc = fromWiki(entry.wiki);
      schema.nodeFromJSON(doc).check();
      await expect(stableJson(doc)).toMatchFileSnapshot(
        `./__golden__/wiki/source-${entry.name}.json`,
      );
      const wiki = toWiki(doc);
      await expect(wiki).toMatchFileSnapshot(`./__golden__/wiki/source-${entry.name}.wiki`);
      expect(fromWiki(wiki)).toEqual(doc);
      expect(toWiki(fromWiki(wiki))).toBe(wiki);
    });
  }
});

// Properties ---------------------------------------------------------------------------------------

/** Text full of the markup's own characters and tokens. */
const textArb = fc
  .array(
    fc.constantFrom(
      ...'ab1 *_-+^~{}[]|!#&\\?.,:;()h9é\t'.split(''),
      '😀',
      'h1. ',
      'bq. ',
      '----',
      '{code}',
      '{quote}',
      '{panel}',
      '{color:red}',
      '{{',
      '}}',
      '&#92;',
      '\\\\',
      '[~',
      '* ',
      '# ',
      '- ',
      '||',
      '[x] ',
      '{*}',
      '!a.png!',
      ' ',
    ),
    { minLength: 1, maxLength: 12 },
  )
  .map((parts) => parts.join(''));

const MARK_CHOICES = [
  { type: 'bold' },
  { type: 'italic' },
  { type: 'strike' },
  { type: 'underline' },
  { type: 'subsup', attrs: { type: 'sup' } },
  { type: 'textColor', attrs: { color: '#ff5630' } },
  { type: 'link', attrs: { href: 'https://example.test/x', target: null, rel: null, class: null } },
];

const inlineArb = fc.array(
  fc.oneof(
    {
      weight: 6,
      arbitrary: fc
        .record({ text: textArb, marks: fc.subarray(MARK_CHOICES) })
        .map(
          ({ text, marks }): PmJson =>
            marks.length ? { type: 'text', text, marks } : { type: 'text', text },
        ),
    },
    {
      weight: 1,
      arbitrary: textArb.map((text): PmJson => ({ type: 'text', text, marks: [{ type: 'code' }] })),
    },
    { weight: 1, arbitrary: fc.constant<PmJson>({ type: 'hardBreak' }) },
    {
      weight: 1,
      arbitrary: fc.constant<PmJson>({ type: 'mention', attrs: { id: '7', label: null } }),
    },
  ),
  { minLength: 1, maxLength: 6 },
);

/** The places inline content can be. */
function place(kind: number, inline: PmJson[]): PmJson {
  const para: PmJson = { type: 'paragraph', content: inline };
  switch (kind) {
    case 0:
      return { type: 'heading', attrs: { level: 3 }, content: inline };
    case 1:
      return { type: 'bulletList', content: [{ type: 'listItem', content: [para] }] };
    case 2:
      return {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [para] },
              { type: 'tableCell', content: [para] },
            ],
          },
        ],
      };
    case 3:
      return { type: 'blockquote', content: [para, { type: 'blockquote', content: [para] }] };
    case 4:
      return {
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: true }, content: [para] }],
      };
    case 5:
      return { type: 'panel', attrs: { panelType: 'tip' }, content: [para] };
    default:
      return para;
  }
}

describe('Wiki markup round trip (properties)', () => {
  it('[API-011] keeps any text with any marks in any place', () => {
    fc.assert(
      fc.property(inlineArb, fc.integer({ min: 0, max: 6 }), (inline, kind) => {
        const doc: PmJson = { type: 'doc', content: [place(kind, inline)] };
        // Addresses in text read back as links: that loss is documented, not tested here.
        fc.pre(
          !/https?:|mailto:/i.test(JSON.stringify(inline).replaceAll('https://example.test/x', '')),
        );
        const want = normal(doc);
        expect(fromWiki(toWiki(want))).toEqual(want);
      }),
    );
  });

  it('[API-011] writes back any markup in a stable form', () => {
    const pieces = fc.constantFrom(
      ...[
        'a',
        'b ',
        ' ',
        '\n',
        '\n\n',
        '*',
        '_',
        '-',
        '+',
        '^',
        '~',
        '{',
        '}',
        '[',
        ']',
        '|',
        '||',
      ],
      ...['!', '#', '&', '\\', '\\\\', 'h1. ', 'h3.', 'bq. ', '----', '{code}', '{code:js}'],
      ...['{noformat}', '{quote}', '{panel}', '{panel:bgColor=#ffebe6}', '{info}', '{color}'],
      ...['{color:red}', '{{', '}}', '&#92;', '[~accountid:5]', '[x|http://e.test]'],
      ...['[http://e.test]', '* ', '** ', '# ', '#* ', '- ', '[x] ', '[ ] ', '{*}', '!a.png!'],
      ...['http://e.test/p ', 'mailto:a@e.test', '\t', 'é', '😀', '1'],
    );
    fc.assert(
      fc.property(fc.array(pieces, { maxLength: 30 }), (parts) => {
        const doc = fromWiki(parts.join(''));
        schema.nodeFromJSON(doc).check();
        const wiki = toWiki(doc);
        expect(fromWiki(wiki)).toEqual(doc);
        expect(toWiki(fromWiki(wiki))).toBe(wiki);
      }),
    );
  });

  it('[API-011] reaches a fixed point for any synthetic imported document', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const once = fromWiki(toWiki(fromAdfJson(generateAdfDocument(seed))));
        schema.nodeFromJSON(once).check();
        const wiki = toWiki(once);
        expect(fromWiki(wiki)).toEqual(once);
        expect(toWiki(fromWiki(wiki))).toBe(wiki);
      }),
    );
  });
});

describe('Wiki markup details', () => {
  it('[API-011] reads wiki markup into content that exports to the document format', () => {
    const doc = fromWiki('h2. Plan\n\n* [x] ship *it*\n\nPing [~accountid:12].');
    expect(toAdfFromJson(doc)).toEqual({
      version: 1,
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { state: 'DONE' },
              content: [
                { type: 'text', text: 'ship ' },
                { type: 'text', text: 'it', marks: [{ type: 'strong' }] },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ping ' },
            { type: 'mention', attrs: { id: '12' } },
            { type: 'text', text: '.' },
          ],
        },
      ],
    });
  });

  it('[API-011] reads an empty text as an empty document', () => {
    expect(fromWiki('')).toEqual(normal({ type: 'doc', content: [{ type: 'paragraph' }] }));
    expect(toWiki(fromWiki(''))).toBe('');
  });

  it('[API-011] nests lists only as deep as it can hold', () => {
    const doc = fromWiki(`${'*'.repeat(500)} deep`);
    let depth = 0;
    let node: PmJson | undefined = doc.content?.[0];
    while (node) {
      depth++;
      node = node.content?.[0]?.content?.find((c) => c.type === 'bulletList');
    }
    expect(depth).toBe(20);
  });

  it('[API-011] reads large inputs in linear time', () => {
    // Markers that never close must not make the reader search again from each one.
    const started = performance.now();
    fromWiki(`${'*a _b -c '.repeat(20_000)}\n\n${'[x '.repeat(20_000)}`);
    expectWithinBudget(
      performance.now() - started,
      2_000,
      'reading 360 kB of unclosed markup (ms)',
    );
  });

  it('rejects a root that is not a document', () => {
    expect(() => toWiki({ type: 'paragraph' })).toThrow(/Expected a doc node/);
    expect(() => toPlainText({ type: 'paragraph' })).toThrow(/Expected a doc node/);
  });
});

describe('Plain text', () => {
  it('[API-011] strips formatting for ETL use', () => {
    const doc = fromWiki(
      [
        'h2. Plan',
        '',
        'Ship *it* on _Friday_ with [~accountid:7] and [the docs|https://example.test].',
        'Second line',
        '',
        '* one',
        '** nested',
        '# two',
        '',
        '||a||b||',
        '|1|2|',
        '',
        '{code:sql}',
        'SELECT 1;',
        '{code}',
        '',
        '{quote}',
        'quoted',
        '{quote}',
        '',
        '----',
      ].join('\n'),
    );
    expect(toPlainText(doc)).toBe(
      [
        'Plan',
        '',
        'Ship it on Friday with @7 and the docs.',
        'Second line',
        '',
        'one',
        '  nested',
        '',
        'two',
        '',
        'a\tb',
        '1\t2',
        '',
        'SELECT 1;',
        '',
        'quoted',
      ].join('\n'),
    );
    expect(toPlainText(fromWiki(''))).toBe('');
  });
});
