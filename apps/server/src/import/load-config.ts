import type { Database, JsonValue } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { REFERENCE_OF } from '../fields/types';
import { withMovesIfNone } from '../workflows/free-moves';
import { definitionProblem, definitionSchema, statusIdsOf } from '../workflows/model';
import {
  existingTarget,
  type LoadContext,
  type Loader,
  lower,
  optional,
  PENDING,
  PlanFailure,
  real,
  required,
} from './load';
import type {
  AreaCommand,
  CloseReasonCommand,
  FieldCommand,
  FieldContextCommand,
  FieldOptionCommand,
  LinkTypeCommand,
  PriorityCommand,
  ReleaseCommand,
  RoleCommand,
  WorkflowCommand,
  WorkflowMapCommand,
} from './model';
import { RefCollector, remapDefinition, remapFieldConfig, remapStored } from './remap';

/**
 * Loaders for the configuration Taskmoor's own export carries (M1-098; IMP-014): roles,
 * priorities, close reasons, link types, releases, areas, custom fields with their contexts and
 * options, workflows and workflow maps. Each links to the target's object of the same name (a
 * newly set-up instance already has the built-in ones) or creates it; objects linked this way
 * keep the target's settings, as for people and statuses (ADR-048). Ids inside stored values
 * (a formula's fields, a default value's options, a workflow's statuses) are mapped with
 * `remap.ts`.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** One query for a row of the workspace by name, ignoring case. */
async function named(
  ctx: LoadContext,
  table: 'role' | 'priority' | 'close_reason' | 'link_type',
  name: string,
): Promise<number | null> {
  const row = await ctx.trx
    .selectFrom(table)
    .select('id')
    .where('workspace_id', '=', ctx.workspaceId)
    .where(sql<string>`lower(name)`, '=', lower(name))
    .executeTakeFirst();
  return row?.id ?? null;
}

/** A plan for an object linked by name, or created; a re-run updates the one it made. */
async function byNamePlan(
  ctx: LoadContext,
  table: 'role' | 'priority' | 'close_reason' | 'link_type',
  name: string,
  existing: number | null,
  fingerprint: JsonValue,
) {
  if (existing !== null) {
    await existingTarget(ctx, table, existing);
    return { action: 'update' as const, targetId: existing, fingerprint };
  }
  const found = await named(ctx, table, name);
  if (found !== null) return { action: 'link' as const, targetId: found, fingerprint };
  return { action: 'create' as const, targetId: null, fingerprint };
}

const readNamed =
  (table: 'role' | 'priority' | 'close_reason' | 'link_type') =>
  async (db: Db, ws: number, ids: readonly number[]) => {
    const rows = await db
      .selectFrom(table)
      .select(['id', 'name'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(rows.map((r) => [r.id, { name: lower(r.name) } as JsonValue]));
  };

export const roles: Loader<RoleCommand> = {
  table: { name: 'role', id: 'id' },
  plan: (ctx, cmd, existing) =>
    byNamePlan(ctx, 'role', cmd.name, existing, { name: lower(cmd.name) }),
  async apply(ctx, cmd, plan) {
    if (plan.action === 'link') return plan.targetId as number;
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('role')
        .set({ name: cmd.name, description: cmd.description })
        .where('id', '=', plan.targetId as number)
        .execute();
      return plan.targetId as number;
    }
    const row = await ctx.trx
      .insertInto('role')
      .values({ workspace_id: ctx.workspaceId, name: cmd.name, description: cmd.description })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  read: readNamed('role'),
};

export const priorities: Loader<PriorityCommand> = {
  table: { name: 'priority', id: 'id' },
  plan: (ctx, cmd, existing) =>
    byNamePlan(ctx, 'priority', cmd.name, existing, { name: lower(cmd.name) }),
  async apply(ctx, cmd, plan) {
    if (plan.action === 'link') return plan.targetId as number;
    const look = { description: cmd.description, icon: cmd.icon, color: cmd.color };
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('priority')
        .set({ name: cmd.name, ...look, updated_at: new Date() })
        .where('id', '=', plan.targetId as number)
        .execute();
      return plan.targetId as number;
    }
    // After the target's own, in the source's order; offered by the default set (CORE-014).
    const row = await ctx.trx
      .insertInto('priority')
      .values({
        workspace_id: ctx.workspaceId,
        name: cmd.name,
        ...look,
        sort_order: sql<number>`(SELECT coalesce(max(sort_order), 0) + 1 FROM priority
          WHERE workspace_id = ${ctx.workspaceId})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`
      INSERT INTO priority_set_member (workspace_id, priority_set_id, priority_id)
      SELECT workspace_id, id, ${row.id} FROM priority_set
       WHERE workspace_id = ${ctx.workspaceId} AND is_default`.execute(ctx.trx);
    return row.id;
  },
  read: readNamed('priority'),
};

export const closeReasons: Loader<CloseReasonCommand> = {
  table: { name: 'close_reason', id: 'id' },
  plan: (ctx, cmd, existing) =>
    byNamePlan(ctx, 'close_reason', cmd.name, existing, { name: lower(cmd.name) }),
  async apply(ctx, cmd, plan) {
    if (plan.action === 'link') return plan.targetId as number;
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('close_reason')
        .set({ name: cmd.name, description: cmd.description, updated_at: new Date() })
        .where('id', '=', plan.targetId as number)
        .execute();
      return plan.targetId as number;
    }
    // Not `createCloseReason`: an import records no event per row it writes, as with priorities
    // and statuses. Its trail is the run's report and `import_run.finished` (ADR-048).
    const row = await ctx.trx
      .insertInto('close_reason')
      .values({
        workspace_id: ctx.workspaceId,
        name: cmd.name,
        description: cmd.description,
        sort_order: sql<number>`(SELECT coalesce(max(sort_order), 0) + 1 FROM close_reason
          WHERE workspace_id = ${ctx.workspaceId})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  read: readNamed('close_reason'),
};

export const linkTypes: Loader<LinkTypeCommand> = {
  table: { name: 'link_type', id: 'id' },
  plan: (ctx, cmd, existing) =>
    byNamePlan(ctx, 'link_type', cmd.name, existing, { name: lower(cmd.name) }),
  async apply(ctx, cmd, plan) {
    if (plan.action === 'link') return plan.targetId as number;
    const phrases = { outward: cmd.outward, inward: cmd.inward };
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('link_type')
        .set({ name: cmd.name, ...phrases, updated_at: new Date() })
        .where('id', '=', plan.targetId as number)
        .execute();
      return plan.targetId as number;
    }
    const row = await ctx.trx
      .insertInto('link_type')
      .values({ workspace_id: ctx.workspaceId, name: cmd.name, ...phrases })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  read: readNamed('link_type'),
};

// --- Releases and areas -----------------------------------------------------------------------

/** A release or area of a track by name, or null; a track the run would create has none. */
async function inTrack(
  ctx: LoadContext,
  table: 'release' | 'area',
  track: number,
  name: string,
): Promise<number | null> {
  if (track === PENDING) return null;
  const row = await ctx.trx
    .selectFrom(table)
    .select('id')
    .where('track_id', '=', track)
    .where(sql<string>`lower(name)`, '=', lower(name))
    .executeTakeFirst();
  return row?.id ?? null;
}

const trackPrint = (track: number | null, name: string): JsonValue => ({
  track: real(track),
  name: lower(name),
});

const readInTrack =
  (table: 'release' | 'area') => async (db: Db, ws: number, ids: readonly number[]) => {
    const rows = await db
      .selectFrom(table)
      .select(['id', 'track_id', 'name'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(rows.map((r) => [r.id, trackPrint(r.track_id, r.name)]));
  };

export const releases: Loader<ReleaseCommand> = {
  table: { name: 'release', id: 'id' },
  async plan(ctx, cmd, existing) {
    const track = required(ctx, cmd.track, 'track');
    const fingerprint = trackPrint(track, cmd.name);
    if (existing !== null) {
      await existingTarget(ctx, 'release', existing);
      return { action: 'update', targetId: existing, fingerprint, data: track };
    }
    const found = await inTrack(ctx, 'release', track, cmd.name);
    if (found !== null) return { action: 'link', targetId: found, fingerprint, data: track };
    return { action: 'create', targetId: null, fingerprint, data: track };
  },
  async apply(ctx, cmd, plan) {
    if (plan.action === 'link') return plan.targetId as number;
    const values = {
      name: cmd.name,
      description: cmd.description,
      start_date: cmd.startDate,
      release_date: cmd.releaseDate,
      shipped_at: cmd.shippedAt,
      archived_at: cmd.archivedAt,
    };
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('release')
        .set({ ...values, updated_at: new Date() })
        .where('id', '=', plan.targetId as number)
        .execute();
      return plan.targetId as number;
    }
    const track = plan.data as number;
    const row = await ctx.trx
      .insertInto('release')
      .values({
        workspace_id: ctx.workspaceId,
        track_id: track,
        ...values,
        // In the source's order, after the track's own.
        sort_order: sql<number>`(SELECT coalesce(max(sort_order), 0) + 1 FROM release
          WHERE track_id = ${track})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  read: readInTrack('release'),
};

export const areas: Loader<AreaCommand> = {
  table: { name: 'area', id: 'id' },
  async plan(ctx, cmd, existing) {
    const track = required(ctx, cmd.track, 'track');
    const owner = optional(ctx, cmd.owner, 'owner');
    const ownerTeam =
      cmd.ownerTeam === undefined ? undefined : optional(ctx, cmd.ownerTeam, 'ownerTeam');
    const fingerprint = trackPrint(track, cmd.name);
    const data = { track, owner, ownerTeam };
    if (existing !== null) {
      await existingTarget(ctx, 'area', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    const found = await inTrack(ctx, 'area', track, cmd.name);
    if (found !== null) return { action: 'link', targetId: found, fingerprint, data };
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    if (plan.action === 'link') return plan.targetId as number;
    const { track, owner, ownerTeam } = plan.data as {
      track: number;
      owner: number | null;
      ownerTeam?: number | null;
    };
    const values = {
      name: cmd.name,
      description: cmd.description,
      owner_id: owner,
      ...(ownerTeam !== undefined ? { owner_team_id: ownerTeam } : {}),
      default_assignee: cmd.defaultAssignee,
      archived_at: cmd.archivedAt,
    };
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('area')
        .set({ ...values, updated_at: new Date() })
        .where('id', '=', plan.targetId as number)
        .execute();
      return plan.targetId as number;
    }
    const row = await ctx.trx
      .insertInto('area')
      .values({ workspace_id: ctx.workspaceId, track_id: track, ...values })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  read: readInTrack('area'),
};

// --- Custom fields ----------------------------------------------------------------------------

/** References inside settings and defaults of a batch, looked up before planning. */
async function preload(ctx: LoadContext, walk: (collect: RefCollector) => void): Promise<void> {
  const fieldsOnly = new RefCollector(() => undefined);
  walk(fieldsOnly);
  await ctx.refs.preload(fieldsOnly.refs);
  const all = new RefCollector((id) => ctx.remap.field(id));
  walk(all);
  await ctx.refs.preload(all.refs);
}

export const fields: Loader<FieldCommand> = {
  table: { name: 'field', id: 'id' },
  async prepare(ctx, cmds) {
    await preload(ctx, (map) => {
      for (const cmd of cmds) remapFieldConfig(cmd.config, map);
    });
  },
  async plan(ctx, cmd, existing) {
    const track = optional(ctx, cmd.track, 'track');
    const config = remapFieldConfig(cmd.config, ctx.remap);
    const fingerprint = {
      name: lower(cmd.name),
      type: cmd.type,
      multiple: cmd.multiple,
      track: real(track),
    };
    const data = { track, config };
    const named = async (name: string) =>
      track === PENDING
        ? undefined
        : ctx.trx
            .selectFrom('field')
            .select(['id', 'type', 'multiple'])
            .where('workspace_id', '=', ctx.workspaceId)
            .where(sql<number>`coalesce(track_id, 0)`, '=', track ?? 0)
            .where(sql<string>`lower(name)`, '=', lower(name))
            .executeTakeFirst();
    if (existing !== null) {
      await existingTarget(ctx, 'field', existing);
      // A field that came in under another name keeps it while the name stays taken.
      const holder = await named(cmd.name);
      const keepName = holder !== undefined && holder.id !== existing;
      return { action: 'update', targetId: existing, fingerprint, data: { ...data, keepName } };
    }
    const found = await named(cmd.name);
    if (found && found.type === cmd.type && found.multiple === cmd.multiple) {
      return { action: 'link', targetId: found.id, fingerprint, data };
    }
    if (found) {
      // The name is taken by a field of another kind, such as the Points every workspace starts
      // with (0095). The source's values still have to arrive, so the field does under a name of
      // its own, and the report says so.
      const name = `${cmd.name} (imported)`;
      const twin = await named(name);
      if (twin && twin.type === cmd.type && twin.multiple === cmd.multiple) {
        return { action: 'link', targetId: twin.id, fingerprint, data };
      }
      if (twin) throw new PlanFailure('field_type_differs');
      ctx.warn({ code: 'field_name_taken', detail: cmd.name });
      return { action: 'create', targetId: null, fingerprint, data: { ...data, name } };
    }
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    if (plan.action === 'link') return plan.targetId as number;
    const { track, config, name, keepName } = plan.data as {
      track: number | null;
      config: Record<string, JsonValue>;
      name?: string;
      keepName?: boolean;
    };
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('field')
        .set({
          ...(keepName ? {} : { name: cmd.name }),
          description: cmd.description,
          config: JSON.stringify(config),
          updated_at: new Date(),
        })
        .where('id', '=', plan.targetId as number)
        .execute();
      return plan.targetId as number;
    }
    const row = await ctx.trx
      .insertInto('field')
      .values({
        workspace_id: ctx.workspaceId,
        track_id: track,
        name: name ?? cmd.name,
        description: cmd.description,
        type: cmd.type,
        multiple: cmd.multiple,
        config: JSON.stringify(config),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('field')
      .select(['id', 'name', 'type', 'multiple', 'track_id'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        { name: lower(r.name), type: r.type, multiple: r.multiple, track: r.track_id },
      ]),
    );
  },
};

interface ContextData {
  field: number;
  defaultValue: JsonValue | null;
  scopes: { track: number | null; type: number | null }[];
}

export const fieldContexts: Loader<FieldContextCommand> = {
  table: { name: 'field_context', id: 'id' },
  async prepare(ctx, cmds) {
    // The fields come first: a default value's references depend on its field's type.
    await ctx.refs.preload(cmds.map((c) => c.field));
    await preload(ctx, (map) => {
      for (const cmd of cmds) {
        const shape = map.field(cmd.field.id);
        if (shape && cmd.defaultValue !== null) remapStored(shape, cmd.defaultValue, map);
      }
    });
  },
  async plan(ctx, cmd, existing) {
    const field = required(ctx, cmd.field, 'field');
    const shape = ctx.remap.field(cmd.field.id);
    const defaultValue =
      cmd.defaultValue === null || shape === undefined
        ? null
        : (remapStored(shape, cmd.defaultValue, ctx.remap, 'defaultValue') ?? null);
    // Options are loaded after their contexts and say themselves whether they are the default.
    if (shape && REFERENCE_OF[shape.type] === 'option' && cmd.defaultValue !== null) {
      throw new PlanFailure('option_default_in_context');
    }
    const scopes = cmd.scopes.map((s) => ({
      track: optional(ctx, s.track, 'scopes.track'),
      type: optional(ctx, s.type, 'scopes.type'),
    }));
    if (scopes.some((s, i) => (s.track === null) !== (cmd.scopes[i]?.track === null))) {
      // A scope whose track or type did not map would widen the context: refused.
      throw new PlanFailure('missing_reference:scopes');
    }
    if (scopes.some((s, i) => (s.type === null) !== (cmd.scopes[i]?.type === null))) {
      throw new PlanFailure('missing_reference:scopes');
    }
    const fingerprint = {
      field: real(field),
      name: lower(cmd.name),
      scopes: scopes
        .map((s) => `${real(s.track) ?? 0}:${real(s.type) ?? 0}`)
        .sort()
        .join(','),
    };
    const data: ContextData = { field, defaultValue, scopes };
    if (existing !== null) {
      await existingTarget(ctx, 'field_context', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    if (field !== PENDING) {
      const found = await ctx.trx
        .selectFrom('field_context')
        .select('id')
        .where('field_id', '=', field)
        .where(sql<string>`lower(name)`, '=', lower(cmd.name))
        .executeTakeFirst();
      if (found) return { action: 'link', targetId: found.id, fingerprint, data };
      // A field linked by name, such as the Points every workspace starts with (migration 0095),
      // may already cover this scope under another context name. Two contexts of a field cannot
      // cover the same pair (CORE-009), so the target's own one stands.
      const pairs = scopes.filter((s) => s.track !== PENDING && s.type !== PENDING);
      if (pairs.length > 0) {
        const covering = await ctx.trx
          .selectFrom('field_context_scope')
          .select('context_id')
          .where('field_id', '=', field)
          .where((eb) =>
            eb.or(
              pairs.map((s) =>
                eb.and([
                  eb(sql<number>`coalesce(track_id, 0)`, '=', s.track ?? 0),
                  eb(sql<number>`coalesce(ticket_type_id, 0)`, '=', s.type ?? 0),
                ]),
              ),
            ),
          )
          .orderBy('context_id')
          .executeTakeFirst();
        if (covering) {
          const held = await fieldContexts.read(ctx.trx, ctx.workspaceId, [covering.context_id]);
          return {
            action: 'link',
            targetId: covering.context_id,
            fingerprint: held.get(covering.context_id) ?? fingerprint,
            data,
          };
        }
      }
    }
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    if (plan.action === 'link') return plan.targetId as number;
    const d = plan.data as ContextData;
    const values = {
      name: cmd.name,
      description: cmd.description,
      default_value: d.defaultValue === null ? null : JSON.stringify(d.defaultValue),
      config: JSON.stringify(cmd.config),
    };
    let id = plan.targetId as number;
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('field_context')
        .set({ ...values, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      await ctx.trx.deleteFrom('field_context_scope').where('context_id', '=', id).execute();
    } else {
      id = (
        await ctx.trx
          .insertInto('field_context')
          .values({ workspace_id: ctx.workspaceId, field_id: d.field, ...values })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    if (d.scopes.length > 0) {
      await ctx.trx
        .insertInto('field_context_scope')
        .values(
          d.scopes.map((s) => ({
            workspace_id: ctx.workspaceId,
            field_id: d.field,
            context_id: id,
            track_id: s.track,
            ticket_type_id: s.type,
          })),
        )
        .execute();
    }
    return id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('field_context as c')
      .select([
        'c.id',
        'c.field_id',
        'c.name',
        sql<string>`coalesce((SELECT string_agg(coalesce(s.track_id, 0) || ':' ||
            coalesce(s.ticket_type_id, 0), ',' ORDER BY coalesce(s.track_id, 0) || ':' ||
            coalesce(s.ticket_type_id, 0)) FROM field_context_scope s WHERE s.context_id = c.id),
          '')`.as('scopes'),
      ])
      .where('c.workspace_id', '=', ws)
      .where('c.id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [r.id, { field: r.field_id, name: lower(r.name), scopes: r.scopes }]),
    );
  },
};

export const fieldOptions: Loader<FieldOptionCommand> = {
  table: { name: 'field_option', id: 'id' },
  async plan(ctx, cmd, existing) {
    const context = required(ctx, cmd.context, 'context');
    const parent = optional(ctx, cmd.parent, 'parent');
    if (cmd.parent !== null && parent === null) throw new PlanFailure('missing_reference:parent');
    const fingerprint = { context: real(context), parent: real(parent), value: lower(cmd.value) };
    const data = { context, parent };
    if (existing !== null) {
      await existingTarget(ctx, 'field_option', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    if (context !== PENDING && parent !== PENDING) {
      const found = await ctx.trx
        .selectFrom('field_option')
        .select('id')
        .where('context_id', '=', context)
        .where(sql<number>`coalesce(parent_id, 0)`, '=', parent ?? 0)
        .where(sql<string>`lower(value)`, '=', lower(cmd.value))
        .executeTakeFirst();
      if (found) return { action: 'link', targetId: found.id, fingerprint, data };
    }
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    if (plan.action === 'link') return plan.targetId as number;
    const { context, parent } = plan.data as { context: number; parent: number | null };
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('field_option')
        .set({
          value: cmd.value,
          sort_order: cmd.sortOrder,
          disabled: cmd.disabled,
          updated_at: new Date(),
        })
        .where('id', '=', plan.targetId as number)
        .execute();
      if (cmd.default) await makeDefault(ctx, context, plan.targetId as number, parent);
      return plan.targetId as number;
    }
    const field = await ctx.trx
      .selectFrom('field_context')
      .select('field_id')
      .where('id', '=', context)
      .executeTakeFirstOrThrow();
    const row = await ctx.trx
      .insertInto('field_option')
      .values({
        workspace_id: ctx.workspaceId,
        field_id: field.field_id,
        context_id: context,
        parent_id: parent,
        value: cmd.value,
        sort_order: cmd.sortOrder,
        disabled: cmd.disabled,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (cmd.default) await makeDefault(ctx, context, row.id, parent);
    return row.id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('field_option')
      .select(['id', 'context_id', 'parent_id', 'value'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        { context: r.context_id, parent: r.parent_id, value: lower(r.value) },
      ]),
    );
  },
};

/**
 * Adds an option to its context's default value: the option for one value, one more of
 * several (in id order, as stored), a cascade's parent or parent and child.
 */
async function makeDefault(
  ctx: LoadContext,
  context: number,
  option: number,
  parent: number | null,
): Promise<void> {
  const row = await ctx.trx
    .selectFrom('field_context as c')
    .innerJoin('field as f', 'f.id', 'c.field_id')
    .select(['c.default_value', 'f.type', 'f.multiple'])
    .where('c.id', '=', context)
    .executeTakeFirstOrThrow();
  let value: JsonValue;
  if (row.type === 'cascading-select') value = parent === null ? [option] : [parent, option];
  else if (row.multiple) {
    const before = Array.isArray(row.default_value) ? (row.default_value as number[]) : [];
    value = [...new Set([...before, option])].sort((a, b) => a - b);
  } else value = option;
  await ctx.trx
    .updateTable('field_context')
    .set({ default_value: JSON.stringify(value) })
    .where('id', '=', context)
    .execute();
}

// --- Workflows --------------------------------------------------------------------------------

export const workflows: Loader<WorkflowCommand> = {
  table: { name: 'workflow', id: 'id' },
  async prepare(ctx, cmds) {
    await preload(ctx, (map) => {
      for (const cmd of cmds) remapDefinition(cmd.definition, map);
    });
  },
  async plan(ctx, cmd, existing) {
    const mapped = remapDefinition(cmd.definition, ctx.remap);
    const parsed = definitionSchema.safeParse(mapped);
    // In a dry run, statuses the run would create have no ids yet: the check waits.
    const pending = JSON.stringify(mapped).includes(String(PENDING));
    if (!pending) {
      if (!parsed.success) throw new PlanFailure('invalid_definition');
      const known = await ctx.trx
        .selectFrom('status')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .execute();
      const problem = definitionProblem(parsed.data, new Set(known.map((k) => k.id)));
      if (problem) throw new PlanFailure(`invalid_definition:${problem.problem}`);
    }
    const fingerprint = { name: lower(cmd.name), default: cmd.isDefault };
    const data = parsed.success ? parsed.data : mapped;
    if (existing !== null) {
      await existingTarget(ctx, 'workflow', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    const found = await ctx.trx
      .selectFrom('workflow')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('owner_track_id', 'is', null)
      .where((eb) =>
        cmd.isDefault
          ? eb('is_default', '=', true)
          : eb(sql<string>`lower(name)`, '=', lower(cmd.name)),
      )
      .executeTakeFirst();
    if (found) return { action: 'link', targetId: found.id, fingerprint, data };
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    // A workflow the target has keeps its versions: an import never publishes over it.
    if (plan.action !== 'create') return plan.targetId as number;
    const row = await ctx.trx
      .insertInto('workflow')
      .values({
        workspace_id: ctx.workspaceId,
        name: cmd.name,
        description: cmd.description,
        owner_track_id: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // One that converts to no transitions at all (a source workflow with only its create action)
    // is published with the free moves a new workflow gets, never as a workflow where no ticket
    // can move (T-246; WF-008 (4); ADR-116). Close reasons load before workflows.
    const definition = await withMovesIfNone(
      ctx.trx,
      ctx.workspaceId,
      row.id,
      plan.data as ReturnType<typeof definitionSchema.parse>,
    );
    await ctx.trx
      .insertInto('workflow_version')
      .values({
        workspace_id: ctx.workspaceId,
        workflow_id: row.id,
        version: 1,
        definition: JSON.stringify(definition),
        created_by: null,
        published_at: new Date(),
        published_by: null,
      })
      .execute();
    await ctx.trx
      .insertInto('workflow_version_status')
      .values(
        [...statusIdsOf(definition)].map((status_id) => ({
          workspace_id: ctx.workspaceId,
          workflow_id: row.id,
          version: 1,
          status_id,
        })),
      )
      .execute();
    return row.id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('workflow')
      .select(['id', 'name', 'is_default'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(rows.map((r) => [r.id, { name: lower(r.name), default: r.is_default }]));
  },
};

interface MapData {
  defaultWorkflow: number;
  entries: { type: number; workflow: number }[];
  tracks: number[];
}

export const workflowMaps: Loader<WorkflowMapCommand> = {
  table: { name: 'workflow_map', id: 'id' },
  async plan(ctx, cmd, existing) {
    const data: MapData = {
      defaultWorkflow: required(ctx, cmd.defaultWorkflow, 'defaultWorkflow'),
      entries: cmd.entries.map((e) => ({
        type: required(ctx, e.type, 'entries.type'),
        workflow: required(ctx, e.workflow, 'entries.workflow'),
      })),
      tracks: cmd.tracks.flatMap((t) => {
        const id = optional(ctx, t, 'tracks');
        return id === null ? [] : [id];
      }),
    };
    const fingerprint = {
      name: lower(cmd.name),
      default: cmd.isDefault,
      defaultWorkflow: real(data.defaultWorkflow),
    };
    if (existing !== null) {
      await existingTarget(ctx, 'workflow_map', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    const found = await ctx.trx
      .selectFrom('workflow_map')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('owner_track_id', 'is', null)
      .where((eb) =>
        cmd.isDefault
          ? eb('is_default', '=', true)
          : eb(sql<string>`lower(name)`, '=', lower(cmd.name)),
      )
      .executeTakeFirst();
    if (found) return { action: 'link', targetId: found.id, fingerprint, data };
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as MapData;
    let id = plan.targetId as number;
    if (plan.action === 'create') {
      id = (
        await ctx.trx
          .insertInto('workflow_map')
          .values({
            workspace_id: ctx.workspaceId,
            name: cmd.name,
            description: cmd.description,
            default_workflow_id: d.defaultWorkflow,
            owner_track_id: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      if (d.entries.length > 0) {
        await ctx.trx
          .insertInto('workflow_map_entry')
          .values(
            d.entries.map((e) => ({
              workspace_id: ctx.workspaceId,
              map_id: id,
              ticket_type_id: e.type,
              workflow_id: e.workflow,
            })),
          )
          .execute();
      }
    }
    // The tracks that use it: an import runs before their tickets, so nothing migrates.
    if (d.tracks.length > 0) {
      await ctx.trx
        .updateTable('track')
        .set({ workflow_map_id: id, updated_at: new Date() })
        .where('id', 'in', d.tracks)
        .execute();
    }
    return id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('workflow_map')
      .select(['id', 'name', 'is_default', 'default_workflow_id'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        { name: lower(r.name), default: r.is_default, defaultWorkflow: r.default_workflow_id },
      ]),
    );
  },
};
