import type { Database, JsonValue } from '@taskmoor/db';
import { QueryError } from '@taskmoor/query';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
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
  type PersonChoice,
  personFilter,
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
import { confinedTrackKey, trackBoardQuery } from '../boards/one-per-track';
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
  addColumnPath,
  type BoardWorkflowChange,
  BoardWorkflowError,
  columnReach,
  mayManageWorkflow,
  syncBoardWorkflow,
} from '../workflows/board-managed';
import { registerBacklogPlanningRoutes } from './backlog-planning';
import { registerBoardReportRoutes } from './board-reports';
import { registerPropertyRoutes } from './properties';
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
 * - `GET /api/v1/boards/:id/data?filters=a,b&people=me,12` gives the columns with their counts
 *   and WIP state, the lanes and the cards in rank order, with the given board filters and person
 *   filter applied, and who the viewer can filter by (`boards/data.ts`). Every statement carries
 *   the viewer's ticket filter.
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
    /**
     * Only the cards of these people, any of them: `me`, `none` (nobody assigned) or a person's
     * id, comma separated (AGL-005 (3)).
     */
    people: z
      .string()
      .regex(/^(me|none|\d{1,10})(,(me|none|\d{1,10})){0,49}$/)
      .optional(),
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
      'b.closing_column',
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

/**
 * A board's kind decides its track's backlog and sprints toggles (CORE-002; ADR-116): on for Scrum,
 * off for Kanban, in the same transaction, recorded as a change of the track.
 */
async function alignTrackFeatures(
  trx: Transaction<Database>,
  actor: Parameters<typeof emit>[1],
  trackId: number,
  kind: string,
): Promise<void> {
  const on = kind === 'scrum';
  const track = await trx
    .selectFrom('track')
    .select(['feature_backlog', 'feature_sprints'])
    .where('id', '=', trackId)
    .executeTakeFirst();
  if (!track || (track.feature_backlog === on && track.feature_sprints === on)) return;
  await trx
    .updateTable('track')
    .set({ feature_backlog: on, feature_sprints: on, updated_at: new Date() })
    .where('id', '=', trackId)
    .execute();
  await emit(trx, actor, {
    type: 'track.updated',
    subjectId: trackId,
    payload: {
      changes: {
        ...(track.feature_backlog !== on
          ? { 'features.backlog': { from: track.feature_backlog, to: on } }
          : {}),
        ...(track.feature_sprints !== on
          ? { 'features.sprints': { from: track.feature_sprints, to: on } }
          : {}),
      },
    },
  });
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
  createBoard: (
    request: FastifyRequest,
    body: unknown,
    options?: { forTrack?: boolean; system?: boolean },
  ) => Promise<RouteAnswer>;
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

  /** Who changes a track's workflow through its board. */
  async function mayChangeWorkflow(request: FastifyRequest, trackId: number) {
    const held = await request.authz.track(trackId);
    return held.has('administer_track') || isConfigAdmin(request);
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
      team: teamOf(row),
      source: sourceOf(row),
      subFilter: row.sub_filter_query === null ? null : { query: row.sub_filter_query },
      columns: row.columns,
      /** Its columns are its local-mode track's statuses (M1-126; WF-010). */
      managesWorkflow: row.manages_workflow,
      closingColumn: row.closing_column,
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
    // A column is a status (the user's decision; ADR-116): one each, in the workflow's order.
    const columns: Column[] = statuses
      .slice()
      .sort(
        (a, b) =>
          ['new', 'active', 'closed'].indexOf(a.stage) -
          ['new', 'active', 'closed'].indexOf(b.stage),
      )
      .map((status, index) => ({
        id: `c${index + 1}`,
        name: status.name,
        statusIds: [status.id],
        min: null,
        max: null,
      }));
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
  async function createBoard(
    request: FastifyRequest,
    input: unknown,
    /** A track's own board, made for it on first use or by its template (ADR-116). */
    options: { forTrack?: boolean; system?: boolean } = {},
  ): Promise<RouteAnswer> {
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
    // One board per track, and none outside a track (ADR-116).
    let givenQuery: string | null = null;
    if (body.source && 'query' in body.source) givenQuery = body.source.query;
    if (body.source && 'savedSearchId' in body.source) {
      const saved = await db
        .selectFrom('saved_search')
        .select('query')
        .where('id', '=', body.source.savedSearchId)
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      givenQuery = saved?.query ?? null;
    }
    const confined = givenQuery === null ? null : confinedTrackKey(givenQuery);
    const track = await db
      .selectFrom('track')
      .select(['id', 'key', 'archived_at'])
      .where('workspace_id', '=', ws)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        body.trackId != null
          ? eb('id', '=', body.trackId)
          : eb(sql`lower(key)`, '=', (confined ?? '').toLowerCase()),
      )
      .executeTakeFirst();
    if (!track) {
      return refused({ trackId: body.trackId == null ? 'required' : 'not_found' });
    }
    const trackId = track.id;
    if (!options.system) {
      const held = await request.authz.track(trackId);
      const browses = held.has('browse_track') || held.has('administer_track');
      const configures = await isConfigAdmin(request);
      if (!browses && !configures) return refused({ trackId: 'not_found' });
    }
    if (track.archived_at) return { statusCode: 409, payload: { error: 'track_archived' } };
    const existing = await db
      .selectFrom('board')
      .select('id')
      .where('location_track_id', '=', trackId)
      .executeTakeFirst();
    if (existing) {
      return { statusCode: 409, payload: { error: 'track_has_board', boardId: existing.id } };
    }
    const source = body.source ?? { query: trackBoardQuery(track.key) };
    const checked = await checkConfiguration(request, body);
    if (Object.keys(checked.fields).length > 0) return refused(checked.fields);
    if (body.source && (confined === null || confined.toLowerCase() !== track.key.toLowerCase())) {
      return refused({ source: 'outside_track' });
    }
    const scope = await boardScope(db, catalogs, request);
    const columns = checked.columns ?? (await defaultColumns(scope, sourceQuery(source), trackId));
    const swimlanes = checked.swimlanes ?? DEFAULT_SWIMLANES;
    const boardFilters = checked.boardFilters ?? DEFAULT_BOARD_FILTERS;
    const cardRules = checked.cardRules ?? DEFAULT_CARD_RULES;
    const adminIds = options.system ? [] : [...new Set([user.id, ...(body.adminIds ?? [])])];
    const made = await db
      .transaction()
      .execute(async (trx) => {
        const row = await trx
          .insertInto('board')
          .values({
            workspace_id: ws,
            name: body.name,
            description: body.description ?? '',
            kind: body.kind,
            location_track_id: trackId,
            location_user_id: null,
            filter_query: 'query' in source ? source.query : null,
            saved_search_id: 'savedSearchId' in source ? source.savedSearchId : null,
            sub_filter_query: body.subFilter?.query ?? null,
            columns: JSON.stringify(columns),
            swimlanes: JSON.stringify(swimlanes),
            board_filters: JSON.stringify(boardFilters),
            ...(body.boardFilterDisplay ? { board_filter_display: body.boardFilterDisplay } : {}),
            card_rules: JSON.stringify(cardRules),
            sprint_settings: JSON.stringify(body.sprintSettings ?? DEFAULT_SPRINT_SETTINGS),
            team_id: body.teamId ?? null,
            created_by: options.system ? null : user.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (adminIds.length > 0) {
          await trx
            .insertInto('board_admin')
            .values(
              adminIds.map((userId) => ({ workspace_id: ws, board_id: row.id, user_id: userId })),
            )
            .execute();
        }
        // A track's own board manages its workflow where nobody else shares it: each column is a
        // status (the user's decision; ADR-116, ADR-079).
        let workflow: BoardWorkflowChange | undefined;
        if (options.forTrack && (await mayManageWorkflow(trx, ws, trackId))) {
          const synced = await syncBoardWorkflow(
            trx,
            by(request),
            { id: row.id, trackId },
            columns,
            {
              collapse: true,
            },
          );
          workflow = synced.change;
          await trx
            .updateTable('board')
            .set({ manages_workflow: true, columns: JSON.stringify(synced.columns) })
            .where('id', '=', row.id)
            .execute();
        }
        await emit(trx, by(request), {
          type: 'board.created',
          subjectId: row.id,
          payload: {
            name: body.name,
            kind: body.kind,
            trackId,
            query: sourceQuery(source),
            ...(workflow ? { workflow } : {}),
          },
        });
        await alignTrackFeatures(trx, by(request), trackId, body.kind);
        return row.id;
      })
      .then(
        (id) => ({ id }),
        (error: unknown) => {
          // Two people opening a new track at once: the other one's board is the track's.
          if (uniqueViolation(error) === 'board_one_per_track_idx') return { taken: true as const };
          throw error;
        },
      );
    if ('taken' in made) return { statusCode: 409, payload: { error: 'track_has_board' } };
    const row = await boardQuery(db, ws).where('b.id', '=', made.id).executeTakeFirstOrThrow();
    return { statusCode: 201, payload: { board: view(row, await adminsOf(made.id), true) } };
  }

  // A track's one board (ADR-116): made the first time anyone who can see the track opens it, so
  // a Blank track has one too. It belongs to the track, not to who happened to open it first.
  app.get('/api/v1/tracks/:id/board', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const { id: ref } = request.params as { id: string };
    const track = await db
      .selectFrom('track')
      .select(['id', 'name', 'archived_at'])
      .where('workspace_id', '=', request.workspaceId)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        /^\d{1,10}$/.test(ref)
          ? eb('id', '=', Number(ref))
          : eb(sql`lower(key)`, '=', ref.toLowerCase()),
      )
      .executeTakeFirst();
    if (!track) return notFound(reply);
    const held = await request.authz.track(track.id);
    const browses = held.has('browse_track') || held.has('administer_track');
    if (!browses && !(await isConfigAdmin(request))) return notFound(reply);
    const find = () =>
      boardQuery(db, request.workspaceId)
        .where('b.location_track_id', '=', track.id)
        .executeTakeFirst();
    let row = await find();
    if (!row) {
      if (track.archived_at) return notFound(reply);
      const made = await createBoard(
        request,
        { name: track.name, kind: 'kanban', trackId: track.id },
        { forTrack: true, system: true },
      );
      const error = (made.payload as { error?: string }).error;
      if (made.statusCode !== 201 && error !== 'track_has_board') {
        return reply.code(made.statusCode).send(made.payload);
      }
      row = await find();
      if (!row) return notFound(reply);
    }
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
    const reach =
      row.location_track_id === null
        ? null
        : await columnReach(
            db,
            request.workspaceId,
            row.location_track_id,
            row.columns as unknown as Column[],
          );
    return {
      board: view(row, admins, configure),
      reach: reach && { ...reach, mayFix: await isConfigAdmin(request) },
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
    if (body.source && found.row.location_track_id !== null) {
      const text =
        'query' in body.source
          ? body.source.query
          : ((
              await db
                .selectFrom('saved_search')
                .select('query')
                .where('id', '=', body.source.savedSearchId)
                .where('workspace_id', '=', request.workspaceId)
                .executeTakeFirst()
            )?.query ?? '');
      const own = await db
        .selectFrom('track')
        .select('key')
        .where('id', '=', found.row.location_track_id)
        .executeTakeFirstOrThrow();
      if (confinedTrackKey(text)?.toLowerCase() !== own.key.toLowerCase()) {
        return invalidFields(reply, { source: 'outside_track' });
      }
    }
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
        const closing =
          body.closingColumn !== undefined ? body.closingColumn : found.row.closing_column;
        // A new column on a track nobody else shares just works: the board takes over the
        // workflow, as long as the person may administer the track and no rule stands in the way.
        const takesOver =
          columns !== undefined &&
          !found.row.manages_workflow &&
          found.row.location_track_id !== null &&
          (columns as Column[]).some((c) => c.statusIds.length === 0) &&
          (await mayChangeWorkflow(request, found.row.location_track_id)) &&
          (await mayManageWorkflow(trx, request.workspaceId, found.row.location_track_id));
        const syncing =
          found.row.manages_workflow &&
          (columns !== undefined ||
            (body.closingColumn !== undefined && body.closingColumn !== found.row.closing_column));
        if (takesOver || syncing) {
          const synced = await syncBoardWorkflow(
            trx,
            by(request),
            { id: p.data.id, trackId: found.row.location_track_id },
            (columns ?? record(found.row).columns) as Column[],
            {
              closing,
              collapse: takesOver,
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
          ...(body.closingColumn !== undefined ? { closingColumn: body.closingColumn } : {}),
          ...(takesOver ? { managesWorkflow: true } : {}),
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
            ...(body.closingColumn !== undefined ? { closing_column: body.closingColumn } : {}),
            ...(takesOver ? { manages_workflow: true } : {}),
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
        if (
          body.kind !== undefined &&
          body.kind !== found.row.kind &&
          found.row.location_track_id !== null
        ) {
          await alignTrackFeatures(trx, by(request), found.row.location_track_id, body.kind);
        }
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
    const people = (parsed.data.people?.split(',') ?? []) as PersonChoice[];
    if (people.some((c) => Number(c) > MAX_INT)) {
      return invalidFields(reply, { people: 'out_of_range' });
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
    const { estimation } = readSprintSettings(found.row.sprint_settings);
    try {
      const data = await loadBoardData({
        ...(sprintIds !== undefined ? { sprintIds } : {}),
        estimateFieldId: estimation.statistic === 'field' ? (estimation.fieldId ?? null) : null,
        db,
        request,
        catalogs,
        scope,
        board,
        // The person filter is one more board filter: same compiler, same viewer's filter.
        active: people.length > 0 ? [...active, personFilter(people)] : active,
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

  // Lets cards reach a column on a workflow the board does not manage (ADR-116): a status, and
  // the steps in and out, as a new version of the workflow. That workflow may be shared, so this
  // takes the right to edit workflows; the settings page names the other tracks first.
  app.post('/api/v1/boards/:id/columns/:columnId/path', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const { id: boardRef, columnId } = request.params as { id: string; columnId: string };
    const p = idParam.safeParse({ id: boardRef });
    if (!p.success) return notFound(reply);
    const found = await visibleBoard(request, reply, p.data.id);
    if (!found) return reply;
    const row = found.row;
    if (row.location_track_id === null) return notFound(reply);
    if (!(await isConfigAdmin(request))) {
      return reply.code(403).send({ error: 'forbidden', permission: 'edit_workflow' });
    }
    const columns = row.columns as unknown as Column[];
    const reach = await columnReach(db, request.workspaceId, row.location_track_id, columns);
    if (!columns.some((c) => c.id === columnId)) return notFound(reply);
    if (!reach?.workflow || !reach.singleWorkflow) {
      return reply.code(409).send({ error: 'per_type_workflows' });
    }
    const workflowId = reach.workflow.id;
    try {
      const updated = await db.transaction().execute(async (trx) => {
        await trx.selectFrom('board').select('id').where('id', '=', row.id).forUpdate().execute();
        const { columns: stored, change } = await addColumnPath(
          trx,
          by(request),
          workflowId,
          columns,
          columnId,
        );
        await trx
          .updateTable('board')
          .set({
            columns: JSON.stringify(stored),
            version: row.version + 1,
            updated_at: new Date(),
          })
          .where('id', '=', row.id)
          .execute();
        await emit(trx, by(request), {
          type: 'board.updated',
          subjectId: row.id,
          payload: { changes: { columnPath: { from: null, to: columnId } }, workflow: change },
        });
        return row.id;
      });
      const next = await boardQuery(db, request.workspaceId)
        .where('b.id', '=', updated)
        .executeTakeFirstOrThrow();
      return { board: view(next, found.admins, true) };
    } catch (error) {
      if (error instanceof BoardWorkflowError) {
        return reply.code(409).send({ error: error.problem });
      }
      throw error;
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
  // Board and sprint properties (M1-129): seen as the board is, changed by its configurers or,
  // for a sprint, by those who manage its sprints.
  registerPropertyRoutes(app, db, 'board', '/api/v1/boards', async (request, reply, id) => {
    const numeric = /^\d{1,10}$/.test(id) ? Number(id) : null;
    if (numeric === null) {
      await reply.code(404).send({ error: 'not_found' });
      return null;
    }
    const found = await visibleBoard(request, reply, numeric);
    if (!found) return null;
    const configure = await mayConfigure(
      request,
      found.row,
      found.admins.map((a) => a.id),
    );
    return { id: found.row.id, mayWrite: configure };
  });
  registerPropertyRoutes(app, db, 'sprint', '/api/v1/sprints', async (request, reply, id) => {
    const numeric = /^\d{1,10}$/.test(id) ? Number(id) : null;
    const sprint =
      numeric === null
        ? undefined
        : await db
            .selectFrom('sprint')
            .select(['id', 'board_id'])
            .where('workspace_id', '=', request.workspaceId)
            .where('id', '=', numeric)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
    if (!sprint) {
      await reply.code(404).send({ error: 'not_found' });
      return null;
    }
    const board = await sprintRoutes.board(request, reply, sprint.board_id);
    if (!board) return null;
    return { id: sprint.id, mayWrite: board.manage };
  });
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
