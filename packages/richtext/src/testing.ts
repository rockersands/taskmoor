import { Rng } from '@taskmoor/testkit/gen';
import { type AdfMark, type AdfNode, adfDoc } from './adf';

/**
 * Synthetic documents in the Jira-compatible format, covering every node and mark the
 * converter maps plus node types it does not, so round-trip tests exercise the unknown path.
 * Built from the format's public description, in our own words; no real content.
 */

const WORDS = [
  'release',
  'login',
  'retry',
  'cache',
  'index',
  'draft',
  'review',
  'deploy',
  'queue',
  'alert',
];
const COLORS = ['#ff5630', '#36b37e', '#0052cc', '#6554c0'];
const STATUS_COLORS = ['neutral', 'purple', 'blue', 'red', 'yellow', 'green'];
const PANELS = ['info', 'note', 'success', 'warning', 'error'];
const LANGUAGES = ['typescript', 'sql', 'bash', null];

/** Node types the editor does not map; they must survive untouched. */
const UNKNOWN_BLOCKS = [
  'extension',
  'bodiedExtension',
  'expand',
  'decisionList',
  'mediaSingle',
  'layoutSection',
  'embedCard',
];
const UNKNOWN_INLINES = ['inlineCard', 'inlineExtension', 'placeholder'];
const UNKNOWN_MARKS = ['annotation', 'dataConsumer', 'border'];

function words(rng: Rng, min = 1, max = 6): string {
  return Array.from({ length: rng.int(min, max) }, () => rng.pick(WORDS)).join(' ');
}

function marks(rng: Rng): AdfMark[] | undefined {
  const out: AdfMark[] = [];
  const seen = new Set<string>();
  const add = (m: AdfMark) => {
    if (!seen.has(m.type)) {
      seen.add(m.type);
      out.push(m);
    }
  };
  const count = rng.geometric(0.7);
  for (let i = 0; i < count; i++) {
    switch (rng.int(0, 8)) {
      case 0:
        add({ type: 'strong' });
        break;
      case 1:
        add({ type: 'em' });
        break;
      case 2:
        add({ type: 'strike' });
        break;
      case 3:
        add({ type: 'underline' });
        break;
      case 4:
        add({
          type: 'link',
          attrs: {
            href: `https://example.test/${words(rng, 1, 1)}`,
            ...(rng.chance(0.3) ? { title: words(rng, 1, 2) } : {}),
          },
        });
        break;
      case 5:
        add({ type: 'textColor', attrs: { color: rng.pick(COLORS) } });
        break;
      case 6:
        add({ type: 'subsup', attrs: { type: rng.pick(['sub', 'sup']) } });
        break;
      case 7:
        add({
          type: rng.pick(UNKNOWN_MARKS),
          attrs: { id: `m${rng.int(1, 999)}`, annotationType: 'inlineComment' },
        });
        break;
      default:
        add({ type: 'code' });
    }
  }
  return out.length > 0 ? out : undefined;
}

function text(rng: Rng): AdfNode {
  const m = marks(rng);
  const withCode = m?.some((x) => x.type === 'code');
  // Code and other marks are not combined by real editors; keep the generator realistic.
  const node: AdfNode = { type: 'text', text: words(rng) };
  if (m && !withCode) node.marks = m;
  else if (withCode) node.marks = [{ type: 'code' }];
  return node;
}

function inlineNode(rng: Rng): AdfNode {
  switch (
    rng.weighted([
      [0, 60],
      [1, 8],
      [2, 5],
      [3, 4],
      [4, 4],
      [5, 5],
      [6, 4],
      [7, 4],
      [8, 2],
    ] as const)
  ) {
    case 8:
      return {
        type: 'inlineCard',
        attrs: { url: `/browse/${rng.pick(['PAY', 'OPS'])}-${rng.int(1, 999)}` },
      };
    case 1:
      return {
        type: 'mention',
        attrs: {
          id: `user-${rng.int(1, 500)}`,
          text: `@${rng.pick(WORDS)}`,
          ...(rng.chance(0.5) ? { accessLevel: 'CONTAINER', userType: 'DEFAULT' } : {}),
        },
      };
    case 2:
      return {
        type: 'emoji',
        attrs: {
          shortName: `:${rng.pick(WORDS)}:`,
          ...(rng.chance(0.5) ? { id: `${rng.int(1, 9999)}`, text: '🙂' } : {}),
        },
      };
    case 3:
      return {
        type: 'date',
        attrs: { timestamp: String(Date.UTC(2026, rng.int(0, 11), rng.int(1, 28))) },
      };
    case 4:
      return {
        type: 'status',
        attrs: {
          text: rng.pick(WORDS).toUpperCase(),
          color: rng.pick(STATUS_COLORS),
          localId: `s${rng.int(1, 999)}`,
        },
      };
    case 5:
      return { type: 'hardBreak' };
    case 6:
      return {
        type: rng.pick(UNKNOWN_INLINES),
        attrs: { url: `https://example.test/${rng.pick(WORDS)}`, localId: `u${rng.int(1, 999)}` },
      };
    case 7:
      return {
        type: 'inlineExtension',
        attrs: {
          extensionType: 'com.example',
          extensionKey: rng.pick(WORDS),
          parameters: { n: rng.int(1, 9), tags: [rng.pick(WORDS)] },
        },
      };
    default:
      return text(rng);
  }
}

function inlineContent(rng: Rng): AdfNode[] {
  return Array.from({ length: rng.int(1, 5) }, () => inlineNode(rng));
}

function paragraph(rng: Rng): AdfNode {
  const node: AdfNode = { type: 'paragraph', content: inlineContent(rng) };
  if (rng.chance(0.2)) node.attrs = { localId: `p${rng.int(1, 9999)}` };
  return node;
}

function list(rng: Rng, depth: number): AdfNode {
  const ordered = rng.chance(0.4);
  const items = Array.from({ length: rng.int(1, 4) }, () => {
    const content: AdfNode[] = [paragraph(rng)];
    if (depth < 2 && rng.chance(0.3)) content.push(list(rng, depth + 1));
    return { type: 'listItem', content } as AdfNode;
  });
  if (ordered) {
    const node: AdfNode = { type: 'orderedList', content: items };
    if (rng.chance(0.5)) node.attrs = { order: rng.int(1, 9) };
    return node;
  }
  return { type: 'bulletList', content: items };
}

function table(rng: Rng): AdfNode {
  const cols = rng.int(1, 4);
  const rows = rng.int(1, 4);
  const cell = (header: boolean): AdfNode => {
    const attrs: Record<string, unknown> = {};
    if (rng.chance(0.2)) attrs.colspan = 2;
    if (rng.chance(0.1)) attrs.rowspan = 2;
    if (rng.chance(0.3)) attrs.colwidth = [rng.int(60, 300)];
    if (rng.chance(0.2)) attrs.background = rng.pick(COLORS);
    const node: AdfNode = { type: header ? 'tableHeader' : 'tableCell', content: [paragraph(rng)] };
    if (Object.keys(attrs).length > 0) node.attrs = attrs;
    return node;
  };
  const node: AdfNode = {
    type: 'table',
    content: Array.from({ length: rows }, (_, r) => ({
      type: 'tableRow',
      content: Array.from({ length: cols }, () => cell(r === 0 && rng.chance(0.7))),
    })),
  };
  if (rng.chance(0.5))
    node.attrs = {
      isNumberColumnEnabled: false,
      layout: rng.pick(['default', 'wide', 'full-width']),
    };
  return node;
}

function blockNode(rng: Rng, depth: number): AdfNode {
  const choice = rng.weighted([
    [0, 30],
    [1, 10],
    [2, 8],
    [3, 5],
    [4, 4],
    [5, 3],
    [6, 5],
    [7, 4],
    [8, 4],
    [9, 6],
    [10, 3],
    [11, 3],
    [12, 2],
  ] as const);
  switch (choice) {
    case 1:
      return { type: 'heading', attrs: { level: rng.int(1, 6) }, content: inlineContent(rng) };
    case 2:
      return list(rng, depth);
    case 3: {
      const node: AdfNode = {
        type: 'codeBlock',
        content: [{ type: 'text', text: `const x = ${rng.int(1, 99)};` }],
      };
      const language = rng.pick(LANGUAGES);
      if (language) node.attrs = { language };
      return node;
    }
    case 4:
      return {
        type: 'blockquote',
        content: [paragraph(rng), ...(rng.chance(0.3) ? [paragraph(rng)] : [])],
      };
    case 5:
      return { type: 'rule' };
    case 6:
      return {
        type: 'panel',
        attrs: { panelType: rng.pick(PANELS) },
        content: [paragraph(rng), ...(depth < 1 && rng.chance(0.3) ? [list(rng, depth + 1)] : [])],
      };
    case 7:
      return table(rng);
    case 8:
      return {
        type: 'taskList',
        attrs: { localId: `tl${rng.int(1, 999)}` },
        content: Array.from({ length: rng.int(1, 3) }, () => ({
          type: 'taskItem',
          attrs: { localId: `ti${rng.int(1, 9999)}`, state: rng.pick(['TODO', 'DONE']) },
          content: inlineContent(rng).filter((n) => n.type !== 'hardBreak'),
        })),
      };
    case 9: {
      const type = rng.pick(UNKNOWN_BLOCKS);
      const node: AdfNode = {
        type,
        attrs: {
          extensionType: 'com.example',
          extensionKey: rng.pick(WORDS),
          layout: 'default',
          parameters: { items: [1, 2, { nested: true }] },
        },
      };
      // Some unknown blocks hold known children; they must come back untouched too.
      if (rng.chance(0.5))
        node.content = [paragraph(rng), ...(rng.chance(0.3) ? [list(rng, depth + 1)] : [])];
      return node;
    }
    case 10:
      return {
        type: 'expand',
        ...(rng.chance(0.8) ? { attrs: { title: words(rng, 1, 3) } } : {}),
        content: [paragraph(rng), ...(depth < 1 && rng.chance(0.3) ? [list(rng, depth + 1)] : [])],
      };
    case 11:
      return {
        type: 'layoutSection',
        content: Array.from({ length: rng.int(2, 3) }, () => ({
          type: 'layoutColumn',
          ...(rng.chance(0.5) ? { attrs: { width: rng.pick([25, 33.33, 50]) } } : {}),
          content: [
            paragraph(rng),
            ...(depth < 1 && rng.chance(0.3) ? [list(rng, depth + 1)] : []),
          ],
        })),
      };
    case 12:
      return {
        type: rng.pick(['mediaSingle', 'mediaGroup']),
        content: [
          {
            type: 'media',
            attrs: {
              type: 'file',
              id: `${rng.pick(WORDS)}.png`,
              collection: 'taskmoor-attachments',
            },
          },
        ],
      };
    default:
      return paragraph(rng);
  }
}

/** A document with 1 to 12 top-level blocks, reproducible from the seed. */
export function generateAdfDocument(seed: number): AdfNode {
  const rng = new Rng(seed);
  return adfDoc(Array.from({ length: rng.int(1, 12) }, () => blockNode(rng, 0)));
}

export function generateAdfDocuments(count: number, seed = 1): AdfNode[] {
  return Array.from({ length: count }, (_, i) => generateAdfDocument(seed * 100_003 + i));
}

/** The round-trip corpora, as seeds for the fuzzers (`pnpm fuzz wiki|markdown`, M1-118). */
export {
  DOCUMENTS as MARKDOWN_DOCUMENTS,
  SOURCES as MARKDOWN_SOURCES,
} from './markdown-corpus';
export { DOCUMENTS as WIKI_DOCUMENTS, SOURCES as WIKI_SOURCES } from './wiki-corpus';
