import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT, docFromYDoc, EMPTY_DOC, writeDocToYDoc } from './collab';
import { fromAdfJson, type PmJson } from './convert';
import { DOCUMENTS } from './markdown-corpus';
import { schema } from './schema';
import { generateAdfDocuments } from './testing';

const normal = (doc: PmJson): PmJson => schema.nodeFromJSON(doc).toJSON() as PmJson;

const paragraph = (text: string): PmJson => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Two peers that start from the same state. */
function peers(doc: PmJson) {
  const a = new Y.Doc();
  writeDocToYDoc(a, doc);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return { a, b };
}

function exchange(a: Y.Doc, b: Y.Doc) {
  const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, fromA);
  Y.applyUpdate(a, fromB);
}

describe('documents in Yjs (ADR-014)', () => {
  it('[NTF-008] carries every corpus and synthetic document through an encoded update', () => {
    const docs = [
      ...DOCUMENTS.map((d) => d.doc),
      ...generateAdfDocuments(30, 11).map((d) => fromAdfJson(d)),
    ];
    for (const doc of docs) {
      const source = new Y.Doc();
      writeDocToYDoc(source, doc);
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(source));
      expect(docFromYDoc(copy)).toEqual(normal(doc));
    }
  });

  it('[NTF-008] merges two people typing in one paragraph at once, keeping both', () => {
    const { a, b } = peers(paragraph('The login fails.'));
    writeDocToYDoc(a, paragraph('The login page fails.'));
    writeDocToYDoc(b, paragraph('The login fails on Safari.'));
    exchange(a, b);
    expect(docFromYDoc(a)).toEqual(docFromYDoc(b));
    expect(docFromYDoc(a)).toEqual(normal(paragraph('The login page fails on Safari.')));
  });

  it('[NTF-008] merges structural edits made apart', () => {
    const start: PmJson = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'First.' }] },
      ],
    };
    const { a, b } = peers(start);
    writeDocToYDoc(a, {
      ...start,
      content: [
        ...(start.content ?? []),
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [paragraph('x').content?.[0] as PmJson] }],
        },
      ],
    });
    writeDocToYDoc(b, {
      ...start,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'New plan' }] },
        ...(start.content?.slice(1) ?? []),
      ],
    });
    exchange(a, b);
    const merged = docFromYDoc(a);
    expect(merged).toEqual(docFromYDoc(b));
    expect(merged.content?.map((n) => n.type)).toEqual(['heading', 'paragraph', 'bulletList']);
    expect(merged.content?.[0]?.content?.[0]?.text).toBe('New plan');
  });

  it('[NTF-014] (3) holds every new block, and two peers converge on it', () => {
    const start: PmJson = {
      type: 'doc',
      content: [
        {
          type: 'expand',
          attrs: { title: 'More' },
          content: [paragraph('Inside').content?.[0] as PmJson],
        },
        {
          type: 'columnLayout',
          content: [
            { type: 'column', content: [paragraph('Left').content?.[0] as PmJson] },
            { type: 'column', content: [paragraph('Right').content?.[0] as PmJson] },
          ],
        },
        { type: 'attachmentRef', attrs: { name: 'a.png', image: true } },
        {
          type: 'paragraph',
          content: [
            { type: 'ticketRef', attrs: { key: 'PAY-42' } },
            { type: 'date', attrs: { timestamp: '1760000000000' } },
            { type: 'status', attrs: { text: 'OPEN', color: 'blue' } },
            { type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } },
          ],
        },
        { type: 'panel', attrs: { panelType: 'warning' }, content: [{ type: 'paragraph' }] },
      ],
    };
    const { a, b } = peers(start);
    expect(docFromYDoc(a)).toEqual(normal(start));
    expect(docFromYDoc(b)).toEqual(normal(start));
    // One retitles the section while the other adds a block.
    const retitled = normal(start);
    (retitled.content?.[0]?.attrs as Record<string, unknown>).title = 'Much more';
    writeDocToYDoc(a, retitled);
    const added = normal(start);
    added.content?.push({ type: 'attachmentRef', attrs: { name: 'b.pdf', image: false } });
    writeDocToYDoc(b, added);
    exchange(a, b);
    const merged = docFromYDoc(a);
    expect(merged).toEqual(docFromYDoc(b));
    expect(merged.content?.[0]?.attrs?.title).toBe('Much more');
    expect(merged.content?.at(-1)?.attrs?.name).toBe('b.pdf');
  });

  it('updates a document in place: writing what it holds changes nothing', () => {
    const ydoc = new Y.Doc();
    writeDocToYDoc(ydoc, paragraph('Same text'));
    const before = Y.encodeStateVector(ydoc);
    let updates = 0;
    ydoc.on('update', () => updates++);
    writeDocToYDoc(ydoc, paragraph('Same text'));
    expect(updates).toBe(0);
    expect(Y.encodeStateVector(ydoc)).toEqual(before);
  });

  it('holds an empty document for null and leaves out what the schema refuses', () => {
    const ydoc = new Y.Doc();
    writeDocToYDoc(ydoc, null);
    expect(docFromYDoc(ydoc)).toEqual(normal(EMPTY_DOC));
    // A peer that writes an element no editor makes.
    const fragment = ydoc.getXmlFragment(COLLAB_FRAGMENT);
    fragment.insert(0, [new Y.XmlElement('script')]);
    expect(docFromYDoc(ydoc)).toEqual(normal(EMPTY_DOC));
  });
});
