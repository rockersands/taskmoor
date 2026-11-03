// @vitest-environment jsdom
import { DOMParser, DOMSerializer } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { docShapeProblem, isExpandTitle, MAX_TITLE_LENGTH } from './adf';
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

describe('a collapsible section pasted as HTML (NTF-014)', () => {
  /** HTML as the clipboard holds it, read through the schema's parse rules. */
  const pasted = (html: string) => {
    const holder = page.createElement('div') as unknown as { innerHTML: string };
    holder.innerHTML = html;
    return DOMParser.fromSchema(schema)
      .parse(holder as never)
      .toJSON() as { content: { type: string; attrs: { title: string } }[] };
  };
  const section = (title: string) =>
    `<details data-expand=""><summary>${title}</summary><div data-expand-body=""><p>Text</p></div></details>`;

  it('[NTF-014] reads control characters in its title as spaces, as the editor and Markdown do', () => {
    const doc = pasted(section('Step\t1\u0007 and\n\r\u001f2\u007f'));
    const title = doc.content[0]?.attrs.title;
    expect(title).toBe('Step 1 and 2');
    expect(isExpandTitle(title)).toBe(true);
    expect(docShapeProblem(doc)).toBeNull();
  });

  it('[NTF-014] holds a pasted title to the length the document takes', () => {
    const doc = pasted(section(`${'a'.repeat(300)}`));
    expect(doc.content[0]?.attrs.title).toBe('a'.repeat(MAX_TITLE_LENGTH));
    expect(docShapeProblem(doc)).toBeNull();
  });
});
