import { stableJson } from '@taskmoor/testkit/golden';
import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { fromAdfJson, type PmJson, toAdfFromJson } from './convert';
import { fromMarkdown, isSafeHref, looksLikeMarkdown, toMarkdown } from './markdown';
import { DOCUMENTS, SOURCES } from './markdown-corpus';
import { schema } from './schema';
import { generateAdfDocument } from './testing';
import { toWiki } from './wiki';

/** A document as the schema stores it: defaults filled in, equal text runs merged. */
const normal = (doc: PmJson): PmJson => schema.nodeFromJSON(doc).toJSON() as PmJson;

describe('Markdown round trip (corpus)', () => {
  it('[NTF-007] holds at least 40 documents and sources', () => {
    expect(DOCUMENTS.length + SOURCES.length).toBeGreaterThanOrEqual(40);
    expect(DOCUMENTS.filter((d) => d.lossless).length).toBeGreaterThanOrEqual(30);
    expect(new Set([...DOCUMENTS, ...SOURCES].map((d) => d.name)).size).toBe(
      DOCUMENTS.length + SOURCES.length,
    );
  });

  for (const entry of DOCUMENTS) {
    it(`[NTF-007] ${entry.name}: ${entry.lossless ? 'comes back unchanged' : 'loses only what is documented'}`, async () => {
      const markdown = toMarkdown(entry.doc);
      await expect(markdown).toMatchFileSnapshot(`./__golden__/markdown/${entry.name}.md`);
      const back = fromMarkdown(markdown);
      schema.nodeFromJSON(back).check();
      // Whatever was lost, the Markdown we write is stable from then on.
      expect(toMarkdown(back)).toBe(markdown);
      if (entry.lossless) {
        expect(back).toEqual(normal(entry.doc));
      } else {
        await expect(stableJson(back)).toMatchFileSnapshot(
          `./__golden__/markdown/${entry.name}.json`,
        );
      }
    });
  }

  for (const entry of SOURCES) {
    it(`[NTF-007] reads ${entry.name} and writes it back in a stable form`, async () => {
      const doc = fromMarkdown(entry.markdown);
      schema.nodeFromJSON(doc).check();
      await expect(stableJson(doc)).toMatchFileSnapshot(
        `./__golden__/markdown/source-${entry.name}.json`,
      );
      const markdown = toMarkdown(doc);
      await expect(markdown).toMatchFileSnapshot(`./__golden__/markdown/source-${entry.name}.md`);
      expect(fromMarkdown(markdown)).toEqual(doc);
    });
  }
});

describe('Markdown round trip (properties)', () => {
  it('[NTF-007] keeps a link address with a backslash the same over repeated saves', () => {
    // The document of a seed a full gate found: the address gained a backslash on every save.
    const once = fromMarkdown(toMarkdown(fromAdfJson(generateAdfDocument(365932749))));
    const markdown = toMarkdown(once);
    expect(fromMarkdown(markdown)).toEqual(once);
    expect(toMarkdown(fromMarkdown(markdown))).toBe(markdown);
  });

  it('[NTF-007] reaches a fixed point for any synthetic imported document', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        // One pass takes the documented losses (and GFM's merging of a link with the address
        // written right after it); from then on document and Markdown stay the same.
        const once = fromMarkdown(toMarkdown(fromAdfJson(generateAdfDocument(seed))));
        schema.nodeFromJSON(once).check();
        const markdown = toMarkdown(once);
        const back = fromMarkdown(markdown);
        expect(back).toEqual(once);
        expect(toMarkdown(back)).toBe(markdown);
      }),
    );
  });

  it('[API-011] reads Markdown into content that exports to the other format', () => {
    const doc = fromMarkdown('## Plan\n\n- [x] ship **it**\n\nPing [@Ana](mention:12).\n');
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
            { type: 'mention', attrs: { id: '12', text: '@Ana' } },
            { type: 'text', text: '.' },
          ],
        },
      ],
    });
  });
});

describe('Markdown details', () => {
  it('[NTF-006] reads a pasted Markdown table as a table', () => {
    const doc = fromMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(doc.content?.[0]?.type).toBe('table');
    expect(doc.content?.[0]?.content?.[0]?.content?.map((c) => c.type)).toEqual([
      'tableHeader',
      'tableHeader',
    ]);
  });

  it('[NTF-006] tells Markdown worth converting from plain text', () => {
    for (const text of [
      '## Heading',
      '- item',
      '1. step',
      '> quoted',
      '```\ncode\n```',
      '| a | b |',
      'some **bold** text',
      'a [link](https://example.test)',
      '`code`',
    ]) {
      expect(looksLikeMarkdown(text), text).toBe(true);
    }
    for (const text of ['Just a sentence.', 'Price: 5 * 3 = 15', 'email me at a@b.test']) {
      expect(looksLikeMarkdown(text), text).toBe(false);
    }
  });

  it('keeps only safe link targets', () => {
    expect(isSafeHref('https://example.test')).toBe(true);
    expect(isSafeHref('/relative/path')).toBe(true);
    expect(isSafeHref('#anchor')).toBe(true);
    expect(isSafeHref('mailto:a@example.test')).toBe(true);
    expect(isSafeHref('JavaScript:alert(1)')).toBe(false);
    expect(isSafeHref(' data:text/html,x')).toBe(false);
    expect(isSafeHref('vbscript:x')).toBe(false);
  });

  it('[API-011] lays out a stored table with a huge span in bounded space (M1-118)', () => {
    // As a document stored before the span check: the writers cap the span themselves.
    const doc: PmJson = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  attrs: { colspan: 1e308 },
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'wide' }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(toMarkdown(doc).length).toBeLessThan(20_000);
    expect(toWiki(doc).length).toBeLessThan(20_000);
  });

  it('[NFR-008] reads the scheme as a browser does (tabs, line breaks, leading controls)', () => {
    // Built from parts so the test file holds no working payload.
    const js = ['java', 'script:'];
    for (const href of [
      js.join('\t'),
      js.join('\n'),
      js.join('\r\n'),
      `\u0001${js.join('')}x`,
      `\u0000 ${js.join('')}x`,
      `\u001f${js.join('')}x`,
      `\u00a0${js.join('')}x`,
      'da\tta:text/html,x',
      '\tvb\nscript:x',
    ]) {
      expect(isSafeHref(href), JSON.stringify(href)).toBe(false);
      // What the browser makes of it, for the record.
      const parsed = new URL(href, 'https://taskmoor.example/app/').protocol;
      if (!href.startsWith('\u00a0')) expect(['http:', 'https:']).not.toContain(parsed);
    }
    expect(isSafeHref('https://exa\tmple.test/a\nb')).toBe(true);
    expect(isSafeHref('\t/relative')).toBe(true);
  });

  it('reads an empty text as an empty document', () => {
    expect(fromMarkdown('')).toEqual(normal({ type: 'doc', content: [{ type: 'paragraph' }] }));
    expect(toMarkdown(fromMarkdown(''))).toBe('\n');
  });

  it('rejects a root that is not a document', () => {
    expect(() => toMarkdown({ type: 'paragraph' })).toThrow(/Expected a doc node/);
  });
});
