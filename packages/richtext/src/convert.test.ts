import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { type AdfNode, adfDoc, canonicalAdf, countNodes } from './adf';
import { fromAdf, fromAdfJson, toAdf, toAdfFromJson } from './convert';
import { generateAdfDocument, generateAdfDocuments } from './testing';

/** Round trip through the editor schema, comparing canonical forms. */
function roundTrip(doc: AdfNode): AdfNode {
  const pm = fromAdf(doc);
  pm.check(); // throws when the content does not satisfy the schema
  return toAdf(pm);
}

const sample: AdfNode = adfDoc([
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Login page' }] },
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Fails ' },
      { type: 'text', text: 'after upgrade', marks: [{ type: 'strong' }, { type: 'em' }] },
      { type: 'text', text: ' for ' },
      { type: 'mention', attrs: { id: 'user-7', text: '@kalo', accessLevel: 'CONTAINER' } },
      { type: 'hardBreak' },
      { type: 'text', text: 'see ', marks: [{ type: 'textColor', attrs: { color: '#ff5630' } }] },
      {
        type: 'text',
        text: 'docs',
        marks: [{ type: 'link', attrs: { href: 'https://example.test/d', title: 'Docs' } }],
      },
      { type: 'status', attrs: { text: 'OPEN', color: 'blue', localId: 's1' } },
      { type: 'date', attrs: { timestamp: '1760000000000' } },
      { type: 'emoji', attrs: { shortName: ':tada:', id: '1f389', text: '🎉' } },
      { type: 'text', text: 'x', marks: [{ type: 'subsup', attrs: { type: 'sup' } }] },
    ],
  },
  {
    type: 'orderedList',
    attrs: { order: 3 },
    content: [
      {
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
      },
      {
        type: 'listItem',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }],
              },
            ],
          },
        ],
      },
    ],
  },
  { type: 'codeBlock', attrs: { language: 'sql' }, content: [{ type: 'text', text: 'SELECT 1;' }] },
  {
    type: 'blockquote',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }],
  },
  { type: 'rule' },
  {
    type: 'panel',
    attrs: { panelType: 'warning' },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'careful' }] }],
  },
  {
    type: 'table',
    attrs: { isNumberColumnEnabled: false, layout: 'wide' },
    content: [
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableHeader',
            attrs: { colspan: 2, colwidth: [120, 80], background: '#eee' },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'h' }] }],
          },
        ],
      },
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableCell',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
          },
          {
            type: 'tableCell',
            attrs: { rowspan: 2 },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }],
          },
        ],
      },
    ],
  },
  {
    type: 'taskList',
    attrs: { localId: 'tl1' },
    content: [
      {
        type: 'taskItem',
        attrs: { localId: 'ti1', state: 'DONE' },
        content: [
          { type: 'text', text: 'done ' },
          { type: 'mention', attrs: { id: 'u2', text: '@mi' } },
        ],
      },
      {
        type: 'taskItem',
        attrs: { localId: 'ti2', state: 'TODO' },
        content: [{ type: 'text', text: 'todo' }],
      },
    ],
  },
  {
    type: 'extension',
    attrs: {
      extensionType: 'com.example',
      extensionKey: 'chart',
      parameters: { series: [1, 2, 3] },
    },
  },
  {
    type: 'expand',
    attrs: { title: 'More' },
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'hidden',
            marks: [{ type: 'annotation', attrs: { id: 'a1', annotationType: 'inlineComment' } }],
          },
        ],
      },
    ],
  },
]);

describe('document format round trip', () => {
  it('[NTF-007] keeps every node, attribute and mark of a document that uses each mapped type', () => {
    const back = roundTrip(sample);
    expect(canonicalAdf(back)).toEqual(canonicalAdf(sample));
    expect(countNodes(canonicalAdf(back))).toBe(countNodes(canonicalAdf(sample)));
  });

  it('keeps unknown nodes and marks whole, including their children', () => {
    const pm = fromAdfJson(sample);
    const unknown = pm.content?.filter((n) => n.type === 'unknownBlock') ?? [];
    expect(unknown.map((n) => (n.attrs as { adf: AdfNode }).adf.type)).toEqual([
      'extension',
      'expand',
    ]);
    const back = toAdfFromJson(pm);
    expect(back.content?.at(-1)).toEqual(sample.content?.at(-1));
  });

  it('round-trips 50 synthetic documents without losing a node', () => {
    for (const doc of generateAdfDocuments(50)) {
      const back = roundTrip(doc);
      expect(canonicalAdf(back)).toEqual(canonicalAdf(doc));
      // Counted on the canonical forms: the editor merges equal text runs, which is not a loss.
      expect(countNodes(canonicalAdf(back))).toBe(countNodes(canonicalAdf(doc)));
    }
  });

  it('round-trips any seed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const doc = generateAdfDocument(seed);
        expect(canonicalAdf(roundTrip(doc))).toEqual(canonicalAdf(doc));
      }),
    );
  });

  it('exports edits made in the editor', () => {
    const pm = fromAdfJson(sample);
    const taskList = pm.content?.find((n) => n.type === 'taskList');
    const item = taskList?.content?.[1];
    if (!item?.attrs) throw new Error('task item missing');
    item.attrs.checked = true;
    const back = toAdfFromJson(pm);
    const exported = back.content?.find((n) => n.type === 'taskList')?.content?.[1];
    expect(exported?.attrs).toEqual({ localId: 'ti2', state: 'DONE' });
  });

  it('writes defaults only when the original had them', () => {
    const doc = adfDoc([
      {
        type: 'orderedList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
          },
        ],
      },
      { type: 'codeBlock', content: [] },
    ]);
    expect(roundTrip(doc)).toEqual(doc);
  });

  it('[NTF-005] reads a mention label without its "@" and writes the "@" back', () => {
    const doc = adfDoc([
      {
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { id: 'u1', text: '@Kalo' } },
          { type: 'mention', attrs: { id: 'u2', text: 'Bare' } },
        ],
      },
    ]);
    const pm = fromAdfJson(doc);
    const labels = pm.content?.[0]?.content?.map((n) => n.attrs?.label);
    expect(labels).toEqual(['Kalo', 'Bare']);
    expect(roundTrip(doc)).toEqual(doc);
    // A mention made in the editor has no original: the format's "@" is added.
    const made = toAdfFromJson({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'mention', attrs: { id: '7', label: 'Mi' } }] },
      ],
    });
    expect(made.content?.[0]?.content?.[0]).toEqual({
      type: 'mention',
      attrs: { id: '7', text: '@Mi' },
    });
  });

  it('rejects a root that is not a document', () => {
    expect(() => fromAdf({ type: 'paragraph' })).toThrow(/Expected a doc node/);
  });
});
