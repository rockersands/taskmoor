import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  type AdfNode,
  adfDoc,
  adfShapeProblem,
  canonicalAdf,
  countNodes,
  docShapeProblem,
} from './adf';
import { fromAdf, fromAdfJson, toAdf, toAdfFromJson } from './convert';
import { schema } from './schema';
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
    type: 'bodiedExtension',
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
      'bodiedExtension',
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

  it('[API-011] refuses trees the readers and writers cannot rely on (M1-118)', () => {
    const p = (extra: Record<string, unknown>) =>
      adfDoc([{ type: 'paragraph', ...extra } as AdfNode]);
    for (const bad of [
      p({ attrs: 'x' }),
      p({ content: 'x' }),
      p({ content: [null] }),
      p({ content: [{ type: 'text', text: 1 }] }),
      p({ content: [{ type: 'text', text: 'a', marks: 'strong' }] }),
      p({ content: [{ type: 'text', text: 'a', marks: [{ type: 'link', attrs: 'x' }] }] }),
      adfDoc([
        { type: 'inlineExtension', attrs: { id: 1 }, content: { a: 1 } } as unknown as AdfNode,
      ]),
    ]) {
      expect(adfShapeProblem(bad), JSON.stringify(bad)).not.toBeNull();
      expect(() => fromAdfJson(bad)).toThrow();
    }
    let deep: AdfNode = { type: 'text', text: 'x' };
    for (let i = 0; i < 50_000; i++) deep = { type: 'blockquote', content: [deep] };
    expect(adfShapeProblem(adfDoc([deep]))).toMatch(/deeper/);
    expect(() => fromAdfJson(adfDoc([deep]))).toThrow(/deeper/);
    expect(adfShapeProblem(generateAdfDocument(3))).toBeNull();
  });

  it('[API-011] refuses table spans the writers cannot lay out (M1-118)', () => {
    const cell = (attrs: Record<string, unknown>) =>
      adfDoc([
        {
          type: 'table',
          content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs, content: [] }] }],
        },
      ]);
    for (const attrs of [
      { colspan: 1e308 },
      { colspan: 0 },
      { rowspan: 1.5 },
      { colspan: '2' },
      { rowspan: 1001 },
    ]) {
      expect(adfShapeProblem(cell(attrs)), JSON.stringify(attrs)).toMatch(/span/);
    }
    expect(adfShapeProblem(cell({ colspan: 3, rowspan: 2 }))).toBeNull();
  });

  it('[API-011] checks the kept attributes of a stored document too (M1-118)', () => {
    const stored = (node: Record<string, unknown>) => ({ type: 'doc', content: [node] });
    expect(docShapeProblem(stored({ type: 'paragraph', attrs: { adfAttrs: 'x' } }))).not.toBeNull();
    expect(
      docShapeProblem(
        stored({ type: 'unknownBlock', attrs: { adf: { type: 'x', content: 'y' } } }),
      ),
    ).not.toBeNull();
    expect(
      docShapeProblem(
        stored({
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'a',
              marks: [{ type: 'unknownMark', attrs: { type: 'x', attrs: 1 } }],
            },
          ],
        }),
      ),
    ).not.toBeNull();
    expect(docShapeProblem(fromAdfJson(generateAdfDocument(4)))).toBeNull();
  });

  it('rejects a root that is not a document', () => {
    expect(() => fromAdf({ type: 'paragraph' })).toThrow(/Expected a doc node/);
  });
});

describe('the new blocks (NTF-014)', () => {
  const para = (text: string): AdfNode => ({
    type: 'paragraph',
    content: [{ type: 'text', text }],
  });
  const blocks: [string, AdfNode, string][] = [
    [
      'a collapsible section',
      { type: 'expand', attrs: { title: 'More' }, content: [para('x')] },
      'expand',
    ],
    [
      'columns',
      {
        type: 'layoutSection',
        content: [
          { type: 'layoutColumn', attrs: { width: 33.33 }, content: [para('a')] },
          { type: 'layoutColumn', attrs: { width: 66.66 }, content: [para('b')] },
        ],
      },
      'columnLayout',
    ],
    [
      'an image of the ticket',
      {
        type: 'mediaSingle',
        attrs: { layout: 'center' },
        content: [
          {
            type: 'media',
            attrs: { type: 'file', id: 'a.png', collection: 'taskmoor-attachments' },
          },
        ],
      },
      'attachmentRef',
    ],
    [
      'a file of the ticket',
      {
        type: 'mediaGroup',
        content: [
          {
            type: 'media',
            attrs: { type: 'file', id: 'a.pdf', collection: 'taskmoor-attachments' },
          },
        ],
      },
      'attachmentRef',
    ],
  ];
  for (const [name, node, type] of blocks) {
    it(`[NTF-014] (1) maps ${name} and brings it back unchanged`, () => {
      const doc = adfDoc([node]);
      const pm = fromAdf(doc);
      pm.check();
      expect(pm.firstChild?.type.name).toBe(type);
      expect(canonicalAdf(toAdf(pm))).toEqual(canonicalAdf(doc));
    });
  }

  it('[NTF-014] (1) maps a ticket reference and brings it back unchanged', () => {
    const doc = adfDoc([
      {
        type: 'paragraph',
        content: [{ type: 'inlineCard', attrs: { url: '/browse/PAY-42', extra: 'kept' } }],
      },
    ]);
    const pm = fromAdf(doc);
    expect(pm.firstChild?.firstChild?.type.name).toBe('ticketRef');
    expect(pm.firstChild?.firstChild?.attrs.key).toBe('PAY-42');
    expect(canonicalAdf(toAdf(pm))).toEqual(canonicalAdf(doc));
  });

  it('[NTF-014] keeps whole what does not fit: other media, cards, empty sections, too many columns', () => {
    const column: AdfNode = { type: 'layoutColumn', content: [para('c')] };
    for (const node of [
      { type: 'expand' },
      { type: 'expand', attrs: { title: 'two\nlines' }, content: [para('x')] },
      {
        type: 'mediaSingle',
        content: [{ type: 'media', attrs: { type: 'file', id: 'x', collection: 'other' } }],
      },
      { type: 'mediaGroup', content: [] },
      { type: 'layoutSection', content: Array.from({ length: 7 }, () => column) },
      { type: 'layoutSection', content: [para('not a column')] },
      { type: 'layoutSection', content: [{ type: 'layoutColumn', content: [] }] },
    ] as AdfNode[]) {
      const doc = adfDoc([node]);
      const pm = fromAdf(doc);
      expect(pm.firstChild?.type.name).toBe('unknownBlock');
      expect(canonicalAdf(toAdf(pm))).toEqual(canonicalAdf(doc));
    }
    for (const url of [
      'https://example.test/browse/PAY-1',
      '/browse/not a key',
      '/browse/PAY-1/x',
    ]) {
      const doc = adfDoc([
        { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url } }] },
      ]);
      expect(fromAdf(doc).firstChild?.firstChild?.type.name).toBe('unknownInline');
    }
  });

  it('[NTF-014] (2) refuses values that are not what a block may hold', () => {
    const inside = (node: Record<string, unknown>) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [node] }],
    });
    expect(docShapeProblem(inside({ type: 'ticketRef', attrs: { key: 'PAY-42' } }))).toBeNull();
    for (const key of ['', 'PAY', 'PAY-', '-1', 'PAY-1 ', '"><img>-1', 'javascript:x-1', 1]) {
      expect(docShapeProblem(inside({ type: 'ticketRef', attrs: { key } })), String(key)).toMatch(
        /ticket reference/,
      );
    }
    expect(docShapeProblem(inside({ type: 'ticketRef' }))).toMatch(/ticket reference/);
    const block = (node: Record<string, unknown>) => ({ type: 'doc', content: [node] });
    expect(docShapeProblem(block({ type: 'attachmentRef', attrs: { name: 'a.png' } }))).toBeNull();
    for (const name of ['', '   ', 'a'.repeat(256), 'two\nlines', 7]) {
      expect(docShapeProblem(block({ type: 'attachmentRef', attrs: { name } }))).toMatch(
        /attachment reference/,
      );
    }
    expect(
      docShapeProblem(block({ type: 'expand', attrs: { title: 'x'.repeat(256) }, content: [] })),
    ).toMatch(/collapsible/);
  });

  it('[NTF-014] (2) writes no raw HTML and no address from what a block holds', () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'expand',
          attrs: { title: '<img src=x onerror=y>' },
          content: [{ type: 'paragraph' }],
        },
        { type: 'attachmentRef', attrs: { name: '"><script>x</script>' } },
        {
          type: 'paragraph',
          content: [{ type: 'ticketRef', attrs: { key: '"><img src=x>-1' } }],
        },
      ],
    });
    const seen = JSON.stringify(doc.toJSON());
    expect(seen).toContain('<img src=x onerror=y>'); // Text in an attribute, for the renderer to escape.
    const spec = schema.nodes.ticketRef?.spec.toDOM?.(
      doc.lastChild?.firstChild as never,
    ) as unknown[];
    expect((spec[1] as Record<string, unknown>).href).toBeUndefined();
  });
});
