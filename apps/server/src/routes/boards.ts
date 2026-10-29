import type { Database, JsonValue } from '@taskmoor/db';
import { QueryError } from '@taskmoor/query';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import {
  type BoardRecord,
  bindCondition,
  boardScope,
  boardTracks,
  compileBoard,
  editorScope,
  loadBoardData,
  type Scope,
  statusesOfTracks,
} from '../boards/data';
import {
  type BoardFilter,
  type CardRules,
  type Column,
  createBoardBody,
  DEFAULT_BOARD_FILTERS,
  DEFAULT_CARD_RULES,
  DEFAULT_SWIMLANES,
  itemId,
  type Swimlanes,
  sharedStatus,
  updateBoardBody,
  withIds,
} from '../boards/model';
import { diff, emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import { SearchError } from '../search/bind';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { type Caller, callRoute, type TicketRoute } from '../tickets/caller';
import { resolveTicket } from '../tickets/store';
import { searchRefusal } from './search';
import { ticketRoutes } from './tickets';

/**
 * Boards (M1-043; AGL-001 to AGL-006, AGL-013, AGL-014; ADR-049).
 *
 * - `GET /api/v1/boards` lists the boards the person sees (`?trackId=` those of one track);
 *   `POST` creates one, `GET`, `PATCH` and `DELETE /api/v1/boards/:id` read, change and remove
 *   one. A board sits in a track (seen by those who browse it) or with the person who made it
 *   (seen by them and its board admins) until saved searches bring sharing (M1-063). Board
 *   admins, the location track's administrators and site and configuration administrators
 *   change it (AGL-001 (2)).
 * - `GET /api/v1/boards/:id/data?filters=a,b` gives the columns with their counts and WIP
 *   state, the lanes and the cards in rank order, with the given board filters applied
 *   (`boards/data.ts`). Every statement carries the viewer's ticket filter.
 * - `POST /api/v1/boards/:id/moves` moves a card to a column and, with `before` or `after`, to
 *   a place in the rank: it runs the ticket routes themselves (the transition, then the rank),
 *   so every check, event and history row is theirs. Several transitions into the column answer
 *   409 `transition_choice` with the list unless `transitionId` names one (AGL-002 (3)).
 *
 * Board writes emit `board.created`, `board.updated` or `board.deleted` in their transaction;
 * a move emits the events of the ticket routes it runs.
 */
const MAX_INT = 2_147_483_647;
const idParam = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) }).strict();
const listQuery = z
  .object({ trackId: z.coerce.number().int().positive().max(MAX_INT).optional() })
  .strict();
const dataQuery = z
  .object({
    /** Active board filters, by id, comma separated. */
    filters: z.string().max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(50_000).default(5000),
  })
  .strict();
const ticketRef = z.union([z.number().int().positive().max(MAX_INT), z.string().min(1).max(100)]);
const moveBody = z
  .object({
    ticket: ticketRef,
    columnId: itemId,
    transitionId: z.number().int().positive().max(MAX_INT).optional(),
    /** Values for the transition's layout, as the transition route takes them. */
    fields: z.record(z.string().max(100), z.unknown()).optional(),
    before: ticketRef.optional(),
    after: ticketRef.optional(),
    version: z.number().int().positive().optional(),
  })
  .strict()
  .refine((b) => b.before === undefined || b.after === undefined, 'before or after, not both');

export interface BoardRouteOptions {
  timeoutMs?: number;
}

type Db = Kysely<Database> | Transaction<Database>;
type BoardRow = Awaited<ReturnType<ReturnType<typeof boardQuery>['executeTakeFirstOrThrow']>>;

function boardQuery(db: Db, workspaceId: number) {
  return db
    .selectFrom('board as b')
    .leftJoin('track as t', 't.id', 'b.location_track_id')
    .leftJoin('app_user as u', 'u.id', 'b.location_user_id')
    .select([
      'b.id',
      'b.name',
      'b.description',
      'b.kind',
      'b.location_track_id',
      't.key as track_key',
      't.name as track_name',
      't.deleted_at as track_deleted_at',
      'b.location_user_id',
      'u.name as user_name',
      'b.filter_query',
      'b.sub_filter_query',
      'b.columns',
      'b.swimlanes',
      'b.board_filters',
      'b.board_filter_display',
      'b.card_rules',
      'b.version',
      'b.created_at',
      'b.updated_at',
    ])
    .where('b.workspace_id', '=', workspaceId);
}

const record = (row: BoardRow): BoardRecord => ({
  id: row.id,
  name: row.name,
  filterQuery: row.filter_query,
  subFilterQuery: row.sub_filter_query,
  columns: row.columns as unknown as Column[],
  swimlanes: row.swimlanes as unknown as Swimlanes,
  boardFilters: row.board_filters as unknown as BoardFilter[],
  cardRules: row.card_rules as unknown as CardRules,
  locationTrackId: row.location_track_id,
});

/** What the routes compare and report as a board's configuration. */
const settings = (row: BoardRow, admins: number[]) => ({
  name: row.name,
  description: row.description,
  kind: row.kind,
  source: { query: row.filter_query },
  subFilter: row.sub_filter_query === null ? null : { query: row.sub_filter_query },
  columns: row.columns,
  swimlanes: row.swimlanes,
  boardFilters: row.board_filters,
  boardFilterDisplay: row.board_filter_display,
  cardRules: row.card_rules,
  adminIds: admins,
});

const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

const STAGE_NAMES: Record<string, string> = { new: 'New', active: 'Active', closed: 'Closed' };

export function registerBoardRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  authorizer: Authorizer,
  catalogs: FieldCatalogs,
  options: BoardRouteOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const handlers = ticketRoutes(db, authorizer, catalogs);
  const handler = (method: string, url: string) =>
    handlers.find((r) => r.method === method && r.url === url) as TicketRoute;
  const listTransitions = handler('GET', '/api/v1/tickets/:id/transitions');
  const runTransition = handler('POST', '/api/v1/tickets/:id/transitions');
  const rankTicket = handler('PUT', '/api/v1/tickets/:id/rank');

  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  async function adminsOf(boardId: number): Promise<{ id: number; name: string }[]> {
    return db
      .selectFrom('board_admin as a')
      .innerJoin('app_user as u', 'u.id', 'a.user_id')
      .select(['u.id', 'u.name'])
      .where('a.board_id', '=', boardId)
      .orderBy('u.name')
      .orderBy('u.id')
      .execute();
  }

  async function isConfigAdmin(request: FastifyRequest): Promise<boolean> {
    const global = await request.authz.global();
    return global.has('site_admin') || global.has('configuration_admin');
  }

  /** Who sees a board: its track's browsers, or its owner and admins; administrators. */
  async function sees(request: FastifyRequest, row: BoardRow, admins: readonly number[]) {
    const userId = request.user?.id;
    if (userId === undefined) return false;
    if (row.location_track_id !== null) {
      if (row.track_deleted_at !== null) return false;
      const held = await request.authz.track(row.location_track_id);
      if (held.has('browse_track') || held.has('administer_track')) return true;
    } else if (row.location_user_id === userId) {
      return true;
    }
    if (admins.includes(userId)) return true;
    return isConfigAdmin(request);
  }

  /** Who changes a board (AGL-001 (2)). */
  async function mayConfigure(request: FastifyRequest, row: BoardRow, admins: readonly number[]) {
    const userId = request.user?.id;
    if (userId === undefined) return false;
    if (admins.includes(userId)) return true;
    if (row.location_track_id === null && row.location_user_id === userId) return true;
    if (row.location_track_id !== null) {
      const held = await request.authz.track(row.location_track_id);
      if (held.has('administer_track')) return true;
    }
    return isConfigAdmin(request);
  }

  function view(row: BoardRow, admins: { id: number; name: string }[], configure: boolean) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      kind: row.kind,
      location:
        row.location_track_id !== null
          ? {
              type: 'track' as const,
              track: { id: row.location_track_id, key: row.track_key, name: row.track_name },
            }
          : {
              type: 'user' as const,
              user: { id: row.location_user_id, name: row.user_name },
            },
      source: { query: row.filter_query },
      subFilter: row.sub_filter_query === null ? null : { query: row.sub_filter_query },
      columns: row.columns,
      swimlanes: row.swimlanes,
      boardFilters: row.board_filters,
      boardFilterDisplay: row.board_filter_display,
      cardRules: row.card_rules,
      admins,
      version: row.version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      mayConfigure: configure,
    };
  }

  /** A board the caller sees, with its admins; answers 404 otherwise. */
  async function visibleBoard(request: FastifyRequest, reply: FastifyReply, id: number) {
    const row = await boardQuery(db, request.workspaceId).where('b.id', '=', id).executeTakeFirst();
    if (!row) {
      await notFound(reply);
      return null;
    }
    const admins = await adminsOf(row.id);
    if (
      !(await sees(
        request,
        row,
        admins.map((a) => a.id),
      ))
    ) {
      await notFound(reply);
      return null;
    }
    return { row, admins };
  }

  /**
   * Checks the parts of a configuration a create or update gives: queries readable by the
   * editor, statuses of the workspace in one column at most, ids unique, people that exist.
   * Returns the field problems, and the configuration with ids given.
   */
  async function checkConfiguration(
    request: FastifyRequest,
    body: z.infer<typeof updateBoardBody>,
  ): Promise<{
    fields: Record<string, string>;
    columns?: Column[];
    swimlanes?: Swimlanes;
    boardFilters?: BoardFilter[];
    cardRules?: CardRules;
  }> {
    const fields: Record<string, string> = {};
    const scope = await editorScope(db, catalogs, request);
    const now = new Date();
    const checkQuery = async (path: string, text: string) => {
      try {
        await bindCondition(db, scope, text, now);
      } catch (error) {
        if (error instanceof QueryError) fields[path] = 'invalid_query';
        else if (error instanceof SearchError) fields[path] = 'invalid_query';
        else throw error;
      }
    };
    if (body.source) await checkQuery('source.query', body.source.query);
    if (body.subFilter) await checkQuery('subFilter.query', body.subFilter.query);
    const out: Awaited<ReturnType<typeof checkConfiguration>> = { fields };
    if (body.columns) {
      const columns = withIds(body.columns, 'c');
      if (!columns) fields.columns = 'duplicate_id';
      else if (sharedStatus(columns) !== null) fields.columns = 'status_in_two_columns';
      else {
        const statusIds = [...new Set(columns.flatMap((c) => c.statusIds))];
        if (statusIds.length > 0) {
          const found = await db
            .selectFrom('status')
            .select('id')
            .where('workspace_id', '=', request.workspaceId)
            .where('id', 'in', statusIds)
            .execute();
          if (found.length !== statusIds.length) fields.columns = 'unknown_status';
        }
        out.columns = columns.map((c) => ({
          id: c.id,
          name: c.name,
          statusIds: c.statusIds,
          min: c.min,
          max: c.max,
        }));
      }
    }
    if (body.swimlanes) {
      const lanes = withIds(body.swimlanes.lanes, 'l');
      if (!lanes || lanes.some((l) => l.id === 'other')) fields['swimlanes.lanes'] = 'duplicate_id';
      else {
        for (const [i, lane] of lanes.entries()) {
          await checkQuery(`swimlanes.lanes.${i}.query`, lane.query);
        }
        out.swimlanes = { ...body.swimlanes, lanes };
      }
    }
    if (body.boardFilters) {
      const filters = withIds(body.boardFilters, 'f');
      if (!filters) fields.boardFilters = 'duplicate_id';
      else {
        for (const [i, f] of filters.entries()) {
          await checkQuery(`boardFilters.${i}.query`, f.query);
        }
        out.boardFilters = filters;
      }
    }
    if (body.cardRules) {
      const colours = withIds(body.cardRules.colours, 'r');
      if (!colours) fields['cardRules.colours'] = 'duplicate_id';
      else {
        for (const [i, rule] of colours.entries()) {
          await checkQuery(`cardRules.colours.${i}.query`, rule.query);
        }
        out.cardRules = { ...body.cardRules, colours };
      }
    }
    if (body.adminIds && body.adminIds.length > 0) {
      const people = await db
        .selectFrom('app_user')
        .select('id')
        .where('workspace_id', '=', request.workspaceId)
        .where('id', 'in', body.adminIds)
        .execute();
      if (people.length !== new Set(body.adminIds).size) fields.adminIds = 'not_found';
    }
    return out;
  }

  /** Default columns: one per status stage of the board's workflows, in stage order. */
  async function defaultColumns(
    scope: Scope,
    filterQuery: string,
    trackId: number | null,
  ): Promise<Column[]> {
    const compiled = await compileBoard(
      db,
      scope,
      {
        id: 0,
        name: '',
        filterQuery,
        subFilterQuery: null,
        columns: [],
        swimlanes: DEFAULT_SWIMLANES,
        boardFilters: [],
        cardRules: { ...DEFAULT_CARD_RULES, daysInColumn: false },
        locationTrackId: trackId,
      },
      [],
      new Date(),
    );
    const tracks = await boardTracks(db, compiled, trackId, timeoutMs);
    const statuses = await statusesOfTracks(db, scope.ws, tracks);
    const columns: Column[] = [];
    for (const stage of ['new', 'active', 'closed']) {
      const ids = statuses.filter((s) => s.stage === stage).map((s) => s.id);
      columns.push({
        id: `c${columns.length + 1}`,
        name: STAGE_NAMES[stage] as string,
        statusIds: ids,
        min: null,
        max: null,
      });
    }
    return columns;
  }

  app.get('/api/v1/boards', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    let query = boardQuery(db, request.workspaceId);
    if (parsed.data.trackId !== undefined) {
      query = query.where('b.location_track_id', '=', parsed.data.trackId);
    }
    const rows = await query
      .orderBy(({ fn }) => fn('lower', ['b.name']))
      .orderBy('b.id')
      .execute();
    const admins =
      rows.length === 0
        ? []
        : await db
            .selectFrom('board_admin')
            .select(['board_id', 'user_id'])
            .where(
              'board_id',
              'in',
              rows.map((r) => r.id),
            )
            .execute();
    const boards = [];
    for (const row of rows) {
      const ids = admins.filter((a) => a.board_id === row.id).map((a) => a.user_id);
      if (!(await sees(request, row, ids))) continue;
      boards.push({
        id: row.id,
        name: row.name,
        description: row.description,
        kind: row.kind,
        location:
          row.location_track_id !== null
            ? {
                type: 'track' as const,
                track: { id: row.location_track_id, key: row.track_key, name: row.track_name },
              }
            : { type: 'user' as const, user: { id: row.location_user_id, name: row.user_name } },
      });
    }
    return { boards };
  });

  app.post('/api/v1/boards', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = createBoardBody.safeParse(request.body);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    const trackId = body.trackId ?? null;
    if (trackId !== null) {
      const track = await db
        .selectFrom('track')
        .select(['id', 'archived_at'])
        .where('id', '=', trackId)
        .where('workspace_id', '=', ws)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!track) return invalidFields(reply, { trackId: 'not_found' });
      const held = await request.authz.track(trackId);
      const browses = held.has('browse_track') || held.has('administer_track');
      if (!browses && !(await isConfigAdmin(request))) {
        return invalidFields(reply, { trackId: 'not_found' });
      }
      if (track.archived_at) return reply.code(409).send({ error: 'track_archived' });
    }
    const checked = await checkConfiguration(request, body);
    if (Object.keys(checked.fields).length > 0) return invalidFields(reply, checked.fields);
    const scope = await boardScope(db, catalogs, request);
    const columns = checked.columns ?? (await defaultColumns(scope, body.source.query, trackId));
    const swimlanes = checked.swimlanes ?? DEFAULT_SWIMLANES;
    const boardFilters = checked.boardFilters ?? DEFAULT_BOARD_FILTERS;
    const cardRules = checked.cardRules ?? DEFAULT_CARD_RULES;
    const adminIds = [...new Set([user.id, ...(body.adminIds ?? [])])];
    const created = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('board')
        .values({
          workspace_id: ws,
          name: body.name,
          description: body.description ?? '',
          kind: body.kind,
          location_track_id: trackId,
          location_user_id: trackId === null ? user.id : null,
          filter_query: body.source.query,
          sub_filter_query: body.subFilter?.query ?? null,
          columns: JSON.stringify(columns),
          swimlanes: JSON.stringify(swimlanes),
          board_filters: JSON.stringify(boardFilters),
          ...(body.boardFilterDisplay ? { board_filter_display: body.boardFilterDisplay } : {}),
          card_rules: JSON.stringify(cardRules),
          created_by: user.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('board_admin')
        .values(adminIds.map((userId) => ({ workspace_id: ws, board_id: row.id, user_id: userId })))
        .execute();
      await emit(trx, by(request), {
        type: 'board.created',
        subjectId: row.id,
        payload: { name: body.name, kind: body.kind, trackId, query: body.source.query },
      });
      return row.id;
    });
    const row = await boardQuery(db, ws).where('b.id', '=', created).executeTakeFirstOrThrow();
    return reply.code(201).send({ board: view(row, await adminsOf(created), true) });
  });

  app.get('/api/v1/boards/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const found = await visibleBoard(request, reply, p.data.id);
    if (!found) return reply;
    const { row, admins } = found;
    const configure = await mayConfigure(
      request,
      row,
      admins.map((a) => a.id),
    );
    // The statuses a column may take: those of the board's tracks' workflows, every type.
    const scope = await boardScope(db, catalogs, request);
    let statuses: Awaited<ReturnType<typeof statusesOfTracks>> = [];
    try {
      const compiled = await compileBoard(db, scope, record(row), [], new Date());
      statuses = await statusesOfTracks(
        db,
        request.workspaceId,
        await boardTracks(db, compiled, row.location_track_id, timeoutMs),
      );
    } catch (error) {
      if (!(error instanceof QueryError || error instanceof SearchError)) throw error;
    }
    const columnOf = new Map<number, string>();
    for (const c of row.columns as unknown as Column[]) {
      for (const s of c.statusIds) columnOf.set(s, c.id);
    }
    return {
      board: view(row, admins, configure),
      statuses: statuses.map((s) => ({
        id: s.id,
        name: s.name,
        stage: s.stage,
        columnId: columnOf.get(s.id) ?? null,
      })),
    };
  });

  app.patch('/api/v1/boards/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const parsed = updateBoardBody.safeParse(request.body);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const found = await visibleBoard(request, reply, p.data.id);
    if (!found) return reply;
    const adminIdsBefore = found.admins.map((a) => a.id);
    if (!(await mayConfigure(request, found.row, adminIdsBefore))) {
      return reply.code(403).send({ error: 'forbidden', permission: 'configure_board' });
    }
    const checked = await checkConfiguration(request, body);
    if (Object.keys(checked.fields).length > 0) return invalidFields(reply, checked.fields);
    const outcome = await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('board')
        .select('version')
        .where('id', '=', p.data.id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return { missing: true as const };
      if (body.version !== undefined && body.version !== current.version) {
        return { conflict: current.version };
      }
      const before = settings(found.row, adminIdsBefore);
      const after = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.source !== undefined ? { source: body.source } : {}),
        ...(body.subFilter !== undefined ? { subFilter: body.subFilter } : {}),
        ...(checked.columns ? { columns: checked.columns as unknown as JsonValue } : {}),
        ...(checked.swimlanes ? { swimlanes: checked.swimlanes as unknown as JsonValue } : {}),
        ...(checked.boardFilters
          ? { boardFilters: checked.boardFilters as unknown as JsonValue }
          : {}),
        ...(body.boardFilterDisplay !== undefined
          ? { boardFilterDisplay: body.boardFilterDisplay }
          : {}),
        ...(checked.cardRules ? { cardRules: checked.cardRules as unknown as JsonValue } : {}),
        ...(body.adminIds !== undefined
          ? { adminIds: [...new Set(body.adminIds)].sort((a, b) => a - b) }
          : {}),
      };
      const changes = diff(
        { ...before, adminIds: [...adminIdsBefore].sort((a, b) => a - b) } as Record<
          string,
          unknown
        >,
        after,
      );
      if (Object.keys(changes).length === 0) return { unchanged: true as const };
      await trx
        .updateTable('board')
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.kind !== undefined ? { kind: body.kind } : {}),
          ...(body.source !== undefined ? { filter_query: body.source.query } : {}),
          ...(body.subFilter !== undefined
            ? { sub_filter_query: body.subFilter?.query ?? null }
            : {}),
          ...(checked.columns ? { columns: JSON.stringify(checked.columns) } : {}),
          ...(checked.swimlanes ? { swimlanes: JSON.stringify(checked.swimlanes) } : {}),
          ...(checked.boardFilters ? { board_filters: JSON.stringify(checked.boardFilters) } : {}),
          ...(body.boardFilterDisplay !== undefined
            ? { board_filter_display: body.boardFilterDisplay }
            : {}),
          ...(checked.cardRules ? { card_rules: JSON.stringify(checked.cardRules) } : {}),
          version: current.version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', p.data.id)
        .execute();
      if (body.adminIds !== undefined) {
        await trx.deleteFrom('board_admin').where('board_id', '=', p.data.id).execute();
        const ids = [...new Set(body.adminIds)];
        if (ids.length > 0) {
          await trx
            .insertInto('board_admin')
            .values(
              ids.map((userId) => ({
                workspace_id: request.workspaceId,
                board_id: p.data.id,
                user_id: userId,
              })),
            )
            .execute();
        }
      }
      await emit(trx, by(request), {
        type: 'board.updated',
        subjectId: p.data.id,
        payload: { changes },
      });
      return { updated: true as const };
    });
    if ('missing' in outcome) return notFound(reply);
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: 'version_conflict', version: outcome.conflict });
    }
    const row = await boardQuery(db, request.workspaceId)
      .where('b.id', '=', p.data.id)
      .executeTakeFirstOrThrow();
    const admins = await adminsOf(row.id);
    return {
      board: view(
        row,
        admins,
        await mayConfigure(
          request,
          row,
          admins.map((a) => a.id),
        ),
      ),
    };
  });

  app.delete('/api/v1/boards/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const found = await visibleBoard(request, reply, p.data.id);
    if (!found) return reply;
    if (
      !(await mayConfigure(
        request,
        found.row,
        found.admins.map((a) => a.id),
      ))
    ) {
      return reply.code(403).send({ error: 'forbidden', permission: 'configure_board' });
    }
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('board').where('id', '=', p.data.id).execute();
      await emit(trx, by(request), {
        type: 'board.deleted',
        subjectId: p.data.id,
        payload: { name: found.row.name },
      });
    });
    return reply.code(204).send();
  });

  app.get('/api/v1/boards/:id/data', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const parsed = dataQuery.safeParse(request.query);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const found = await visibleBoard(request, reply, p.data.id);
    if (!found) return reply;
    const board = record(found.row);
    const wanted = (parsed.data.filters ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f !== '');
    const active: BoardFilter[] = [];
    for (const id of new Set(wanted)) {
      const filter = board.boardFilters.find((f) => f.id === id);
      if (!filter) return invalidFields(reply, { filters: 'not_found' });
      active.push(filter);
    }
    const scope = await boardScope(db, catalogs, request);
    try {
      const data = await loadBoardData({
        db,
        request,
        catalogs,
        scope,
        board,
        active,
        limit: parsed.data.limit,
        timeoutMs,
      });
      return {
        board: { id: board.id, name: board.name, version: found.row.version },
        activeFilters: active.map((f) => f.id),
        ...data,
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.post('/api/v1/boards/:id/moves', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const parsed = moveBody.safeParse(request.body);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const found = await visibleBoard(request, reply, p.data.id);
    if (!found) return reply;
    const board = record(found.row);
    const column = board.columns.find((c) => c.id === body.columnId);
    if (!column) return invalidFields(reply, { columnId: 'not_found' });
    const ws = request.workspaceId;
    const ticket = await resolveTicket(db, ws, body.ticket);
    if (!ticket) return invalidFields(reply, { ticket: 'not_found' });
    // The card must be on the board for this viewer: the board's tickets, in a mapped status.
    const scope = await boardScope(db, catalogs, request);
    let onBoard: { status_id: number } | undefined;
    try {
      const compiled = await compileBoard(db, scope, board, [], new Date());
      onBoard = await readOnly(db, timeoutMs, async (trx) =>
        trx
          .selectFrom('ticket as k')
          .select('k.status_id')
          .where('k.id', '=', ticket.id)
          .where(compiled.scope)
          .executeTakeFirst(),
      );
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
    const mapped = new Set(board.columns.flatMap((c) => c.statusIds));
    if (!onBoard || !mapped.has(onBoard.status_id)) {
      return invalidFields(reply, { ticket: 'not_on_board' });
    }
    const caller = (params: unknown, payload: unknown, query: unknown = {}): Caller => ({
      workspaceId: request.workspaceId,
      user: request.user,
      authz: request.authz,
      apiToken: request.apiToken,
      params,
      query,
      body: payload,
    });
    let transitioned = false;
    let last: unknown;
    if (!column.statusIds.includes(onBoard.status_id)) {
      const offered = await callRoute(listTransitions, caller({ id: String(ticket.id) }, null));
      if (offered.statusCode !== 200) {
        return reply.code(offered.statusCode).send(offered.payload);
      }
      const candidates = (
        (offered.payload as { transitions: { id: number; name: string; to: { id: number } }[] })
          .transitions ?? []
      ).filter((t) => column.statusIds.includes(t.to.id));
      let chosen: number;
      if (body.transitionId !== undefined) {
        if (!candidates.some((t) => t.id === body.transitionId)) {
          return reply.code(409).send({
            error: 'transition_not_offered',
            transitions: candidates,
          });
        }
        chosen = body.transitionId;
      } else if (candidates.length === 1) {
        chosen = (candidates[0] as { id: number }).id;
      } else if (candidates.length === 0) {
        return reply.code(409).send({ error: 'no_transition', columnId: column.id });
      } else {
        return reply.code(409).send({ error: 'transition_choice', transitions: candidates });
      }
      const ran = await callRoute(
        runTransition,
        caller(
          { id: String(ticket.id) },
          {
            transitionId: chosen,
            ...(body.fields ? { fields: body.fields } : {}),
            ...(body.version !== undefined ? { version: body.version } : {}),
          },
        ),
      );
      if (ran.statusCode !== 200) return reply.code(ran.statusCode).send(ran.payload);
      transitioned = true;
      last = ran.payload;
    }
    let ranked = false;
    const anchor = body.before ?? body.after;
    if (anchor !== undefined) {
      const ran = await callRoute(
        rankTicket,
        caller(
          { id: String(ticket.id) },
          body.before !== undefined ? { before: body.before } : { after: body.after },
        ),
      );
      if (ran.statusCode !== 200) {
        return reply
          .code(ran.statusCode)
          .send({ ...(ran.payload as Record<string, unknown>), transitioned });
      }
      ranked = true;
      last = ran.payload;
    }
    if (last === undefined) {
      const read = handler('GET', '/api/v1/tickets/:id');
      last = (await callRoute(read, caller({ id: String(ticket.id) }, null))).payload;
    }
    return {
      ticket: (last as { ticket?: unknown }).ticket ?? null,
      transitioned,
      ranked,
    };
  });
}
