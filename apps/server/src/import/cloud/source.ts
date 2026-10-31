import type { Database, JsonValue } from '@taskmoor/db';
import { openSecret, type PepperRing } from '@taskmoor/iam';
import { type AdfNode, fromAdfJson, type PmJson, toPlainText } from '@taskmoor/richtext';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { type FieldShape, type FieldType, parseValue } from '../../fields/types';
import { checkLabels } from '../../tickets/fields';
import { shapeOfType } from '../dc-fields';
import type {
  Coverage,
  HistoryValue,
  ImportFormat,
  ImportSource,
  Mapped,
  OpenContext,
  Ref,
  SourceItem,
  SourceNote,
  SourceRecord,
  Stage,
  Warning,
} from '../model';
import { type ClientOptions, CloudClient, type Transport } from './client';
import { CloudFetcher, type FetchState, LISTED_TICKETS } from './fetch';
import { type PeopleSettings, peopleSettings, personMapping } from './people';

/**
 * A server that speaks the Jira-compatible REST API as an import source (M1-095; IMP-002,
 * IMP-007, IMP-009; ADR-094), read with the customer's own token. The fetch (`fetch.ts`) stages
 * everything first, resumably; this source then reads the staged records a page at a time, and
 * the mapper below turns them into the framework's commands, the same kinds the backup importer
 * makes. Kinds staged here that the framework does not load (issues the token could not read,
 * boards of projects left out) are counted with their reason.
 */
export const CLOUD_SOURCE = 'cloud-rest';

const sealed = z.string().min(1).max(4096);

/** A run's stored settings: the token only sealed (`sealSecret`), never as given. */
export const cloudSettings = z
  .object({
    format: z.literal(CLOUD_SOURCE),
    baseUrl: z.string().url().max(2000),
    system: z.string().min(1).max(200),
    auth: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('basic'), email: z.string().max(320), token: sealed }).strict(),
      z.object({ kind: z.literal('bearer'), token: sealed }).strict(),
    ]),
    projects: z.array(z.string().min(1).max(40)).max(1000).nullable().default(null),
    jql: z.string().min(1).max(10_000).nullable().default(null),
    pageSize: z.number().int().min(1).max(100).default(100),
    concurrency: z.number().int().min(1).max(16).default(4),
    people: peopleSettings.default({ mode: 'email' }),
    /**
     * A delta run (M1-096): when the earlier run's fetch began. Only issues updated since then
     * are fetched, and the site's issue ids are listed to find the ones it no longer has.
     */
    since: z.iso.datetime().nullable().default(null),
  })
  .strict();
export type CloudSettings = z.infer<typeof cloudSettings>;

/** What the format needs from the server: the pepper ring, and how to reach a base URL. */
export interface CloudDeps {
  peppers?: PepperRing | undefined;
  /** Replaced in tests (replay, in process); the platform's fetch otherwise. */
  transport: (baseUrl: string) => Transport;
  /** Retry timing; tests make waiting instant. */
  client?: Omit<ClientOptions, 'transport' | 'authorization' | 'concurrency'>;
  /** Issues per details chunk (tests use small ones). */
  detailChunk?: number;
  /** How far before the earlier fetch a delta search reaches (`DELTA_OVERLAP_MS`). */
  deltaOverlapMs?: number;
}

export class CloudSourceError extends Error {}

/** The `Authorization` header from stored settings, the token unsealed only here. */
export function authorizationOf(settings: CloudSettings, peppers: PepperRing | undefined): string {
  const token = openSecret(settings.auth.token, peppers);
  if (token === null) throw new CloudSourceError('token_unreadable');
  if (settings.auth.kind === 'bearer') return `Bearer ${token}`;
  return `Basic ${Buffer.from(`${settings.auth.email}:${token}`).toString('base64')}`;
}

/** Kinds the fetch reads whole on every run (M1-096). */
const WHOLE = new Set([
  'field',
  'field_context',
  'ticket_type',
  'priority',
  'close_reason',
  'status',
  'link_type',
  'track',
  'release',
  'area',
]);

/** Reasons of the staged kinds the framework does not load. */
const LEFT_OUT: Record<string, string> = {
  issue_unreadable: 'not_visible_to_token',
  board_not_imported: 'project_not_imported',
};

export class CloudSource implements ImportSource {
  readonly importSource = CLOUD_SOURCE;
  readonly system: string;
  private shapes: Map<string, FieldShape> | null = null;
  private readonly lookup: Map<string, string> | null;

  constructor(
    private readonly settings: CloudSettings,
    private readonly context: OpenContext,
    private readonly deps: CloudDeps,
  ) {
    this.system = settings.system;
    this.lookup =
      settings.people.mode === 'csv'
        ? new Map(settings.people.rows.map((r) => [r.source, r.target]))
        : null;
  }

  private get db(): Kysely<Database> {
    return this.context.db;
  }

  async prepare(until: number): Promise<'ready' | 'more'> {
    const client = new CloudClient({
      ...this.deps.client,
      transport: this.deps.transport(this.settings.baseUrl),
      authorization: authorizationOf(this.settings, this.deps.peppers),
      concurrency: this.settings.concurrency,
    });
    const fetcher = new CloudFetcher(
      this.db,
      { id: this.context.runId, workspaceId: this.context.workspaceId },
      client,
      {
        projects: this.settings.projects,
        jql: this.settings.jql,
        pageSize: this.settings.pageSize,
        since: this.settings.since,
        ...(this.deps.detailChunk ? { detailChunk: this.deps.detailChunk } : {}),
        ...(this.deps.deltaOverlapMs !== undefined ? { overlapMs: this.deps.deltaOverlapMs } : {}),
      },
    );
    return fetcher.run(until);
  }

  async kinds(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('import_staged')
      .select('kind')
      .distinct()
      .where('run_id', '=', this.context.runId)
      .execute();
    // A delta run's listing of the site's ids is no kind of record (M1-096).
    return rows.map((r) => r.kind).filter((k) => k !== LISTED_TICKETS);
  }

  /**
   * What a delta run (M1-096) can tell is gone: configuration, boards and sprints are read whole;
   * tickets are listed by id; a changed ticket's comments, time and history are read whole.
   * People and options are only those seen, so nothing is said of them.
   */
  async coverage(kind: string): Promise<Coverage> {
    if (kind === 'ticket') return this.settings.since === null ? 'all' : 'listed';
    if (kind === 'comment' || kind === 'time_entry' || kind === 'history') {
      return 'within_tickets';
    }
    if (kind === 'board' || kind === 'sprint') {
      const state = await this.fetchState();
      return state.agile?.unavailable ? null : 'all';
    }
    return WHOLE.has(kind) ? 'all' : null;
  }

  private async fetchState(): Promise<FetchState> {
    const row = await this.db
      .selectFrom('import_run')
      .select('fetch_state')
      .where('id', '=', this.context.runId)
      .executeTakeFirstOrThrow();
    return row.fetch_state as FetchState;
  }

  async unsupported(kind: string): Promise<{ count: number; reason: string } | null> {
    const reason = LEFT_OUT[kind];
    if (!reason) return null;
    const row = await this.db
      .selectFrom('import_staged')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('run_id', '=', this.context.runId)
      .where('kind', '=', kind)
      .executeTakeFirstOrThrow();
    return { count: Number(row.n), reason };
  }

  async notes(): Promise<SourceNote[]> {
    const state = await this.fetchState();
    const notes: SourceNote[] = [];
    const stats = state.stats;
    if (stats && stats.throttled > 0) {
      notes.push({ code: 'source_throttled', count: stats.throttled, examples: [] });
    }
    if (stats && stats.failures > 0) {
      notes.push({ code: 'source_failures_retried', count: stats.failures, examples: [] });
    }
    if (state.agile?.unavailable) {
      notes.push({ code: 'agile_api_unavailable', count: 1, examples: [] });
    }
    return notes;
  }

  /** Custom field shapes by source id, for reading the values tickets hold. */
  private async fieldShapes(): Promise<Map<string, FieldShape>> {
    if (this.shapes) return this.shapes;
    const rows = await this.db
      .selectFrom('import_staged')
      .select(['source_id', 'data'])
      .where('run_id', '=', this.context.runId)
      .where('kind', '=', 'field')
      .execute();
    const out = new Map<string, FieldShape>();
    for (const r of rows) {
      const shape = cloudShape((r.data as { raw: Raw }).raw?.schema);
      if (shape && !('skip' in shape)) out.set(r.source_id, shape);
    }
    this.shapes = out;
    return out;
  }

  async read(kind: string, after: string | null, limit: number): Promise<SourceItem[]> {
    const [depth, ordinal] = (after ?? '0:0').split(':').map(Number) as [number, number];
    const rows = await this.db
      .selectFrom('import_staged')
      .select(['source_id', 'label', 'data', 'depth', 'ordinal'])
      .where('run_id', '=', this.context.runId)
      .where('kind', '=', kind)
      .where((eb) =>
        eb.or([
          eb('depth', '>', depth),
          eb.and([eb('depth', '=', depth), eb('ordinal', '>', String(ordinal))]),
        ]),
      )
      .orderBy('depth')
      .orderBy('ordinal')
      .limit(limit)
      .execute();
    const shapes = kind === 'ticket' ? await this.fieldShapes() : null;
    return rows.map((r) => {
      let data = r.data as Record<string, unknown>;
      if (kind === 'user') {
        const u = data as Raw;
        data = {
          ...data,
          mapping: personMapping(
            this.settings.people,
            String(u.accountId),
            u.emailAddress ? String(u.emailAddress) : null,
            this.lookup,
          ),
          mode: this.settings.people.mode,
        };
      } else if (shapes) {
        // The shapes of the custom fields the ticket holds: the mapper reads values by them.
        const fields = ((data as Raw).fields ?? {}) as Record<string, unknown>;
        const own: Record<string, FieldShape> = {};
        for (const key of Object.keys(fields)) {
          const m = /^customfield_(\d+)$/.exec(key);
          const shape = m ? shapes.get(m[1] as string) : undefined;
          if (m && shape) own[m[1] as string] = shape;
        }
        data = { ...data, shapes: own };
      }
      return {
        kind,
        id: r.source_id,
        ...(r.label !== null && kind !== 'ticket' ? { label: r.label } : {}),
        data,
        cursor: `${r.depth}:${r.ordinal}`,
      };
    });
  }
}

// --- Mapping ----------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: staged API bodies are read field by field
type Raw = any;

const ref = (kind: Ref['kind'], id: unknown): Ref | null =>
  id === null || id === undefined || id === '' ? null : { kind, id: String(id) };
const personRef = (u: Raw): Ref | null => (u ? ref('user', u.accountId ?? u.id) : null);
const idOf = (x: Raw): string | null =>
  x && typeof x === 'object' && x.id !== undefined && x.id !== null ? String(x.id) : null;

/** An instant as the API writes it (`2026-10-31T09:00:00.000+0000`) in ISO form. */
export function instantOf(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const text = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Plain text as a document of paragraphs. */
function plainDoc(text: string): JsonValue {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .filter((b) => b.trim() !== '');
  return {
    type: 'doc',
    content: (blocks.length === 0 ? [''] : blocks).map((block) =>
      block === ''
        ? { type: 'paragraph' }
        : { type: 'paragraph', content: [{ type: 'text', text: block }] },
    ),
  };
}

/**
 * Rich text in Taskmoor's stored form: the document format (version 3) converted, text (version
 * 2, or a server that answers text) as paragraphs. Mentions keep the source's account ids,
 * which the load maps to people.
 */
function docOf(value: unknown, warnings: Warning[], where: string): JsonValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : plainDoc(value);
  if (typeof value === 'object' && (value as { type?: string }).type === 'doc') {
    // A document without a version is already in Taskmoor's stored form: a Taskmoor source
    // answers custom paragraph values that way.
    if ((value as { version?: number }).version === undefined) return value as JsonValue;
    try {
      return fromAdfJson(value as AdfNode) as unknown as JsonValue;
    } catch {
      warnings.push({ code: 'rich_text_as_plain_text', detail: where });
      return plainDoc(adfText(value));
    }
  }
  warnings.push({ code: 'rich_text_not_imported', detail: where });
  return null;
}

/** The text of a document-format node, for when it does not convert. */
function adfText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { text?: string; content?: unknown[]; type?: string };
  if (typeof n.text === 'string') return n.text;
  const inner = (n.content ?? []).map(adfText);
  return n.type === 'doc' ? inner.join('\n\n') : inner.join('');
}

const textOf = (value: unknown, warnings: Warning[], where: string): string => {
  const doc = docOf(value, warnings, where);
  return doc === null ? '' : toPlainText(doc as unknown as PmJson);
};

/**
 * A custom field's Taskmoor shape from its schema: the built-in custom types by their key (as
 * the backup importer reads them), Taskmoor's own (`taskmoor:<type>`, multiple when the schema
 * is an array), or a reason to leave it out. Fields of apps become read-only text.
 */
export function cloudShape(schema: Raw): FieldShape | { skip: string } | null {
  if (!schema || typeof schema !== 'object') return null;
  const custom = String(schema.custom ?? '');
  if (custom.startsWith('taskmoor:')) {
    const type = custom.slice('taskmoor:'.length) as FieldType;
    if (type === 'formula') return { skip: 'computed_field' };
    if (type === 'team') return { skip: 'not_imported_yet' };
    const multiple = schema.type === 'array';
    const parsed = parseValue({ type, multiple, config: {} }, null);
    return parsed.ok || type === 'read-only-text' || type === 'paragraph'
      ? { type, multiple, config: {} }
      : { skip: 'unknown_field_type' };
  }
  const shape = shapeOfType(custom);
  if (shape) return shape;
  if (custom !== '') return { type: 'read-only-text', multiple: false, config: {} };
  return null;
}

/** A custom value as the API gives it, in stored form with source ids; undefined: not held. */
function storedValue(shape: FieldShape, value: Raw): JsonValue | null | undefined {
  if (value === null || value === undefined) return null;
  const parse = (input: unknown) => {
    const parsed = parseValue(shape, input);
    if (!parsed.ok) return undefined;
    return parsed.value === undefined ? null : (parsed.value as JsonValue);
  };
  const ids = (list: Raw[], key: (x: Raw) => unknown) => {
    const out = list.map(key).filter((x) => x !== null && x !== undefined && x !== '');
    return out.length === list.length ? out : undefined;
  };
  switch (shape.type) {
    case 'text':
    case 'url':
      return parse(typeof value === 'string' ? value : String(value));
    case 'read-only-text': {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return parse(text.slice(0, 255));
    }
    case 'paragraph': {
      const doc = docOf(value, [], 'fields');
      return doc === null ? null : parse(doc);
    }
    case 'number':
      return parse(typeof value === 'number' ? value : Number(value));
    case 'date':
      return parse(String(value).slice(0, 10));
    case 'datetime':
      return parse(instantOf(value));
    case 'labels': {
      const list = Array.isArray(value) ? value.map(String) : [];
      if (list.length === 0) return null;
      const checked = checkLabels(list);
      return checked.ok ? checked.labels : undefined;
    }
    case 'select':
    case 'release':
    case 'area': {
      const list = ids(Array.isArray(value) ? value : [value], idOf);
      if (list === undefined) return undefined;
      const sorted = [...new Set(list.map(Number))].sort((a, b) => a - b);
      if (sorted.length === 0) return null;
      return shape.multiple ? sorted : (sorted[0] as number);
    }
    case 'cascading-select': {
      const parent = idOf(value);
      if (parent === null) return undefined;
      const child = idOf(value.child);
      return child === null ? [Number(parent)] : [Number(parent), Number(child)];
    }
    case 'user': {
      const list = ids(Array.isArray(value) ? value : [value], (u) => u?.accountId ?? u?.id);
      if (list === undefined) return undefined;
      const people = [...new Set(list.map(String))];
      if (people.length === 0) return null;
      return shape.multiple ? people : (people[0] as string);
    }
    default:
      return undefined;
  }
}

const STAGES: Record<string, Stage> = { new: 'new', indeterminate: 'active', done: 'closed' };

/**
 * Changelog fields by the names the compatible API gives (and Taskmoor's own, which a Taskmoor
 * source answers with), as history names them, with the kind their ids name.
 */
const HISTORY_FIELDS: Record<string, { field: string; ref?: Ref['kind'] }> = {
  status: { field: 'status', ref: 'status' },
  assignee: { field: 'assignee', ref: 'user' },
  reporter: { field: 'requester', ref: 'user' },
  requester: { field: 'requester', ref: 'user' },
  summary: { field: 'summary' },
  duedate: { field: 'dueDate' },
  dueDate: { field: 'dueDate' },
  startDate: { field: 'startDate' },
  priority: { field: 'priority', ref: 'priority' },
  resolution: { field: 'closeReason', ref: 'close_reason' },
  closeReason: { field: 'closeReason', ref: 'close_reason' },
  issuetype: { field: 'type', ref: 'ticket_type' },
  type: { field: 'type', ref: 'ticket_type' },
  timeoriginalestimate: { field: 'originalEstimate' },
  originalEstimate: { field: 'originalEstimate' },
  timeestimate: { field: 'remainingEstimate' },
  remainingEstimate: { field: 'remainingEstimate' },
};
/** The entries a Taskmoor source writes when a ticket is made: its starting values. */
const CREATION_FIELDS = new Set(['key', 'track']);
/**
 * Entries a Taskmoor source writes for content that arrives as its own records (comments, time
 * entries and the time they add up to) or that the target keeps itself (rank): left out quietly.
 */
const CARRIED_ELSEWHERE = new Set(['comment', 'timeEntry', 'timeSpent', 'rank']);

const numberOf = (key: unknown): number | null => {
  const m = /-([1-9][0-9]{0,9})$/.exec(String(key ?? ''));
  return m ? Number(m[1]) : null;
};

function mapUser(d: Raw): Mapped {
  const mapping = d.mapping as { email: string | null; link?: 'existing' | 'scim' };
  const mode = d.mode as PeopleSettings['mode'];
  const name = String(d.displayName ?? d.accountId);
  const warnings: Warning[] = [];
  if (mode === 'email' && !d.emailAddress) warnings.push({ code: 'no_email' });
  if (d.accountType === 'app') warnings.push({ code: 'app_account' });
  return {
    command: {
      kind: 'user',
      email: mapping.email,
      name,
      active: d.active !== false,
      timeZone: d.timeZone ?? null,
      ...(mapping.link ? { link: mapping.link } : {}),
    },
    warnings,
  };
}

function mapTicket(d: Raw): Mapped {
  const f = d.fields ?? {};
  const warnings: Warning[] = [];
  const summary = String(f.summary ?? '').trim();
  if (summary === '') return { fail: 'no_summary' };
  const track = ref('track', f.project?.id);
  if (!track) return { fail: 'no_project' };
  const shapes = (d.shapes ?? {}) as Record<string, FieldShape>;
  const fields: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(f as Record<string, Raw>)) {
    const m = /^customfield_(\d+)$/.exec(key);
    if (!m || value === null || value === undefined) continue;
    const id = m[1] as string;
    const shape = shapes[id];
    if (!shape) {
      warnings.push({ code: 'field_value_not_imported', detail: key });
      continue;
    }
    const stored = storedValue(shape, value);
    if (stored === undefined) warnings.push({ code: 'invalid_field_value', detail: key });
    else if (stored !== null) fields[id] = stored;
  }
  const tracking = f.timetracking ?? {};
  const seconds = (v: unknown) => (typeof v === 'number' && v >= 0 ? Math.round(v) : null);
  const list = (values: Raw, kind: Ref['kind']) =>
    ((values ?? []) as Raw[]).flatMap((x) => {
      const r = ref(kind, idOf(x));
      return r ? [r] : [];
    });
  const labels = Array.isArray(f.labels) ? [...new Set((f.labels as unknown[]).map(String))] : [];
  return {
    command: {
      kind: 'ticket',
      track,
      number: numberOf(d.key),
      type: ref('ticket_type', idOf(f.issuetype)),
      status: ref('status', idOf(f.status)),
      summary,
      description: null,
      docs: {
        description: docOf(f.description, warnings, 'description'),
        environment: docOf(f.environment, warnings, 'environment'),
      },
      assignee: personRef(f.assignee),
      requester: personRef(f.reporter),
      creator: personRef(f.creator ?? f.reporter),
      parent: ref('ticket', idOf(f.parent)),
      priority: null,
      priorityRef: ref('priority', idOf(f.priority)),
      closeReason: ref('close_reason', idOf(f.resolution)),
      labels,
      startDate: null,
      dueDate: typeof f.duedate === 'string' ? f.duedate.slice(0, 10) : null,
      createdAt: instantOf(f.created),
      updatedAt: instantOf(f.updated),
      closedAt: instantOf(f.resolutiondate),
      originalEstimate: seconds(tracking.originalEstimateSeconds ?? f.timeoriginalestimate),
      remainingEstimate: seconds(tracking.remainingEstimateSeconds ?? f.timeestimate),
      releases: { target: list(f.fixVersions, 'release'), found: list(f.versions, 'release') },
      areas: list(f.components, 'area'),
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
    },
    warnings,
  };
}

function mapHistory(d: Raw): Mapped {
  const warnings: Warning[] = [];
  const items: { field: string; from: HistoryValue; to: HistoryValue }[] = [];
  const raw = (d.items ?? []) as Raw[];
  if (raw.some((i) => CREATION_FIELDS.has(String(i.field)))) return { skip: 'creation_entry' };
  for (const item of raw) {
    if (CARRIED_ELSEWHERE.has(String(item.field))) continue;
    const known =
      HISTORY_FIELDS[String(item.fieldId ?? item.field)] ?? HISTORY_FIELDS[String(item.field)];
    if (!known) {
      warnings.push({ code: 'history_field_not_imported', detail: String(item.field) });
      continue;
    }
    const value = (v: unknown, display: unknown): HistoryValue => {
      const text = v === null || v === undefined || v === '' ? null : String(v);
      const shown = display === null || display === undefined ? null : String(display);
      return known.ref && text !== null
        ? { ref: { kind: known.ref, id: text }, display: shown }
        : {
            text: known.ref ? null : (text ?? (known.field === 'summary' ? shown : null)),
            display: shown,
          };
    };
    items.push({
      field: known.field,
      from: value(item.from, item.fromString),
      to: value(item.to, item.toString),
    });
  }
  if (items.length === 0) return { skip: 'no_supported_history_items', warnings };
  const at = instantOf(d.created);
  if (at === null) return { fail: 'no_time', warnings };
  return {
    command: {
      kind: 'history',
      ticket: { kind: 'ticket', id: String(d.issueId) },
      actor: personRef(d.author),
      at,
      items,
    },
    warnings,
  };
}

function mapComment(d: Raw): Mapped {
  const warnings: Warning[] = [];
  const created = instantOf(d.created);
  if (created === null) return { fail: 'no_time' };
  const updated = instantOf(d.updated) ?? created;
  if (d.visibility)
    warnings.push({ code: 'comment_visibility_not_imported', detail: String(d.visibility.type) });
  const doc = docOf(d.body, warnings, 'comment');
  const edited = updated !== created;
  return {
    command: {
      kind: 'comment',
      ticket: { kind: 'ticket', id: String(d.issueId) },
      author: personRef(d.author),
      body: '',
      doc: doc ?? plainDoc(''),
      visibleGroup: null,
      createdAt: created,
      updatedAt: updated,
      editedAt: edited ? updated : null,
      editedBy: edited ? personRef(d.updateAuthor) : null,
    },
    warnings,
  };
}

function mapTimeEntry(d: Raw): Mapped {
  const warnings: Warning[] = [];
  const author = personRef(d.author);
  if (!author) return { fail: 'no_author' };
  const started = instantOf(d.started);
  if (started === null) return { fail: 'no_time' };
  const seconds = Number(d.timeSpentSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return { fail: 'no_time_spent' };
  return {
    command: {
      kind: 'time_entry',
      ticket: { kind: 'ticket', id: String(d.issueId) },
      author,
      startedAt: started,
      seconds: Math.round(seconds),
      description: textOf(d.comment ?? null, warnings, 'worklog'),
      ...(instantOf(d.created) ? { createdAt: instantOf(d.created) as string } : {}),
      ...(instantOf(d.updated) ? { updatedAt: instantOf(d.updated) as string } : {}),
    },
    warnings,
  };
}

const dayStart = (day: unknown) =>
  typeof day === 'string' && /^\d{4}-\d{2}-\d{2}/.test(day)
    ? `${day.slice(0, 10)}T00:00:00.000Z`
    : null;

const MAPPERS: Record<string, (d: Raw) => Mapped> = {
  user: mapUser,
  status: (d) => {
    const key = String(d.statusCategory?.key ?? '');
    const stage = STAGES[key];
    return {
      command: {
        kind: 'status',
        name: String(d.name),
        description: String(d.description ?? ''),
        stage: stage ?? 'new',
      },
      warnings: stage ? [] : [{ code: 'unknown_status_category', detail: key }],
    };
  },
  priority: (d) => ({
    command: {
      kind: 'priority',
      name: String(d.name),
      description: String(d.description ?? ''),
      icon: null,
      color: typeof d.statusColor === 'string' ? d.statusColor : null,
    },
  }),
  close_reason: (d) => ({
    command: {
      kind: 'close_reason',
      name: String(d.name),
      description: String(d.description ?? ''),
    },
  }),
  ticket_type: (d) => ({
    command: {
      kind: 'ticket_type',
      name: String(d.name),
      description: String(d.description ?? ''),
      level: d.subtask ? 'subticket' : Number(d.hierarchyLevel ?? 0) > 0 ? 'outcome' : 'standard',
    },
  }),
  link_type: (d) => ({
    command: {
      kind: 'link_type',
      name: String(d.name),
      outward: String(d.outward ?? ''),
      inward: String(d.inward ?? ''),
    },
  }),
  track: (d) => {
    const types: Record<string, 'software' | 'business' | 'service'> = {
      software: 'software',
      business: 'business',
      service_desk: 'service',
    };
    const trackType = types[String(d.projectTypeKey)];
    return {
      command: {
        kind: 'track',
        key: String(d.key),
        name: String(d.name),
        description: String(d.description ?? ''),
        owner: personRef(d.lead),
        trackType: trackType ?? 'business',
      },
      warnings: trackType
        ? []
        : [{ code: 'unknown_project_type', detail: String(d.projectTypeKey ?? '') }],
    };
  },
  release: (d) => {
    const warnings: Warning[] = [];
    const day = dayStart(d.releaseDate) ?? dayStart(d.startDate);
    if ((d.released || d.archived) && day === null) warnings.push({ code: 'release_date_unknown' });
    return {
      command: {
        kind: 'release',
        track: { kind: 'track', id: String(d.projectId) },
        name: String(d.name),
        description: String(d.description ?? ''),
        startDate: typeof d.startDate === 'string' ? d.startDate.slice(0, 10) : null,
        releaseDate: typeof d.releaseDate === 'string' ? d.releaseDate.slice(0, 10) : null,
        shippedAt: d.released ? day : null,
        archivedAt: d.archived ? day : null,
      },
      warnings,
    };
  },
  area: (d) => {
    const defaults: Record<string, 'area_owner' | 'track_owner' | 'unassigned'> = {
      COMPONENT_LEAD: 'area_owner',
      PROJECT_LEAD: 'track_owner',
      PROJECT_DEFAULT: 'track_owner',
      UNASSIGNED: 'unassigned',
    };
    return {
      command: {
        kind: 'area',
        track: { kind: 'track', id: String(d.projectId) },
        name: String(d.name),
        description: String(d.description ?? ''),
        owner: personRef(d.lead),
        defaultAssignee: defaults[String(d.assigneeType)] ?? 'unassigned',
        archivedAt: null,
      },
    };
  },
  field: (d) => {
    const raw = d.raw ?? {};
    const shape = cloudShape(raw.schema);
    if (shape === null) return { skip: 'unknown_field_type' };
    if ('skip' in shape) return { skip: shape.skip };
    const custom = String(raw.schema?.custom ?? '');
    const app = !custom.startsWith('taskmoor:') && shapeOfType(custom) === null;
    return {
      command: {
        kind: 'field',
        name: String(raw.name),
        description: String(raw.description ?? ''),
        type: shape.type,
        multiple: shape.multiple,
        config: shape.config as Record<string, JsonValue>,
        track: null,
      },
      warnings: app ? [{ code: 'app_field_as_read_only_text', detail: custom }] : [],
    };
  },
  field_context: (d) => ({
    command: {
      kind: 'field_context',
      field: { kind: 'field', id: String(d.field) },
      name: 'Imported context',
      description: '',
      defaultValue: null,
      config: {},
      scopes: [{ track: null, type: null }],
    },
  }),
  field_option: (d) => ({
    command: {
      kind: 'field_option',
      context: { kind: 'field_context', id: String(d.field) },
      parent: ref('field_option', d.parent),
      value: String(d.value),
      sortOrder: 0,
      disabled: false,
    },
  }),
  ticket: mapTicket,
  history: mapHistory,
  comment: mapComment,
  time_entry: mapTimeEntry,
  board: (d) => {
    const warnings: Warning[] = [];
    const track = ref('track', d.location?.projectId);
    if (!track) return { fail: 'no_project' };
    const kind = d.type === 'scrum' ? 'scrum' : 'kanban';
    if (d.type !== 'scrum' && d.type !== 'kanban')
      warnings.push({ code: 'board_type_as_kanban', detail: String(d.type) });
    return {
      command: {
        kind: 'board',
        name: String(d.name),
        description: '',
        boardKind: kind,
        track,
        query: typeof d.filterJql === 'string' && d.filterJql !== '' ? d.filterJql : null,
        columns: ((d.columns ?? []) as Raw[]).slice(0, 30).map((c) => ({
          name: String(c.name).slice(0, 100),
          statuses: ((c.statuses ?? []) as Raw[]).flatMap((s) => {
            const r = ref('status', idOf(s));
            return r ? [r] : [];
          }),
          min: typeof c.min === 'number' ? c.min : null,
          max: typeof c.max === 'number' ? c.max : null,
        })),
      },
      warnings,
    };
  },
  sprint: (d) => {
    const state = d.state === 'active' || d.state === 'closed' ? d.state : 'future';
    return {
      command: {
        kind: 'sprint',
        board: { kind: 'board', id: String(d.boardId) },
        name: String(d.name),
        goal: String(d.goal ?? ''),
        state,
        startAt: instantOf(d.startDate),
        endAt: instantOf(d.endDate),
        startedAt: instantOf(d.activatedDate),
        completedAt: instantOf(d.completeDate),
        tickets: ((d.issues ?? []) as unknown[]).map((id) => ({ kind: 'ticket', id: String(id) })),
      },
    };
  },
};

export function mapCloudRecord(record: SourceRecord): Mapped {
  const mapper = MAPPERS[record.kind];
  if (!mapper) return { fail: 'unknown_kind' };
  return mapper(record.data);
}

/** The format, with what it needs to reach the source and open its token. */
export function cloudFormat(deps: CloudDeps): ImportFormat {
  return {
    importSource: CLOUD_SOURCE,
    open(source: unknown, context?: OpenContext) {
      if (!context) throw new CloudSourceError('no_context');
      return new CloudSource(cloudSettings.parse(source), context, deps);
    },
    map: mapCloudRecord,
    sourceHistory: true,
  };
}
