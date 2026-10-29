import { z } from 'zod';
import type {
  Command,
  HistoryValue,
  ImportFormat,
  ImportSource,
  Mapped,
  Ref,
  SourceItem,
  SourceRecord,
  Warning,
} from './model';

/**
 * The synthetic source format (M1-086): a small format of our own that exercises the importer
 * framework until the real readers arrive (backup XML M1-087, Cloud REST M1-095, CSV). It is
 * newline-delimited JSON written by `syntheticFixture` or by hand: a header line
 * `{"format": "taskmoor-synthetic", "version": 1, "system": "..."}`, then one record per line,
 * `{"kind": "...", "id": "...", ...fields}`. Its vocabulary is deliberately not the
 * target's (`category` instead of stage, `lead`, `reporter`, `resolved`, `started`), so the
 * mapper has real work.
 * Records of kinds the framework does not import (`board`, `dashboard`) are reported as
 * unsupported; fields the mapper does not know are reported as warnings.
 */
export const SYNTHETIC_FORMAT = 'taskmoor-synthetic';
export const SYNTHETIC_SOURCE = 'synthetic';

const header = z.object({
  format: z.literal(SYNTHETIC_FORMAT),
  version: z.literal(1),
  system: z.string().min(1).max(200),
});

const recordLine = z.looseObject({
  kind: z.string().min(1).max(100),
  id: z.string().min(1).max(200),
});

export class SyntheticFormatError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`line ${line}: ${message}`);
  }
}

/** Parses the format; throws `SyntheticFormatError` naming the first bad line. */
export function parseSynthetic(text: string): { system: string; records: SourceRecord[] } {
  const lines = text.split('\n');
  let system: string | null = null;
  const records: SourceRecord[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new SyntheticFormatError(i + 1, 'not JSON');
    }
    if (system === null) {
      const parsed = header.safeParse(value);
      if (!parsed.success) throw new SyntheticFormatError(i + 1, 'not a taskmoor-synthetic header');
      system = parsed.data.system;
      continue;
    }
    const parsed = recordLine.safeParse(value);
    if (!parsed.success) throw new SyntheticFormatError(i + 1, 'a record needs a kind and an id');
    const { kind, id, ...data } = parsed.data;
    if (seen.has(`${kind}\u0000${id}`)) throw new SyntheticFormatError(i + 1, 'duplicate record');
    seen.add(`${kind}\u0000${id}`);
    records.push({ kind, id, data });
  }
  if (system === null) throw new SyntheticFormatError(1, 'empty');
  return { system, records };
}

/** A parsed synthetic file as a source: records of a kind in file order, the cursor a position. */
export class SyntheticSource implements ImportSource {
  readonly importSource = SYNTHETIC_SOURCE;
  readonly system: string;
  private readonly records: SourceRecord[];

  constructor(text: string) {
    const parsed = parseSynthetic(text);
    this.system = parsed.system;
    this.records = parsed.records;
  }

  async kinds(): Promise<string[]> {
    return [...new Set(this.records.map((r) => r.kind))];
  }

  async read(kind: string, after: string | null, limit: number): Promise<SourceItem[]> {
    const out: SourceItem[] = [];
    for (let i = after === null ? 0 : Number(after) + 1; i < this.records.length; i++) {
      const record = this.records[i] as SourceRecord;
      if (record.kind !== kind) continue;
      out.push({ ...record, cursor: String(i) });
      if (out.length >= limit) break;
    }
    return out;
  }
}

// --- Mapping -------------------------------------------------------------------------------

const text = z.string().max(100_000);
const id = z.string().min(1).max(200);
const instant = z.iso.datetime({ offset: true });
const day = z.iso.date();

const SCHEMAS = {
  user: z.object({
    email: z.string().email().max(320).nullable().optional(),
    name: z.string().min(1).max(200),
    active: z.boolean().optional(),
    deleted: z.boolean().optional(),
    timeZone: z.string().max(100).nullable().optional(),
  }),
  group: z.object({
    name: z.string().min(1).max(200),
    description: text.optional(),
    members: z.array(id).optional(),
  }),
  status: z.object({
    name: z.string().min(1).max(200),
    category: z.enum(['todo', 'in_progress', 'done']),
  }),
  ticket_type: z.object({
    name: z.string().min(1).max(200),
    description: text.optional(),
    subtask: z.boolean().optional(),
  }),
  track: z.object({
    key: z.string().min(1).max(255),
    name: z.string().min(1).max(200),
    description: text.optional(),
    lead: id.nullable().optional(),
    style: z.enum(['software', 'business', 'service']).optional(),
  }),
  ticket: z.object({
    track: id,
    number: z.number().int().min(1).max(2_147_483_647),
    type: id,
    status: id.nullable().optional(),
    summary: z.string().min(1).max(255),
    description: text.nullable().optional(),
    assignee: id.nullable().optional(),
    reporter: id.nullable().optional(),
    creator: id.nullable().optional(),
    parent: id.nullable().optional(),
    priority: z.string().max(200).nullable().optional(),
    labels: z.array(z.string().min(1).max(255)).optional(),
    start: day.nullable().optional(),
    due: day.nullable().optional(),
    created: instant,
    updated: instant.optional(),
    resolved: instant.nullable().optional(),
    estimate: z.number().int().min(0).nullable().optional(),
    remaining: z.number().int().min(0).nullable().optional(),
  }),
  comment: z.object({
    ticket: id,
    author: id.nullable().optional(),
    body: z.string().min(1).max(100_000),
    group: id.nullable().optional(),
    created: instant,
    updated: instant.optional(),
  }),
  link: z.object({
    from: id,
    to: id,
    type: z.object({
      name: z.string().min(1).max(200),
      outward: z.string().min(1).max(200),
      inward: z.string().min(1).max(200),
    }),
    created: instant,
    creator: id.nullable().optional(),
  }),
  history: z.object({
    ticket: id,
    actor: id.nullable().optional(),
    at: instant,
    items: z
      .array(
        z.object({
          field: z.string().min(1).max(100),
          from: z.string().nullable(),
          to: z.string().nullable(),
          fromDisplay: z.string().nullable().optional(),
          toDisplay: z.string().nullable().optional(),
        }),
      )
      .min(1),
  }),
  time_entry: z.object({
    ticket: id,
    author: id,
    started: instant,
    seconds: z.number().int().min(1).max(31_536_000),
    comment: z.string().max(100_000).optional(),
  }),
} as const;

/** History fields whose values are references, and the kind they refer to. */
const REF_FIELDS: Record<string, Ref['kind']> = {
  status: 'status',
  assignee: 'user',
  requester: 'user',
  type: 'ticket_type',
  parent: 'ticket',
};
/** History fields the synthetic format may carry, as history names them. */
const HISTORY_FIELDS = new Set([
  ...Object.keys(REF_FIELDS),
  'summary',
  'description',
  'labels',
  'dueDate',
  'startDate',
  'priority',
  'originalEstimate',
  'remainingEstimate',
]);

const ref = (kind: Ref['kind'], value: string | null | undefined): Ref | null =>
  value === null || value === undefined ? null : { kind, id: value };
const iso = (value: string) => new Date(value).toISOString();

/** Maps a synthetic record to a command; unknown fields become warnings. */
export function mapSynthetic(record: SourceRecord): Mapped {
  const schema = SCHEMAS[record.kind as keyof typeof SCHEMAS];
  if (!schema) return { fail: 'unsupported_kind' };
  const parsed = schema.safeParse(record.data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { fail: `invalid:${first?.path.join('.') || 'record'}` };
  }
  const known = new Set(Object.keys(schema.shape));
  const warnings: Warning[] = Object.keys(record.data)
    .filter((k) => !known.has(k))
    .sort()
    .map((k) => ({ code: 'unsupported_field', detail: k }));
  const command = toCommand(record.kind as keyof typeof SCHEMAS, parsed.data, warnings);
  return 'fail' in command ? { ...command, warnings } : { command, warnings };
}

function toCommand(
  kind: keyof typeof SCHEMAS,
  data: Record<string, unknown>,
  warnings: Warning[],
): Command | { fail: string } {
  switch (kind) {
    case 'user': {
      const d = data as z.infer<(typeof SCHEMAS)['user']>;
      return {
        kind,
        email: d.email ?? null,
        name: d.name,
        active: (d.active ?? true) && !d.deleted,
        timeZone: d.timeZone ?? null,
      };
    }
    case 'group': {
      const d = data as z.infer<(typeof SCHEMAS)['group']>;
      return {
        kind,
        name: d.name,
        description: d.description ?? '',
        members: (d.members ?? []).map((m) => ({ kind: 'user', id: m })),
      };
    }
    case 'status': {
      const d = data as z.infer<(typeof SCHEMAS)['status']>;
      const stage = ({ todo: 'new', in_progress: 'active', done: 'closed' } as const)[d.category];
      return { kind, name: d.name, stage };
    }
    case 'ticket_type': {
      const d = data as z.infer<(typeof SCHEMAS)['ticket_type']>;
      return {
        kind,
        name: d.name,
        description: d.description ?? '',
        level: d.subtask ? 'subticket' : 'standard',
      };
    }
    case 'track': {
      const d = data as z.infer<(typeof SCHEMAS)['track']>;
      return {
        kind,
        key: d.key,
        name: d.name,
        description: d.description ?? '',
        owner: ref('user', d.lead),
        trackType: d.style ?? 'software',
      };
    }
    case 'ticket': {
      const d = data as z.infer<(typeof SCHEMAS)['ticket']>;
      const created = iso(d.created);
      return {
        kind,
        track: { kind: 'track', id: d.track },
        number: d.number,
        type: { kind: 'ticket_type', id: d.type },
        status: ref('status', d.status),
        summary: d.summary,
        description: d.description ?? null,
        assignee: ref('user', d.assignee),
        requester: ref('user', d.reporter),
        creator: ref('user', d.creator ?? d.reporter),
        parent: ref('ticket', d.parent),
        priority: d.priority ?? null,
        labels: [...new Set(d.labels ?? [])],
        startDate: d.start ?? null,
        dueDate: d.due ?? null,
        createdAt: created,
        updatedAt: d.updated ? iso(d.updated) : created,
        closedAt: d.resolved ? iso(d.resolved) : null,
        originalEstimate: d.estimate ?? null,
        remainingEstimate: d.remaining ?? d.estimate ?? null,
      };
    }
    case 'comment': {
      const d = data as z.infer<(typeof SCHEMAS)['comment']>;
      const created = iso(d.created);
      return {
        kind,
        ticket: { kind: 'ticket', id: d.ticket },
        author: ref('user', d.author),
        body: d.body,
        visibleGroup: ref('group', d.group),
        createdAt: created,
        updatedAt: d.updated ? iso(d.updated) : created,
      };
    }
    case 'link': {
      const d = data as z.infer<(typeof SCHEMAS)['link']>;
      return {
        kind,
        source: { kind: 'ticket', id: d.from },
        target: { kind: 'ticket', id: d.to },
        linkType: d.type,
        createdAt: iso(d.created),
        creator: ref('user', d.creator),
      };
    }
    case 'history': {
      const d = data as z.infer<(typeof SCHEMAS)['history']>;
      const items: { field: string; from: HistoryValue; to: HistoryValue }[] = [];
      for (const item of d.items) {
        if (!HISTORY_FIELDS.has(item.field)) {
          warnings.push({ code: 'unsupported_history_field', detail: item.field });
          continue;
        }
        const target = REF_FIELDS[item.field];
        const value = (v: string | null, display: string | null | undefined): HistoryValue =>
          target && v !== null
            ? { ref: { kind: target, id: v }, display: display ?? null }
            : { text: v, display: display ?? null };
        items.push({
          field: item.field,
          from: value(item.from, item.fromDisplay),
          to: value(item.to, item.toDisplay),
        });
      }
      if (items.length === 0) return { fail: 'no_supported_history_items' };
      return {
        kind,
        ticket: { kind: 'ticket', id: d.ticket },
        actor: ref('user', d.actor),
        at: iso(d.at),
        items,
      };
    }
    case 'time_entry': {
      const d = data as z.infer<(typeof SCHEMAS)['time_entry']>;
      return {
        kind,
        ticket: { kind: 'ticket', id: d.ticket },
        author: { kind: 'user', id: d.author },
        startedAt: iso(d.started),
        seconds: d.seconds,
        description: d.comment ?? '',
      };
    }
  }
}

/** The settings a run stores for a synthetic source: the uploaded file, or a generated one. */
export const syntheticSource = z.union([
  z.object({ format: z.literal('synthetic'), data: z.string().min(1).max(16_000_000) }),
  z.object({
    format: z.literal('synthetic'),
    generate: z
      .object({
        seed: z.number().int().min(0).max(2_147_483_647),
        system: z.string().min(1).max(200).optional(),
        prefix: z
          .string()
          .regex(/^[A-Z]{0,4}$/)
          .optional(),
        tickets: z.number().int().min(1).max(5000).optional(),
      })
      .strict(),
  }),
]);
export type SyntheticSettings = z.infer<typeof syntheticSource>;

export const syntheticFormat: ImportFormat = {
  importSource: SYNTHETIC_SOURCE,
  open: (source) => {
    const settings = syntheticSource.parse(source);
    return new SyntheticSource(
      'data' in settings ? settings.data : syntheticFixture(settings.generate),
    );
  },
  map: mapSynthetic,
};

// --- Generator ------------------------------------------------------------------------------

/** A small seeded generator (mulberry32): the same seed gives the same fixture everywhere. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (p: number) => next() < p,
  };
}

export interface FixtureOptions {
  seed: number;
  /** The source system id; defaults to one derived from the seed. */
  system?: string | undefined;
  /** Letters before every track key, group and email, so fixtures can sit side by side. */
  prefix?: string | undefined;
  /** Tickets across the two tracks. */
  tickets?: number | undefined;
}

const WORDS = [
  'harbour',
  'lantern',
  'meadow',
  'copper',
  'ledger',
  'orchard',
  'quarry',
  'signal',
  'timber',
  'violet',
  'willow',
  'beacon',
];

/**
 * Writes a synthetic fixture: people (one inactive, one deleted, one with a hidden email),
 * groups, statuses (one named like a built-in status, so it links), ticket types, two tracks,
 * tickets with gaps in their numbers and subtickets, comments (some restricted to a group),
 * links, history, time entries, a few fields and kinds the framework does not import.
 */
export function syntheticFixture(options: FixtureOptions): string {
  const rng = random(options.seed);
  const p = options.prefix ?? '';
  const lower = p.toLowerCase();
  const total = options.tickets ?? 40;
  const lines: unknown[] = [
    {
      format: SYNTHETIC_FORMAT,
      version: 1,
      system: options.system ?? `synthetic-${options.seed}`,
    },
  ];
  const sentence = (n: number) => Array.from({ length: n }, () => rng.pick(WORDS)).join(' ');
  const at = (day: number, minute = 0) =>
    new Date(Date.UTC(2024, 0, 1) + day * 86_400_000 + minute * 60_000).toISOString();

  const users = Array.from({ length: 8 }, (_, i) => `u${i + 1}`);
  for (const [i, u] of users.entries()) {
    lines.push({
      kind: 'user',
      id: u,
      email: i === 6 ? null : `${lower}person${i + 1}@example.test`,
      name: `${p}Person ${i + 1}`,
      ...(i === 5 ? { active: false } : {}),
      ...(i === 7 ? { deleted: true } : {}),
      ...(i % 3 === 0 ? { timeZone: 'Europe/Berlin' } : {}),
      ...(i === 2 ? { avatar: 'https://example.test/a.png' } : {}),
    });
  }
  const active = users.slice(0, 5);
  lines.push(
    {
      kind: 'group',
      id: 'g1',
      name: `${p}Engineers`,
      description: 'Builders',
      members: ['u1', 'u2', 'u3'],
    },
    { kind: 'group', id: 'g2', name: `${p}Support`, members: ['u4', 'u5', 'u6', 'u9'] },
  );
  const statuses = [
    { id: 's1', name: 'Backlog', category: 'todo' },
    { id: 's2', name: `${p}Doing`, category: 'in_progress' },
    { id: 's3', name: `${p}Finished`, category: 'done' },
  ];
  for (const s of statuses) lines.push({ kind: 'status', ...s });
  lines.push(
    { kind: 'ticket_type', id: 't1', name: `${p}Story`, description: 'A user story' },
    { kind: 'ticket_type', id: 't2', name: `${p}Defect` },
    { kind: 'ticket_type', id: 't3', name: `${p}Step`, subtask: true },
  );
  const tracks = [
    { id: 'p1', key: `${p}SYN`, name: `${p}Synthetic`, lead: 'u1' },
    { id: 'p2', key: `${p}ALT`, name: `${p}Alternate`, lead: 'u8', style: 'business' },
  ];
  for (const t of tracks) lines.push({ kind: 'track', ...t, description: sentence(4) });

  interface Made {
    id: string;
    status: string;
    assignee: string | null;
    created: string;
  }
  const made: Made[] = [];
  const numbers = new Map<string, number>();
  const standard: { id: string; track: string }[] = [];
  for (let i = 0; i < total; i++) {
    const track = tracks[i % 2] as (typeof tracks)[number];
    // Numbers with gaps, as after deletions in the source.
    const number = (numbers.get(track.id) ?? 0) + (rng.chance(0.2) ? 2 : 1);
    numbers.set(track.id, number);
    const parent = standard.filter((s) => s.track === track.id);
    const sub = parent.length > 0 && rng.chance(0.25);
    const status = rng.pick(statuses);
    const assignee = rng.chance(0.8) ? rng.pick(active) : null;
    const created = at(i, rng.int(0, 600));
    const id = `i${i + 1}`;
    lines.push({
      kind: 'ticket',
      id,
      track: track.id,
      number,
      type: sub ? 't3' : rng.pick(['t1', 't2']),
      status: status.id,
      summary: `${sentence(3)} ${i + 1}`,
      description: rng.chance(0.7) ? `Some **${rng.pick(WORDS)}** text\n\n- ${sentence(2)}` : null,
      assignee,
      reporter: rng.pick(users),
      parent: sub ? rng.pick(parent).id : null,
      priority: rng.pick(['High', 'Normal', 'Low', 'Blocker', null]),
      labels: rng.chance(0.5) ? [rng.pick(WORDS), rng.pick(WORDS)] : [],
      due: rng.chance(0.3) ? `2024-0${rng.int(2, 9)}-1${rng.int(0, 9)}` : null,
      created,
      updated: at(i + 3),
      resolved: status.category === 'done' ? at(i + 2) : null,
      estimate: rng.chance(0.4) ? rng.int(1, 16) * 3600 : null,
      ...(rng.chance(0.3) ? { votes: rng.int(1, 9) } : {}),
    });
    if (!sub) standard.push({ id, track: track.id });
    made.push({ id, status: status.id, assignee, created });
  }
  let n = 0;
  for (const t of made) {
    for (let c = rng.int(0, 2); c > 0; c--) {
      lines.push({
        kind: 'comment',
        id: `c${++n}`,
        ticket: t.id,
        author: rng.pick(users),
        body: `${sentence(5)}.`,
        group: rng.chance(0.2) ? 'g1' : null,
        created: at(1 + n, 5),
      });
    }
  }
  for (let l = 1; l <= Math.floor(total / 4); l++) {
    const from = rng.pick(made);
    const to = rng.pick(made);
    if (from.id === to.id) continue;
    lines.push({
      kind: 'link',
      id: `l${l}`,
      from: from.id,
      to: to.id,
      type: rng.pick([
        { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
        { name: `${p}Clones`, outward: 'clones', inward: 'is cloned by' },
      ]),
      created: at(l, 30),
    });
  }
  n = 0;
  for (const t of made) {
    if (t.status === 's1') continue;
    lines.push({
      kind: 'history',
      id: `h${++n}`,
      ticket: t.id,
      actor: rng.pick(active),
      at: new Date(Date.parse(t.created) + 3_600_000).toISOString(),
      items: [
        { field: 'status', from: 's1', to: t.status, fromDisplay: 'Backlog', toDisplay: null },
        ...(rng.chance(0.3)
          ? [{ field: 'sprint', from: null, to: 'Sprint 1', fromDisplay: null, toDisplay: null }]
          : []),
      ],
    });
    if (t.assignee && rng.chance(0.5)) {
      lines.push({
        kind: 'history',
        id: `h${++n}`,
        ticket: t.id,
        actor: rng.pick(active),
        at: new Date(Date.parse(t.created) + 7_200_000).toISOString(),
        items: [{ field: 'assignee', from: null, to: t.assignee }],
      });
    }
  }
  n = 0;
  for (const t of made) {
    if (!rng.chance(0.4)) continue;
    lines.push({
      kind: 'time_entry',
      id: `w${++n}`,
      ticket: t.id,
      author: rng.pick(active),
      started: new Date(Date.parse(t.created) + 86_400_000).toISOString(),
      seconds: rng.int(1, 8) * 1800,
      comment: rng.chance(0.5) ? sentence(3) : undefined,
    });
  }
  lines.push(
    { kind: 'board', id: 'b1', name: 'Team board', tracks: ['p1'] },
    { kind: 'board', id: 'b2', name: 'Cross-track board', tracks: ['p1', 'p2'] },
    { kind: 'dashboard', id: 'd1', name: 'Overview' },
  );
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}
