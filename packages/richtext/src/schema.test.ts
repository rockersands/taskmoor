// @vitest-environment jsdom
import { DOMParser, DOMSerializer } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { adfDoc, docShapeProblem, isExpandTitle, MAX_TITLE_LENGTH, withSafeColors } from './adf';
import { fromAdfJson, toAdfFromJson } from './convert';
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

describe('text colours checked at the door (NTF-014, T-318)', () => {
  const coloured = (...colors: unknown[]) => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: colors.map((color, i) => ({
          type: 'text',
          text: `part ${i}`,
          marks: [{ type: 'bold' }, { type: 'textColor', attrs: { color } }],
        })),
      },
    ],
  });
  /** The spans the schema writes for a document's text, as HTML. */
  const spans = (doc: Record<string, unknown>) => {
    const holder = page.createElement('div') as unknown as {
      appendChild(child: unknown): unknown;
      querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null }>;
    };
    holder.appendChild(
      DOMSerializer.fromSchema(schema).serializeFragment(schema.nodeFromJSON(doc).content),
    );
    return Array.from(holder.querySelectorAll('span')).map((span) => span.getAttribute('style'));
  };
  const UNSAFE = [
    'red; position: fixed; inset: 0',
    'url(https://example.test/x)',
    'expression(alert(1))',
    '#ff5630ff00',
    '',
    null,
    42,
  ];

  it('[NTF-014] writes a colour into a style only when it is a hex value or a colour name', () => {
    const safe = spans(coloured('#36b37e', 'purple', '#0af'));
    expect(safe).toHaveLength(3);
    for (const style of safe) expect(style).toMatch(/^color: [^;]+;?$/);
    // Another, in a document stored before colours were checked, shows as plain text.
    expect(spans(coloured(...UNSAFE))).toEqual(UNSAFE.map(() => null));
  });

  it('[NTF-014] [NTF-007] keeps an imported colour that is not safe aside, and writes it back', () => {
    const adf = adfDoc([
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'safe',
            marks: [{ type: 'textColor', attrs: { color: '#ff5630' } }],
          },
          {
            type: 'text',
            text: 'unsafe',
            marks: [{ type: 'textColor', attrs: { color: 'red; position: fixed' } }],
          },
        ],
      },
    ]);
    const doc = fromAdfJson(adf);
    const [safe, unsafe] = doc.content?.[0]?.content ?? [];
    expect(safe?.marks).toEqual([
      { type: 'textColor', attrs: { color: '#ff5630', adfAttrs: { color: '#ff5630' } } },
    ]);
    expect(unsafe?.marks).toEqual([
      {
        type: 'unknownMark',
        attrs: { type: 'textColor', attrs: { color: 'red; position: fixed' } },
      },
    ]);
    expect(docShapeProblem(doc)).toBeNull();
    expect(spans(doc as never)).not.toContain('color: red; position: fixed');
    // Nothing is lost on the way back.
    expect(toAdfFromJson(doc)).toEqual(adf);
  });

  it('[NTF-014] takes an unsafe colour off its text on save, keeping the text and its other marks', () => {
    const doc = coloured('#36b37e', ...UNSAFE);
    // Not refused: a document stored before colours were checked still saves.
    expect(docShapeProblem(doc)).toBeNull();
    const saved = withSafeColors(doc);
    expect(saved).not.toBe(doc);
    const parts = saved.content[0]?.content ?? [];
    expect(parts.map((part) => part.text)).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `part ${i}`),
    );
    expect(parts[0]?.marks).toEqual([
      { type: 'bold' },
      { type: 'textColor', attrs: { color: '#36b37e' } },
    ]);
    for (const part of parts.slice(1)) expect(part.marks).toEqual([{ type: 'bold' }]);
    // The document it was given is left as it was; one with only safe colours comes back as is.
    expect(doc.content[0]?.content[1]?.marks).toHaveLength(2);
    const safe = coloured('red', '#abcdef');
    expect(withSafeColors(safe)).toBe(safe);
  });
});
