import { createHash } from 'node:crypto';
import type { Database, JsonValue } from '@taskmoor/db';
import { fromMarkdown } from '@taskmoor/richtext';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Catalog } from '../fields/catalog';
import { refreshFormulas } from '../fields/formulas';
import { defaultTypeSetId } from '../tickets/configuration';
import { rememberLabels } from '../tickets/fields';
import { type FieldChange, linkChange, recordChanges, ticketChanges } from '../tickets/history';
import { canonicalJson, ticketKey } from '../tickets/model';
import { bottomRank, loadTicket } from '../tickets/store';
import { checkKey } from '../tracks/model';
import {
  type Command,
  type CommentCommand,
  type EntityKind,
  type GroupCommand,
  type HistoryCommand,
  type HistoryValue,
  isEntityKind,
  type LinkCommand,
  type Ref,
  type StatusCommand,
  type TicketCommand,
  type TicketTypeCommand,
  type TimeEntryCommand,
  type TrackCommand,
  type UserCommand,
  type Warning,
} from './model';

/**
 * The load stage (M1-086, ADR-048): one loader per entity kind plans a command (create, update,
 * link to an existing object, or fail) and, outside a dry run, writes it with SQL in the batch's
 * transaction. It writes directly rather than through the routes because an import keeps what
 * the routes would replace: original authors and times, ticket numbers, statuses without
 * transitions, history as it happened. What the routes keep right it keeps right the same way:
 * history rows through the history module (the starting values of a new ticket, then the
 * source's own entries), the change log through its triggers, labels, ticket counters, time
 * spent and formulas (`refreshFormulas`) for every ticket a batch touched. A plan reads but
 * never writes, so a dry run plans every record and reports exactly what it would do.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** A reference a dry run would create: resolvable, but with no id yet. */
export const PENDING = -1;

/** Resolves source references to target ids through external ids (and, in a dry run, plans). */
export class Resolver {
  private readonly ids = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly scope: {
      workspaceId: number;
      importSource: string;
      system: string;
      runId: string;
      dryRun: boolean;
    },
  ) {}

  static key(ref: Ref): string {
    return `${ref.kind}\u0000${ref.id}`;
  }

  /** Looks up every reference not seen yet, in two queries. */
  async preload(refs: readonly Ref[]): Promise<void> {
    const wanted = [
      ...new Map(
        refs.filter((r) => !this.ids.has(Resolver.key(r))).map((r) => [Resolver.key(r), r]),
      ).values(),
    ];
    if (wanted.length === 0) return;
    const kinds = wanted.map((r) => r.kind);
    const ids = wanted.map((r) => r.id);
    const s = this.scope;
    const { rows } = await sql<{ entity_kind: string; source_id: string; target_id: string }>`
      SELECT e.entity_kind, e.source_id, e.target_id
        FROM unnest(${kinds}::text[], ${ids}::text[]) AS w (kind, id)
        JOIN import_external_id e
          ON e.workspace_id = ${s.workspaceId} AND e.import_source = ${s.importSource}
         AND e.source_system = ${s.system} AND e.entity_kind = w.kind AND e.source_id = w.id`.execute(
      this.db,
    );
    for (const r of rows) {
      this.ids.set(
        Resolver.key({ kind: r.entity_kind as EntityKind, id: r.source_id }),
        Number(r.target_id),
      );
    }
    if (s.dryRun) {
      const planned = await sql<{
        entity_kind: string;
        source_id: string;
        target_id: string | null;
      }>`
        SELECT r.entity_kind, r.source_id, r.target_id
          FROM unnest(${kinds}::text[], ${ids}::text[]) AS w (kind, id)
          JOIN import_record r
            ON r.run_id = ${Number(s.runId)} AND r.entity_kind = w.kind AND r.source_id = w.id
         WHERE r.outcome IN ('created', 'updated', 'unchanged', 'linked')`.execute(this.db);
      for (const r of planned.rows) {
        const key = Resolver.key({ kind: r.entity_kind as EntityKind, id: r.source_id });
        if (!this.ids.has(key))
          this.ids.set(key, r.target_id === null ? PENDING : Number(r.target_id));
      }
    }
  }

  /** The target id, PENDING for one a dry run would create, or null when nothing resolves. */
  get(ref: Ref): number | null {
    return this.ids.get(Resolver.key(ref)) ?? null;
  }

  set(ref: Ref, id: number): void {
    this.ids.set(Resolver.key(ref), id);
  }
}

/** Every source reference in a command, for preloading. */
export function refsOf(value: unknown, out: Ref[] = []): Ref[] {
  if (Array.isArray(value)) {
    for (const v of value) refsOf(v, out);
  } else if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.kind === 'string' && typeof o.id === 'string' && isEntityKind(o.kind)) {
      out.push({ kind: o.kind, id: o.id });
    } else {
      for (const v of Object.values(o)) refsOf(v, out);
    }
  }
  return out;
}

export interface LoadContext {
  trx: Transaction<Database>;
  workspaceId: number;
  system: string;
  importSource: string;
  dryRun: boolean;
  refs: Resolver;
  catalog: Catalog;
  warn(warning: Warning): void;
  /** Whether the run already has this warning (of the current kind). */
  warned(code: string, detail?: string): boolean;
  /** Tickets the batch wrote, for formulas and time spent at its end. */
  touched: Set<number>;
  /** Lookups by name, kept for the batch. */
  cache: Map<string, number | null>;
}

export class PlanFailure extends Error {}

export interface Plan {
  action: 'create' | 'update' | 'link';
  targetId: number | null;
  /** The command with references resolved: what the report's sample compares. */
  fingerprint: JsonValue;
  data?: unknown;
}

export interface Loader<C extends Command> {
  /** Where its targets live, for counting the ones still there. */
  table: { name: string; id: string };
  plan(ctx: LoadContext, cmd: C, existing: number | null, sourceId: string): Promise<Plan>;
  apply(ctx: LoadContext, cmd: C, plan: Plan): Promise<number>;
  /** The batch's closing writes, before it commits. */
  finish?(ctx: LoadContext): Promise<void>;
  /** The target side of the sample: the same shape as the plan's fingerprint. */
  read(db: Db, workspaceId: number, ids: readonly number[]): Promise<Map<number, JsonValue>>;
}

/** A checksum of canonical JSON. */
export function checksum(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

const lower = (s: string) => s.toLowerCase();
const isoOf = (v: Date | string | null) =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();
const real = (id: number | null) => (id === null || id === PENDING ? null : id);

/** A reference that must resolve; a failure names the field. */
function required(ctx: LoadContext, ref: Ref, field: string): number {
  const id = ctx.refs.get(ref);
  if (id === null) throw new PlanFailure(`missing_reference:${field}`);
  return id;
}

/** A reference that may be absent; one that does not resolve is left empty with a warning. */
function optional(ctx: LoadContext, ref: Ref | null, field: string): number | null {
  if (ref === null) return null;
  const id = ctx.refs.get(ref);
  if (id === null) ctx.warn({ code: 'missing_reference', detail: field });
  return id;
}

async function exists(ctx: LoadContext, table: string, id: number): Promise<boolean> {
  const { rows } = await sql`SELECT 1 FROM ${sql.table(table)} WHERE id = ${id}`.execute(ctx.trx);
  return rows.length > 0;
}

/** The existing object a re-run updates; gone since the last run fails the record. */
async function existingTarget(ctx: LoadContext, table: string, existing: number) {
  if (!(await exists(ctx, table, existing))) throw new PlanFailure('target_deleted');
}

/** Writes changes as one change set at a given time (imported history keeps its times). */
async function writeChanges(
  trx: Transaction<Database>,
  workspaceId: number,
  actorId: number | null,
  at: string,
  changes: readonly FieldChange[],
): Promise<string | null> {
  if (changes.length === 0) return null;
  const changeSet = (
    await sql<{ n: string }>`SELECT nextval('ticket_change_set_seq') AS n`.execute(trx)
  ).rows[0]?.n as string;
  await trx
    .insertInto('ticket_change')
    .values(
      changes.map((c) => ({
        workspace_id: workspaceId,
        ticket_id: c.ticketId,
        change_set: changeSet,
        at: new Date(at),
        actor_id: actorId,
        field: c.field,
        from_value: c.from,
        to_value: c.to,
        from_display: c.fromDisplay,
        to_display: c.toDisplay,
      })),
    )
    .execute();
  return changeSet;
}

async function byName(
  ctx: LoadContext,
  key: string,
  find: () => Promise<{ id: number } | undefined>,
): Promise<number | null> {
  if (ctx.cache.has(key)) return ctx.cache.get(key) ?? null;
  const row = await find();
  ctx.cache.set(key, row?.id ?? null);
  return row?.id ?? null;
}

const priorityId = (ctx: LoadContext, name: string) =>
  byName(ctx, `priority:${lower(name)}`, () =>
    ctx.trx
      .selectFrom('priority')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where(sql<string>`lower(name)`, '=', lower(name))
      .executeTakeFirst(),
  );

// --- People and configuration ---------------------------------------------------------------

const userPrint = (u: { email: string; name: string; active: boolean }): JsonValue => ({
  email: lower(u.email),
  name: u.name,
  active: u.active,
});

/** An address for a person the source hides the email of: unique, and never deliverable. */
export function placeholderEmail(system: string, sourceId: string): string {
  const hash = createHash('sha256').update(`${system}\u0000${sourceId}`).digest('hex');
  return `imported-${hash.slice(0, 20)}@placeholder.invalid`;
}

const users: Loader<UserCommand> = {
  table: { name: 'app_user', id: 'id' },
  async plan(ctx, cmd, existing, sourceId) {
    const email = lower(cmd.email ?? placeholderEmail(ctx.system, sourceId));
    const fingerprint = userPrint({ email, name: cmd.name, active: cmd.active });
    if (existing !== null) {
      await existingTarget(ctx, 'app_user', existing);
      return { action: 'update', targetId: existing, fingerprint, data: email };
    }
    const found = await ctx.trx
      .selectFrom('app_user')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where(sql<string>`lower(email)`, '=', email)
      .executeTakeFirst();
    if (found) return { action: 'link', targetId: found.id, fingerprint };
    if (cmd.email === null) ctx.warn({ code: 'placeholder_email' });
    return { action: 'create', targetId: null, fingerprint, data: email };
  },
  async apply(ctx, cmd, plan) {
    if (plan.action === 'link') return plan.targetId as number;
    if (plan.action === 'update') {
      const id = plan.targetId as number;
      await ctx.trx
        .updateTable('app_user')
        .set({
          name: cmd.name,
          time_zone: cmd.timeZone,
          updated_at: new Date(),
          deactivated_at: cmd.active
            ? null
            : (sql`coalesce(deactivated_at, now())` as unknown as Date),
        })
        .where('id', '=', id)
        .execute();
      return id;
    }
    const row = await ctx.trx
      .insertInto('app_user')
      .values({
        workspace_id: ctx.workspaceId,
        email: plan.data as string,
        name: cmd.name,
        password_hash: null,
        time_zone: cmd.timeZone,
        locale: null,
        password_changed_at: null,
        last_sign_in_at: null,
        deactivated_at: cmd.active ? null : new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('app_user')
      .select(['id', 'email', 'name', 'deactivated_at'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        userPrint({ email: r.email, name: r.name, active: r.deactivated_at === null }),
      ]),
    );
  },
};

const groups: Loader<GroupCommand> = {
  table: { name: 'user_group', id: 'id' },
  async plan(ctx, cmd, existing) {
    const members: number[] = [];
    for (const m of cmd.members) {
      const id = optional(ctx, m, 'members');
      if (id !== null) members.push(id);
    }
    const fingerprint = {
      name: lower(cmd.name),
      members: [...new Set(members.filter((m) => m !== PENDING))].sort((a, b) => a - b),
    };
    if (existing !== null) {
      await existingTarget(ctx, 'user_group', existing);
      return { action: 'update', targetId: existing, fingerprint, data: members };
    }
    const found = await ctx.trx
      .selectFrom('user_group')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where(sql<string>`lower(name)`, '=', lower(cmd.name))
      .executeTakeFirst();
    if (found) return { action: 'link', targetId: found.id, fingerprint, data: members };
    return { action: 'create', targetId: null, fingerprint, data: members };
  },
  async apply(ctx, cmd, plan) {
    let id = plan.targetId;
    if (plan.action === 'create') {
      id = (
        await ctx.trx
          .insertInto('user_group')
          .values({ workspace_id: ctx.workspaceId, name: cmd.name, description: cmd.description })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    } else if (plan.action === 'update') {
      await ctx.trx
        .updateTable('user_group')
        .set({ name: cmd.name, description: cmd.description })
        .where('id', '=', id as number)
        .execute();
    }
    // Members are added, never removed: a group linked by name keeps the people it had.
    const members = plan.data as number[];
    if (members.length > 0) {
      await ctx.trx
        .insertInto('group_member')
        .values(
          members.map((user_id) => ({
            workspace_id: ctx.workspaceId,
            group_id: id as number,
            user_id,
          })),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    return id as number;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('user_group as g')
      .select([
        'g.id',
        'g.name',
        sql<number[]>`coalesce((SELECT array_agg(m.user_id ORDER BY m.user_id) FROM group_member m
          WHERE m.group_id = g.id), '{}')`.as('members'),
      ])
      .where('g.workspace_id', '=', ws)
      .where('g.id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [r.id, { name: lower(r.name), members: r.members.map(Number) }]),
    );
  },
};

const statuses: Loader<StatusCommand> = {
  table: { name: 'status', id: 'id' },
  async plan(ctx, cmd, existing) {
    const fingerprint = { name: lower(cmd.name), stage: cmd.stage };
    if (existing !== null) {
      await existingTarget(ctx, 'status', existing);
      return { action: 'update', targetId: existing, fingerprint };
    }
    const found = await ctx.trx
      .selectFrom('status')
      .select(['id', 'stage'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where(sql<string>`lower(name)`, '=', lower(cmd.name))
      .executeTakeFirst();
    if (found) {
      if (found.stage !== cmd.stage) ctx.warn({ code: 'stage_differs', detail: cmd.name });
      return { action: 'link', targetId: found.id, fingerprint };
    }
    // A new status is in no workflow yet (M1-090 maps workflows): tickets keep it, and the
    // report says so.
    ctx.warn({ code: 'status_not_in_workflow', detail: cmd.name });
    return { action: 'create', targetId: null, fingerprint };
  },
  async apply(ctx, cmd, plan) {
    // Statuses are shared by every workflow: a re-run never renames or moves one.
    if (plan.action !== 'create') return plan.targetId as number;
    const row = await ctx.trx
      .insertInto('status')
      .values({
        workspace_id: ctx.workspaceId,
        name: cmd.name,
        stage: cmd.stage,
        sort_order: sql<number>`(SELECT coalesce(max(sort_order), 0) + 1 FROM status
          WHERE workspace_id = ${ctx.workspaceId})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('status')
      .select(['id', 'name', 'stage'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(rows.map((r) => [r.id, { name: lower(r.name), stage: r.stage }]));
  },
};

const ticketTypes: Loader<TicketTypeCommand> = {
  table: { name: 'ticket_type', id: 'id' },
  async plan(ctx, cmd, existing) {
    const fingerprint = { name: lower(cmd.name), level: cmd.level };
    if (existing !== null) {
      await existingTarget(ctx, 'ticket_type', existing);
      return { action: 'update', targetId: existing, fingerprint };
    }
    const found = await ctx.trx
      .selectFrom('ticket_type')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('owner_track_id', 'is', null)
      .where(sql<string>`lower(name)`, '=', lower(cmd.name))
      .executeTakeFirst();
    if (found) return { action: 'link', targetId: found.id, fingerprint };
    return { action: 'create', targetId: null, fingerprint };
  },
  async apply(ctx, cmd, plan) {
    if (plan.action === 'link') return plan.targetId as number;
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('ticket_type')
        .set({ description: cmd.description, updated_at: new Date() })
        .where('id', '=', plan.targetId as number)
        .execute();
      return plan.targetId as number;
    }
    const level = await ctx.trx
      .selectFrom('hierarchy_level')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('kind', '=', cmd.level)
      .executeTakeFirstOrThrow();
    const row = await ctx.trx
      .insertInto('ticket_type')
      .values({
        workspace_id: ctx.workspaceId,
        name: cmd.name,
        description: cmd.description,
        icon: null,
        color: null,
        level_id: level.id,
        owner_track_id: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('ticket_type as t')
      .innerJoin('hierarchy_level as l', 'l.id', 't.level_id')
      .select(['t.id', 't.name', 'l.kind'])
      .where('t.workspace_id', '=', ws)
      .where('t.id', 'in', [...ids])
      .execute();
    return new Map(rows.map((r) => [r.id, { name: lower(r.name), level: r.kind }]));
  },
};

const tracks: Loader<TrackCommand> = {
  table: { name: 'track', id: 'id' },
  async plan(ctx, cmd, existing) {
    const owner = optional(ctx, cmd.owner, 'owner');
    const key = checkKey(cmd.key, 'import');
    if (!key.ok) throw new PlanFailure(`invalid_key:${key.problem}`);
    const fingerprint = { key: key.key, name: cmd.name, owner: real(owner) };
    if (existing !== null) {
      await existingTarget(ctx, 'track', existing);
      return { action: 'update', targetId: existing, fingerprint, data: { owner, key: key.key } };
    }
    const taken = await ctx.trx
      .selectFrom('track_key_history')
      .select('track_id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where(sql<string>`upper(key)`, '=', key.key)
      .executeTakeFirst();
    if (taken) throw new PlanFailure('track_key_taken');
    return { action: 'create', targetId: null, fingerprint, data: { owner, key: key.key } };
  },
  async apply(ctx, cmd, plan) {
    const { owner, key } = plan.data as { owner: number | null; key: string };
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('track')
        .set({
          name: cmd.name,
          description: cmd.description,
          owner_id: owner,
          updated_at: new Date(),
        })
        .where('id', '=', plan.targetId as number)
        .execute();
      return plan.targetId as number;
    }
    const policy = await ctx.trx
      .selectFrom('access_policy')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('is_default', '=', true)
      .executeTakeFirst();
    if (!policy) throw new PlanFailure('no_default_access_policy');
    const row = await ctx.trx
      .insertInto('track')
      .values({
        workspace_id: ctx.workspaceId,
        key,
        name: cmd.name,
        description: cmd.description,
        type: cmd.trackType,
        mode: 'shared',
        owner_id: owner,
        access_policy_id: policy.id,
        type_set_id: await defaultTypeSetId(ctx.trx, ctx.workspaceId, cmd.trackType),
        category_id: null,
        icon: null,
        color: null,
        archived_at: null,
        archived_by: null,
        priority_set_id: null,
        deleted_at: null,
        deleted_by: null,
        purge_started_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('track')
      .select(['id', 'key', 'name', 'owner_id'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(rows.map((r) => [r.id, { key: r.key, name: r.name, owner: r.owner_id }]));
  },
};

// --- Tickets and their content --------------------------------------------------------------

interface TicketValues {
  track_id: number;
  number: number;
  ticket_type_id: number;
  status_id: number | null;
  summary: string;
  description: JsonValue | null;
  assignee_id: number | null;
  requester_id: number | null;
  creator_id: number | null;
  parent_id: number | null;
  priority_id: number | null;
  labels: string[];
  start_date: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  original_estimate: number | null;
  remaining_estimate: number | null;
}

const ticketPrint = (v: Omit<TicketValues, 'updated_at'>): JsonValue => ({
  track: real(v.track_id),
  number: v.number,
  type: real(v.ticket_type_id),
  status: real(v.status_id),
  summary: v.summary,
  description: v.description === null ? null : checksum(v.description),
  assignee: real(v.assignee_id),
  requester: real(v.requester_id),
  creator: real(v.creator_id),
  parent: real(v.parent_id),
  priority: v.priority_id,
  labels: [...v.labels].sort(),
  startDate: v.start_date,
  dueDate: v.due_date,
  createdAt: isoOf(v.created_at),
  closedAt: isoOf(v.closed_at),
  originalEstimate: v.original_estimate,
  remainingEstimate: v.remaining_estimate,
});

/** A label holds no spaces (CORE-016): spaces become underscores, with a warning. */
function labelsOf(ctx: LoadContext, labels: readonly string[]): string[] {
  return [
    ...new Set(
      labels.map((l) => {
        if (!/\s/.test(l)) return l;
        ctx.warn({ code: 'label_renamed', detail: l });
        return l.trim().replace(/\s+/g, '_');
      }),
    ),
  ];
}

const tickets: Loader<TicketCommand> = {
  table: { name: 'ticket', id: 'id' },
  async plan(ctx, cmd, existing) {
    const track = required(ctx, cmd.track, 'track');
    const type = required(ctx, cmd.type, 'type');
    const priority = cmd.priority === null ? null : await priorityId(ctx, cmd.priority);
    if (cmd.priority !== null && priority === null) {
      ctx.warn({ code: 'unknown_priority', detail: cmd.priority });
    }
    const values: TicketValues = {
      track_id: track,
      number: cmd.number,
      ticket_type_id: type,
      status_id: optional(ctx, cmd.status, 'status'),
      summary: cmd.summary,
      description:
        cmd.description === null ? null : (fromMarkdown(cmd.description) as unknown as JsonValue),
      assignee_id: optional(ctx, cmd.assignee, 'assignee'),
      requester_id: optional(ctx, cmd.requester, 'requester'),
      creator_id: optional(ctx, cmd.creator, 'creator'),
      parent_id: optional(ctx, cmd.parent, 'parent'),
      priority_id: priority,
      labels: labelsOf(ctx, cmd.labels),
      start_date: cmd.startDate,
      due_date: cmd.dueDate,
      created_at: cmd.createdAt,
      updated_at: cmd.updatedAt,
      closed_at: cmd.closedAt,
      original_estimate: cmd.originalEstimate,
      remaining_estimate: cmd.remainingEstimate,
    };
    const fingerprint = ticketPrint(values);
    if (existing !== null) {
      await existingTarget(ctx, 'ticket', existing);
      return { action: 'update', targetId: existing, fingerprint, data: values };
    }
    if (track !== PENDING) {
      const taken = await ctx.trx
        .selectFrom('ticket_key_history')
        .select('ticket_id')
        .where('track_id', '=', track)
        .where('number', '=', cmd.number)
        .executeTakeFirst();
      if (taken) throw new PlanFailure('number_taken');
    }
    // A type the track's type set lacks: the ticket imports, but the track does not offer the
    // type for new tickets until an administrator adds it (M1-088 maps type schemes). A type
    // the run creates is in no set; a track the run creates (dry run) takes a default set.
    const offered =
      type === PENDING
        ? undefined
        : track === PENDING
          ? await ctx.trx
              .selectFrom('type_set_default as d')
              .innerJoin('type_set_member as m', 'm.type_set_id', 'd.type_set_id')
              .select('m.ticket_type_id')
              .where('d.workspace_id', '=', ctx.workspaceId)
              .where('m.ticket_type_id', '=', type)
              .executeTakeFirst()
          : await ctx.trx
              .selectFrom('track as t')
              .innerJoin('type_set_member as m', 'm.type_set_id', 't.type_set_id')
              .select('m.ticket_type_id')
              .where('t.id', '=', track)
              .where('m.ticket_type_id', '=', type)
              .executeTakeFirst();
    if (!offered) ctx.warn({ code: 'type_not_offered', detail: cmd.type.id });
    return { action: 'create', targetId: null, fingerprint, data: values };
  },
  async apply(ctx, _cmd, plan) {
    const v = plan.data as TicketValues;
    const ws = ctx.workspaceId;
    const columns = {
      track_id: v.track_id,
      number: v.number,
      ticket_type_id: v.ticket_type_id,
      ...(v.status_id === null ? {} : { status_id: v.status_id }),
      summary: v.summary,
      description: v.description === null ? null : JSON.stringify(v.description),
      assignee_id: v.assignee_id,
      requester_id: v.requester_id,
      creator_id: v.creator_id,
      parent_id: v.parent_id,
      priority_id: v.priority_id,
      labels: v.labels,
      start_date: v.start_date,
      due_date: v.due_date,
      created_at: new Date(v.created_at),
      updated_at: new Date(v.updated_at),
      closed_at: v.closed_at === null ? null : new Date(v.closed_at),
      original_estimate: v.original_estimate,
      remaining_estimate: v.remaining_estimate,
    };
    let id: number;
    if (plan.action === 'update') {
      id = plan.targetId as number;
      const before = await loadTicket(ctx.trx, ws, id);
      await ctx.trx
        .updateTable('ticket')
        .set({ ...columns, version: sql<number>`version + 1` })
        .where('id', '=', id)
        .execute();
      const after = await loadTicket(ctx.trx, ws, id);
      if (before && after) {
        await recordChanges(ctx.trx, ws, null, ticketChanges(before, after));
      }
    } else {
      id = (
        await ctx.trx
          .insertInto('ticket')
          .values({
            workspace_id: ws,
            ...columns,
            rank: await bottomRank(ctx.trx),
            fields: '{}',
            deleted_at: null,
            deleted_by: null,
            trashed_with: null,
            close_reason_id: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      // Every starting value is history too (ADR-010), at the time and by the person that
      // created the ticket; the source's history entries correct values they changed later.
      const created = await loadTicket(ctx.trx, ws, id);
      if (created) {
        await writeChanges(ctx.trx, ws, v.creator_id, v.created_at, ticketChanges(null, created));
      }
    }
    // Numbers come from the source: the counter moves past them (CORE-001).
    await sql`
      INSERT INTO ticket_counter (workspace_id, track_id, last_number)
      VALUES (${ws}, ${v.track_id}, ${v.number})
      ON CONFLICT (track_id) DO UPDATE
        SET last_number = greatest(ticket_counter.last_number, EXCLUDED.last_number)`.execute(
      ctx.trx,
    );
    await rememberLabels(ctx.trx, ws, v.labels);
    ctx.touched.add(id);
    return id;
  },
  async finish(ctx) {
    await refreshTouched(ctx);
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('ticket')
      .selectAll()
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        ticketPrint({
          ...r,
          created_at: r.created_at.toISOString(),
          closed_at: r.closed_at?.toISOString() ?? null,
          description: r.description,
        }),
      ]),
    );
  },
};

/** Time spent from the time entries, then formulas, for every ticket the batch touched. */
async function refreshTouched(ctx: LoadContext): Promise<void> {
  const ids = [...ctx.touched];
  if (ids.length === 0) return;
  await sql`
    UPDATE ticket k SET time_spent = s.total
      FROM (SELECT t.id, coalesce((SELECT sum(duration) FROM time_entry e WHERE e.ticket_id = t.id),
                                  0)::int AS total
              FROM unnest(${ids}::int[]) AS t (id)) s
     WHERE k.id = s.id AND k.time_spent <> s.total`.execute(ctx.trx);
  const computed = await refreshFormulas(ctx.trx, ctx.catalog, ctx.workspaceId, ids);
  await recordChanges(ctx.trx, ctx.workspaceId, null, computed);
}

const commentPrint = (c: {
  ticket: number | null;
  author: number | null;
  body: JsonValue;
  group: number | null;
  createdAt: string | null;
}): JsonValue => ({
  ticket: real(c.ticket),
  author: real(c.author),
  body: checksum(c.body),
  group: real(c.group),
  createdAt: c.createdAt,
});

const comments: Loader<CommentCommand> = {
  table: { name: 'ticket_comment', id: 'id' },
  async plan(ctx, cmd, existing) {
    const data = {
      ticket: required(ctx, cmd.ticket, 'ticket'),
      author: optional(ctx, cmd.author, 'author'),
      group: optional(ctx, cmd.visibleGroup, 'group'),
      body: fromMarkdown(cmd.body) as unknown as JsonValue,
    };
    const fingerprint = commentPrint({ ...data, createdAt: isoOf(cmd.createdAt) });
    if (existing !== null) {
      await existingTarget(ctx, 'ticket_comment', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as {
      ticket: number;
      author: number | null;
      group: number | null;
      body: JsonValue;
    };
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('ticket_comment')
        .set({
          body: JSON.stringify(d.body),
          visible_group_id: d.group,
          updated_at: new Date(cmd.updatedAt),
        })
        .where('id', '=', plan.targetId as number)
        .execute();
      return plan.targetId as number;
    }
    const row = await ctx.trx
      .insertInto('ticket_comment')
      .values({
        workspace_id: ctx.workspaceId,
        ticket_id: d.ticket,
        author_id: d.author,
        body: JSON.stringify(d.body),
        visible_role_id: null,
        visible_group_id: d.group,
        created_at: new Date(cmd.createdAt),
        updated_at: new Date(cmd.updatedAt),
        edited_at: null,
        edited_by: null,
        deleted_at: null,
        deleted_by: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await writeChanges(ctx.trx, ctx.workspaceId, d.author, cmd.createdAt, [
      {
        ticketId: d.ticket,
        field: 'comment',
        from: null,
        to: String(row.id),
        fromDisplay: null,
        toDisplay: null,
      },
    ]);
    return row.id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('ticket_comment')
      .select(['id', 'ticket_id', 'author_id', 'body', 'visible_group_id', 'created_at'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        commentPrint({
          ticket: r.ticket_id,
          author: r.author_id,
          body: r.body,
          group: r.visible_group_id,
          createdAt: r.created_at.toISOString(),
        }),
      ]),
    );
  },
};

async function linkTypeId(ctx: LoadContext, name: string) {
  return byName(ctx, `link_type:${lower(name)}`, () =>
    ctx.trx
      .selectFrom('link_type')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where(sql<string>`lower(name)`, '=', lower(name))
      .executeTakeFirst(),
  );
}

async function keyOf(trx: Transaction<Database>, ticketId: number): Promise<string> {
  const row = await trx
    .selectFrom('ticket as k')
    .innerJoin('track as t', 't.id', 'k.track_id')
    .select(['t.key', 'k.number'])
    .where('k.id', '=', ticketId)
    .executeTakeFirstOrThrow();
  return ticketKey(row.key, row.number);
}

const links: Loader<LinkCommand> = {
  table: { name: 'ticket_link', id: 'id' },
  async plan(ctx, cmd, existing) {
    const source = required(ctx, cmd.source, 'source');
    const target = required(ctx, cmd.target, 'target');
    const fingerprint = {
      type: lower(cmd.linkType.name),
      source: real(source),
      target: real(target),
    };
    if (existing !== null) {
      await existingTarget(ctx, 'ticket_link', existing);
      return { action: 'update', targetId: existing, fingerprint };
    }
    const typeId = await linkTypeId(ctx, cmd.linkType.name);
    // Once per run and type: the real run creates it with the first link, a dry run never does.
    if (typeId === null && !ctx.warned('link_type_created', cmd.linkType.name)) {
      ctx.warn({ code: 'link_type_created', detail: cmd.linkType.name });
    }
    if (typeId !== null && source !== PENDING && target !== PENDING) {
      const found = await ctx.trx
        .selectFrom('ticket_link')
        .select('id')
        .where('source_id', '=', source)
        .where('link_type_id', '=', typeId)
        .where('target_id', '=', target)
        .executeTakeFirst();
      if (found) return { action: 'link', targetId: found.id, fingerprint };
    }
    return {
      action: 'create',
      targetId: null,
      fingerprint,
      data: { source, target, creator: optional(ctx, cmd.creator, 'creator') },
    };
  },
  async apply(ctx, cmd, plan) {
    // A link is its two tickets and type: a re-run has nothing to change.
    if (plan.action !== 'create') return plan.targetId as number;
    const { source, target, creator } = plan.data as {
      source: number;
      target: number;
      creator: number | null;
    };
    let typeId = await linkTypeId(ctx, cmd.linkType.name);
    if (typeId === null) {
      typeId = (
        await ctx.trx
          .insertInto('link_type')
          .values({
            workspace_id: ctx.workspaceId,
            name: cmd.linkType.name,
            outward: cmd.linkType.outward,
            inward: cmd.linkType.inward,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      ctx.cache.set(`link_type:${lower(cmd.linkType.name)}`, typeId);
    }
    const row = await ctx.trx
      .insertInto('ticket_link')
      .values({
        workspace_id: ctx.workspaceId,
        link_type_id: typeId,
        source_id: source,
        target_id: target,
        created_by: creator,
        created_at: new Date(cmd.createdAt),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const [sourceKey, targetKey] = [await keyOf(ctx.trx, source), await keyOf(ctx.trx, target)];
    await writeChanges(ctx.trx, ctx.workspaceId, creator, cmd.createdAt, [
      linkChange(
        source,
        { typeId, direction: 'outward', phrase: cmd.linkType.outward, otherId: target },
        targetKey,
        true,
      ),
      linkChange(
        target,
        { typeId, direction: 'inward', phrase: cmd.linkType.inward, otherId: source },
        sourceKey,
        true,
      ),
    ]);
    return row.id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('ticket_link as l')
      .innerJoin('link_type as t', 't.id', 'l.link_type_id')
      .select(['l.id', 't.name', 'l.source_id', 'l.target_id'])
      .where('l.workspace_id', '=', ws)
      .where('l.id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [r.id, { type: lower(r.name), source: r.source_id, target: r.target_id }]),
    );
  },
};

interface HistoryItem {
  field: string;
  from: string | null;
  to: string | null;
  fromDisplay: string | null;
  toDisplay: string | null;
}

const historyPrint = (h: {
  ticket: number | null;
  actor: number | null;
  at: string | null;
  items: { field: string; from: string | null; to: string | null }[];
}): JsonValue => ({
  ticket: real(h.ticket),
  actor: real(h.actor),
  at: h.at,
  items: h.items.map((i) => ({ field: i.field, from: i.from, to: i.to })),
});

/** The name a referenced value had, for display, when the source gives none. */
async function displayOf(ctx: LoadContext, kind: string, id: number): Promise<string | null> {
  if (id === PENDING) return null;
  switch (kind) {
    case 'status':
    case 'ticket_type': {
      const table = kind === 'status' ? 'status' : 'ticket_type';
      const row = await ctx.trx
        .selectFrom(table)
        .select('name')
        .where('id', '=', id)
        .executeTakeFirst();
      return row?.name ?? null;
    }
    case 'user': {
      const row = await ctx.trx
        .selectFrom('app_user')
        .select('name')
        .where('id', '=', id)
        .executeTakeFirst();
      return row?.name ?? null;
    }
    case 'ticket':
      return keyOf(ctx.trx, id);
    default:
      return null;
  }
}

async function historyValue(ctx: LoadContext, field: string, value: HistoryValue) {
  if ('ref' in value) {
    const id = optional(ctx, value.ref, `history.${field}`);
    if (id === null) return { value: null, display: value.display };
    return {
      value: id === PENDING ? 'pending' : String(id),
      display: value.display ?? (await displayOf(ctx, value.ref.kind, id)),
    };
  }
  if (field === 'priority' && value.text !== null) {
    // Priorities are references in history: the id, with the name for display.
    const id = await priorityId(ctx, value.text);
    if (id === null) ctx.warn({ code: 'unknown_priority', detail: value.text });
    return { value: id === null ? null : String(id), display: value.display ?? value.text };
  }
  return { value: value.text, display: value.display };
}

const history: Loader<HistoryCommand> = {
  table: { name: 'ticket_change', id: 'change_set' },
  async plan(ctx, cmd, existing) {
    const ticket = required(ctx, cmd.ticket, 'ticket');
    const actor = optional(ctx, cmd.actor, 'actor');
    const items: HistoryItem[] = [];
    for (const item of cmd.items) {
      const from = await historyValue(ctx, item.field, item.from);
      const to = await historyValue(ctx, item.field, item.to);
      items.push({
        field: item.field,
        from: from.value,
        to: to.value,
        fromDisplay: from.display,
        toDisplay: to.display,
      });
    }
    const fingerprint = historyPrint({ ticket, actor, at: isoOf(cmd.at), items });
    if (existing !== null) {
      // History is what happened: a re-run never rewrites it.
      return { action: 'link', targetId: existing, fingerprint };
    }
    return { action: 'create', targetId: null, fingerprint, data: { ticket, actor, items } };
  },
  async apply(ctx, cmd, plan) {
    if (plan.action !== 'create') return plan.targetId as number;
    const { ticket, actor, items } = plan.data as {
      ticket: number;
      actor: number | null;
      items: HistoryItem[];
    };
    const ws = ctx.workspaceId;
    const first = await ctx.trx
      .selectFrom('ticket_change')
      .select('change_set')
      .where('ticket_id', '=', ticket)
      .where('field', '=', 'key')
      .orderBy('at')
      .orderBy('id')
      .executeTakeFirst();
    // The source's first entry for a field says what it started with: the ticket's starting
    // values (written from its current values) take the entry's "from".
    for (const item of items) {
      if (!first) break;
      const earlier = await ctx.trx
        .selectFrom('ticket_change')
        .select(['id', 'change_set'])
        .where('ticket_id', '=', ticket)
        .where('field', '=', item.field)
        .where('at', '<', new Date(cmd.at))
        .execute();
      if (earlier.some((e) => e.change_set !== first.change_set)) continue;
      const start = earlier.find((e) => e.change_set === first.change_set);
      if (start && item.from === null) {
        await ctx.trx.deleteFrom('ticket_change').where('id', '=', start.id).execute();
      } else if (start) {
        await ctx.trx
          .updateTable('ticket_change')
          .set({ to_value: item.from, to_display: item.fromDisplay })
          .where('id', '=', start.id)
          .execute();
      } else if (item.from !== null) {
        await writeChanges(
          ctx.trx,
          ws,
          null,
          (
            await ctx.trx
              .selectFrom('ticket')
              .select('created_at')
              .where('id', '=', ticket)
              .executeTakeFirstOrThrow()
          ).created_at.toISOString(),
          [
            {
              ticketId: ticket,
              field: item.field,
              from: null,
              to: item.from,
              fromDisplay: null,
              toDisplay: item.fromDisplay,
            },
          ],
        );
      }
    }
    const changeSet = await writeChanges(
      ctx.trx,
      ws,
      actor,
      cmd.at,
      items.map((i) => ({ ticketId: ticket, ...i })),
    );
    return Number(changeSet);
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('ticket_change')
      .select(['change_set', 'ticket_id', 'actor_id', 'at', 'field', 'from_value', 'to_value'])
      .where('workspace_id', '=', ws)
      .where('change_set', 'in', ids.map(String))
      .orderBy('id')
      .execute();
    const out = new Map<number, JsonValue>();
    const grouped = new Map<number, typeof rows>();
    for (const r of rows) {
      const set = Number(r.change_set);
      grouped.set(set, [...(grouped.get(set) ?? []), r]);
    }
    for (const [set, list] of grouped) {
      const head = list[0] as (typeof rows)[number];
      out.set(
        set,
        historyPrint({
          ticket: head.ticket_id,
          actor: head.actor_id,
          at: head.at.toISOString(),
          items: list.map((r) => ({ field: r.field, from: r.from_value, to: r.to_value })),
        }),
      );
    }
    return out;
  },
};

const timePrint = (t: {
  ticket: number | null;
  author: number | null;
  startedAt: string | null;
  seconds: number;
  description: string;
}): JsonValue => ({ ...t, ticket: real(t.ticket), author: real(t.author) });

const timeEntries: Loader<TimeEntryCommand> = {
  table: { name: 'time_entry', id: 'id' },
  async plan(ctx, cmd, existing) {
    const data = {
      ticket: required(ctx, cmd.ticket, 'ticket'),
      author: required(ctx, cmd.author, 'author'),
    };
    const fingerprint = timePrint({
      ...data,
      startedAt: isoOf(cmd.startedAt),
      seconds: cmd.seconds,
      description: cmd.description,
    });
    if (existing !== null) {
      await existingTarget(ctx, 'time_entry', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as { ticket: number; author: number };
    let id = plan.targetId;
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('time_entry')
        .set({
          started_at: new Date(cmd.startedAt),
          duration: cmd.seconds,
          description: cmd.description,
          updated_at: new Date(),
        })
        .where('id', '=', id as number)
        .execute();
    } else {
      id = (
        await ctx.trx
          .insertInto('time_entry')
          .values({
            workspace_id: ctx.workspaceId,
            ticket_id: d.ticket,
            author_id: d.author,
            started_at: new Date(cmd.startedAt),
            duration: cmd.seconds,
            description: cmd.description,
            visible_role_id: null,
            visible_group_id: null,
            created_by: d.author,
            created_at: new Date(cmd.startedAt),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    ctx.touched.add(d.ticket);
    return id as number;
  },
  async finish(ctx) {
    await refreshTouched(ctx);
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('time_entry')
      .select(['id', 'ticket_id', 'author_id', 'started_at', 'duration', 'description'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        timePrint({
          ticket: r.ticket_id,
          author: r.author_id,
          startedAt: r.started_at.toISOString(),
          seconds: r.duration,
          description: r.description,
        }),
      ]),
    );
  },
};

export const LOADERS: { [K in EntityKind]: Loader<Extract<Command, { kind: K }>> } = {
  user: users,
  group: groups,
  status: statuses,
  ticket_type: ticketTypes,
  track: tracks,
  ticket: tickets,
  comment: comments,
  link: links,
  history,
  time_entry: timeEntries,
};
