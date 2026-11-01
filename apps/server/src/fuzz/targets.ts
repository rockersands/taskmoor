import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { JsonValue } from '@taskmoor/db';
import { generateAdfDocument } from '@taskmoor/richtext/testing';
import {
  AWKWARD_CHARACTERS,
  type FuzzTarget,
  type FuzzVerdict,
  mutateText,
  textInput,
} from '@taskmoor/testkit/fuzz';
import type { Rng } from '@taskmoor/testkit/gen';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { cellText, dayOf, instantOf, readRecord, records, secondsOf } from '../import/csv';
import { cleanBuffer } from '../import/dc-backup/clean';
import { ACTIVE_OBJECTS_FILE, ENTITIES_FILE } from '../import/dc-backup/format';
import { defaultOptions, generateDcBackup } from '../import/dc-backup/generate';
import { parseXml } from '../import/dc-backup/parse';
import { DcBackupError, stageDcBackup } from '../import/dc-backup/stage';
import { frontendOrigin, frontendRedirectUri } from '../network/frontends';
import { redirectMatches } from '../oauth/clients';
import { ScimError } from '../scim/errors';
import { matches, parseFilter, parsePath } from '../scim/filter';
import { ENTERPRISE_USER_SCHEMA, GROUP_TYPE, USER_TYPE } from '../scim/schemas';
import { RICH_TEXT_FORMATS, readRichText, writeRichText } from '../tickets/rich-text';
import { eventMatches, urlProblem, validPattern, WEBHOOK_EVENTS } from '../webhooks/model';

/**
 * Fuzz targets for the server's parsers of untrusted input (M1-118, ADR-104): files an import
 * reads, SCIM filters from identity providers, webhook and OAuth addresses, rich text as the
 * API takes it. `pnpm fuzz <name>` runs one; the shared packages' targets are in
 * `packages/devtools/src/fuzz/targets.ts`.
 */

const describe = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : `non-Error ${String(error)}`;

// --- csv: the CSV reader of the CSV import (import/csv.ts) ------------------------------------

const CSV_TOKENS = [
  '"',
  '""',
  ',',
  ';',
  '\t',
  '\r',
  '\n',
  '\r\n',
  "'=",
  "'+",
  '=1+1',
  'a',
  'é',
  '﻿',
];

/** A cell written as RFC 4180 says, quoted when it needs to be. */
const quoteCell = (cell: string, delimiter: string) =>
  /["\r\n]/.test(cell) || cell.includes(delimiter) || cell.startsWith('"')
    ? `"${cell.replaceAll('"', '""')}"`
    : cell;

interface CsvInput {
  delimiter: string;
  /** Rows written properly, when the input is a generated table; undefined for raw bytes. */
  rows?: string[][];
  bytes: Buffer;
}

function csvTable(rng: Rng): string[][] {
  const width = rng.int(1, 8);
  return Array.from({ length: rng.int(1, 12) }, () =>
    Array.from({ length: width }, () => textInput(rng, [], CSV_TOKENS).slice(0, 80)),
  );
}

export function checkCsv(input: CsvInput): FuzzVerdict {
  const d = input.delimiter.charCodeAt(0);
  const read: string[][] = [];
  let last = -1;
  try {
    for (const record of records(input.bytes, input.delimiter)) {
      if (record.start <= last || record.end > input.bytes.length || record.end < record.start) {
        return { problem: `record offsets ${record.start}-${record.end} out of order or bounds` };
      }
      last = record.start;
      read.push(record.fields);
    }
    // Every offset is a place to resume from (the import resumes by offset).
    for (let at = 0; at < Math.min(input.bytes.length, 64); at++) {
      const one = readRecord(input.bytes, at, d);
      if (one && one.next <= at) return { problem: `readRecord at ${at} does not move forward` };
    }
    for (const row of read) {
      for (const cell of row) {
        cellText(cell);
        instantOf(cell);
        const day = dayOf(cell);
        if (day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { problem: `day ${day}` };
        const seconds = secondsOf(cell);
        if (seconds !== null && !(Number.isSafeInteger(seconds) && seconds >= 0)) {
          return { problem: `seconds ${seconds}` };
        }
      }
    }
  } catch (error) {
    return { problem: `the reader threw ${describe(error)}` };
  }
  if (input.rows) {
    // A table written properly reads back cell for cell (blank rows are left out).
    const want = input.rows.filter((r) => !(r.length === 1 && r[0] === ''));
    const got = read.map((r) => r.map((c) => c.replace(/^﻿/, '')));
    const wantClean = want.map((r) => r.map((c) => c.replace(/^﻿/, '')));
    if (JSON.stringify(got) !== JSON.stringify(wantClean)) {
      return { problem: 'a properly written table reads back differently' };
    }
    return 'table';
  }
  return 'bytes';
}

const csvTarget: FuzzTarget<CsvInput> = {
  name: 'csv',
  description:
    'the CSV import reader: never throws, offsets move forward, written tables read back',
  seeds: () => [],
  generate: (rng) => {
    const delimiter = rng.pick([',', ';', '\t', '|']);
    if (rng.chance(0.5)) {
      const rows = csvTable(rng);
      const text = rows
        .map((r) => r.map((c) => quoteCell(c, delimiter)).join(delimiter))
        .join(rng.pick(['\n', '\r\n']));
      // Cells with lone surrogates do not survive UTF-8; such tables are raw input instead.
      const bytes = Buffer.from(text, 'utf8');
      return bytes.toString('utf8') === text && !text.startsWith('﻿')
        ? { delimiter, rows, bytes }
        : { delimiter, bytes };
    }
    let text = csvTable(rng)
      .map((r) => r.join(delimiter))
      .join('\n');
    for (let i = rng.int(1, 5); i > 0; i--) text = mutateText(rng, text, CSV_TOKENS, []);
    const bytes = Buffer.from(text, 'utf8');
    if (rng.chance(0.2)) bytes[rng.int(0, Math.max(0, bytes.length - 1))] = rng.int(0, 255);
    return { delimiter, bytes };
  },
  check: checkCsv,
  show: (i) => JSON.stringify({ delimiter: i.delimiter, text: i.bytes.toString('latin1') }),
};

// --- dc-xml: the backup's XML reading (cleaner, saxes; import/dc-backup) ----------------------

const XML_TOKENS = [
  '<',
  '>',
  '</',
  '/>',
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<entity-engine-xml>',
  '</entity-engine-xml>',
  '<Issue id="1" key="A-1" summary="x"/>',
  '<Project id="10000" key="A" name="A"/>',
  '<![CDATA[',
  ']]>',
  '<!--',
  '-->',
  '<!DOCTYPE x [<!ENTITY e "boom">]>',
  '<!ENTITY a "&b;&b;">',
  '&e;',
  '&amp;',
  '&#0;',
  '&#x1;',
  '&#xFFFE;',
  '&#55296;',
  '&#x110000;',
  '&#99999999999;',
  '&',
  '"',
  "'",
  '=',
  '\u0000',
  '\u0001',
  '￾',
  '￿',
];

const XML_SEEDS = [
  '<?xml version="1.0" encoding="UTF-8"?>\n<entity-engine-xml>\n<Project id="10000" key="ALP" name="Alpha"/>\n<Issue id="10001" project="10000" key="ALP-1" summary="Login &amp; logout"><description><![CDATA[Some *text*]]></description></Issue>\n</entity-engine-xml>\n',
  '<backup><database><table name="AO_60DB71_RAPIDVIEW"><column name="ID"/><row><integer>1</integer><string>Board</string></row></table></database></backup>',
];

interface XmlEvents {
  events: string[];
  error?: string;
}

async function xmlEvents(bytes: Buffer, chunks: number[]): Promise<XmlEvents> {
  const parts: Buffer[] = [];
  let at = 0;
  for (const size of chunks) {
    if (at >= bytes.length) break;
    parts.push(bytes.subarray(at, at + size));
    at += size;
  }
  if (at < bytes.length) parts.push(bytes.subarray(at));
  const events: string[] = [];
  let depth = 0;
  try {
    await parseXml(Readable.from(parts), {
      open: (tag, d) => {
        depth++;
        if (d !== depth) throw new Error(`open at depth ${d}, expected ${depth}`);
        events.push(`<${tag.name} ${JSON.stringify(tag.attributes)}`);
      },
      text: (t) => {
        if (events.at(-1)?.startsWith('#')) events[events.length - 1] += t;
        else events.push(`#${t}`);
      },
      close: (name, d) => {
        if (d !== depth) throw new Error(`close at depth ${d}, expected ${depth}`);
        depth--;
        events.push(`>${name}`);
      },
    });
    return { events };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { events, error: error.message };
  }
}

export async function checkXml(bytes: Buffer, rng: Rng): Promise<FuzzVerdict> {
  // The cleaner gives the same bytes however the input is split.
  const whole = cleanBuffer(bytes).out;
  const split: Buffer[] = [];
  const sizes: number[] = [];
  for (let at = 0; at < bytes.length; ) {
    const size = rng.int(1, 64);
    sizes.push(size);
    at += size;
  }
  {
    const { XmlCleaner } = await import('../import/dc-backup/clean');
    const cleaner = new XmlCleaner();
    cleaner.on('data', (d: Buffer) => split.push(d));
    let at = 0;
    for (const size of sizes) {
      cleaner.write(bytes.subarray(at, at + size));
      at += size;
    }
    cleaner.end();
    await new Promise<void>((done) => cleaner.on('finish', () => done()));
  }
  if (!Buffer.concat(split).equals(whole))
    return { problem: 'the cleaner depends on how the input is split' };
  // What saxes sees after cleaning holds no character XML forbids.
  const text = whole.toString('utf8');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the characters XML forbids
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(text)) {
    return { problem: 'a forbidden character passed the cleaner' };
  }
  const one = await xmlEvents(bytes, [bytes.length]);
  const many = await xmlEvents(bytes, sizes);
  if (JSON.stringify(one) !== JSON.stringify(many)) {
    return { problem: 'the parse depends on how the input is split' };
  }
  return one.error ? 'refused' : 'parsed';
}

const xmlTarget: FuzzTarget<Buffer> = {
  name: 'dc-xml',
  description:
    'the backup XML reader (cleaner and saxes): split-independent, forbidden characters gone, only Errors',
  seeds: () => XML_SEEDS.map((s) => Buffer.from(s)),
  generate: (rng, seeds) => {
    const text = textInput(
      rng,
      seeds.map((s) => s.toString('utf8')),
      XML_TOKENS,
    );
    const bytes = Buffer.from(text, 'utf8');
    if (rng.chance(0.2) && bytes.length > 0) bytes[rng.int(0, bytes.length - 1)] = rng.int(0, 255);
    return bytes;
  },
  check: checkXml,
  show: (b) => b.toString('latin1'),
};

// --- dc-stage: a whole backup ZIP staged (import/dc-backup/stage.ts) --------------------------

interface Backup {
  entities: string;
  activeObjects: string | null;
}

let base: Promise<Backup> | undefined;

async function entryText(zipPath: string, name: string): Promise<string | null> {
  const zip = await new Promise<yauzl.ZipFile>((ok, fail) =>
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (e, f) =>
      e || !f ? fail(e) : ok(f),
    ),
  );
  return new Promise<string | null>((ok, fail) => {
    zip.on('error', fail);
    zip.on('end', () => ok(null));
    zip.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName !== name) return zip.readEntry();
      zip.openReadStream(entry, async (error, stream) => {
        if (error || !stream) return fail(error);
        const parts: Buffer[] = [];
        for await (const c of stream) parts.push(c as Buffer);
        zip.close();
        ok(Buffer.concat(parts).toString('utf8'));
      });
    });
    zip.readEntry();
  });
}

/** A small generated backup (40 issues), once per process. */
function baseBackup(): Promise<Backup> {
  base ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tm-fuzz-dc-'));
    try {
      const { zip } = await generateDcBackup(defaultOptions(40, 118), join(dir, 'base.zip'));
      return {
        entities: (await entryText(zip, ENTITIES_FILE)) ?? '',
        activeObjects: await entryText(zip, ACTIVE_OBJECTS_FILE),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return base;
}

async function zipOf(path: string, files: Record<string, string>): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const [name, text] of Object.entries(files)) zip.addBuffer(Buffer.from(text, 'utf8'), name);
  zip.end();
  const parts: Buffer[] = [];
  for await (const c of zip.outputStream) parts.push(c as Buffer);
  await writeFile(path, Buffer.concat(parts));
}

/** Lines of the generated backup, edited: elements dropped, doubled, cut, attributes garbled. */
function mutateBackup(rng: Rng, backup: Backup): Backup {
  const lines = backup.entities.split('\n');
  for (let i = rng.int(1, 8); i > 0; i--) {
    const at = rng.int(0, lines.length - 1);
    switch (rng.int(0, 5)) {
      case 0:
        lines.splice(at, rng.int(1, 5));
        break;
      case 1:
        lines.splice(at, 0, ...lines.slice(at, at + rng.int(1, 5)));
        break;
      case 2:
        lines[at] = (lines[at] ?? '').replace(
          /="[^"]*"/,
          `="${textInput(rng, [], XML_TOKENS).replaceAll('"', '&quot;').slice(0, 60)}"`,
        );
        break;
      case 3:
        lines[at] = mutateText(rng, lines[at] ?? '', XML_TOKENS, []);
        break;
      case 4:
        lines[at] = (lines[at] ?? '').replace(
          /id="\d+"/,
          `id="${rng.pick(['-1', '0', '1e9', 'x', '', '99999999999999999999', '10000'])}"`,
        );
        break;
      default:
        lines.splice(at, 0, rng.pick(lines));
    }
  }
  return { entities: lines.join('\n'), activeObjects: backup.activeObjects };
}

export async function checkStage(backup: Backup): Promise<FuzzVerdict> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-fuzz-stage-'));
  try {
    const path = join(dir, 'b.zip');
    const files: Record<string, string> = { [ENTITIES_FILE]: backup.entities };
    if (backup.activeObjects !== null) files[ACTIVE_OBJECTS_FILE] = backup.activeObjects;
    await zipOf(path, files);
    try {
      const { summary } = await stageDcBackup(path);
      for (const [kind, n] of Object.entries(summary.kinds)) {
        if (!Number.isSafeInteger(n) || n < 0) return { problem: `staged ${n} of ${kind}` };
      }
      // Staged records are readable JSON lines.
      for (const kind of Object.keys(summary.kinds).slice(0, 3)) {
        const text = await readFile(join(`${path}.staged`, `${kind}.ndjson`), 'utf8').catch(
          () => '',
        );
        for (const line of text.split('\n')) if (line) JSON.parse(line);
      }
      return 'staged';
    } catch (error) {
      if (error instanceof DcBackupError) return 'refused';
      if (error instanceof Error) {
        // A malformed file fails the import with saxes' message (a plain Error); a TypeError,
        // RangeError or the like is a bug.
        if (error.constructor === Error) return 'malformed';
        return { problem: `staging failed with ${describe(error)}` };
      }
      return { problem: `staging threw ${describe(error)}` };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const stageTarget: FuzzTarget<Backup> = {
  name: 'dc-stage',
  description:
    'a whole DC backup ZIP staged from an edited entities.xml: an Error or a stage, never a hang or a crash',
  seeds: async () => [await baseBackup()],
  generate: (rng, seeds) => mutateBackup(rng, rng.pick(seeds)),
  check: checkStage,
  show: (b) => b.entities,
  // Each input writes and stages a ZIP.
  slowMs: 10_000,
};

// --- scim: filters and PATCH paths from identity providers (scim/filter.ts) -------------------

const SCIM_TOKENS = [
  'userName',
  'emails',
  'emails[',
  ']',
  '.value',
  'type',
  'members',
  'displayName',
  'eq',
  'ne',
  'co',
  'sw',
  'ew',
  'gt',
  'ge',
  'lt',
  'le',
  'pr',
  'and',
  'or',
  'not',
  '(',
  ')',
  '"x"',
  '"work"',
  '"',
  '\\"',
  '\\',
  '42',
  '-1.5e3',
  '1e999',
  'true',
  'false',
  'null',
  ' ',
  'meta.created',
  '"2026-01-01T00:00:00Z"',
  `${ENTERPRISE_USER_SCHEMA}:manager.value`,
  `${ENTERPRISE_USER_SCHEMA}:department`,
  'urn:',
  '[',
  '.',
  '__proto__',
  'constructor',
];

const SCIM_SEEDS = [
  'userName eq "ada@example.com"',
  'emails[type eq "work" and value co "@example.com"]',
  'emails[type eq "work"].value eq "ada@example.com"',
  'not (active eq false) and meta.lastModified gt "2026-01-01T00:00:00Z"',
  `${ENTERPRISE_USER_SCHEMA}:department sw "Eng"`,
  'title pr or displayName co "Love"',
  'members[value eq "7"]',
];

const ADA = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', ENTERPRISE_USER_SCHEMA],
  id: '7',
  userName: 'ada@example.com',
  name: { givenName: 'Ada', familyName: 'Lovelace' },
  displayName: 'Ada Lovelace',
  active: true,
  emails: [
    { value: 'ada@example.com', type: 'work', primary: true },
    { value: 'ada@home.example' },
  ],
  [ENTERPRISE_USER_SCHEMA]: { department: 'Engines', manager: { value: '3' } },
  meta: {
    resourceType: 'User',
    created: '2026-01-02T03:04:05Z',
    lastModified: '2026-10-01T00:00:00Z',
  },
};
const TEAM = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
  id: '9',
  displayName: 'Ops',
  members: [{ value: '7' }],
};

export function checkScim(text: string): FuzzVerdict {
  let outcome = 'refused';
  for (const [type, resource] of [
    [USER_TYPE, ADA],
    [GROUP_TYPE, TEAM],
  ] as const) {
    for (const parse of [parseFilter, parsePath]) {
      try {
        const parsed = parse(text, type);
        if (parse === parseFilter) {
          const result = matches(
            resource as Record<string, unknown>,
            parsed as ReturnType<typeof parseFilter>,
          );
          if (typeof result !== 'boolean') return { problem: 'matches gave no boolean' };
        }
        outcome = 'parsed';
      } catch (error) {
        if (!(error instanceof ScimError)) return { problem: `threw ${describe(error)}` };
        if (error.status !== 400 || !error.scimType)
          return { problem: `a ${error.status} without a scimType` };
      }
    }
  }
  return outcome;
}

const scimTarget: FuzzTarget<string> = {
  name: 'scim',
  description: 'SCIM filters and PATCH paths: a parse or a 400 ScimError, matching always answers',
  seeds: () => SCIM_SEEDS,
  generate: (rng, seeds) => textInput(rng, seeds, SCIM_TOKENS),
  check: checkScim,
  show: (s) => s,
};

// --- addresses: webhook targets, OAuth redirects, frontend origins ----------------------------

const URL_TOKENS = [
  'https://',
  'http://',
  'https:',
  'javascript:',
  'file:///',
  'ftp://',
  'localhost',
  '127.0.0.1',
  '[::1]',
  '127.1',
  '0x7f.1',
  '2130706433',
  '[::ffff:127.0.0.1]',
  'localhost.evil.test',
  'app.example.test',
  'evil.test',
  'user:pass@',
  '@',
  ':8080',
  ':0',
  ':99999',
  '/cb',
  '/',
  '//',
  '\\',
  '?',
  '#',
  '%2e%2e',
  '..',
  '*',
  '*.example.test',
  ' ',
  '\t',
  '\n',
  '%00',
  'xn--',
  'ⓔxample.test',
];

const URL_SEEDS = [
  'https://app.example.test/cb',
  'http://localhost:3000/cb',
  'http://127.0.0.1/callback?x=1',
  'https://hooks.example.test/in/abc',
  'https://kit.example.test',
];

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const PATTERNS = [
  ...WEBHOOK_EVENTS.slice(0, 8),
  'ticket.*',
  'comment.*',
  '*',
  'ticket.',
  '.*',
  'x.*',
];

export function checkAddress(text: string): FuzzVerdict {
  let outcome = 'refused';
  try {
    // Webhooks: only HTTPS (or HTTP to this machine), never with credentials.
    if (urlProblem(text) === null) {
      const url = new URL(text);
      if (url.username || url.password) return { problem: 'a webhook address with credentials' };
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
        return { problem: `a webhook address over ${url.protocol}` };
      }
      outcome = 'accepted';
    }
    // OAuth: a redirect matches only itself, or a loopback address on another port.
    const registered = [
      'https://app.example.test/cb',
      'http://localhost:3000/cb',
      'http://127.0.0.1/callback?x=1',
    ];
    if (redirectMatches(registered, text) && !registered.includes(text)) {
      const url = new URL(text);
      if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password) {
        return { problem: `redirect ${JSON.stringify(text)} matched a registered address` };
      }
      outcome = 'accepted';
    }
    // Frontend origins: an origin and nothing else, HTTPS or HTTP on this machine.
    const origin = frontendOrigin(text);
    if (origin !== null) {
      const url = new URL(origin);
      if (url.origin !== origin) return { problem: `origin ${origin} is not an origin` };
      if (origin.includes('*')) return { problem: `origin ${origin} has a wildcard` };
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        return { problem: `origin over ${url.protocol}` };
      const redirect = frontendRedirectUri(`${origin}/cb`, origin);
      if (redirect === null || new URL(redirect).origin !== origin)
        return { problem: 'redirect leaves its origin' };
      outcome = 'accepted';
    }
    const redirect = frontendRedirectUri(text, 'https://kit.example.test');
    if (redirect !== null && new URL(redirect).origin !== 'https://kit.example.test') {
      return { problem: `redirect ${JSON.stringify(text)} leaves its origin` };
    }
    // Webhook event patterns.
    for (const p of [text, ...PATTERNS]) {
      if (!validPattern(p)) continue;
      if (!WEBHOOK_EVENTS.some((t) => eventMatches([p], t)))
        return { problem: `pattern ${p} takes no event` };
    }
  } catch (error) {
    return { problem: `threw ${describe(error)}` };
  }
  return outcome;
}

const addressTarget: FuzzTarget<string> = {
  name: 'addresses',
  description:
    'webhook targets, OAuth redirect matching, frontend origins and event patterns: nothing unsafe accepted',
  seeds: () => URL_SEEDS,
  generate: (rng, seeds) => {
    if (rng.chance(0.5)) {
      let s = '';
      for (let i = rng.int(1, 7); i > 0; i--) s += rng.pick(URL_TOKENS);
      return s;
    }
    return textInput(rng, seeds, URL_TOKENS);
  },
  check: checkAddress,
  show: (s) => s,
};

// --- rich-text: rich text as the API takes and gives it (tickets/rich-text.ts) ----------------

interface RichInput {
  format: (typeof RICH_TEXT_FORMATS)[number];
  value: unknown;
}

const ODD: unknown[] = [null, 1, 'x', [], {}, [1], { a: 1 }, true, ''];

function mutateJson(rng: Rng, value: unknown, depth = 0): unknown {
  if (depth > 6 || rng.chance(0.15)) return structuredClone(rng.pick(ODD));
  if (Array.isArray(value)) {
    const out = value.map((v) => (rng.chance(0.3) ? mutateJson(rng, v, depth + 1) : v));
    if (rng.chance(0.2)) out.push(structuredClone(rng.pick(ODD)));
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    const keys = Object.keys(out);
    if (keys.length > 0 && rng.chance(0.7)) {
      const k = rng.pick(keys);
      out[k] = mutateJson(rng, out[k], depth + 1);
    }
    if (rng.chance(0.1))
      out[rng.pick(['attrs', 'adfAttrs', 'marks', 'content', 'text', 'type', 'adf'])] =
        structuredClone(rng.pick(ODD));
    return out;
  }
  return rng.chance(0.5) ? structuredClone(rng.pick(ODD)) : value;
}

function deep(rng: Rng, format: 'doc' | 'adf'): unknown {
  let node: unknown = { type: 'text', text: 'deep' };
  const kind = format === 'doc' ? 'blockquote' : rng.pick(['blockquote', 'bulletList', 'panel']);
  for (let i = rng.int(100, 50_000); i > 0; i--) node = { type: kind, content: [node] };
  return format === 'doc'
    ? { type: 'doc', content: [node] }
    : { version: 1, type: 'doc', content: [node] };
}

export function checkRichInput(input: RichInput): FuzzVerdict {
  let read: ReturnType<typeof readRichText>;
  try {
    read = readRichText(input.value, input.format);
  } catch (error) {
    return { problem: `readRichText threw ${describe(error)} (a 500)` };
  }
  if (!read.ok) return `refused:${read.problem}`;
  for (const format of RICH_TEXT_FORMATS) {
    try {
      writeRichText(read.text.doc as JsonValue | null, format);
    } catch (error) {
      return { problem: `a stored document cannot be read as ${format}: ${describe(error)}` };
    }
  }
  return 'stored';
}

const richTarget: FuzzTarget<RichInput> = {
  name: 'rich-text',
  description:
    'rich text as the API reads it (doc, adf, markdown, wiki): a value or a refusal, and whatever is stored reads back in every format',
  seeds: async () => {
    const out: RichInput[] = [];
    for (let i = 1; i <= 50; i++) {
      const adf = generateAdfDocument(i);
      out.push({ format: 'adf', value: adf });
      const r = readRichText(adf, 'adf');
      if (r.ok && r.text.doc) out.push({ format: 'doc', value: r.text.doc });
    }
    return out;
  },
  generate: (rng, seeds) => {
    const kind = rng.int(0, 19);
    if (kind === 0)
      return {
        format: rng.pick(['doc', 'adf'] as const),
        value: deep(rng, rng.pick(['doc', 'adf'] as const)),
      };
    if (kind < 4) {
      const format = rng.pick(['markdown', 'wiki'] as const);
      return {
        format,
        value: textInput(
          rng,
          [],
          [
            ...AWKWARD_CHARACTERS,
            '[x|javascript:y]',
            '[x](javascript:y)',
            '{code}',
            '```',
            '@',
            '[~a]',
          ],
        ),
      };
    }
    const seed = rng.pick(seeds);
    let value = seed.value;
    for (let i = rng.int(1, 4); i > 0; i--) value = mutateJson(rng, value);
    return { format: seed.format, value };
  },
  check: checkRichInput,
  show: (i) => JSON.stringify(i),
};

export const FUZZ_TARGETS: readonly FuzzTarget<unknown>[] = [
  csvTarget,
  xmlTarget,
  stageTarget,
  scimTarget,
  addressTarget,
  richTarget,
] as FuzzTarget<unknown>[];
