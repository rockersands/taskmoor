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
  boardRecord,
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
  sourceQuery,
  updateBoardBody,
  withIds,
} from '../boards/model';
import { diff, emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import { uniqueViolation } from '../scim/store';
import { SearchError } from '../search/bind';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { DEFAULT_SPRINT_SETTINGS, readSprintSettings } from '../sprints/model';
import { findTeam } from '../teams';
import { type Caller, callRoute, type TicketRoute } from '../tickets/caller';
import { resolveTicket } from '../tickets/store';
import {
  type BoardWorkflowChange,
  BoardWorkflowError,
  syncBoardWorkflow,
} from '../workflows/board-managed';
import { registerBacklogPlanningRoutes } from './backlog-planning';
import { registerBoardReportRoutes } from './board-reports';
import { registerScopeReportRoutes } from './scope-reports';
import { searchRefusal } from './search';
import { registerSprintRoutes, type SprintBoard, type SprintRouteDeps } from './sprints';
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
export const listQuery = z
  .object({
    trackId: z.coerce.number().int().positive().max(MAX_INT).optional(),
    /** Only the boards of a team (M1-123). */
    teamId: z.coerce.number().int().positive().max(MAX_INT).optional(),
  })
  .strict();
export const dataQuery = z
  .object({
    /** Active board filters, by id, comma separated. */
    filters: z.string().max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(50_000).default(5000),
    /** Scrum boards: `active` shows the active sprints' tickets, or sprint ids (M1-044). */
    sprints: z
      .string()
      .regex(/^(active|\d{1,10}(,\d{1,10}){0,49})$/)
      .optional(),
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
    .leftJoin('team as tm', 'tm.id', 'b.team_id')
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
      'b.saved_search_id',
      'b.sub_filter_query',
      'b.columns',
      'b.manages_workflow',
      'b.swimlanes',
      'b.board_filters',
      'b.board_filter_display',
      'b.card_rules',
      'b.sprint_settings',
      'b.team_id',
      'tm.name as team_name',
      'b.version',
      'b.created_at',
      'b.updated_at',
    ])
    .where('b.workspace_id', '=', workspaceId);
}

const record = (row: BoardRow): BoardRecord => boardRecord(row);

/** The board's team (M1-123), shown by its current name. */
const teamOf = (row: BoardRow) =>
  row.team_id === null ? null : { id: row.team_id, name: row.team_name ?? '' };

/** A board's source as the API shows it: its query, or the saved search it uses. */
const sourceOf = (row: BoardRow) =>
  row.saved_search_id !== null
    ? { savedSearchId: row.saved_search_id }
    : { query: row.filter_query ?? '' };

/** What the routes compare and report as a board's configuration. */
const settings = (row: BoardRow, admins: number[]) => ({
  name: row.name,
  description: row.description,
  kind: row.kind,
  source: sourceOf(row),
  subFilter: row.sub_filter_query === null ? null : { query: row.sub_filter_query },
  columns: row.columns,
  swimlanes: row.swimlanes,
  boardFilters: row.board_filters,
  boardFilterDisplay: row.board_filter_display,
  cardRules: row.card_rules,
  sprintSettings: readSprintSettings(row.sprint_settings),
  adminIds: admins,
  teamId: row.team_id,
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

/** A copy of a JSON value with every object's keys in order, so equal values print alike. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
  );
}

const STAGE_NAMES: Record<string, string> = { new: 'New', active: 'Active', closed: 'Closed' };

function boardAdmins(db: Db, boardId: number): Promise<{ id: number; name: string }[]> {
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

/**
 * A board as the sprint and report routes read it, when the person sees it; null otherwise
 * (dashboard widgets, M1-064, which answer for themselves).
 */
export async function visibleBoardRecord(
  db: Db,
  request: FastifyRequest,
  id: number,
): Promise<Omit<SprintBoard, 'manage'> | null> {
  const row = await boardQuery(db, request.workspaceId).where('b.id', '=', id).executeTakeFirst();
  if (!row) return null;
  const admins = await boardAdmins(db, row.id);
  if (
    !(await sees(
      request,
      row,
      admins.map((a) => a.id),
    ))
  ) {
    return null;
  }
  return {
    record: record(row),
    kind: row.kind,
    name: row.name,
    settings: readSprintSettings(row.sprint_settings),
  };
}

/** A route's answer as a status and a body, for callers inside the server. */
export interface RouteAnswer {
  statusCode: number;
  payload: unknown;
}

/** What other routes may do with boards: make one as the caller (track templates, M1-054). */
export interface BoardRoutes {
  createBoard: (request: FastifyRequest, body: unknown) => Promise<RouteAnswer>;
}

export function registerBoardRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  authorizer: Authorizer,
  catalogs: FieldCatalogs,
  options: BoardRouteOptions = {},
): BoardRoutes {
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

  const adminsOf = (boardId: number) => boardAdmins(db, boardId);

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
      team: teamOf(row),
      source: sourceOf(row),
      subFilter: row.sub_filter_query === null ? null : { query: row.sub_filter_query },
      columns: row.columns,
      /** Its columns are its local-mode track's statuses (M1-126; WF-010). */
      managesWorkflow: row.manages_workflow,
      swimlanes: row.swimlanes,
      boardFilters: row.board_filters,
      boardFilterDisplay: row.board_filter_display,
      cardRules: row.card_rules,
      sprintSettings: readSprintSettings(row.sprint_settings),
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
    if (body.source && 'query' in body.source) {
      await checkQuery('source.query', body.source.query);
    } else if (body.source) {
      // Checked as the editor could run it: one they cannot see reads as missing.
      await checkQuery('source.savedSearchId', sourceQuery(body.source));
      if (fields['source.savedSearchId']) fields['source.savedSearchId'] = 'not_found';
    }
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
    const estimation = body.sprintSettings?.estimation;
    if (estimation?.fieldId !== undefined) {
      // Story points and the like: a number field of the workspace (AGL-007).
      const field = await db
        .selectFrom('field')
        .select('id')
        .where('workspace_id', '=', request.workspaceId)
        .where('id', '=', estimation.fieldId)
        .where('type', '=', 'number')
        .executeTakeFirst();
      if (!field) fields['sprintSettings.estimation.fieldId'] = 'not_a_number_field';
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
    if (body.teamId !== undefined && body.teamId !== null) {
      if (!(await findTeam(db, request.workspaceId, body.teamId))) fields.teamId = 'not_found';
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
    if (parsed.data.teamId !== undefined) {
      query = query.where('b.team_id', '=', parsed.data.teamId);
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
        team: teamOf(row),
      });
    }
    return { boards };
  });

  /** Makes a board as the caller: the create route's checks, defaults and event. */
  async function createBoard(request: FastifyRequest, input: unknown): Promise<RouteAnswer> {
    const user = request.user;
    if (!user) return { statusCode: 401, payload: { error: 'unauthenticated' } };
    const refused = (fields: Record<string, string>) => ({
      statusCode: 400,
      payload: { error: 'invalid_fields', fields },
    });
    const parsed = createBoardBody.safeParse(input);
    if (!parsed.success) return refused(shapeErrors(parsed.error));
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
      if (!track) return refused({ trackId: 'not_found' });
      const held = await request.authz.track(trackId);
      const browses = held.has('browse_track') || held.has('administer_track');
      if (!browses && !(await isConfigAdmin(request))) return refused({ trackId: 'not_found' });
      if (track.archived_at) return { statusCode: 409, payload: { error: 'track_archived' } };
    }
    const checked = await checkConfiguration(request, body);
    if (Object.keys(checked.fields).length > 0) return refused(checked.fields);
    const scope = await boardScope(db, catalogs, request);
    const columns =
      checked.columns ?? (await defaultColumns(scope, sourceQuery(body.source), trackId));
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
          filter_query: 'query' in body.source ? body.source.query : null,
          saved_search_id: 'savedSearchId' in body.source ? body.source.savedSearchId : null,
          sub_filter_query: body.subFilter?.query ?? null,
          columns: JSON.stringify(columns),
          swimlanes: JSON.stringify(swimlanes),
          board_filters: JSON.stringify(boardFilters),
          ...(body.boardFilterDisplay ? { board_filter_display: body.boardFilterDisplay } : {}),
          card_rules: JSON.stringify(cardRules),
          sprint_settings: JSON.stringify(body.sprintSettings ?? DEFAULT_SPRINT_SETTINGS),
          team_id: body.teamId ?? null,
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
        payload: {
          name: body.name,
          kind: body.kind,
          trackId,
          query: sourceQuery(body.source),
        },
      });
      return row.id;
    });
    const row = await boardQuery(db, ws).where('b.id', '=', created).executeTakeFirstOrThrow();
    return { statusCode: 201, payload: { board: view(row, await adminsOf(created), true) } };
  }

  app.post('/api/v1/boards', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const answer = await createBoard(request, request.body);
    return reply.code(answer.statusCode).send(answer.payload);
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
    const outcome = await db
      .transaction()
      .execute(async (trx) => {
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
        // A board that manages its track's workflow rewrites it from its columns (M1-126).
        let columns = checked.columns;
        let workflowChange: BoardWorkflowChange | undefined;
        if (columns && found.row.manages_workflow) {
          const synced = await syncBoardWorkflow(
            trx,
            by(request),
            { id: p.data.id, trackId: found.row.location_track_id },
            columns as Column[],
            {
              mapping: new Map(
                Object.entries(body.statusMapping ?? {}).map(([from, to]) => [Number(from), to]),
              ),
            },
          );
          columns = synced.columns as typeof columns;
          workflowChange = synced.change;
        }
        const before = settings(found.row, adminIdsBefore);
        const after = {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.kind !== undefined ? { kind: body.kind } : {}),
          ...(body.source !== undefined ? { source: body.source } : {}),
          ...(body.subFilter !== undefined ? { subFilter: body.subFilter } : {}),
          ...(columns ? { columns: columns as unknown as JsonValue } : {}),
          ...(checked.swimlanes ? { swimlanes: checked.swimlanes as unknown as JsonValue } : {}),
          ...(checked.boardFilters
            ? { boardFilters: checked.boardFilters as unknown as JsonValue }
            : {}),
          ...(body.boardFilterDisplay !== undefined
            ? { boardFilterDisplay: body.boardFilterDisplay }
            : {}),
          ...(checked.cardRules ? { cardRules: checked.cardRules as unknown as JsonValue } : {}),
          ...(body.sprintSettings !== undefined ? { sprintSettings: body.sprintSettings } : {}),
          ...(body.adminIds !== undefined
            ? { adminIds: [...new Set(body.adminIds)].sort((a, b) => a - b) }
            : {}),
          ...(body.teamId !== undefined ? { teamId: body.teamId } : {}),
        };
        // Stored JSON comes back with its keys in another order: compare both sides sorted.
        const changes = diff(
          sortKeys({ ...before, adminIds: [...adminIdsBefore].sort((a, b) => a - b) }) as Record<
            string,
            unknown
          >,
          sortKeys(after) as Record<string, unknown>,
        );
        if (Object.keys(changes).length === 0) return { unchanged: true as const };
        await trx
          .updateTable('board')
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.kind !== undefined ? { kind: body.kind } : {}),
            ...(body.source !== undefined
              ? {
                  filter_query: 'query' in body.source ? body.source.query : null,
                  saved_search_id:
                    'savedSearchId' in body.source ? body.source.savedSearchId : null,
                }
              : {}),
            ...(body.subFilter !== undefined
              ? { sub_filter_query: body.subFilter?.query ?? null }
              : {}),
            ...(columns ? { columns: JSON.stringify(columns) } : {}),
            ...(checked.swimlanes ? { swimlanes: JSON.stringify(checked.swimlanes) } : {}),
            ...(checked.boardFilters
              ? { board_filters: JSON.stringify(checked.boardFilters) }
              : {}),
            ...(body.boardFilterDisplay !== undefined
              ? { board_filter_display: body.boardFilterDisplay }
              : {}),
            ...(checked.cardRules ? { card_rules: JSON.stringify(checked.cardRules) } : {}),
            ...(body.sprintSettings !== undefined
              ? { sprint_settings: JSON.stringify(body.sprintSettings) }
              : {}),
            ...(body.teamId !== undefined ? { team_id: body.teamId } : {}),
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
          payload: { changes, ...(workflowChange ? { workflow: workflowChange } : {}) },
        });
        return { updated: true as const };
      })
      .catch((error: unknown) => {
        if (error instanceof BoardWorkflowError) return { workflowProblem: error.problem };
        throw error;
      });
    if ('workflowProblem' in outcome) {
      return reply.code(409).send({ error: outcome.workflowProblem });
    }
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
    let sprintIds: number[] | undefined;
    if (parsed.data.sprints !== undefined) {
      let sprints = db
        .selectFrom('sprint')
        .select('id')
        .where('board_id', '=', board.id)
        .where('deleted_at', 'is', null);
      sprints =
        parsed.data.sprints === 'active'
          ? sprints.where('state', '=', 'active')
          : sprints.where('id', 'in', parsed.data.sprints.split(',').map(Number));
      sprintIds = (await sprints.execute()).map((s) => s.id);
    }
    try {
      const data = await loadBoardData({
        ...(sprintIds !== undefined ? { sprintIds } : {}),
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

  // A board that manages its local-mode track's workflow (M1-126; WF-010): on, each column
  // becomes one status and the workflow is rewritten from the columns; off, the workflow stays
  // as it was and the board goes back to mapping statuses.
  app.put('/api/v1/boards/:id/workflow', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const parsed = z.object({ managed: z.boolean() }).strict().safeParse(request.body);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const found = await visibleBoard(request, reply, p.data.id);
    if (!found) return reply;
    const row = found.row;
    // Changing the track's workflow takes the right to administer the track.
    const held =
      row.location_track_id === null ? null : await request.authz.track(row.location_track_id);
    if (!held?.has('administer_track') && !(await isConfigAdmin(request))) {
      return reply.code(403).send({ error: 'forbidden', permission: 'administer_track' });
    }
    if (row.manages_workflow === parsed.data.managed) {
      return { board: view(row, found.admins, true) };
    }
    try {
      await db.transaction().execute(async (trx) => {
        await trx.selectFrom('board').select('id').where('id', '=', row.id).forUpdate().execute();
        let workflow: BoardWorkflowChange | undefined;
        if (parsed.data.managed) {
          const synced = await syncBoardWorkflow(
            trx,
            by(request),
            { id: row.id, trackId: row.location_track_id },
            record(row).columns,
            { collapse: true },
          );
          workflow = synced.change;
          await trx
            .updateTable('board')
            .set({
              manages_workflow: true,
              columns: JSON.stringify(synced.columns),
              version: row.version + 1,
              updated_at: new Date(),
            })
            .where('id', '=', row.id)
            .execute();
        } else {
          await trx
            .updateTable('board')
            .set({ manages_workflow: false, version: row.version + 1, updated_at: new Date() })
            .where('id', '=', row.id)
            .execute();
        }
        await emit(trx, by(request), {
          type: 'board.updated',
          subjectId: row.id,
          payload: {
            changes: { managesWorkflow: { from: row.manages_workflow, to: parsed.data.managed } },
            ...(workflow ? { workflow } : {}),
          },
        });
      });
    } catch (error) {
      if (error instanceof BoardWorkflowError) {
        return reply.code(409).send({ error: error.problem });
      }
      if (uniqueViolation(error) === 'board_manages_workflow_idx') {
        return reply.code(409).send({ error: 'another_board_manages' });
      }
      throw error;
    }
    const updated = await boardQuery(db, request.workspaceId)
      .where('b.id', '=', row.id)
      .executeTakeFirstOrThrow();
    return { board: view(updated, found.admins, true) };
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

  // Flow reports (M1-061): any board its viewers see.
  registerBoardReportRoutes(app, db, {
    catalogs,
    timeoutMs,
    board: async (request, reply, id) => {
      const found = await visibleBoard(request, reply, id);
      return found ? record(found.row) : null;
    },
  });

  // Sprints (M1-044): on Scrum boards, managed by "Manage sprints" or the board's configurers.
  const sprintRoutes: SprintRouteDeps = {
    catalogs,
    timeoutMs,
    board: async (request, reply, id) => {
      const found = await visibleBoard(request, reply, id);
      if (!found) return null;
      const adminIds = found.admins.map((a) => a.id);
      let manage = await mayConfigure(request, found.row, adminIds);
      if (!manage && found.row.location_track_id !== null) {
        manage = (await request.authz.track(found.row.location_track_id)).has('manage_sprints');
      }
      return {
        record: record(found.row),
        kind: found.row.kind,
        name: found.row.name,
        settings: readSprintSettings(found.row.sprint_settings),
        manage,
      };
    },
  };
  registerSprintRoutes(app, db, sprintRoutes);
  // Planning on the backlog (M1-047): ranks, parents and releases through the ticket routes.
  const updateTicket = handler('PATCH', '/api/v1/tickets/:id');
  registerBacklogPlanningRoutes(app, db, {
    catalogs,
    timeoutMs,
    board: sprintRoutes.board,
    ticket: (request, route, ticketId, body) =>
      callRoute(route === 'rank' ? rankTicket : updateTicket, {
        workspaceId: request.workspaceId,
        user: request.user,
        authz: request.authz,
        apiToken: request.apiToken,
        params: { id: String(ticketId) },
        query: {},
        body,
      }),
  });
  // Release and outcome reports of Scrum boards (M1-062).
  registerScopeReportRoutes(app, db, sprintRoutes);

  return { createBoard };
}
