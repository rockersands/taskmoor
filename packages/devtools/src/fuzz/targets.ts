import { parseTextSearch, printTextTerm, type TextSearch, TextSearchError } from '@taskmoor/query';
import {
  type AdfNode,
  docShapeProblem,
  fromAdfJson,
  fromMarkdown,
  fromWiki,
  isSafeHref,
  type PmJson,
  schema,
  toAdfFromJson,
  toMarkdown,
  toPlainText,
  toWiki,
} from '@taskmoor/richtext';
import {
  generateAdfDocument,
  MARKDOWN_DOCUMENTS,
  MARKDOWN_SOURCES,
  WIKI_DOCUMENTS,
  WIKI_SOURCES,
} from '@taskmoor/richtext/testing';
import { type FuzzTarget, type FuzzVerdict, textInput } from '@taskmoor/testkit/fuzz';
import type { Rng } from '@taskmoor/testkit/gen';

/**
 * Fuzz targets for the shared packages' parsers of untrusted input (M1-118, ADR-104); the
 * server's are in `apps/server/src/fuzz/targets.ts`. `pnpm fuzz <name>` runs one.
 */

const describe = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : `non-Error ${String(error)}`;

const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'];
const BASE = 'https://taskmoor.example/app/';

/** Every link in a document points somewhere safe, read the way a browser reads it. */
function unsafeLink(doc: PmJson): string | undefined {
  for (const mark of doc.marks ?? []) {
    if (mark.type !== 'link') continue;
    const href = String(mark.attrs?.href ?? '');
    let protocol: string;
    try {
      protocol = new URL(href, BASE).protocol;
    } catch {
      continue; // not an address a browser follows
    }
    if (!SAFE_PROTOCOLS.includes(protocol)) return href;
  }
  for (const child of doc.content ?? []) {
    const found = unsafeLink(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function schemaProblem(doc: PmJson): string | undefined {
  try {
    schema.nodeFromJSON(doc).check();
    return undefined;
  } catch (error) {
    return describe(error);
  }
}

// --- text: the search syntax inside a `~` value (packages/query/src/text.ts) -------------------

const TEXT_TOKENS = [
  'login',
  'timeout',
  '"login failed"',
  '"',
  '\\',
  '\\"',
  '-',
  '-password',
  '*',
  'log*',
  '**',
  '?',
  'lo?in',
  '???',
  '~',
  'login~',
  'C\\+\\+',
  '\\-1',
  'what\\?',
  'e-mail',
  'foo.bar',
  ' ',
  '\t',
  '日本',
  'é',
  '🙂',
];

const TEXT_SEEDS = [
  'login timeout',
  '"login failed"',
  'log*',
  'lo?in',
  'login~',
  'login -password',
  'C\\+\\+',
  '\\-1',
  'what\\?',
  '"a \\" quote" -"left out" x*',
  'e-mail foo.bar',
];

function printSearch(search: TextSearch): string {
  return [
    ...search.terms.map(printTextTerm),
    ...search.excluded.map((t) => `-${printTextTerm(t)}`),
  ].join(' ');
}

export function checkTextSearch(text: string): FuzzVerdict {
  let search: TextSearch;
  try {
    search = parseTextSearch(text);
  } catch (error) {
    if (!(error instanceof TextSearchError)) return { problem: `threw ${describe(error)}` };
    const length = [...text].length;
    if (error.at < 0 || error.at > length) {
      return { problem: `error place ${error.at} outside the text (${length})` };
    }
    if (!error.message) return { problem: 'a refusal without a message' };
    return 'refused';
  }
  if (search.terms.length === 0) return { problem: 'a search with nothing to find' };
  for (const term of [...search.terms, ...search.excluded]) {
    const body = term.kind === 'wildcard' ? term.parts.join('') : term.text;
    if (!/[\p{L}\p{N}]/u.test(body))
      return { problem: `a term with no letter or digit: ${JSON.stringify(term)}` };
    if (term.kind === 'wildcard' && term.parts.length - 1 > 2) {
      return { problem: 'more than two ? in one word' };
    }
  }
  const printed = printSearch(search);
  let again: TextSearch;
  try {
    again = parseTextSearch(printed);
  } catch (error) {
    return {
      problem: `the printed search ${JSON.stringify(printed)} is refused: ${describe(error)}`,
    };
  }
  if (JSON.stringify(again) !== JSON.stringify(search)) {
    return { problem: `the printed search ${JSON.stringify(printed)} reads back differently` };
  }
  return 'valid';
}

const textTarget: FuzzTarget<string> = {
  name: 'text',
  description:
    'the text search syntax (~ values): only TextSearchError, terms well formed, printing reads back',
  seeds: () => TEXT_SEEDS,
  generate: (rng, seeds) => textInput(rng, seeds, TEXT_TOKENS),
  check: checkTextSearch,
  show: (s) => s,
};

// --- href: link targets against the browser's URL parser --------------------------------------

const HREF_TOKENS = [
  'javascript:',
  'JaVaScRiPt:',
  'java',
  'script',
  ':',
  'data:',
  'vbscript:',
  'http:',
  'https:',
  'mailto:',
  'tel:',
  'file:',
  'blob:',
  '//',
  '/',
  '\\',
  '%0a',
  '%09',
  '&#x09;',
  '&colon;',
  '\t',
  '\n',
  '\r',
  ' ',
  '\u0000',
  '\u0001',
  '\u001f',
  ' ',
  '​',
  '﻿',
  'alert(1)',
  'example.test',
  '#x',
  '?q=1',
];

export function checkHref(href: string): FuzzVerdict {
  let safe: boolean;
  try {
    safe = isSafeHref(href);
  } catch (error) {
    return { problem: `isSafeHref threw ${describe(error)}` };
  }
  if (!safe) return 'unsafe';
  let protocol: string;
  try {
    protocol = new URL(href, BASE).protocol;
  } catch {
    return 'not-a-url';
  }
  if (!SAFE_PROTOCOLS.includes(protocol)) {
    return { problem: `isSafeHref accepts an address the browser opens as ${protocol}` };
  }
  return 'safe';
}

const hrefTarget: FuzzTarget<string> = {
  name: 'href',
  description:
    'isSafeHref against the WHATWG URL parser: an address it accepts never opens as another scheme',
  seeds: () => [
    'https://example.test/a',
    '/relative',
    '#anchor',
    'mailto:a@example.test',
    'tel:+1',
  ],
  generate: (rng, seeds) => {
    if (rng.chance(0.5)) {
      // Pieces glued together: schemes split by breaks and controls.
      const n = rng.int(1, 8);
      let s = '';
      for (let i = 0; i < n; i++) s += rng.pick(HREF_TOKENS);
      return s;
    }
    return textInput(rng, seeds, HREF_TOKENS);
  },
  check: checkHref,
  show: (s) => s,
};

// --- wiki: wiki markup reader and writer (packages/richtext/src/wiki.ts) ----------------------

const WIKI_TOKENS = [
  '*',
  '_',
  '-',
  '+',
  '^',
  '~',
  '??',
  '{{',
  '}}',
  '{*}',
  '[',
  ']',
  '|',
  '||',
  '\\',
  '!',
  '!a.png!',
  '!a.png|thumbnail!',
  'h1. ',
  'h6. ',
  'bq. ',
  '----',
  '* ',
  '** ',
  '# ',
  '#* ',
  '- ',
  '[x] ',
  '{code}',
  '{code:js}',
  '{noformat}',
  '{quote}',
  '{panel}',
  '{panel:title=T|bgColor=#ffebe6}',
  '{info}',
  '{color:red}',
  '{color}',
  '[~accountid:5]',
  '[~someone]',
  '[x|http://e.test]',
  '[http://e.test]',
  '[x|javascript:alert(1)]',
  '[x|java\tscript:x]',
  '[x|\u0001javascript:x]',
  'http://e.test/p ',
  'mailto:a@e.test',
  '&#92;',
  '&amp;',
  '&#x1F600;',
  '\n',
  '\n\n',
  '\r\n',
];

const wikiSeeds = (): string[] => [
  ...WIKI_SOURCES.map((s) => s.wiki),
  ...WIKI_DOCUMENTS.map((d) => toWiki(d.doc)),
];

export function checkWiki(text: string): FuzzVerdict {
  let doc: PmJson;
  try {
    doc = fromWiki(text);
  } catch (error) {
    return { problem: `fromWiki threw ${describe(error)}` };
  }
  const invalid = schemaProblem(doc);
  if (invalid) return { problem: `fromWiki built a document the schema refuses: ${invalid}` };
  const link = unsafeLink(doc);
  if (link !== undefined)
    return { problem: `fromWiki kept an unsafe link ${JSON.stringify(link)}` };
  let wiki: string;
  try {
    wiki = toWiki(doc);
    toAdfFromJson(doc);
    toMarkdown(doc);
    toPlainText(doc);
  } catch (error) {
    return { problem: `writing the document threw ${describe(error)}` };
  }
  // Fidelity, not safety: a document that writes back differently is counted, not failed
  // (the round-trip properties in wiki.test.ts guard it; ADR-104).
  const back = fromWiki(wiki);
  if (JSON.stringify(back) !== JSON.stringify(doc) || toWiki(back) !== wiki) return 'unstable';
  return 'valid';
}

const wikiTarget: FuzzTarget<string> = {
  name: 'wiki',
  description:
    'wiki markup (v2 API, DC import): no throw, schema-valid, safe links, writes back stably',
  seeds: wikiSeeds,
  generate: (rng, seeds) => textInput(rng, seeds, WIKI_TOKENS),
  check: checkWiki,
  show: (s) => s,
};

// --- markdown: the Markdown reader (packages/richtext/src/markdown.ts) -------------------------

const MD_TOKENS = [
  '#',
  '# ',
  '###### ',
  '*',
  '**',
  '_',
  '~~',
  '`',
  '```',
  '```js\n',
  '> ',
  '> [!NOTE]\n',
  '- ',
  '1. ',
  '- [ ] ',
  '- [x] ',
  '|',
  '| a | b |\n| - | - |\n',
  '[x](https://e.test)',
  '[x](javascript:alert(1))',
  '[x](java\tscript:x)',
  '[x](<\u0001javascript:x>)',
  '![a](https://e.test/a.png)',
  '![a](data:image/png;base64,AA)',
  '[x][r]\n\n[r]: javascript:x',
  '<b>',
  '<script>',
  '<!--',
  '-->',
  '&amp;',
  '&#0;',
  '\\',
  '---',
  '@someone',
  '\n',
  '\n\n',
  '    ',
];

const markdownSeeds = (): string[] => [
  ...MARKDOWN_SOURCES.map((s) => s.markdown),
  ...MARKDOWN_DOCUMENTS.map((d) => toMarkdown(d.doc)),
];

export function checkMarkdown(text: string): FuzzVerdict {
  let doc: PmJson;
  try {
    doc = fromMarkdown(text);
  } catch (error) {
    return { problem: `fromMarkdown threw ${describe(error)}` };
  }
  const invalid = schemaProblem(doc);
  if (invalid) return { problem: `fromMarkdown built a document the schema refuses: ${invalid}` };
  const link = unsafeLink(doc);
  if (link !== undefined) {
    return { problem: `fromMarkdown kept an unsafe link ${JSON.stringify(link)}` };
  }
  try {
    toMarkdown(doc);
    toWiki(doc);
    toAdfFromJson(doc);
  } catch (error) {
    return { problem: `writing the document threw ${describe(error)}` };
  }
  return 'valid';
}

const markdownTarget: FuzzTarget<string> = {
  name: 'markdown',
  description:
    'Markdown (API writes, CSV import): no throw, schema-valid, safe links, every writer copes',
  seeds: markdownSeeds,
  generate: (rng, seeds) => textInput(rng, seeds, MD_TOKENS),
  check: checkMarkdown,
  show: (s) => s,
};

// --- adf: the Jira-compatible document format (packages/richtext/src/convert.ts) ---------------

const NODE_TYPES = [
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'blockquote',
  'rule',
  'panel',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'taskList',
  'taskItem',
  'hardBreak',
  'mention',
  'emoji',
  'date',
  'status',
  'mediaSingle',
  'media',
  'inlineCard',
  'extension',
  '__proto__',
  'constructor',
  '',
];
const MARK_TYPES = [
  'strong',
  'em',
  'strike',
  'underline',
  'code',
  'link',
  'textColor',
  'subsup',
  'x',
];
const ODD_VALUES: unknown[] = [
  null,
  true,
  0,
  -1,
  1e308,
  Number.NaN,
  '',
  'x',
  'javascript:alert(1)',
  [],
  {},
  [1, 2],
  { a: 1 },
  'a'.repeat(5000),
];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** An odd value, a fresh copy each time (a later edit may add content to it). */
const odd = (rng: Rng): unknown => structuredClone(rng.pick(ODD_VALUES));

function nodesOf(node: AdfNode, out: AdfNode[] = []): AdfNode[] {
  out.push(node);
  if (Array.isArray(node.content)) {
    for (const child of node.content) if (child && typeof child === 'object') nodesOf(child, out);
  }
  return out;
}

/** One structural edit of an ADF tree: types, attributes, marks, content, nesting. */
function mutateAdf(rng: Rng, doc: AdfNode, seeds: readonly AdfNode[]): AdfNode {
  const root = clone(doc);
  const all = nodesOf(root);
  const node = rng.pick(all) as AdfNode & Record<string, unknown>;
  switch (rng.int(0, 11)) {
    case 0:
      node.type = rng.pick(NODE_TYPES);
      break;
    case 1:
      node.attrs = {
        ...(node.attrs ?? {}),
        [rng.pick([
          'level',
          'order',
          'colspan',
          'rowspan',
          'colwidth',
          'state',
          'id',
          'text',
          'href',
          'language',
          'panelType',
          'timestamp',
          'color',
          '__proto__',
        ])]: odd(rng),
      };
      break;
    case 2:
      node.marks = [
        ...(Array.isArray(node.marks) ? node.marks : []),
        {
          type: rng.pick(MARK_TYPES),
          attrs: rng.chance(0.5) ? { href: odd(rng), color: odd(rng), type: odd(rng) } : undefined,
        },
      ] as NonNullable<AdfNode['marks']>;
      break;
    case 3:
      delete node.content;
      break;
    case 4:
      (node as Record<string, unknown>).content = odd(rng);
      break;
    case 5: {
      // Graft a node from another document.
      const donor = rng.pick(nodesOf(clone(rng.pick(seeds))));
      node.content = [...(Array.isArray(node.content) ? node.content : []), donor];
      break;
    }
    case 6:
      node.content = [nested(rng, rng.int(2, 40))];
      break;
    case 7:
      node.text = odd(rng) as string;
      break;
    case 8:
      // Many children.
      node.content = Array.from({ length: rng.int(10, 2000) }, () => ({ type: 'text', text: 'x' }));
      break;
    case 9:
      if (Array.isArray(node.content) && node.content.length > 1) node.content.reverse();
      break;
    case 10:
      (node as Record<string, unknown>)[rng.pick(['version', 'attrs', 'marks', 'text'])] = odd(rng);
      break;
    default:
      node.content = [...(Array.isArray(node.content) ? node.content : []), odd(rng) as AdfNode];
  }
  return root;
}

const NESTING = ['blockquote', 'bulletList', 'listItem', 'panel', 'paragraph', 'tableCell', 'x'];

/** `depth` nodes of one kind inside each other, a text at the bottom. */
function nested(rng: Rng, depth: number): AdfNode {
  let inner: AdfNode = { type: 'text', text: 'deep' };
  const kind = rng.pick(NESTING);
  for (let i = depth; i > 0; i--) inner = { type: kind, content: [inner] };
  return inner;
}

export function checkAdf(value: AdfNode): FuzzVerdict {
  let doc: PmJson;
  try {
    doc = fromAdfJson(value);
  } catch (error) {
    // The API refuses these as invalid (readRichText); any Error is a refusal it can catch.
    return error instanceof Error ? 'refused' : { problem: `threw ${describe(error)}` };
  }
  // What the server stores passes checkRichText: the shape check and the schema.
  if (docShapeProblem(doc) !== null || schemaProblem(doc)) return 'refused-by-check';
  let adf: AdfNode;
  try {
    adf = toAdfFromJson(doc);
    toWiki(doc);
    toMarkdown(doc);
    toPlainText(doc);
  } catch (error) {
    return { problem: `writing an accepted document threw ${describe(error)}` };
  }
  let again: PmJson;
  try {
    again = fromAdfJson(adf);
  } catch (error) {
    return { problem: `the written document is refused: ${describe(error)}` };
  }
  if (schemaProblem(again)) return { problem: 'the written document fails the schema check' };
  return 'valid';
}

const adfTarget: FuzzTarget<AdfNode> = {
  name: 'adf',
  description:
    'the Jira-compatible document format (v3 API, cloud import): only Errors, writers cope, output reads back',
  seeds: () => Array.from({ length: 200 }, (_, i) => generateAdfDocument(i + 1)),
  generate: (rng, seeds) => {
    let doc = rng.pick(seeds);
    const edits = rng.int(1, 6);
    for (let i = 0; i < edits; i++) doc = mutateAdf(rng, doc, seeds);
    if (rng.chance(0.05)) {
      // Very deep nesting last (cloning it again would be the fuzzer's own stack at stake).
      const node = rng.pick(nodesOf(doc));
      node.content = [nested(rng, rng.int(100, 20_000))];
    }
    return doc;
  },
  check: checkAdf,
  show: (v) => JSON.stringify(v),
};

export const FUZZ_TARGETS: readonly FuzzTarget<unknown>[] = [
  textTarget,
  hrefTarget,
  wikiTarget,
  markdownTarget,
  adfTarget as FuzzTarget<unknown>,
] as FuzzTarget<unknown>[];
