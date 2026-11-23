import { isUtf8 } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { bomLength, CSV_DELIMITERS, detectDelimiter } from '@taskmoor/webconfig';
import { z } from 'zod';
import type {
  Command,
  CustomText,
  ImportFormat,
  ImportSource,
  Mapped,
  Ref,
  SourceItem,
  SourceNote,
  SourceRecord,
  TicketProperty,
  Warning,
} from './model';

/**
 * CSV import (M1-098; IMP-012) through the importer framework (ADR-048). A file (uploaded, or
 * a path on the server) and a mapping of its columns to ticket fields: system fields, custom
 * fields by id, labels, releases, areas and the parent by key or by another row's id. The run
 * is staged, resumable and idempotent like every import: each row is a ticket record keyed by
 * its id column, else its key column, else its line, so importing the same file again with
 * changes updates the tickets it made (IMP-012 (2)); a key column also updates a ticket the
 * target already has at that key (create-or-update by key). A dry run reports every row's
 * problems without writing.
 *
 * The source scans the file once per job part: record boundaries (RFC 4180: quotes, doubled
 * quotes, line breaks inside quotes, CRLF), the people, statuses, types, tracks, releases and
 * areas the rows name (each becomes a record the framework links to the target's own, people
 * by email, or creates where that is allowed), and the order of the rows: parents before
 * children (IMP-012 (1)), then by line. A batch reads its rows from their byte offsets.
 *
 * The CSV that Taskmoor's search export writes (M1-042) reads back with a mapping of its
 * columns: lists are split on "; ", and a cell that starts with an apostrophe before =, +, -,
 * @, a tab or a carriage return (the export's guard against spreadsheet formulas) loses it.
 *
 * Files as spreadsheets save them (T-263): the separator is found from the header when the
 * mapping does not name one (`detectDelimiter`); a file that is not UTF-8 is read as UTF-16 when
 * it starts with that byte-order mark, else as Windows-1252 (what Excel's plain "CSV" saves in
 * Western Europe and the Americas), with a note in the report; and a number field of a semicolon
 * file reads a decimal comma ("2,5", "1.234,5"), as the export's semicolon style writes it.
 */
export const CSV_SOURCE = 'csv';

/** The fields a column can fill. */
export const CSV_TARGETS = [
  'id',
  'key',
  'track',
  'summary',
  'description',
  'type',
  'status',
  'priority',
  'assignee',
  'requester',
  'creator',
  'parent',
  'labels',
  'targetRelease',
  'foundInRelease',
  'area',
  'startDate',
  'dueDate',
  'createdAt',
  'updatedAt',
  'closedAt',
  'originalEstimate',
  'remainingEstimate',
  'field',
  'ignore',
] as const;
export type CsvTarget = (typeof CSV_TARGETS)[number];

const trackKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,9}$/);

export const csvMapping = z
  .object({
    /** The track of rows without a track or key column. */
    track: trackKey.optional(),
    /** The ticket type of rows without a type (it must exist); the track's default if left out. */
    type: z.string().min(1).max(255).optional(),
    columns: z
      .array(
        z
          .object({
            /** The header, as the file's first row has it (every column of that name). */
            column: z.string().min(1).max(500),
            to: z.enum(CSV_TARGETS),
            /** A custom field by id, for `to: 'field'`. */
            field: z.number().int().positive().max(2_147_483_647).optional(),
          })
          .strict()
          .refine((c) => (c.to === 'field') === (c.field !== undefined), {
            message: 'a field column names its field, and only it',
          }),
      )
      .min(1)
      .max(500),
    /**
     * Between the cells; found from the header when left out (T-263). Runs stored before then
     * hold the comma that was the default.
     */
    delimiter: z.enum(CSV_DELIMITERS).optional(),
    /** Between the values of a list in one cell (releases, areas, fields with several values). */
    listSeparator: z.string().min(1).max(3).default(';'),
    /** People by the text the file has for them, when it is not an email: text to email. */
    people: z.record(z.string().max(500), z.email()).default({}),
  })
  .strict();
export type CsvMapping = z.infer<typeof csvMapping>;

export const csvSource = z
  .object({
    format: z.literal(CSV_SOURCE),
    /** The file's text (an upload) ... */
    data: z.string().min(1).max(16_000_000).optional(),
    /** ... or a file on the server (the route keeps it inside the imports folder). */
    path: z.string().min(1).max(4096).optional(),
    /** Names the file's ids: importing again with the same system updates. */
    system: z.string().min(1).max(200).default('csv'),
    mapping: csvMapping,
  })
  .strict()
  .refine((s) => (s.data === undefined) !== (s.path === undefined), {
    message: 'give data or a path',
  });
export type CsvSettings = z.infer<typeof csvSource>;

export class CsvFormatError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`line ${line}: ${message}`);
  }
}

// --- Reading records --------------------------------------------------------------------------

const QUOTE = 0x22;
const CR = 0x0d;
const LF = 0x0a;

export interface CsvRecord {
  fields: string[];
  /** Byte offsets of the record in the file. */
  start: number;
  end: number;
  /** The file's line the record starts on, from 1. */
  line: number;
}

/**
 * Reads one record at a byte offset (RFC 4180, leniently: text after a closing quote is
 * ignored, an unclosed quote runs to the end). Works on bytes: the structural characters are
 * ASCII, which never occurs inside a multi-byte UTF-8 character.
 */
export function readRecord(
  buf: Buffer,
  start: number,
  delimiter: number,
): { fields: string[]; next: number; lines: number } | null {
  if (start >= buf.length) return null;
  const fields: string[] = [];
  let pos = start;
  let lines = 1;
  for (;;) {
    if (buf[pos] === QUOTE) {
      pos += 1;
      const parts: Buffer[] = [];
      let from = pos;
      for (;;) {
        const q = buf.indexOf(QUOTE, pos);
        if (q < 0) {
          parts.push(buf.subarray(from));
          pos = buf.length;
          break;
        }
        if (buf[q + 1] === QUOTE) {
          parts.push(buf.subarray(from, q + 1));
          pos = q + 2;
          from = pos;
          continue;
        }
        parts.push(buf.subarray(from, q));
        pos = q + 1;
        break;
      }
      const value = Buffer.concat(parts);
      for (const b of value) if (b === LF) lines += 1;
      fields.push(value.toString('utf8'));
      while (pos < buf.length && buf[pos] !== delimiter && buf[pos] !== LF && buf[pos] !== CR) {
        pos += 1;
      }
    } else {
      const from = pos;
      while (pos < buf.length && buf[pos] !== delimiter && buf[pos] !== LF && buf[pos] !== CR) {
        pos += 1;
      }
      fields.push(buf.toString('utf8', from, pos));
    }
    if (pos >= buf.length) return { fields, next: buf.length, lines };
    if (buf[pos] === delimiter) {
      pos += 1;
      if (pos >= buf.length) {
        fields.push('');
        return { fields, next: pos, lines };
      }
      continue;
    }
    if (buf[pos] === CR) pos += 1;
    if (buf[pos] === LF) pos += 1;
    return { fields, next: pos, lines };
  }
}

/** Every record of a file, blank lines left out. */
export function* records(buf: Buffer, delimiter: string): Generator<CsvRecord> {
  const d = delimiter.charCodeAt(0);
  // A byte-order mark is not part of the first header: every export writes one (T-252).
  let pos = bomLength(buf);
  let line = 1;
  for (;;) {
    const read = readRecord(buf, pos, d);
    if (!read) return;
    const blank = read.fields.length === 1 && read.fields[0] === '';
    if (!blank) yield { fields: read.fields, start: pos, end: read.next, line };
    line += read.lines;
    pos = read.next;
  }
}

/** A cell as written, without the formula guard an export added. */
export function cellText(raw: string): string {
  return /^'[=+\-@\t\r＝＋－＠]/.test(raw) ? raw.slice(1) : raw;
}

// --- Encodings and numbers (T-263) ------------------------------------------------------------

/** How a file's bytes were read. */
export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/**
 * Windows-1252's characters for the bytes 0x80 to 0x9F, where it differs from Latin-1 (the euro
 * sign, curly quotes, dashes, Š, Œ, Ž and so on). The five bytes it leaves undefined keep the
 * Latin-1 control character, as browsers do. A table, so reading does not depend on the
 * runtime's ICU data.
 */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152,
  0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122,
  0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

/**
 * A file's bytes as UTF-8, once, before any record is read, so the byte offsets every job part
 * resumes from are the same (T-263):
 *
 * - a UTF-16 byte-order mark (FF FE or FE FF; Excel's "Unicode text") reads the rest as UTF-16;
 * - otherwise bytes that are valid UTF-8 after any UTF-8 mark are kept as they are;
 * - anything else is read as Windows-1252, which is what Excel's plain "CSV" saves in Spain and
 *   the rest of Western Europe and the Americas. Accented text in that code page is almost never
 *   valid UTF-8, and plain ASCII reads the same both ways, so the test does not misjudge a file
 *   either way in practice. Other code pages (Mac Roman, Windows-1250) still read wrong: the
 *   report's note says to save as "CSV UTF-8".
 */
export function decodeCsv(raw: Buffer): { bytes: Buffer; encoding: CsvEncoding } {
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return {
      bytes: Buffer.from(raw.subarray(2).toString('utf16le'), 'utf8'),
      encoding: 'utf-16le',
    };
  }
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    const swapped = Buffer.from(raw.subarray(2, 2 + ((raw.length - 2) & ~1)));
    swapped.swap16();
    return { bytes: Buffer.from(swapped.toString('utf16le'), 'utf8'), encoding: 'utf-16be' };
  }
  const start = bomLength(raw);
  if (isUtf8(raw.subarray(start))) return { bytes: raw, encoding: 'utf-8' };
  const text = raw
    .subarray(start)
    .toString('latin1')
    .replace(/[\u0080-\u009f]/g, (c) =>
      String.fromCharCode(CP1252_HIGH[c.charCodeAt(0) - 0x80] as number),
    );
  return { bytes: Buffer.from(text, 'utf8'), encoding: 'windows-1252' };
}

/**
 * A number cell of a semicolon file, where the comma is the decimal mark, as a number field
 * reads it: "2,5" is 2.5 and "1.234,5" is 1234.5 (dots group thousands), as the export's
 * semicolon style writes them (T-263). A cell with one group of three after a dot and no comma,
 * such as "1.234", could be a thousands dot or a decimal point, so it is refused (null) rather than
 * read as either. Anything else is returned as it is, for the field's own reading: "2.5" stays a
 * decimal point, as a file from elsewhere may have it.
 */
export function fromDecimalComma(text: string): string | null {
  const t = text.trim();
  const comma = /^([+-]?)(\d{1,3}(?:\.\d{3})+|\d*),(\d+)([eE][+-]?\d{1,4})?$/.exec(t);
  if (comma) {
    const [, sign = '', whole = '', fraction = '', exponent = ''] = comma;
    return `${sign}${whole.replaceAll('.', '')}.${fraction}${exponent}`;
  }
  if (/^[+-]?[1-9]\d{0,2}\.\d{3}$/.test(t)) return null;
  if (/^[+-]?[1-9]\d{0,2}(?:\.\d{3}){2,}$/.test(t)) return t.replaceAll('.', '');
  return t;
}

/**
 * The first word of each line with a letter outside ASCII, as the note about the reading shows:
 * `<line>: <word>`, data only, which the report words in the reader's language.
 */
function accentedLines(bytes: Buffer): { count: number; examples: string[] } {
  const examples: string[] = [];
  let count = 0;
  const lines = bytes.toString('utf8', bomLength(bytes)).split('\n');
  for (const [i, line] of lines.entries()) {
    const word = /[^\s,;|"]*\P{ASCII}[^\s,;|"]*/u.exec(line);
    if (!word) continue;
    count += 1;
    if (examples.length < 5) examples.push(`${i + 1}: ${word[0].slice(0, 40)}`);
  }
  return { count, examples };
}

// --- The source -------------------------------------------------------------------------------

/** A row's values by what they fill, as the source hands them to the mapper. */
export interface CsvRow {
  line: number;
  /** Set when an earlier row has the same id: this one fails. */
  duplicate?: boolean;
  track: string | null;
  number: number | null;
  type: string | null;
  /** Properties the mapping fills (a row leaves the others as they are on update). */
  mapped: string[];
  values: Partial<Record<CsvTarget, string[]>>;
  /** People columns as emails; null for text that names nobody. */
  people: Partial<Record<'assignee' | 'requester' | 'creator', string | null>>;
  parent: { row: string } | { key: string } | null;
  custom: CustomText[];
  separator: string;
}

const PEOPLE = ['assignee', 'requester', 'creator'] as const;
const KEY = /^([A-Za-z][A-Za-z0-9_]{0,9})-([1-9][0-9]{0,9})$/;

const splitList = (texts: string[], separator: string) =>
  texts
    .flatMap((t) => t.split(separator))
    .map((t) => t.trim())
    .filter((t) => t !== '');

/** A record of a kind other than ticket: what the rows name, each once. */
interface Named {
  id: string;
  data: Record<string, unknown>;
}

export class CsvSource implements ImportSource {
  readonly importSource = CSV_SOURCE;
  readonly system: string;
  private readonly mapping: CsvMapping;
  /** The file as UTF-8 (`decodeCsv`): every offset is into these bytes. */
  private readonly buf: Buffer;
  /** How the file's bytes were read. */
  readonly encoding: CsvEncoding;
  /** The mapping's separator, else the one the header shows (T-263). */
  readonly delimiter: string;
  private scanned: {
    rows: { id: string; start: number; end: number; line: number; duplicate: boolean }[];
    named: Map<string, Named[]>;
    columns: Map<CsvTarget | `field:${number}`, number[]>;
  } | null = null;

  constructor(settings: CsvSettings) {
    this.system = settings.system;
    this.mapping = settings.mapping;
    const read = decodeCsv(
      settings.data !== undefined
        ? Buffer.from(settings.data, 'utf8')
        : readFileSync(settings.path as string),
    );
    this.buf = read.bytes;
    this.encoding = read.encoding;
    this.delimiter = settings.mapping.delimiter ?? detectDelimiter(this.buf);
  }

  /** The header's columns by what they fill, or the first problem with the mapping. */
  private columns(header: string[]) {
    const columns = new Map<CsvTarget | `field:${number}`, number[]>();
    for (const c of this.mapping.columns) {
      if (c.to === 'ignore') continue;
      const indexes = header.flatMap((h, i) => (h.trim() === c.column ? [i] : []));
      if (indexes.length === 0) throw new CsvFormatError(1, `no column "${c.column}"`);
      const key: CsvTarget | `field:${number}` =
        c.to === 'field' ? `field:${c.field as number}` : c.to;
      columns.set(key, [...(columns.get(key) ?? []), ...indexes]);
    }
    return columns;
  }

  /** The row at a record, as the mapper reads it. */
  private row(fields: string[], line: number): CsvRow {
    const { columns } = this.scan();
    const separator = this.mapping.listSeparator;
    const values: Partial<Record<CsvTarget, string[]>> = {};
    const custom: CustomText[] = [];
    for (const [key, indexes] of columns) {
      const texts = indexes.map((i) => cellText(fields[i] ?? ''));
      if (key.startsWith('field:')) {
        custom.push({
          fieldId: Number(key.slice('field:'.length)),
          texts,
          separator,
          // A semicolon file writes numbers with a decimal comma (T-263).
          ...(this.delimiter === ';' ? { decimalComma: true } : {}),
        });
      } else {
        values[key as CsvTarget] = texts;
      }
    }
    const one = (target: CsvTarget) => {
      const v = values[target]?.find((t) => t.trim() !== '');
      return v === undefined ? null : v.trim();
    };
    const key = one('key');
    const keyMatch = key === null ? null : KEY.exec(key);
    const people: CsvRow['people'] = {};
    for (const p of PEOPLE) {
      if (values[p] === undefined) continue;
      const text = one(p);
      people[p] = text === null ? null : this.email(text);
    }
    const parentText = one('parent');
    return {
      line,
      track: (one('track') ?? keyMatch?.[1] ?? this.mapping.track ?? null)?.toUpperCase() ?? null,
      number: keyMatch ? Number(keyMatch[2]) : null,
      type: one('type') ?? this.mapping.type ?? null,
      mapped: [...columns.keys()],
      values,
      people,
      parent:
        parentText === null
          ? null
          : this.rowIds().has(parentText)
            ? { row: parentText }
            : { key: parentText },
      custom,
      separator,
    };
  }

  /** A person's email from a cell: an email, or text the mapping's people names. */
  private email(text: string): string | null {
    const mapped = this.mapping.people[text];
    if (mapped) return mapped.toLowerCase();
    return text.includes('@') ? text.toLowerCase() : null;
  }

  private ids: Set<string> | null = null;
  private rowIds(): Set<string> {
    if (!this.ids) this.ids = new Set(this.scan().rows.map((r) => r.id));
    return this.ids;
  }

  /** Reads the file once: rows, their order, and what they name. */
  private scan() {
    if (this.scanned) return this.scanned;
    const all = records(this.buf, this.delimiter);
    const head = all.next();
    if (head.done) throw new CsvFormatError(1, 'empty');
    const columns = this.columns(head.value.fields);
    this.scanned = { rows: [], named: new Map(), columns };
    const separator = this.mapping.listSeparator;
    const idColumn = columns.get('id') ?? columns.get('key');
    const parentColumn = columns.get('parent');
    const raw: { id: string; parent: string | null; rec: CsvRecord }[] = [];
    const named = new Map<string, Map<string, Named>>();
    const add = (kind: string, id: string, data: Record<string, unknown>) => {
      const m = named.get(kind) ?? new Map<string, Named>();
      named.set(kind, m);
      if (!m.has(id)) m.set(id, { id, data });
    };
    for (const rec of all) {
      const cell = (indexes: number[] | undefined) =>
        indexes?.map((i) => cellText(rec.fields[i] ?? '').trim()).find((t) => t !== '') ?? null;
      const id = cell(idColumn) ?? `line:${rec.line}`;
      raw.push({ id, parent: cell(parentColumn), rec });
    }
    // Ids are known before any row is read: a parent may come later in the file.
    const seen = new Set<string>();
    this.ids = new Set(raw.map((r) => r.id));
    for (const r of raw) {
      const row = this.row(r.rec.fields, r.rec.line);
      if (row.track) add('track', row.track, { key: row.track });
      if (row.type) add('ticket_type', row.type.toLowerCase(), { name: row.type });
      const status = row.values.status?.find((t) => t.trim() !== '')?.trim();
      if (status) add('status', status.toLowerCase(), { name: status });
      for (const p of PEOPLE) {
        const email = row.people[p];
        if (email) add('user', email, { email });
      }
      if (row.track) {
        for (const target of ['targetRelease', 'foundInRelease', 'area'] as const) {
          for (const name of splitList(row.values[target] ?? [], separator)) {
            const kind = target === 'area' ? 'area' : 'release';
            add(kind, `${row.track}/${name.toLowerCase()}`, { track: row.track, name });
          }
        }
      }
    }
    // Parents before children, then by line; a cycle stops at the rows count.
    const byId = new Map(raw.map((r) => [r.id, r]));
    const depth = new Map<string, number>();
    const depthOf = (id: string): number => {
      const known = depth.get(id);
      if (known !== undefined) return known;
      let d = 0;
      let at = byId.get(id);
      const walked = new Set<string>();
      while (at?.parent && byId.has(at.parent) && !walked.has(at.parent)) {
        walked.add(at.parent);
        d += 1;
        at = byId.get(at.parent);
      }
      depth.set(id, d);
      return d;
    };
    const ordered = raw
      .map((r, i) => ({ r, i, d: depthOf(r.id) }))
      .sort((a, b) => a.d - b.d || a.i - b.i);
    for (const { r } of ordered) {
      const duplicate = seen.has(r.id);
      seen.add(r.id);
      this.scanned.rows.push({
        id: duplicate ? `${r.id}#line:${r.rec.line}` : r.id,
        start: r.rec.start,
        end: r.rec.end,
        line: r.rec.line,
        duplicate,
      });
    }
    for (const [kind, m] of named) {
      this.scanned.named.set(
        kind,
        [...m.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      );
    }
    return this.scanned;
  }

  /** The header's problems, checked when the run starts. */
  check(): void {
    this.scan();
  }

  /**
   * A file read as Windows-1252 says so in the report, with the first lines whose letters to
   * check (T-263). A separator found from the header gets no note: the header shows it.
   */
  async notes(): Promise<SourceNote[]> {
    if (this.encoding !== 'windows-1252') return [];
    const { count, examples } = accentedLines(this.buf);
    return [{ code: 'read_as_windows_1252', count: Math.max(count, 1), examples }];
  }

  async kinds(): Promise<string[]> {
    const { named, rows } = this.scan();
    return [...named.keys(), ...(rows.length > 0 ? ['ticket'] : [])];
  }

  async read(kind: string, after: string | null, limit: number): Promise<SourceItem[]> {
    const { named, rows } = this.scan();
    const from = after === null ? 0 : Number(after);
    if (kind !== 'ticket') {
      return (named.get(kind) ?? []).slice(from, from + limit).map((n, i) => ({
        kind,
        id: n.id,
        data: n.data,
        cursor: String(from + i + 1),
      }));
    }
    const d = this.delimiter.charCodeAt(0);
    return rows.slice(from, from + limit).map((r, i) => {
      const read = readRecord(this.buf, r.start, d);
      const row = this.row(read?.fields ?? [], r.line);
      if (r.duplicate) row.duplicate = true;
      return {
        kind,
        id: r.id,
        data: row as unknown as Record<string, unknown>,
        cursor: String(from + i + 1),
      };
    });
  }
}

// --- Mapping rows to commands -----------------------------------------------------------------

/** An instant from a cell: ISO 8601, or a day (midnight UTC), or "YYYY-MM-DD HH:MM[:SS]" (UTC). */
export function instantOf(text: string): string | null {
  const t = text.trim();
  const day = /^(\d{4}-\d{2}-\d{2})$/.exec(t);
  if (day) return `${day[1]}T00:00:00.000Z`;
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2}(\.\d{1,6})?)?$/.exec(t);
  const candidate = local ? `${local[1]}T${local[2]}${local[3] ?? ':00'}Z` : t;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(candidate)) return null;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A calendar day from a cell: a day, or the day of an instant. */
export function dayOf(text: string): string | null {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const date = new Date(`${t}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === t ? t : null;
  }
  return instantOf(t)?.slice(0, 10) ?? null;
}

/** Seconds from a cell: a number of seconds, or hours and minutes ("2h 30m"). */
export function secondsOf(text: string): number | null {
  const t = text.trim();
  if (/^\d{1,12}$/.test(t)) return Number(t);
  const m = /^(?:(\d{1,9})h)?\s*(?:(\d{1,9})m)?$/.exec(t);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60;
}

/** The ticket properties each target fills. */
const FILLS: Partial<Record<CsvTarget, TicketProperty>> = {
  summary: 'summary',
  description: 'description',
  type: 'type',
  status: 'status',
  priority: 'priority',
  assignee: 'assignee',
  requester: 'requester',
  creator: 'creator',
  parent: 'parent',
  labels: 'labels',
  targetRelease: 'targetReleases',
  foundInRelease: 'foundReleases',
  area: 'areas',
  startDate: 'startDate',
  dueDate: 'dueDate',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  closedAt: 'closedAt',
  originalEstimate: 'originalEstimate',
  remainingEstimate: 'remainingEstimate',
};

function mapRow(row: CsvRow): Mapped {
  if (row.duplicate) return { fail: 'duplicate_row_id' };
  if (row.track === null) return { fail: 'no_track' };
  const warnings: Warning[] = [];
  const one = (target: CsvTarget) => {
    const v = row.values[target]?.find((t) => t.trim() !== '');
    return v === undefined ? null : v.trim();
  };
  const read = <T>(target: CsvTarget, parse: (t: string) => T | null): T | null => {
    const text = one(target);
    if (text === null) return null;
    const value = parse(text);
    if (value === null) warnings.push({ code: 'invalid_value', detail: target });
    return value;
  };
  const person = (p: (typeof PEOPLE)[number]): Ref | null => {
    const email = row.people[p];
    if (email === undefined || email === null) {
      if (email === null && one(p) !== null) warnings.push({ code: 'unknown_person', detail: p });
      return null;
    }
    return { kind: 'user', id: email };
  };
  const list = (target: CsvTarget) => splitList(row.values[target] ?? [], row.separator);
  const named = (kind: 'release' | 'area', target: CsvTarget): Ref[] =>
    list(target).map((name) => ({ kind, id: `${row.track}/${name.toLowerCase()}` }));
  const filled = new Set(
    row.mapped.flatMap((m) => {
      const p = FILLS[m as CsvTarget];
      return p ? [p] : m.startsWith('field:') ? ['fields' as const] : [];
    }),
  );
  const summary = one('summary');
  if (filled.has('summary') && summary === null) return { fail: 'summary_required', warnings };
  const status = one('status');
  const command: Command = {
    kind: 'ticket',
    track: { kind: 'track', id: row.track },
    number: row.number,
    type: row.type === null ? null : { kind: 'ticket_type', id: row.type.toLowerCase() },
    status: status === null ? null : { kind: 'status', id: status.toLowerCase() },
    summary: summary ?? '',
    description: one('description'),
    assignee: person('assignee'),
    requester: person('requester'),
    creator: person('creator'),
    parent: row.parent && 'row' in row.parent ? { kind: 'ticket', id: row.parent.row } : null,
    parentKey: row.parent && 'key' in row.parent ? row.parent.key : null,
    priority: one('priority'),
    labels: list('labels').flatMap((l) => l.split(/\s+/)),
    startDate: read('startDate', dayOf),
    dueDate: read('dueDate', dayOf),
    createdAt: read('createdAt', instantOf),
    updatedAt: read('updatedAt', instantOf),
    closedAt: read('closedAt', instantOf),
    originalEstimate: read('originalEstimate', secondsOf),
    remainingEstimate: read('remainingEstimate', secondsOf),
    releases: {
      target: named('release', 'targetRelease'),
      found: named('release', 'foundInRelease'),
    },
    areas: named('area', 'area'),
    customTexts: row.custom,
    ...(row.number === null ? {} : { match: 'key' as const }),
    keep: (
      [
        'type',
        'status',
        'summary',
        'description',
        'assignee',
        'requester',
        'creator',
        'parent',
        'priority',
        'labels',
        'startDate',
        'dueDate',
        'createdAt',
        'updatedAt',
        'closedAt',
        'originalEstimate',
        'remainingEstimate',
        'targetReleases',
        'foundReleases',
        'areas',
        'fields',
      ] as const
    ).filter((p) => !filled.has(p)),
  };
  return { command, warnings };
}

export function mapCsvRecord(record: SourceRecord): Mapped {
  const d = record.data;
  switch (record.kind) {
    case 'user': {
      const email = String(d.email);
      // People the file names who are not here yet: deactivated, so attribution stays.
      return {
        command: {
          kind: 'user',
          email,
          name: email.split('@')[0] ?? email,
          active: false,
          timeZone: null,
        },
      };
    }
    case 'status':
      return { command: { kind: 'status', name: String(d.name), stage: 'new', mustExist: true } };
    case 'ticket_type':
      return {
        command: {
          kind: 'ticket_type',
          name: String(d.name),
          description: '',
          level: 'standard',
          mustExist: true,
        },
      };
    case 'track':
      return {
        command: {
          kind: 'track',
          key: String(d.key),
          name: String(d.key),
          description: '',
          owner: null,
          trackType: 'software',
          match: 'key',
        },
      };
    case 'release':
      return {
        command: {
          kind: 'release',
          track: { kind: 'track', id: String(d.track) },
          name: String(d.name),
          description: '',
          startDate: null,
          releaseDate: null,
          shippedAt: null,
          archivedAt: null,
        },
      };
    case 'area':
      return {
        command: {
          kind: 'area',
          track: { kind: 'track', id: String(d.track) },
          name: String(d.name),
          description: '',
          owner: null,
          defaultAssignee: 'unassigned',
          archivedAt: null,
        },
      };
    case 'ticket':
      return mapRow(d as unknown as CsvRow);
    default:
      return { fail: 'unsupported_kind' };
  }
}

export const csvFormat: ImportFormat = {
  importSource: CSV_SOURCE,
  open: (source) => new CsvSource(csvSource.parse(source)),
  map: mapCsvRecord,
};
