import { createHash } from 'node:crypto';
import type { Database, JsonValue } from '@taskmoor/db';
import { fromMarkdown } from '@taskmoor/richtext';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { AttachmentStores } from '../attachments/stores';
import type { Catalog } from '../fields/catalog';
import { refreshFormulas } from '../fields/formulas';
import { syncFieldValues } from '../fields/storage';
import { REFERENCE_OF, type Reference } from '../fields/types';
import { checkCustomValues, customChanges, rememberFieldLabels } from '../fields/values';
import { defaultTypeSetId } from '../tickets/configuration';
import { rememberLabels } from '../tickets/fields';
import { type FieldChange, linkChange, recordChanges, ticketChanges } from '../tickets/history';
import { canonicalJson, ticketKey } from '../tickets/model';
import { sequenceValueOf } from '../tickets/rank';
import { bottomRank, loadTicket, type TicketRow, ticketQuery } from '../tickets/store';
import { checkKey } from '../tracks/model';
import {
  type Command,
  type CommentCommand,
  type CustomText,
  type EntityKind,
  type GroupCommand,
  type HistoryCommand,
  type HistoryValue,
  type ImportSource,
  isEntityKind,
  type LinkCommand,
  type Ref,
  type StatusCommand,
  type StoredHistoryItem,
  type TicketCommand,
  type TicketProperty,
  type TicketTypeCommand,
  type TimeEntryCommand,
  type TrackCommand,
  type UserCommand,
  type Warning,
} from './model';
import {
  type IdMap,
  RefCollector,
  remapDoc,
  remapFieldName,
  remapFields,
  remapHistoryValue,
} from './remap';

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
  /** The pool, for writes that must outlive a batch that rolls back (storage cleanup). */
  db: Kysely<Database>;
  workspaceId: number;
  system: string;
  importSource: string;
  dryRun: boolean;
  /** The source holds complete history and derived values (`ImportFormat.verbatim`). */
  verbatim: boolean;
  /** The batch's start, for times a source leaves out. */
  now: string;
  refs: Resolver;
  catalog: Catalog;
  /** Source ids inside stored values to the target's (`remap.ts`), through `refs`. */
  remap: IdMap;
  /** The source, for the files it holds. */
  source: ImportSource;
  /** Where attachments go; null when the server keeps none. */
  stores: AttachmentStores | null;
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
  /** Reads a batch's commands need before planning (references inside stored values). */
  prepare?(ctx: LoadContext, cmds: readonly C[]): Promise<void>;
  plan(ctx: LoadContext, cmd: C, existing: number | null, sourceId: string): Promise<Plan>;
  apply(ctx: LoadContext, cmd: C, plan: Plan): Promise<number>;
  /** The batch's closing writes, before it commits. */
  finish?(ctx: LoadContext): Promise<void>;
  /** The target side of the sample: the same shape as the plan's fingerprint. */
  read(db: Db, workspaceId: number, ids: readonly number[]): Promise<Map<number, JsonValue>>;
}

/**
 * The `IdMap` of a batch: source ids to the target's through the resolver (references a dry run
 * would create map to PENDING), custom fields' shapes from the target's catalogue. Ids that do
 * not map are warned about by where they were.
 */
export function targetIdMap(refs: Resolver, catalog: Catalog, warn: (w: Warning) => void): IdMap {
  return {
    id(kind, id) {
      const target = refs.get({ kind, id });
      return target === null ? null : String(target);
    },
    field(id) {
      const target = refs.get({ kind: 'field', id });
      return target === null || target === PENDING ? undefined : catalog.fields.get(target);
    },
    unmapped(kind, where) {
      warn({ code: 'unmapped_reference', detail: `${where} (${kind})` });
    },
  };
}

/** A checksum of canonical JSON. */
export function checksum(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export const lower = (s: string) => s.toLowerCase();
export const isoOf = (v: Date | string | null) =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();
export const real = (id: number | null) => (id === null || id === PENDING ? null : id);

/** A reference that must resolve; a failure names the field. */
export function required(ctx: LoadContext, ref: Ref, field: string): number {
  const id = ctx.refs.get(ref);
  if (id === null) throw new PlanFailure(`missing_reference:${field}`);
  return id;
}

/** A reference that may be absent; one that does not resolve is left empty with a warning. */
export function optional(ctx: LoadContext, ref: Ref | null, field: string): number | null {
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
export async function existingTarget(ctx: LoadContext, table: string, existing: number) {
  if (!(await exists(ctx, table, existing))) throw new PlanFailure('target_deleted');
}

/** Writes changes as one change set at a given time (imported history keeps its times). */
export async function writeChanges(
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
        // Text, not a Date: the source's microseconds are kept.
        at,
        transition_id: c.transitionId ?? null,
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

export async function byName(
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
          ...(cmd.locale === undefined ? {} : { locale: cmd.locale }),
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
        locale: cmd.locale ?? null,
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
    if (cmd.mustExist) throw new PlanFailure('unknown_status');
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
        ...(cmd.description === undefined ? {} : { description: cmd.description }),
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
    if (cmd.mustExist) throw new PlanFailure('unknown_ticket_type');
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
        icon: cmd.icon ?? null,
        color: cmd.color ?? null,
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
      .selectFrom('track_key_history as h')
      .innerJoin('track as t', 't.id', 'h.track_id')
      .select(['h.track_id', 't.key', 't.name', 't.owner_id'])
      .where('h.workspace_id', '=', ctx.workspaceId)
      .where(sql<string>`upper(h.key)`, '=', key.key)
      .where('h.replaced_at', 'is', null)
      .where('t.deleted_at', 'is', null)
      .executeTakeFirst();
    if (taken && cmd.match === 'key') {
      // The track a CSV names: used as it is.
      return {
        action: 'link',
        targetId: taken.track_id,
        fingerprint: { key: taken.key, name: taken.name, owner: taken.owner_id },
      };
    }
    if (cmd.match === 'key') throw new PlanFailure('unknown_track');
    if (taken) throw new PlanFailure('track_key_taken');
    return { action: 'create', targetId: null, fingerprint, data: { owner, key: key.key } };
  },
  async apply(ctx, cmd, plan) {
    if (plan.action === 'link') return plan.targetId as number;
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
        icon: cmd.icon ?? null,
        color: cmd.color ?? null,
        archived_at: null,
        archived_by: null,
        priority_set_id: null,
        deleted_at: null,
        deleted_by: null,
        purge_started_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (cmd.lastNumber !== undefined && cmd.lastNumber > 0) {
      // Numbers the source gave out and deleted stay used (CORE-001).
      await sql`
        INSERT INTO ticket_counter (workspace_id, track_id, last_number)
        VALUES (${ctx.workspaceId}, ${row.id}, ${cmd.lastNumber})
        ON CONFLICT (track_id) DO UPDATE
          SET last_number = greatest(ticket_counter.last_number, EXCLUDED.last_number)`.execute(
        ctx.trx,
      );
    }
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
  number: number | null;
  ticket_type_id: number;
  status_id: number | null;
  summary: string;
  description: JsonValue | null;
  environment: JsonValue | null;
  assignee_id: number | null;
  requester_id: number | null;
  creator_id: number | null;
  parent_id: number | null;
  priority_id: number | null;
  close_reason_id: number | null;
  labels: string[];
  start_date: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  original_estimate: number | null;
  remaining_estimate: number | null;
  /** Null: a new rank at the bottom (or the current one on an update). */
  rank: string | null;
  /** Null: summed from the time entries. */
  time_spent: number | null;
  /**
   * Custom values to write; null leaves them as they are. Formula values only from a verbatim
   * source: otherwise they are computed.
   */
  fields: Record<string, JsonValue> | null;
  /** The custom values compared in samples: formulas left out. */
  compared: Record<string, JsonValue> | null;
  /** Labels of labels fields, for their vocabularies. */
  field_labels: { fieldId: number; names: string[] }[];
  releases: { target: number[]; found: number[] } | null;
  areas: number[] | null;
  followers: number[] | null;
  voters: number[] | null;
  /** In the trash; null leaves it as it is (out of the trash for a new ticket). */
  trash: { deleted_at: string; deleted_by: number | null; trashed_with: number | null } | null;
}

const sortedIds = (ids: readonly number[] | null) =>
  ids === null ? null : [...new Set(ids.map((i) => real(i)))].sort((a, b) => (a ?? 0) - (b ?? 0));

const ticketPrint = (
  v: Omit<TicketValues, 'updated_at' | 'field_labels' | 'fields'>,
): JsonValue => ({
  track: real(v.track_id),
  number: v.number,
  type: real(v.ticket_type_id),
  status: real(v.status_id),
  summary: v.summary,
  description: v.description === null ? null : checksum(v.description),
  environment: v.environment === null ? null : checksum(v.environment),
  assignee: real(v.assignee_id),
  requester: real(v.requester_id),
  creator: real(v.creator_id),
  parent: real(v.parent_id),
  priority: v.priority_id,
  closeReason: real(v.close_reason_id),
  labels: [...v.labels].sort(),
  startDate: v.start_date,
  dueDate: v.due_date,
  createdAt: isoOf(v.created_at),
  closedAt: isoOf(v.closed_at),
  originalEstimate: v.original_estimate,
  remainingEstimate: v.remaining_estimate,
  fields: v.compared === null ? null : checksum(v.compared),
  targetReleases: sortedIds(v.releases?.target ?? null),
  foundReleases: sortedIds(v.releases?.found ?? null),
  areas: sortedIds(v.areas),
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

/** References that resolve, in order, each once; one that does not is left out with a warning. */
function refList(ctx: LoadContext, refs: readonly Ref[] | undefined, field: string): number[] {
  const out: number[] = [];
  for (const ref of refs ?? []) {
    const id = optional(ctx, ref, field);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The ticket's own documents: a verbatim source's with mentions mapped, or Markdown. */
function docsOf(ctx: LoadContext, cmd: TicketCommand) {
  if (cmd.docs) {
    const doc = (d: JsonValue | null) => (d === null ? null : remapDoc(d, ctx.remap));
    return { description: doc(cmd.docs.description), environment: doc(cmd.docs.environment) };
  }
  return {
    description:
      cmd.description === null ? null : (fromMarkdown(cmd.description) as unknown as JsonValue),
    environment: null,
  };
}

/** Field ids of formula fields: computed, so neither written nor compared. */
const formulaIds = (catalog: Catalog) =>
  new Set(
    [...catalog.fields.values()].filter((f) => f.type === 'formula').map((f) => String(f.id)),
  );
const withoutFormulas = (fields: Record<string, JsonValue>, formulas: ReadonlySet<string>) =>
  Object.fromEntries(Object.entries(fields).filter(([k]) => !formulas.has(k)));
const formulaValues = (catalog: Catalog, fields: Record<string, JsonValue> | undefined) => {
  const formulas = formulaIds(catalog);
  return Object.fromEntries(Object.entries(fields ?? {}).filter(([k]) => formulas.has(k)));
};

/** The objects a cell names, looked up by name the way CSV gives them; null when unknown. */
async function referenceByText(
  ctx: LoadContext,
  reference: Reference,
  text: string,
  at: { trackId: number; contextId: number; parentId: number | null },
): Promise<number | null> {
  const name = text.trim();
  switch (reference) {
    case 'option': {
      const option = ctx.catalog
        .optionsOf(at.contextId, at.parentId)
        .find((o) => lower(o.value) === lower(name));
      return option?.id ?? null;
    }
    case 'user':
      return byName(ctx, `user:${lower(name)}`, () =>
        ctx.trx
          .selectFrom('app_user')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where(sql<string>`lower(email)`, '=', lower(name))
          .executeTakeFirst(),
      );
    case 'group':
      return byName(ctx, `group:${lower(name)}`, () =>
        ctx.trx
          .selectFrom('user_group')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where(sql<string>`lower(name)`, '=', lower(name))
          .executeTakeFirst(),
      );
    case 'release':
    case 'area':
      return byName(ctx, `${reference}:${at.trackId}:${lower(name)}`, () =>
        ctx.trx
          .selectFrom(reference)
          .select('id')
          .where('track_id', '=', at.trackId)
          .where(sql<string>`lower(name)`, '=', lower(name))
          .executeTakeFirst(),
      );
  }
}

/**
 * Custom values given as text (CSV) read against the target's fields: names of options, people
 * (by email), groups, releases and areas become ids, then the values go through the same check
 * as a REST edit (`checkCustomValues`). A value that does not read is left out with a warning.
 */
async function customFromTexts(
  ctx: LoadContext,
  texts: readonly CustomText[],
  at: { trackId: number; typeId: number },
  current: Record<string, JsonValue>,
  creating: boolean,
): Promise<{ fields: Record<string, JsonValue>; labels: { fieldId: number; names: string[] }[] }> {
  const input: Record<string, unknown> = {};
  for (const { fieldId, texts: values, separator } of texts) {
    const field = ctx.catalog.fields.get(fieldId);
    const context = field ? ctx.catalog.contextOf(fieldId, at.trackId, at.typeId) : null;
    if (!field || !context) {
      ctx.warn({ code: field ? 'field_not_applicable' : 'unknown_field', detail: String(fieldId) });
      continue;
    }
    // Several values of one field come in one cell, split on the mapping's separator.
    const split = (field.multiple && REFERENCE_OF[field.type]) || field.type === 'labels';
    const given = values
      .flatMap((v) => (split ? v.split(separator) : [v]))
      .map((v) => v.trim())
      .filter((v) => v !== '');
    if (given.length === 0) {
      input[fieldId] = null;
      continue;
    }
    const reference = REFERENCE_OF[field.type];
    if (field.type === 'cascading-select') {
      const [parentName, childName] = (given[0] as string).split(/\s+\/\s+|:/);
      const where = { trackId: at.trackId, contextId: context.id, parentId: null };
      const parent = await referenceByText(ctx, 'option', parentName ?? '', where);
      const child =
        parent === null || childName === undefined
          ? null
          : await referenceByText(ctx, 'option', childName, { ...where, parentId: parent });
      if (parent === null || (childName !== undefined && child === null)) {
        ctx.warn({ code: 'unknown_value', detail: `cf[${fieldId}]` });
        continue;
      }
      input[fieldId] = child === null ? [parent] : [parent, child];
    } else if (reference) {
      const ids: number[] = [];
      for (const text of given) {
        const id = await referenceByText(ctx, reference, text, {
          trackId: at.trackId,
          contextId: context.id,
          parentId: null,
        });
        if (id === null) ctx.warn({ code: 'unknown_value', detail: `cf[${fieldId}]` });
        else ids.push(id);
      }
      if (ids.length === 0) continue;
      input[fieldId] = field.multiple ? ids : ids[0];
    } else if (field.type === 'labels') {
      input[fieldId] = given.flatMap((t) => t.split(/\s+/));
    } else if (field.type === 'paragraph') {
      input[fieldId] = fromMarkdown(given.join('\n\n'));
    } else {
      input[fieldId] = given.join(' ');
    }
  }
  const checked = await checkCustomValues(
    ctx.trx,
    ctx.catalog,
    { workspaceId: ctx.workspaceId, trackId: at.trackId, ticketTypeId: at.typeId },
    'rest',
    current,
    input,
    creating,
  );
  if (checked.ok) return { fields: checked.fields, labels: checked.labels };
  // Drop what was refused, field by field, and keep the rest.
  for (const [key, problem] of Object.entries(checked.errors)) {
    const id = key.replace(/^fields\./, '');
    ctx.warn({ code: `value_${problem}`, detail: `cf[${id}]` });
    delete input[id];
  }
  const retry = await checkCustomValues(
    ctx.trx,
    ctx.catalog,
    { workspaceId: ctx.workspaceId, trackId: at.trackId, ticketTypeId: at.typeId },
    'rest',
    current,
    input,
    creating,
  );
  return retry.ok
    ? { fields: retry.fields, labels: retry.labels }
    : { fields: current, labels: [] };
}

/** Labels of labels fields in stored values, for their vocabularies. */
function fieldLabelsOf(catalog: Catalog, fields: Record<string, JsonValue>) {
  return Object.entries(fields).flatMap(([key, value]) =>
    catalog.fields.get(Number(key))?.type === 'labels' && Array.isArray(value)
      ? [{ fieldId: Number(key), names: value.map(String) }]
      : [],
  );
}

/** Ids in stored values a batch of verbatim tickets names, looked up before planning. */
async function preloadStored(ctx: LoadContext, walk: (map: IdMap) => void): Promise<void> {
  // Field ids first: a value's references depend on its field's type.
  const fieldsOnly = new RefCollector(() => undefined);
  walk(fieldsOnly);
  await ctx.refs.preload(fieldsOnly.refs);
  const all = new RefCollector((id) => ctx.remap.field(id));
  walk(all);
  await ctx.refs.preload(all.refs);
}

const tickets: Loader<TicketCommand> = {
  table: { name: 'ticket', id: 'id' },
  async prepare(ctx, cmds) {
    await preloadStored(ctx, (map) => {
      for (const cmd of cmds) {
        if (cmd.fields) remapFields(cmd.fields, map);
        if (cmd.docs?.description) remapDoc(cmd.docs.description, map);
        if (cmd.docs?.environment) remapDoc(cmd.docs.environment, map);
      }
    });
    // Ranks the target already uses: a source rank that clashes takes a new one.
    const ranks = cmds.flatMap((c) => (c.rank === undefined ? [] : [c.rank]));
    if (ranks.length > 0) {
      const taken = await ctx.trx
        .selectFrom('ticket')
        .select('rank')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('rank', 'in', ranks)
        .execute();
      for (const r of taken) ctx.cache.set(`rank:${r.rank}`, 1);
    }
  },
  async plan(ctx, cmd, existing) {
    const track = required(ctx, cmd.track, 'track');
    let target = existing;
    if (target === null && cmd.match === 'key' && cmd.number !== null && track !== PENDING) {
      // Create-or-update by key (IMP-012): the ticket the target has at this key is the one.
      const found = await ctx.trx
        .selectFrom('ticket')
        .select('id')
        .where('track_id', '=', track)
        .where('number', '=', cmd.number)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (found) target = found.id;
    }
    if (target !== null) await existingTarget(ctx, 'ticket', target);
    const current = target === null ? null : await loadTicket(ctx.trx, ctx.workspaceId, target);
    const keep = new Set(current ? (cmd.keep ?? []) : []);
    const kept = <T>(property: TicketProperty, mine: () => T, theirs: (row: TicketRow) => T) =>
      current && keep.has(property) ? theirs(current) : mine();

    const type =
      current && keep.has('type')
        ? current.ticket_type_id
        : cmd.type === null
          ? await defaultTypeOf(ctx, track)
          : required(ctx, cmd.type, 'type');
    let priority: number | null = null;
    if (cmd.priorityRef !== undefined) {
      priority = optional(ctx, cmd.priorityRef, 'priority');
    } else if (!(current && keep.has('priority')) && cmd.priority !== null) {
      priority = await priorityId(ctx, cmd.priority);
      if (priority === null) ctx.warn({ code: 'unknown_priority', detail: cmd.priority });
    } else if (current && keep.has('priority')) {
      priority = current.priority_id;
    }
    let parent = kept(
      'parent',
      () => optional(ctx, cmd.parent, 'parent'),
      (r) => r.parent_id,
    );
    if (parent === null && cmd.parentKey && !(current && keep.has('parent'))) {
      parent = await ticketByKey(ctx, cmd.parentKey);
      if (parent === null) ctx.warn({ code: 'missing_reference', detail: 'parent' });
    }
    const docs = docsOf(ctx, cmd);
    const formulas = formulaIds(ctx.catalog);
    let fields: Record<string, JsonValue> | null = null;
    let fieldLabels: { fieldId: number; names: string[] }[] = [];
    if (cmd.fields) {
      fields = remapFields(cmd.fields, ctx.remap);
      if (!ctx.verbatim) fields = withoutFormulas(fields, formulas);
      fieldLabels = fieldLabelsOf(ctx.catalog, fields);
    } else if (cmd.customTexts && track !== PENDING && type !== PENDING) {
      const read = await customFromTexts(
        ctx,
        cmd.customTexts,
        { trackId: track, typeId: type },
        current?.fields ?? {},
        current === null,
      );
      fields = withoutFormulas(read.fields, formulas);
      fieldLabels = read.labels;
    }
    const currentReleases = (role: 'target_releases' | 'found_releases') =>
      (current?.[role] ?? []).map((r) => r.id);
    const releases =
      cmd.releases && !(keep.has('targetReleases') && keep.has('foundReleases'))
        ? {
            target: keep.has('targetReleases')
              ? currentReleases('target_releases')
              : refList(ctx, cmd.releases.target, 'targetRelease'),
            found: keep.has('foundReleases')
              ? currentReleases('found_releases')
              : refList(ctx, cmd.releases.found, 'foundInRelease'),
          }
        : null;
    const values: TicketValues = {
      track_id: track,
      number: cmd.number ?? current?.number ?? null,
      ticket_type_id: type,
      status_id: kept(
        'status',
        () => optional(ctx, cmd.status, 'status'),
        (r) => r.status_id,
      ),
      summary: kept(
        'summary',
        () => cmd.summary,
        (r) => r.summary,
      ),
      description: kept(
        'description',
        () => docs.description,
        (r) => r.description,
      ),
      environment: current && !cmd.docs ? current.environment : docs.environment,
      assignee_id: kept(
        'assignee',
        () => optional(ctx, cmd.assignee, 'assignee'),
        (r) => r.assignee_id,
      ),
      requester_id: kept(
        'requester',
        () => optional(ctx, cmd.requester, 'requester'),
        (r) => r.requester_id,
      ),
      creator_id: kept(
        'creator',
        () => optional(ctx, cmd.creator, 'creator'),
        (r) => r.creator_id,
      ),
      parent_id: parent,
      priority_id: priority,
      close_reason_id:
        cmd.closeReason === undefined
          ? (current?.close_reason_id ?? null)
          : optional(ctx, cmd.closeReason, 'closeReason'),
      labels: kept(
        'labels',
        () => labelsOf(ctx, cmd.labels),
        (r) => r.labels,
      ),
      start_date: kept(
        'startDate',
        () => cmd.startDate,
        (r) => r.start_date,
      ),
      due_date: kept(
        'dueDate',
        () => cmd.dueDate,
        (r) => r.due_date,
      ),
      created_at: kept(
        'createdAt',
        () => cmd.createdAt ?? ctx.now,
        (r) => r.created_at.toISOString(),
      ),
      updated_at: kept(
        'updatedAt',
        () => cmd.updatedAt ?? ctx.now,
        (r) => r.updated_at.toISOString(),
      ),
      closed_at: kept(
        'closedAt',
        () => cmd.closedAt,
        (r) => r.closed_at?.toISOString() ?? null,
      ),
      original_estimate: kept(
        'originalEstimate',
        () => cmd.originalEstimate,
        (r) => r.original_estimate,
      ),
      remaining_estimate: kept(
        'remainingEstimate',
        () => cmd.remainingEstimate,
        (r) => r.remaining_estimate,
      ),
      rank:
        cmd.rank !== undefined && (current?.rank === cmd.rank || !ctx.cache.has(`rank:${cmd.rank}`))
          ? cmd.rank
          : null,
      time_spent: ctx.verbatim ? (cmd.timeSpent ?? 0) : null,
      fields: keep.has('fields') ? null : fields,
      compared: keep.has('fields') || fields === null ? null : withoutFormulas(fields, formulas),
      field_labels: keep.has('fields') ? [] : fieldLabels,
      releases,
      areas: keep.has('areas') || !cmd.areas ? null : refList(ctx, cmd.areas, 'area'),
      followers: cmd.followers ? refList(ctx, cmd.followers, 'followers') : null,
      voters: cmd.voters ? refList(ctx, cmd.voters, 'voters') : null,
      trash: cmd.trash
        ? {
            deleted_at: cmd.trash.deletedAt,
            deleted_by: optional(ctx, cmd.trash.deletedBy, 'deletedBy'),
            trashed_with: optional(ctx, cmd.trash.trashedWith, 'trashedWith'),
          }
        : null,
    };
    if (cmd.rank !== undefined && values.rank === null) ctx.warn({ code: 'rank_changed' });
    // What the ticket will hold: values the command leaves out stay as they are (or empty).
    const fingerprint = ticketPrint({
      ...values,
      compared: values.compared ?? withoutFormulas(current?.fields ?? {}, formulas),
      releases: values.releases ?? {
        target: currentReleases('target_releases'),
        found: currentReleases('found_releases'),
      },
      areas: values.areas ?? (current?.areas ?? []).map((a) => a.id),
    });
    if (target !== null) {
      return { action: 'update', targetId: target, fingerprint, data: values };
    }
    // A new ticket needs a summary, also from a file without that column.
    if (values.summary.trim() === '') throw new PlanFailure('summary_required');
    if (track !== PENDING && cmd.number !== null) {
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
    const offeredKey = `offered:${track}:${type}`;
    if (!ctx.cache.has(offeredKey)) {
      const offered =
        type === PENDING
          ? undefined
          : track === PENDING
            ? await ctx.trx
                .selectFrom('type_set_default as d')
                .innerJoin('type_set_member as m', 'm.type_set_id', 'd.type_set_id')
                .select('m.ticket_type_id as id')
                .where('d.workspace_id', '=', ctx.workspaceId)
                .where('m.ticket_type_id', '=', type)
                .executeTakeFirst()
            : await ctx.trx
                .selectFrom('track as t')
                .innerJoin('type_set_member as m', 'm.type_set_id', 't.type_set_id')
                .select('m.ticket_type_id as id')
                .where('t.id', '=', track)
                .where('m.ticket_type_id', '=', type)
                .executeTakeFirst();
      ctx.cache.set(offeredKey, offered ? 1 : null);
    }
    if (ctx.cache.get(offeredKey) === null) {
      ctx.warn({ code: 'type_not_offered', detail: cmd.type?.id ?? String(type) });
    }
    return { action: 'create', targetId: null, fingerprint, data: values };
  },
  async apply(ctx, _cmd, plan) {
    const v = plan.data as TicketValues;
    const ws = ctx.workspaceId;
    const columns = {
      track_id: v.track_id,
      ticket_type_id: v.ticket_type_id,
      ...(v.status_id === null ? {} : { status_id: v.status_id }),
      summary: v.summary,
      description: v.description === null ? null : JSON.stringify(v.description),
      environment: v.environment === null ? null : JSON.stringify(v.environment),
      assignee_id: v.assignee_id,
      requester_id: v.requester_id,
      creator_id: v.creator_id,
      parent_id: v.parent_id,
      priority_id: v.priority_id,
      close_reason_id: v.close_reason_id,
      labels: v.labels,
      start_date: v.start_date,
      due_date: v.due_date,
      created_at: v.created_at,
      updated_at: v.updated_at,
      closed_at: v.closed_at,
      original_estimate: v.original_estimate,
      remaining_estimate: v.remaining_estimate,
      ...(v.time_spent === null ? {} : { time_spent: v.time_spent }),
      ...(v.trash === null ? {} : v.trash),
    };
    let id: number;
    let number: number;
    if (plan.action === 'update') {
      id = plan.targetId as number;
      const before = await loadTicket(ctx.trx, ws, id);
      const row = await ctx.trx
        .updateTable('ticket')
        .set({
          ...columns,
          ...(v.number === null ? {} : { number: v.number }),
          ...(v.rank === null ? {} : { rank: v.rank }),
          ...(v.fields === null
            ? {}
            : {
                // Formula values stay until the batch's end computes them again.
                fields: JSON.stringify(
                  ctx.verbatim
                    ? v.fields
                    : { ...formulaValues(ctx.catalog, before?.fields), ...v.fields },
                ),
              }),
          version: sql<number>`version + 1`,
        })
        .where('id', '=', id)
        .returning('number')
        .executeTakeFirstOrThrow();
      number = row.number;
      await writeTicketSets(ctx, id, v, true);
      const after = await loadTicket(ctx.trx, ws, id);
      // A verbatim source's own history says what changed; others get the difference.
      if (before && after && !ctx.verbatim) {
        await recordChanges(ctx.trx, ws, null, [
          ...ticketChanges(before, after),
          ...(await customChanges(ctx.trx, ws, ctx.catalog, id, before.fields, after.fields)),
        ]);
      }
    } else {
      number =
        v.number ??
        Number(
          (
            await sql<{ n: number }>`
              INSERT INTO ticket_counter (workspace_id, track_id, last_number)
              VALUES (${ws}, ${v.track_id}, 1)
              ON CONFLICT (track_id) DO UPDATE SET last_number = ticket_counter.last_number + 1
              RETURNING last_number AS n`.execute(ctx.trx)
          ).rows[0]?.n,
        );
      id = (
        await ctx.trx
          .insertInto('ticket')
          .values({
            workspace_id: ws,
            ...columns,
            number,
            rank: v.rank ?? (await bottomRank(ctx.trx)),
            fields: JSON.stringify(v.fields ?? {}),
            deleted_at: null,
            deleted_by: null,
            trashed_with: null,
            ...(v.trash === null ? {} : v.trash),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await writeTicketSets(ctx, id, v, false);
      // Every starting value is history too (ADR-010), at the time and by the person that
      // created the ticket; the source's history entries correct values they changed later.
      // A verbatim source brings these entries itself.
      if (!ctx.verbatim) {
        const created = await loadTicket(ctx.trx, ws, id);
        if (created) {
          await writeChanges(ctx.trx, ws, v.creator_id, v.created_at, [
            ...ticketChanges(null, created),
            ...(await customChanges(ctx.trx, ws, ctx.catalog, id, {}, created.fields)),
          ]);
        }
      }
    }
    if (v.rank !== null) {
      const top = ctx.cache.get('rank:max') ?? null;
      const value = Number(sequenceValueOf(v.rank));
      if (top === null || value > top) ctx.cache.set('rank:max', value);
    }
    // Numbers come from the source: the counter moves past them (CORE-001).
    const last = ctx.cache.get(`counter:${v.track_id}`) ?? null;
    if (last === null || number > last) ctx.cache.set(`counter:${v.track_id}`, number);
    await rememberLabels(ctx.trx, ws, v.labels);
    if (v.field_labels.length > 0) await rememberFieldLabels(ctx.trx, ws, v.field_labels);
    ctx.touched.add(id);
    return id;
  },
  async finish(ctx) {
    await moveCounters(ctx);
    await syncFieldValues(ctx.trx, ctx.catalog, [...ctx.touched]);
    if (!ctx.verbatim) await refreshTouched(ctx);
  },
  async read(db, ws, ids) {
    const formulas = new Set(
      (
        await db
          .selectFrom('field')
          .select('id')
          .where('workspace_id', '=', ws)
          .where('type', '=', 'formula')
          .execute()
      ).map((f) => String(f.id)),
    );
    const rows = await ticketQuery(db, ws)
      .where('k.id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        ticketPrint({
          ...r,
          created_at: r.created_at.toISOString(),
          closed_at: r.closed_at?.toISOString() ?? null,
          rank: r.rank,
          time_spent: r.time_spent,
          compared: withoutFormulas(r.fields, formulas),
          releases: {
            target: r.target_releases.map((x) => x.id),
            found: r.found_releases.map((x) => x.id),
          },
          areas: r.areas.map((a) => a.id),
          followers: null,
          voters: null,
          trash: null,
        }),
      ]),
    );
  },
};

/** The type a track preselects for new tickets (its type set's default, else its first). */
async function defaultTypeOf(ctx: LoadContext, track: number): Promise<number> {
  if (track === PENDING) return PENDING;
  const id = await byName(ctx, `default_type:${track}`, () =>
    ctx.trx
      .selectFrom('track as t')
      .innerJoin('type_set as s', 's.id', 't.type_set_id')
      .innerJoin('type_set_member as m', 'm.type_set_id', 's.id')
      .select(sql<number>`coalesce(s.default_type_id, m.ticket_type_id)`.as('id'))
      .where('t.id', '=', track)
      .orderBy(sql`m.ticket_type_id = s.default_type_id`, 'desc')
      .orderBy('m.sort_order')
      .executeTakeFirst(),
  );
  if (id === null) throw new PlanFailure('no_ticket_type');
  return id;
}

/** A ticket of the target by its key (KEY-12), or null. */
async function ticketByKey(ctx: LoadContext, key: string): Promise<number | null> {
  const m = /^([A-Za-z][A-Za-z0-9_]*)-([1-9][0-9]{0,9})$/.exec(key.trim());
  if (!m) return null;
  return byName(ctx, `ticket:${key.trim().toUpperCase()}`, () =>
    ctx.trx
      .selectFrom('ticket_key_history as h')
      .innerJoin('track_key_history as t', 't.track_id', 'h.track_id')
      .select('h.ticket_id as id')
      .where('h.workspace_id', '=', ctx.workspaceId)
      .where(sql<string>`upper(t.key)`, '=', (m[1] as string).toUpperCase())
      .where('h.number', '=', Number(m[2]))
      .executeTakeFirst(),
  );
}

/** A ticket's releases, areas, followers and voters: those the command gives replace the rest. */
async function writeTicketSets(
  ctx: LoadContext,
  ticketId: number,
  v: TicketValues,
  replace: boolean,
): Promise<void> {
  const ws = ctx.workspaceId;
  if (v.releases) {
    if (replace)
      await ctx.trx.deleteFrom('ticket_release').where('ticket_id', '=', ticketId).execute();
    const rows = [
      ...v.releases.target.map((release_id) => ({ release_id, role: 'target' as const })),
      ...v.releases.found.map((release_id) => ({ release_id, role: 'found' as const })),
    ].map((r) => ({ workspace_id: ws, ticket_id: ticketId, ...r }));
    if (rows.length > 0) await ctx.trx.insertInto('ticket_release').values(rows).execute();
  }
  if (v.areas) {
    if (replace)
      await ctx.trx.deleteFrom('ticket_area').where('ticket_id', '=', ticketId).execute();
    if (v.areas.length > 0) {
      await ctx.trx
        .insertInto('ticket_area')
        .values(v.areas.map((area_id) => ({ workspace_id: ws, ticket_id: ticketId, area_id })))
        .execute();
    }
  }
  for (const [table, people] of [
    ['ticket_follower', v.followers],
    ['ticket_vote', v.voters],
  ] as const) {
    if (people === null) continue;
    if (replace) await ctx.trx.deleteFrom(table).where('ticket_id', '=', ticketId).execute();
    if (people.length > 0) {
      await ctx.trx
        .insertInto(table)
        .values(people.map((user_id) => ({ workspace_id: ws, ticket_id: ticketId, user_id })))
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  }
}

/** Ticket counters past the numbers the batch wrote, and the rank sequence past its ranks. */
async function moveCounters(ctx: LoadContext): Promise<void> {
  for (const [key, value] of ctx.cache) {
    if (!key.startsWith('counter:') || value === null) continue;
    const trackId = Number(key.slice('counter:'.length));
    await sql`
      INSERT INTO ticket_counter (workspace_id, track_id, last_number)
      VALUES (${ctx.workspaceId}, ${trackId}, ${value})
      ON CONFLICT (track_id) DO UPDATE
        SET last_number = greatest(ticket_counter.last_number, EXCLUDED.last_number)`.execute(
      ctx.trx,
    );
  }
  const top = ctx.cache.get('rank:max') ?? null;
  if (top !== null) {
    // Later tickets take sequence keys: they must sort after every rank imported.
    await sql`
      SELECT setval('ticket_rank_seq', ${top + 1})
       WHERE ${top + 1} > (SELECT last_value FROM ticket_rank_seq)`.execute(ctx.trx);
  }
}

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

interface CommentData {
  ticket: number;
  author: number | null;
  group: number | null;
  role: number | null;
  body: JsonValue;
  editedBy: number | null;
  deletedBy: number | null;
}

const comments: Loader<CommentCommand> = {
  table: { name: 'ticket_comment', id: 'id' },
  async prepare(ctx, cmds) {
    await preloadStored(ctx, (map) => {
      for (const cmd of cmds) if (cmd.doc !== undefined) remapDoc(cmd.doc, map);
    });
  },
  async plan(ctx, cmd, existing) {
    const data: CommentData = {
      ticket: required(ctx, cmd.ticket, 'ticket'),
      author: optional(ctx, cmd.author, 'author'),
      group: optional(ctx, cmd.visibleGroup, 'group'),
      role: optional(ctx, cmd.visibleRole ?? null, 'role'),
      body:
        cmd.doc !== undefined
          ? remapDoc(cmd.doc, ctx.remap)
          : (fromMarkdown(cmd.body) as unknown as JsonValue),
      editedBy: optional(ctx, cmd.editedBy ?? null, 'editedBy'),
      deletedBy: optional(ctx, cmd.deletedBy ?? null, 'deletedBy'),
    };
    const fingerprint = commentPrint({ ...data, createdAt: isoOf(cmd.createdAt) });
    if (existing !== null) {
      await existingTarget(ctx, 'ticket_comment', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as CommentData;
    const edited = {
      edited_at: cmd.editedAt ?? null,
      edited_by: d.editedBy,
    };
    const deleted = {
      deleted_at: cmd.deletedAt ?? null,
      deleted_by: d.deletedBy,
    };
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('ticket_comment')
        .set({
          body: JSON.stringify(d.body),
          visible_group_id: d.group,
          visible_role_id: d.role,
          updated_at: cmd.updatedAt,
          ...(cmd.editedAt === undefined ? {} : edited),
          ...(cmd.deletedAt === undefined ? {} : deleted),
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
        visible_role_id: d.role,
        visible_group_id: d.group,
        created_at: cmd.createdAt,
        updated_at: cmd.updatedAt,
        ...edited,
        ...deleted,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // A verbatim source's history has the entry for the new comment.
    if (ctx.verbatim) return row.id;
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
        created_at: cmd.createdAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // A verbatim source's history has the entries for the new link.
    if (ctx.verbatim) return row.id;
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
  transitionId?: number;
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

/** A stored entry's field and values with the source's ids mapped; null drops the entry. */
function storedItem(ctx: LoadContext, item: StoredHistoryItem): HistoryItem | null {
  const field = remapFieldName(item.field, ctx.remap, 'history.field');
  if (field === null) return null;
  return {
    field,
    // Values read by the field's source name: its type comes from the field it maps to.
    from: remapHistoryValue(item.field, item.from, ctx.remap),
    to: remapHistoryValue(item.field, item.to, ctx.remap),
    fromDisplay: item.fromDisplay,
    toDisplay: item.toDisplay,
    ...(item.transition === null ? {} : { transitionId: item.transition }),
  };
}

const history: Loader<HistoryCommand> = {
  table: { name: 'ticket_change', id: 'change_set' },
  async prepare(ctx, cmds) {
    await preloadStored(ctx, (map) => {
      for (const cmd of cmds) {
        for (const item of cmd.stored ?? []) {
          remapFieldName(item.field, map);
          remapHistoryValue(item.field, item.from, map);
          remapHistoryValue(item.field, item.to, map);
        }
      }
    });
  },
  async plan(ctx, cmd, existing) {
    const ticket = required(ctx, cmd.ticket, 'ticket');
    const actor = optional(ctx, cmd.actor, 'actor');
    const items: HistoryItem[] = [];
    for (const item of cmd.stored ?? []) {
      const mapped = storedItem(ctx, item);
      if (mapped) items.push(mapped);
    }
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
    if (ctx.verbatim) {
      // Complete history from the source: written as it is, starting values included.
      return Number(
        await writeChanges(
          ctx.trx,
          ws,
          actor,
          cmd.at,
          items.map((i) => ({ ticketId: ticket, ...i })),
        ),
      );
    }
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

interface TimeData {
  ticket: number;
  author: number;
  group: number | null;
  role: number | null;
  createdBy: number | null;
}

const timeEntries: Loader<TimeEntryCommand> = {
  table: { name: 'time_entry', id: 'id' },
  async plan(ctx, cmd, existing) {
    const author = required(ctx, cmd.author, 'author');
    const data: TimeData = {
      ticket: required(ctx, cmd.ticket, 'ticket'),
      author,
      group: optional(ctx, cmd.visibleGroup ?? null, 'group'),
      role: optional(ctx, cmd.visibleRole ?? null, 'role'),
      createdBy: cmd.createdBy === undefined ? author : optional(ctx, cmd.createdBy, 'createdBy'),
    };
    const fingerprint = timePrint({
      ticket: data.ticket,
      author: data.author,
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
    const d = plan.data as TimeData;
    let id = plan.targetId;
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('time_entry')
        .set({
          started_at: cmd.startedAt,
          duration: cmd.seconds,
          description: cmd.description,
          visible_group_id: d.group,
          visible_role_id: d.role,
          updated_at: cmd.updatedAt ?? new Date(),
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
            started_at: cmd.startedAt,
            duration: cmd.seconds,
            description: cmd.description,
            visible_role_id: d.role,
            visible_group_id: d.group,
            created_by: d.createdBy,
            created_at: cmd.createdAt ?? cmd.startedAt,
            ...(cmd.updatedAt === undefined ? {} : { updated_at: cmd.updatedAt }),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    ctx.touched.add(d.ticket);
    return id as number;
  },
  async finish(ctx) {
    // A verbatim source's tickets keep the time spent and formulas they had.
    if (!ctx.verbatim) await refreshTouched(ctx);
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

/** The loaders of the kinds the framework started with (M1-086); `loaders.ts` has them all. */
export const CORE_LOADERS = {
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
} as const;
