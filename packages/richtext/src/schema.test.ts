// @vitest-environment jsdom
import { DOMParser, DOMSerializer } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { schema } from './schema';

/** jsdom's page; the package's types leave the DOM out, since the server has none. */
const page = (
  globalThis as unknown as {
    document: { createElement(tag: string): { appendChild(child: unknown): unknown } };
  }
).document;

/**
 * What the editor's clipboard does: the document as the schema writes it to HTML, then read
 * back through the schema's own parse rules (copy, cut and paste, drag and drop).
 */
function throughHtml(doc: Record<string, unknown>): unknown {
  const node = schema.nodeFromJSON(doc);
  const holder = page.createElement('div');
  holder.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(node.content));
  return DOMParser.fromSchema(schema)
    .parse(holder as never)
    .toJSON();
}

describe('the schema as HTML (NTF-014)', () => {
  it('[NTF-014] (1) keeps a copied ticket reference a ticket reference, not a link', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'ticketRef', attrs: { key: 'PAY-42' } },
          ],
        },
      ],
    };
    const back = throughHtml(doc) as { content: { content: unknown[] }[] };
    expect(back.content[0]?.content).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'ticketRef', attrs: { key: 'PAY-42', adfAttrs: null } },
    ]);
  });

  it('[NTF-014] (1) keeps a link a link', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'docs',
              marks: [{ type: 'link', attrs: { href: 'https://example.test/d' } }],
            },
          ],
        },
      ],
    };
    const back = throughHtml(doc) as {
      content: { content: { marks?: { type: string; attrs: { href: string } }[] }[] }[];
    };
    expect(back.content[0]?.content[0]?.marks?.[0]).toMatchObject({
      type: 'link',
      attrs: { href: 'https://example.test/d' },
    });
  });
});
