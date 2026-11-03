import type { JsonValue } from '@taskmoor/db';
import { parseQuery, printQuery, QueryError } from '@taskmoor/query';
import { sql } from 'kysely';
import { bindCondition, type Scope } from '../boards/data';
import {
  type BoardFilter,
  type Column,
  DEFAULT_BOARD_FILTERS,
  DEFAULT_CARD_RULES,
  DEFAULT_SWIMLANES,
} from '../boards/model';
import { SearchError } from '../search/bind';
import { queryCatalogue } from '../search/catalogue';
import { DEFAULT_SPRINT_SETTINGS } from '../sprints/model';
import {
  existingTarget,
  type LoadContext,
  type Loader,
  lower,
  PENDING,
  type Plan,
  PlanFailure,
  real,
  required,
} from './load';
import type { BoardCommand, Ref, SprintCommand } from './model';

/**
 * Boards and sprints (M1-095; IMP-002; ADR-094). They are written with SQL like the other
 * loaders, keeping what the source says: a sprint's state and dates as they were, a closed
 * sprint's tickets in its history. Board settings the source does not carry take the defaults
 * a new board gets (swimlanes, quick filters, card rules, sprint settings).
 *
 * A track has one board (ADR-116). A source may hold several: the first one a track meets is its
 * board, and any other links to it, so its sprints stay on the track, with its query kept as a
 * saved search of the track's owner and a warning naming it. A track with no owner has nobody to
 * keep the query for: the warning says so and nothing is made up. Linking, not updating, is what
 * keeps a later run from writing the other board's name and columns over the track's.
 */

interface BoardData {
  track: number;
  query: string;
  columns: Column[];
  /** Given by the command (M1-093): written on create and update. */
  subQuery?: string | null;
  boardFilters?: BoardFilter[];
  /** The track already has a board: who owns the saved search this one's query becomes. */
  savedSearchOwner?: number;
}

/** What a dry run has planned as a track's board, per batch: nothing is written to read back. */
const plannedBoards = new WeakMap<LoadContext, Map<string, string>>();

/** Whether an earlier run linked this record to a board that is another's (see the header). */
async function linkedToAnotherBoard(
  ctx: LoadContext,
  board: number,
  sourceId: string,
  name: string,
): Promise<boolean> {
  const own = await ctx.trx
    .selectFrom('board')
    .select('name')
    .where('id', '=', board)
    .executeTakeFirst();
  if (own === undefined || lower(own.name) === lower(name)) return false;
  const first = await ctx.trx
    .selectFrom('import_external_id as e')
    .innerJoin('import_record as r', (join) =>
      join
        .onRef('r.run_id', '=', 'e.first_run_id')
        .onRef('r.entity_kind', '=', 'e.entity_kind')
        .onRef('r.source_id', '=', 'e.source_id'),
    )
    .select('r.outcome')
    .where('e.workspace_id', '=', ctx.workspaceId)
    .where('e.import_source', '=', ctx.importSource)
    .where('e.source_system', '=', ctx.system)
    .where('e.entity_kind', '=', 'board')
    .where('e.source_id', '=', sourceId)
    .executeTakeFirst();
  return first?.outcome === 'linked';
}

/** The plan of a board whose track has one already; `board` is PENDING in a dry run. */
async function linkToTrackBoard(
  ctx: LoadContext,
  cmd: BoardCommand,
  data: BoardData,
  board: number,
  fingerprint: JsonValue,
): Promise<Plan> {
  const owner =
    data.track === PENDING
      ? undefined
      : (
          await ctx.trx
            .selectFrom('track')
            .select('owner_id')
            .where('id', '=', data.track)
            .executeTakeFirst()
        )?.owner_id;
  ctx.warn({
    code: owner === null ? 'board_not_kept_no_owner' : 'board_became_saved_search',
    detail: cmd.name,
  });
  const read =
    board === PENDING
      ? new Map<number, JsonValue>()
      : await boards.read(ctx.trx, ctx.workspaceId, [board]);
  return {
    action: 'link',
    targetId: board,
    // What the sample finds at the target is the track's board.
    fingerprint: read.get(board) ?? fingerprint,
    data: { ...data, ...(owner == null ? {} : { savedSearchOwner: owner }) },
  };
}

/** Keeps a board's query as a saved search, under a name its owner does not have yet. */
async function saveBoardQuery(ctx: LoadContext, cmd: BoardCommand, query: string, owner: number) {
  const base = cmd.name.slice(0, 240);
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : n === 2 ? `${base} (imported)` : `${base} (imported ${n - 1})`;
    const taken = await ctx.trx
      .selectFrom('saved_search')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('owner_id', '=', owner)
      .where(sql<string>`lower(name)`, '=', lower(name))
      .executeTakeFirst();
    if (taken) continue;
    if (n > 1) ctx.warn({ code: 'name_taken' });
    await ctx.trx
      .insertInto('saved_search')
      .values({
        workspace_id: ctx.workspaceId,
        owner_id: owner,
        name,
        description: cmd.description,
        query,
      })
      .execute();
    return;
  }
  throw new PlanFailure('name_taken');
}

/**
 * A query with the backup's custom field ids (`cf[<source id>]`) in the target's (M1-093);
 * null when a field it names did not import. A dry run keeps the source ids.
 */
function withTargetFields(ctx: LoadContext, text: string, fields: readonly Ref[]): string | null {
  if (fields.length === 0) return text;
  const query = parseQuery(text);
  let missing = false;
  const map = (custom: number): number => {
    const target = ctx.refs.get({ kind: 'field', id: String(custom) });
    if (target === null) missing = true;
    return target === null || target === PENDING ? custom : target;
  };
  const visit = (e: NonNullable<typeof query.where>): typeof e => {
    switch (e.kind) {
      case 'and':
      case 'or':
        return { ...e, items: e.items.map(visit) };
      case 'not':
        return { ...e, expr: visit(e.expr) };
      default:
        return e.field.custom === undefined
          ? e
          : { ...e, field: { ...e.field, custom: map(e.field.custom) } };
    }
  };
  const out = printQuery({ where: query.where && visit(query.where), orderBy: [] });
  return missing ? null : out;
}

/**
 * Why a query does not resolve against the target as a board would read it, with no viewer
 * (M1-093): a field, function or value it names; null when it does. A dry run only parses it,
 * since what it names may not exist yet.
 */
async function unresolved(ctx: LoadContext, text: string): Promise<string | null> {
  try {
    if (ctx.dryRun) {
      parseQuery(text);
      return null;
    }
    let scope = scopes.get(ctx);
    if (!scope) {
      scope = {
        ws: ctx.workspaceId,
        filter: { sql: sql<boolean>`true`, tracks: 'all' },
        catalog: ctx.catalog,
        catalogue: await queryCatalogue(ctx.trx, ctx.workspaceId, ctx.catalog, 'all'),
        userId: null,
        person: {
          // Nobody has id 0: queries about the viewer resolve, and find no one (M1-093).
          currentUserId: 0,
          timeZone: null,
          sessionId: null,
          allowedTracks: async () => 'all' as const,
        },
      };
      scopes.set(ctx, scope);
    }
    await bindCondition(ctx.trx, scope, text, new Date(ctx.now));
    return null;
  } catch (error) {
    if (error instanceof QueryError) return error.detail.slice(0, 160);
    if (error instanceof SearchError) return error.message.slice(0, 160);
    throw error;
  }
}
/** The batch's scope for checking queries, kept per batch (tracks made in it included). */
const scopes = new WeakMap<LoadContext, Scope>();

export const boards: Loader<BoardCommand> = {
  table: { name: 'board', id: 'id' },
  async plan(ctx, cmd, existing, sourceId) {
    const track = required(ctx, cmd.track, 'track');
    const fields = cmd.fields ?? [];
    // Queries a source gives in full (M1-093) are checked against the target.
    const checked = cmd.boardFilters !== undefined;
    let query = cmd.query;
    if (query !== null) {
      let problem: string | null = null;
      try {
        parseQuery(query);
        query = withTargetFields(ctx, query, fields);
        if (query === null) problem = 'field_not_imported';
        else if (checked) problem = await unresolved(ctx, query);
      } catch {
        problem = 'not_parsed';
      }
      if (problem !== null) {
        query = null;
        ctx.warn({ code: 'board_query_not_imported', ...(checked ? { detail: problem } : {}) });
      }
    }
    if (query === null) {
      const key =
        track === PENDING
          ? null
          : (
              await ctx.trx
                .selectFrom('track')
                .select('key')
                .where('id', '=', track)
                .executeTakeFirst()
            )?.key;
      query = `track = ${key ?? 'PENDING'}`;
    }
    const columns: Column[] = cmd.columns.map((c, i) => ({
      id: `c${i + 1}`,
      name: c.name,
      statusIds: c.statuses.flatMap((s) => {
        const id = ctx.refs.get(s);
        if (id === null) ctx.warn({ code: 'missing_reference', detail: 'columns.statuses' });
        return id === null || id === PENDING ? [] : [id];
      }),
      min: c.min,
      max: c.max,
    }));
    const data: BoardData = { track, query, columns };
    if (cmd.subQuery !== undefined) {
      const sub = cmd.subQuery === null ? null : withTargetFields(ctx, cmd.subQuery, fields);
      const problem =
        cmd.subQuery === null
          ? null
          : sub === null
            ? 'field_not_imported'
            : await unresolved(ctx, sub);
      if (problem !== null) ctx.warn({ code: 'board_sub_query_not_imported', detail: problem });
      data.subQuery = problem === null ? sub : null;
    }
    if (cmd.boardFilters !== undefined) {
      data.boardFilters = [];
      for (const f of cmd.boardFilters) {
        // IMP-006 (2): the filter is named with what it uses that does not translate.
        const text = withTargetFields(ctx, f.query, fields);
        const problem = text === null ? 'field_not_imported' : await unresolved(ctx, text);
        if (text === null || problem !== null) {
          ctx.warn({ code: 'board_filter_not_imported', detail: `${f.name}: ${problem}` });
          continue;
        }
        data.boardFilters.push({
          id: `f${data.boardFilters.length + 1}`,
          name: f.name,
          query: text,
          description: f.description,
        });
      }
    }
    const fingerprint = {
      name: cmd.name,
      kind: cmd.boardKind,
      track: real(track),
      columns: columns.map((c) => ({ name: c.name, statusIds: c.statusIds })),
    };
    if (existing !== null) {
      await existingTarget(ctx, 'board', existing);
      if (await linkedToAnotherBoard(ctx, existing, sourceId, cmd.name)) {
        return linkToTrackBoard(ctx, cmd, data, existing, fingerprint);
      }
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    if (track !== PENDING) {
      const found = await ctx.trx
        .selectFrom('board')
        .select(['id', 'name'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('location_track_id', '=', track)
        .executeTakeFirst();
      if (found) {
        return lower(found.name) === lower(cmd.name)
          ? { action: 'link', targetId: found.id, fingerprint, data }
          : linkToTrackBoard(ctx, cmd, data, found.id, fingerprint);
      }
    }
    if (ctx.dryRun) {
      const planned = plannedBoards.get(ctx) ?? new Map<string, string>();
      plannedBoards.set(ctx, planned);
      const first = planned.get(cmd.track.id);
      if (first === undefined) planned.set(cmd.track.id, cmd.name);
      else if (lower(first) === lower(cmd.name)) {
        return { action: 'link', targetId: PENDING, fingerprint, data };
      } else return linkToTrackBoard(ctx, cmd, data, PENDING, fingerprint);
    }
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as BoardData;
    if (plan.action === 'link') {
      if (d.savedSearchOwner !== undefined) {
        await saveBoardQuery(ctx, cmd, d.query, d.savedSearchOwner);
      }
      return plan.targetId as number;
    }
    if (plan.action === 'update') {
      const id = plan.targetId as number;
      await ctx.trx
        .updateTable('board')
        .set({
          name: cmd.name,
          description: cmd.description,
          columns: JSON.stringify(d.columns),
          ...(d.boardFilters !== undefined
            ? {
                filter_query: d.query,
                saved_search_id: null,
                sub_filter_query: d.subQuery ?? null,
                board_filters: JSON.stringify(d.boardFilters),
              }
            : {}),
          updated_at: new Date(),
          version: sql`version + 1`,
        })
        .where('id', '=', id)
        .execute();
      return id;
    }
    const row = await ctx.trx
      .insertInto('board')
      .values({
        workspace_id: ctx.workspaceId,
        name: cmd.name,
        description: cmd.description,
        kind: cmd.boardKind,
        location_track_id: d.track,
        location_user_id: null,
        filter_query: d.query,
        sub_filter_query: d.subQuery ?? null,
        columns: JSON.stringify(d.columns),
        swimlanes: JSON.stringify(DEFAULT_SWIMLANES),
        board_filters: JSON.stringify(d.boardFilters ?? DEFAULT_BOARD_FILTERS),
        card_rules: JSON.stringify(DEFAULT_CARD_RULES),
        sprint_settings: JSON.stringify(DEFAULT_SPRINT_SETTINGS),
        created_by: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('board')
      .select(['id', 'name', 'kind', 'location_track_id', 'columns'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        {
          name: r.name,
          kind: r.kind,
          track: r.location_track_id,
          columns: (r.columns as unknown as Column[]).map((c) => ({
            name: c.name,
            statusIds: c.statusIds,
          })),
        },
      ]),
    );
  },
};

interface SprintData {
  board: number;
  tickets: number[];
}

const instant = (v: string | null) => (v === null ? null : new Date(v));

export const sprints: Loader<SprintCommand> = {
  table: { name: 'sprint', id: 'id' },
  async plan(ctx, cmd, existing) {
    const board = required(ctx, cmd.board, 'board');
    const tickets: number[] = [];
    for (const t of cmd.tickets) {
      const id = ctx.refs.get(t);
      if (id === null) ctx.warn({ code: 'missing_reference', detail: 'tickets' });
      else if (id !== PENDING) tickets.push(id);
    }
    const sorted = [...new Set(tickets)].sort((a, b) => a - b);
    const fingerprint = {
      board: real(board),
      name: cmd.name,
      state: cmd.state,
      tickets: sorted,
    };
    const data: SprintData = { board, tickets: sorted };
    if (existing !== null) {
      await existingTarget(ctx, 'sprint', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as SprintData;
    const values = {
      name: cmd.name,
      goal: cmd.goal,
      state: cmd.state,
      start_at: instant(cmd.startAt),
      end_at: instant(cmd.endAt),
      started_at: instant(cmd.startedAt),
      completed_at: instant(cmd.completedAt),
    };
    let id = plan.targetId as number;
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('sprint')
        .set({ ...values, updated_at: new Date(), version: sql`version + 1` })
        .where('id', '=', id)
        .execute();
    } else {
      const top = await ctx.trx
        .selectFrom('sprint')
        .select((eb) => eb.fn.max('sequence').as('top'))
        .where('board_id', '=', d.board)
        .executeTakeFirst();
      id = (
        await ctx.trx
          .insertInto('sprint')
          .values({
            workspace_id: ctx.workspaceId,
            board_id: d.board,
            sequence: Number(top?.top ?? 0) + 1,
            created_by: null,
            ...values,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    if (d.tickets.length === 0) return id;
    const open = cmd.state !== 'closed';
    // A ticket already in another open sprint stays there: one open sprint per ticket.
    const busy = open
      ? new Set(
          (
            await ctx.trx
              .selectFrom('sprint_ticket')
              .select('ticket_id')
              .where('ticket_id', 'in', d.tickets)
              .where('open', '=', true)
              .where('sprint_id', '<>', id)
              .execute()
          ).map((r) => r.ticket_id),
        )
      : new Set<number>();
    if (busy.size > 0) ctx.warn({ code: 'ticket_in_another_open_sprint' });
    const adding = d.tickets.filter((t) => !busy.has(t));
    if (adding.length > 0) {
      await ctx.trx
        .insertInto('sprint_ticket')
        .values(
          adding.map((ticketId) => ({
            workspace_id: ctx.workspaceId,
            sprint_id: id,
            ticket_id: ticketId,
            open,
            added_at: instant(cmd.startedAt ?? cmd.startAt) ?? new Date(),
          })),
        )
        .onConflict((oc) => oc.columns(['sprint_id', 'ticket_id']).doNothing())
        .execute();
    }
    return id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('sprint')
      .select(['id', 'board_id', 'name', 'state'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    const members = await db
      .selectFrom('sprint_ticket')
      .select(['sprint_id', 'ticket_id'])
      .where('sprint_id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        {
          board: r.board_id,
          name: r.name,
          state: r.state,
          tickets: members
            .filter((m) => m.sprint_id === r.id)
            .map((m) => m.ticket_id)
            .sort((a, b) => a - b),
        },
      ]),
    );
  },
};
