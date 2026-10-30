import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type {
  Command,
  CustomText,
  ImportFormat,
  ImportSource,
  Mapped,
  Ref,
  SourceItem,
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
    /** The ticket type of rows without a type column (it must exist). */
    type: z.string().min(1).max(255).default('Task'),
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
    delimiter: z.enum([',', ';', '\t', '|']).default(','),
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
  // A byte order mark is not part of the first header.
  let pos = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
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
  return /^'[=+\-@\t\r]/.test(raw) ? raw.slice(1) : raw;
}

// --- The source -------------------------------------------------------------------------------

/** A row's values by what they fill, as the source hands them to the mapper. */
export interface CsvRow {
  line: number;
  /** Set when an earlier row has the same id: this one fails. */
  duplicate?: boolean;
  track: string | null;
  number: number | null;
  type: string;
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
  private readonly buf: Buffer;
  private scanned: {
    rows: { id: string; start: number; end: number; line: number; duplicate: boolean }[];
    named: Map<string, Named[]>;
    columns: Map<CsvTarget | `field:${number}`, number[]>;
  } | null = null;

  constructor(settings: CsvSettings) {
    this.system = settings.system;
    this.mapping = settings.mapping;
    this.buf =
      settings.data !== undefined
        ? Buffer.from(settings.data, 'utf8')
        : readFileSync(settings.path as string);
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
        custom.push({ fieldId: Number(key.slice('field:'.length)), texts, separator });
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
      type: one('type') ?? this.mapping.type,
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
    const all = records(this.buf, this.mapping.delimiter);
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
      add('ticket_type', row.type.toLowerCase(), { name: row.type });
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
    const d = this.mapping.delimiter.charCodeAt(0);
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
    type: { kind: 'ticket_type', id: row.type.toLowerCase() },
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
