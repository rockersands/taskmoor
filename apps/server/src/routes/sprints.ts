import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { type BoardRecord, boardScope, compileBoard, type Scope } from '../boards/data';
import { emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import { readOnly } from '../search/run';
import {
  completeSprintBody,
  createSprintBody,
  datesInOrder,
  rankSprintBody,
  readSprintSettings,
  type SprintSettings,
  sprintTicketsBody,
  startSprintBody,
  updateSprintBody,
} from '../sprints/model';
import { resolveTicket } from '../tickets/store';
import { searchRefusal } from './search';

/**
 * Sprints (M1-044; AGL-007, AGL-010, AGL-011; ADR-054).
 *
 * - `GET /api/v1/boards/:id/sprints?state=` lists a Scrum board's sprints; `POST` creates a
 *   future one. `GET /api/v1/boards/:id/backlog` gives the sprint sections (active, then future
 *   in order) and the backlog: the board's tickets the viewer sees, in rank order, with their
 *   estimate by the board's statistic and the totals.
 * - `PATCH` and `DELETE /api/v1/sprints/:id` edit and delete one (a future sprint's tickets go
 *   back to the backlog; a deleted completed sprint leaves reports, its history stays);
 *   `POST .../rank` reorders future sprints, `.../start` and `.../complete` run the lifecycle.
 * - `POST /api/v1/sprints/:id/tickets` adds tickets (from the backlog or another open sprint),
 *   `.../tickets/remove` sends them to the backlog. After the start both are scope change.
 * - `GET /api/v1/sprints/:id/report`: committed, added after start, removed, completed and not
 *   completed tickets with their estimate at entry and at the end, and the totals.
 *
 * Managing sprints needs "Manage sprints" in the board's track, or the right to configure the
 * board; adding or removing tickets needs "Schedule tickets" or "Edit tickets" in each ticket's
 * track. Each write emits one `sprint.*` event in its transaction.
 */
const MAX_INT = 2_147_483_647;
const idParam = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) }).strict();
const listQuery = z.object({ state: z.enum(['future', 'active', 'closed']).optional() }).strict();
const backlogQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(10_000).default(2000) })
  .strict();

type Db = Kysely<Database> | Transaction<Database>;

export interface SprintBoard {
  record: BoardRecord;
  kind: 'scrum' | 'kanban';
  name: string;
  settings: SprintSettings;
  /** Whether the caller may manage this board's sprints. */
  manage: boolean;
}

export interface SprintRouteDeps {
  catalogs: FieldCatalogs;
  timeoutMs: number;
  /** A board the caller sees, or null after answering 404. */
  board: (request: FastifyRequest, reply: FastifyReply, id: number) => Promise<SprintBoard | null>;
}

const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const forbidden = (reply: FastifyReply, permission: string) =>
  reply.code(403).send({ error: 'forbidden', permission });

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

/** The ticket's estimate by the board's statistic, over `ticket k`. */
export function estimateSql(settings: SprintSettings): RawBuilder<number | string | null> {
  const e = settings.estimation;
  if (e.statistic === 'ticketCount') return sql`1`;
  if (e.statistic === 'originalEstimate') return sql`k.original_estimate`;
  const key = String(e.fieldId);
  return sql`CASE WHEN jsonb_typeof(k.fields -> ${key}::text) = 'number'
    THEN (k.fields ->> ${key}::text)::numeric END`;
}

/** The statuses of the board's rightmost column: done (spec 01b section 3.2). */
const doneStatuses = (board: BoardRecord): number[] =>
  board.columns[board.columns.length - 1]?.statusIds ?? [];

const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

type SprintRow = Awaited<ReturnType<ReturnType<typeof sprintQuery>['executeTakeFirstOrThrow']>>;

function sprintQuery(db: Db, workspaceId: number) {
  return db
    .selectFrom('sprint')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('deleted_at', 'is', null);
}

const sprintView = (s: SprintRow) => ({
  id: s.id,
  boardId: s.board_id,
  name: s.name,
  goal: s.goal,
  state: s.state,
  sequence: s.sequence,
  startAt: s.start_at?.toISOString() ?? null,
  endAt: s.end_at?.toISOString() ?? null,
  startedAt: s.started_at?.toISOString() ?? null,
  completedAt: s.completed_at?.toISOString() ?? null,
  version: s.version,
});

export function registerSprintRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  deps: SprintRouteDeps,
): void {
  const { catalogs, timeoutMs } = deps;
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  /** A Scrum board the caller sees; kanban boards answer 409 `not_scrum`. */
  async function scrumBoard(request: FastifyRequest, reply: FastifyReply, id: number) {
    const board = await deps.board(request, reply, id);
    if (!board) return null;
    if (board.kind !== 'scrum') {
      await reply.code(409).send({ error: 'not_scrum' });
      return null;
    }
    return board;
  }

  /** A sprint and its board, both visible to the caller. */
  async function sprintAndBoard(request: FastifyRequest, reply: FastifyReply) {
    const p = idParam.safeParse(request.params);
    if (!p.success) {
      await notFound(reply);
      return null;
    }
    const sprint = await sprintQuery(db, request.workspaceId)
      .where('id', '=', p.data.id)
      .executeTakeFirst();
    if (!sprint) {
      await notFound(reply);
      return null;
    }
    const board = await deps.board(request, reply, sprint.board_id);
    if (!board) return null;
    return { sprint, board };
  }

  /** The tickets' estimates now, as the scope-change rows record them. */
  async function snapshot(trx: Db, settings: SprintSettings, ticketIds: readonly number[]) {
    if (ticketIds.length === 0) return new Map<number, Snap>();
    const points =
      settings.estimation.statistic === 'field' ? estimateSql(settings) : sql<null>`NULL`;
    const rows = await sql<{
      id: number;
      original_estimate: number | null;
      remaining_estimate: number | null;
      points: string | null;
    }>`SELECT k.id, k.original_estimate, k.remaining_estimate, ${points} AS points
         FROM ticket k WHERE k.id = ANY(${[...ticketIds]}::int[])`.execute(trx);
    return new Map(
      rows.rows.map((r) => [
        r.id,
        {
          original_estimate: r.original_estimate,
          remaining_estimate: r.remaining_estimate,
          points: r.points,
        },
      ]),
    );
  }
  interface Snap {
    original_estimate: number | null;
    remaining_estimate: number | null;
    points: string | null;
  }

  async function recordChanges(
    trx: Db,
    request: FastifyRequest,
    settings: SprintSettings,
    sprintId: number,
    kind: 'added' | 'removed' | 'committed' | 'completed' | 'carried_over',
    ticketIds: readonly number[],
    extra: { afterStart?: boolean; toSprintId?: number | null; at?: Date } = {},
  ) {
    if (ticketIds.length === 0) return;
    const snaps = await snapshot(trx, settings, ticketIds);
    await trx
      .insertInto('sprint_change')
      .values(
        ticketIds.map((ticketId) => {
          const s = snaps.get(ticketId);
          return {
            workspace_id: request.workspaceId,
            sprint_id: sprintId,
            ticket_id: ticketId,
            kind,
            after_start: extra.afterStart ?? false,
            actor_id: request.user?.id ?? null,
            original_estimate: s?.original_estimate ?? null,
            remaining_estimate: s?.remaining_estimate ?? null,
            points: s?.points ?? null,
            to_sprint_id: extra.toSprintId ?? null,
            ...(extra.at ? { at: extra.at } : {}),
          };
        }),
      )
      .execute();
  }

  /** The board's conditions for the caller (`scope` over `ticket k`). */
  async function compiled(request: FastifyRequest, board: SprintBoard, everyone = false) {
    const scope = await boardScope(db, catalogs, request);
    const used: Scope = everyone
      ? { ...scope, filter: { sql: sql<boolean>`true`, tracks: 'all' } }
      : scope;
    return compileBoard(db, used, board.record, [], new Date());
  }

  // ---- Reads ----

  app.get('/api/v1/boards/:id/sprints', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const q = listQuery.safeParse(request.query);
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const board = await scrumBoard(request, reply, p.data.id);
    if (!board) return reply;
    let query = sprintQuery(db, request.workspaceId).where('board_id', '=', p.data.id);
    if (q.data.state) query = query.where('state', '=', q.data.state);
    const rows = await query.orderBy('sequence').orderBy('id').execute();
    return { sprints: rows.map(sprintView), settings: board.settings, mayManage: board.manage };
  });

  app.get('/api/v1/boards/:id/backlog', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const q = backlogQuery.safeParse(request.query);
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const board = await scrumBoard(request, reply, p.data.id);
    if (!board) return reply;
    const sprints = await sprintQuery(db, request.workspaceId)
      .where('board_id', '=', p.data.id)
      .where('state', '<>', 'closed')
      .orderBy(sql`CASE WHEN state = 'active' THEN 0 ELSE 1 END`)
      .orderBy('sequence')
      .orderBy('id')
      .execute();
    const mapped = board.record.columns.flatMap((c) => c.statusIds);
    const done = doneStatuses(board.record);
    interface Row {
      id: number;
      key: string;
      summary: string;
      status_id: number;
      status_name: string;
      type_name: string;
      estimate: number | string | null;
      remaining_estimate: number | null;
      sprint_id: number | null;
    }
    try {
      const c = await compiled(request, board);
      const rows = await readOnly(db, timeoutMs, async (trx) => {
        const r = await sql<Row>`
          SELECT k.id, t.key || '-' || k.number AS key, k.summary, k.status_id,
                 s.name AS status_name, y.name AS type_name,
                 ${estimateSql(board.settings)} AS estimate, k.remaining_estimate,
                 st.sprint_id
            FROM ticket k
            JOIN track t ON t.id = k.track_id
            JOIN status s ON s.id = k.status_id
            JOIN ticket_type y ON y.id = k.ticket_type_id
            LEFT JOIN sprint_ticket st ON st.ticket_id = k.id AND st.open
           WHERE ${c.scope} AND k.status_id = ANY(${mapped}::int[])
             AND (st.sprint_id = ANY(${sprints.map((s) => s.id)}::int[])
                  OR (st.sprint_id IS NULL AND NOT k.status_id = ANY(${done}::int[])))
           ORDER BY k.rank
           LIMIT ${q.data.limit + 1}`.execute(trx);
        return r.rows;
      });
      const truncated = rows.length > q.data.limit;
      const shown = rows.slice(0, q.data.limit);
      const doneSet = new Set(done);
      const card = (r: Row) => ({
        id: r.id,
        key: r.key,
        summary: r.summary,
        type: r.type_name,
        status: { id: r.status_id, name: r.status_name },
        done: doneSet.has(r.status_id),
        estimate: num(r.estimate),
        remainingEstimate: r.remaining_estimate,
      });
      const totals = (list: Row[]) => {
        const estimate = list.reduce((sum, r) => sum + (num(r.estimate) ?? 0), 0);
        const remaining = list
          .filter((r) => !doneSet.has(r.status_id))
          .reduce((sum, r) => sum + (r.remaining_estimate ?? 0), 0);
        return {
          tickets: list.length,
          estimate,
          ...(board.settings.timeTracking === 'remainingEstimate' ? { remaining } : {}),
        };
      };
      return {
        settings: board.settings,
        mayManage: board.manage,
        sprints: sprints.map((s) => {
          const list = shown.filter((r) => r.sprint_id === s.id);
          return { ...sprintView(s), tickets: list.map(card), totals: totals(list) };
        }),
        backlog: (() => {
          const list = shown.filter((r) => r.sprint_id === null);
          return { tickets: list.map(card), totals: totals(list) };
        })(),
        truncated,
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  // ---- Lifecycle ----

  app.post('/api/v1/boards/:id/sprints', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const parsed = createSprintBody.safeParse(request.body);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const board = await scrumBoard(request, reply, p.data.id);
    if (!board) return reply;
    if (!board.manage) return forbidden(reply, 'manage_sprints');
    const startAt = body.startAt ? new Date(body.startAt) : null;
    const endAt = body.endAt ? new Date(body.endAt) : null;
    if (!datesInOrder(startAt, endAt)) return invalidFields(reply, { endAt: 'before_start' });
    const id = await db.transaction().execute(async (trx) => {
      // One writer at a time per board: the sequence and the default name count sprints.
      await trx.selectFrom('board').select('id').where('id', '=', p.data.id).forUpdate().execute();
      const counted = await trx
        .selectFrom('sprint')
        .select(({ fn }) => [fn.countAll<string>().as('n'), fn.max('sequence').as('top')])
        .where('board_id', '=', p.data.id)
        .executeTakeFirstOrThrow();
      const name = body.name ?? `${board.name} Sprint ${Number(counted.n) + 1}`;
      const row = await trx
        .insertInto('sprint')
        .values({
          workspace_id: request.workspaceId,
          board_id: p.data.id,
          name,
          goal: body.goal ?? '',
          sequence: (counted.top ?? 0) + 1,
          start_at: startAt,
          end_at: endAt,
          created_by: user.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await emit(trx, by(request), {
        type: 'sprint.created',
        subjectId: row.id,
        payload: { boardId: p.data.id, name },
      });
      return row.id;
    });
    const row = await sprintQuery(db, request.workspaceId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return reply.code(201).send({ sprint: sprintView(row) });
  });

  app.patch('/api/v1/sprints/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = updateSprintBody.safeParse(request.body);
    if (!parsed.success) {
      const p = idParam.safeParse(request.params);
      if (!p.success) return notFound(reply);
      return invalidFields(reply, shapeErrors(parsed.error));
    }
    const body = parsed.data;
    const found = await sprintAndBoard(request, reply);
    if (!found) return reply;
    const { sprint, board } = found;
    if (!board.manage) return forbidden(reply, 'manage_sprints');
    if (sprint.state === 'closed' && (body.startAt !== undefined || body.endAt !== undefined)) {
      return reply.code(409).send({ error: 'sprint_closed' });
    }
    const startAt =
      body.startAt === undefined ? sprint.start_at : body.startAt ? new Date(body.startAt) : null;
    const endAt =
      body.endAt === undefined ? sprint.end_at : body.endAt ? new Date(body.endAt) : null;
    if (!datesInOrder(startAt, endAt)) return invalidFields(reply, { endAt: 'before_start' });
    if (sprint.state === 'active' && (startAt === null || endAt === null)) {
      return invalidFields(reply, { [startAt === null ? 'startAt' : 'endAt']: 'required' });
    }
    const before = {
      name: sprint.name,
      goal: sprint.goal,
      startAt: sprint.start_at?.toISOString() ?? null,
      endAt: sprint.end_at?.toISOString() ?? null,
    };
    const after = {
      name: body.name ?? sprint.name,
      goal: body.goal ?? sprint.goal,
      startAt: startAt?.toISOString() ?? null,
      endAt: endAt?.toISOString() ?? null,
    };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(after) as (keyof typeof after)[]) {
      if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
    }
    const outcome = await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('sprint')
        .select('version')
        .where('id', '=', sprint.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (body.version !== undefined && body.version !== current.version) {
        return { conflict: current.version };
      }
      if (Object.keys(changes).length === 0) return { unchanged: true as const };
      await trx
        .updateTable('sprint')
        .set({
          name: after.name,
          goal: after.goal,
          start_at: startAt,
          end_at: endAt,
          version: current.version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', sprint.id)
        .execute();
      await emit(trx, by(request), {
        type: 'sprint.updated',
        subjectId: sprint.id,
        payload: { changes },
      });
      return { updated: true as const };
    });
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: 'version_conflict', version: outcome.conflict });
    }
    const row = await sprintQuery(db, request.workspaceId)
      .where('id', '=', sprint.id)
      .executeTakeFirstOrThrow();
    return { sprint: sprintView(row) };
  });

  app.post('/api/v1/sprints/:id/rank', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = rankSprintBody.safeParse(request.body);
    const found = await sprintAndBoard(request, reply);
    if (!found) return reply;
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const { sprint, board } = found;
    if (!board.manage) return forbidden(reply, 'manage_sprints');
    if (sprint.state !== 'future') return reply.code(409).send({ error: 'sprint_not_future' });
    const anchorId = parsed.data.before ?? (parsed.data.after as number);
    const order = await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('board')
        .select('id')
        .where('id', '=', sprint.board_id)
        .forUpdate()
        .execute();
      const futures = await trx
        .selectFrom('sprint')
        .select(['id', 'sequence'])
        .where('board_id', '=', sprint.board_id)
        .where('state', '=', 'future')
        .orderBy('sequence')
        .orderBy('id')
        .execute();
      if (anchorId === sprint.id || !futures.some((f) => f.id === anchorId)) return null;
      const ids = futures.map((f) => f.id).filter((i) => i !== sprint.id);
      const at = ids.indexOf(anchorId) + (parsed.data.before !== undefined ? 0 : 1);
      ids.splice(at, 0, sprint.id);
      // Future sprints take the sequences after every started one, in the new order.
      const top = await trx
        .selectFrom('sprint')
        .select(({ fn }) => fn.max('sequence').as('top'))
        .where('board_id', '=', sprint.board_id)
        .where('state', '<>', 'future')
        .executeTakeFirst();
      const base = Math.max(top?.top ?? 0, ...futures.map((f) => f.sequence)) + 1;
      for (const [i, id] of ids.entries()) {
        await trx
          .updateTable('sprint')
          .set({ sequence: base + i })
          .where('id', '=', id)
          .execute();
      }
      await emit(trx, by(request), {
        type: 'sprint.reordered',
        subjectId: sprint.id,
        payload: { order: ids },
      });
      return ids;
    });
    if (order === null) return invalidFields(reply, { anchor: 'not_found' });
    return { order };
  });

  app.post('/api/v1/sprints/:id/start', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = startSprintBody.safeParse(request.body ?? {});
    const found = await sprintAndBoard(request, reply);
    if (!found) return reply;
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const { sprint, board } = found;
    if (!board.manage) return forbidden(reply, 'manage_sprints');
    if (sprint.state !== 'future') return reply.code(409).send({ error: 'sprint_not_future' });
    const startAt = body.startAt ? new Date(body.startAt) : (sprint.start_at ?? new Date());
    const endAt = body.endAt ? new Date(body.endAt) : sprint.end_at;
    if (endAt === null) return invalidFields(reply, { endAt: 'required' });
    if (!datesInOrder(startAt, endAt)) return invalidFields(reply, { endAt: 'before_start' });
    const outcome = await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('board')
        .select('id')
        .where('id', '=', sprint.board_id)
        .forUpdate()
        .execute();
      const current = await trx
        .selectFrom('sprint')
        .select('state')
        .where('id', '=', sprint.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.state !== 'future') return { error: 'sprint_not_future' };
      if (!board.settings.parallelSprints) {
        const active = await trx
          .selectFrom('sprint')
          .select('id')
          .where('board_id', '=', sprint.board_id)
          .where('state', '=', 'active')
          .executeTakeFirst();
        if (active) return { error: 'sprint_active', sprintId: active.id };
      }
      const now = new Date();
      await trx
        .updateTable('sprint')
        .set({
          state: 'active',
          name: body.name ?? sprint.name,
          goal: body.goal ?? sprint.goal,
          start_at: startAt,
          end_at: endAt,
          started_at: now,
          started_by: request.user?.id ?? null,
          version: sprint.version + 1,
          updated_at: now,
        })
        .where('id', '=', sprint.id)
        .execute();
      const members = await trx
        .selectFrom('sprint_ticket')
        .select('ticket_id')
        .where('sprint_id', '=', sprint.id)
        .execute();
      const ids = members.map((m) => m.ticket_id);
      await recordChanges(trx, request, board.settings, sprint.id, 'committed', ids, { at: now });
      await emit(trx, by(request), {
        type: 'sprint.started',
        subjectId: sprint.id,
        payload: {
          boardId: sprint.board_id,
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          tickets: ids.length,
        },
      });
      return { started: true as const };
    });
    if ('error' in outcome) return reply.code(409).send(outcome);
    const row = await sprintQuery(db, request.workspaceId)
      .where('id', '=', sprint.id)
      .executeTakeFirstOrThrow();
    return { sprint: sprintView(row) };
  });

  app.post('/api/v1/sprints/:id/complete', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = completeSprintBody.safeParse(request.body);
    const found = await sprintAndBoard(request, reply);
    if (!found) return reply;
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const { moveTo } = parsed.data;
    const { sprint, board } = found;
    if (!board.manage) return forbidden(reply, 'manage_sprints');
    if (sprint.state !== 'active') return reply.code(409).send({ error: 'sprint_not_active' });
    // The completing board's tickets, whoever may see them: only these carry over (AGL-011 (2)).
    let boardScopeSql: RawBuilder<boolean>;
    try {
      boardScopeSql = (await compiled(request, board, true)).scope;
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
    const done = doneStatuses(board.record);
    const outcome = await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('board')
        .select('id')
        .where('id', '=', sprint.board_id)
        .forUpdate()
        .execute();
      const current = await trx
        .selectFrom('sprint')
        .select('state')
        .where('id', '=', sprint.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.state !== 'active') return { error: 'sprint_not_active' as const };
      let target: { id: number; state: string } | null = null;
      if (moveTo.type === 'sprint') {
        const row = await trx
          .selectFrom('sprint')
          .select(['id', 'state'])
          .where('id', '=', moveTo.sprintId)
          .where('board_id', '=', sprint.board_id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!row || row.id === sprint.id || row.state === 'closed') {
          return { error: 'invalid_target' as const };
        }
        target = row;
      } else if (moveTo.type === 'new') {
        const counted = await trx
          .selectFrom('sprint')
          .select(({ fn }) => [fn.countAll<string>().as('n'), fn.max('sequence').as('top')])
          .where('board_id', '=', sprint.board_id)
          .executeTakeFirstOrThrow();
        const row = await trx
          .insertInto('sprint')
          .values({
            workspace_id: request.workspaceId,
            board_id: sprint.board_id,
            name: moveTo.name ?? `${board.name} Sprint ${Number(counted.n) + 1}`,
            sequence: (counted.top ?? 0) + 1,
            created_by: user.id,
          })
          .returning(['id', 'state'])
          .executeTakeFirstOrThrow();
        target = row;
      }
      const members = await sql<{ id: number; done: boolean; on_board: boolean }>`
        SELECT k.id, k.status_id = ANY(${done}::int[]) AS done, (${boardScopeSql}) AS on_board
          FROM sprint_ticket st JOIN ticket k ON k.id = st.ticket_id
         WHERE st.sprint_id = ${sprint.id}::int AND st.open`.execute(trx);
      const finished = members.rows.filter((m) => m.done).map((m) => m.id);
      const carried = members.rows.filter((m) => !m.done && m.on_board).map((m) => m.id);
      const others = members.rows.filter((m) => !m.done && !m.on_board).map((m) => m.id);
      const now = new Date();
      await recordChanges(trx, request, board.settings, sprint.id, 'completed', finished, {
        at: now,
      });
      await recordChanges(
        trx,
        request,
        board.settings,
        sprint.id,
        'carried_over',
        [...carried, ...others],
        { at: now },
      );
      if (target && carried.length > 0) {
        await trx
          .updateTable('sprint_change')
          .set({ to_sprint_id: target.id })
          .where('sprint_id', '=', sprint.id)
          .where('kind', '=', 'carried_over')
          .where('ticket_id', 'in', carried)
          .execute();
      }
      await trx
        .updateTable('sprint_ticket')
        .set({ open: false })
        .where('sprint_id', '=', sprint.id)
        .execute();
      if (target && carried.length > 0) {
        await trx
          .insertInto('sprint_ticket')
          .values(
            carried.map((ticketId) => ({
              workspace_id: request.workspaceId,
              sprint_id: (target as { id: number }).id,
              ticket_id: ticketId,
            })),
          )
          .execute();
        await recordChanges(trx, request, board.settings, target.id, 'added', carried, {
          afterStart: target.state === 'active',
          at: now,
        });
      }
      await trx
        .updateTable('sprint')
        .set({
          state: 'closed',
          completed_at: now,
          completed_by: user.id,
          version: sprint.version + 1,
          updated_at: now,
        })
        .where('id', '=', sprint.id)
        .execute();
      await emit(trx, by(request), {
        type: 'sprint.completed',
        subjectId: sprint.id,
        payload: {
          boardId: sprint.board_id,
          completed: finished.length,
          carriedOver: carried.length,
          toBacklog: others.length + (target ? 0 : carried.length),
          moveTo: moveTo.type,
          toSprintId: target?.id ?? null,
        },
      });
      return {
        completed: finished.length,
        carriedOver: target ? carried.length : 0,
        toBacklog: others.length + (target ? 0 : carried.length),
        toSprintId: target?.id ?? null,
      };
    });
    if ('error' in outcome) {
      if (outcome.error === 'invalid_target') {
        return invalidFields(reply, { 'moveTo.sprintId': 'not_found' });
      }
      return reply.code(409).send(outcome);
    }
    const row = await db
      .selectFrom('sprint')
      .selectAll()
      .where('id', '=', sprint.id)
      .executeTakeFirstOrThrow();
    return { sprint: sprintView(row), ...outcome };
  });

  app.delete('/api/v1/sprints/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const found = await sprintAndBoard(request, reply);
    if (!found) return reply;
    const { sprint, board } = found;
    if (!board.manage) return forbidden(reply, 'manage_sprints');
    if (sprint.state === 'active') return reply.code(409).send({ error: 'sprint_active' });
    await db.transaction().execute(async (trx) => {
      if (sprint.state === 'future') {
        // Never started: no history to keep; its tickets go back to the backlog.
        await trx.deleteFrom('sprint').where('id', '=', sprint.id).execute();
      } else {
        // A completed sprint leaves reports; its rows stay as its tickets' history.
        await trx
          .updateTable('sprint')
          .set({ deleted_at: new Date() })
          .where('id', '=', sprint.id)
          .execute();
      }
      await emit(trx, by(request), {
        type: 'sprint.deleted',
        subjectId: sprint.id,
        payload: { boardId: sprint.board_id, name: sprint.name, state: sprint.state },
      });
    });
    return reply.code(204).send();
  });

  // ---- Tickets ----

  /**
   * Resolves the tickets of a request: each must be on the board for the caller, and the caller
   * must schedule or edit tickets in its track. Answers the refusal itself and returns null.
   */
  async function ticketsFor(
    request: FastifyRequest,
    reply: FastifyReply,
    board: SprintBoard,
    refs: readonly (number | string)[],
  ): Promise<number[] | null> {
    const ids: number[] = [];
    for (const [i, ref] of refs.entries()) {
      const t = await resolveTicket(db, request.workspaceId, ref);
      if (!t) {
        await invalidFields(reply, { [`tickets.${i}`]: 'not_found' });
        return null;
      }
      if (!ids.includes(t.id)) ids.push(t.id);
    }
    let rows: { id: number; track_id: number }[];
    try {
      const c = await compiled(request, board);
      rows = await readOnly(db, timeoutMs, async (trx) =>
        trx
          .selectFrom('ticket as k')
          .select(['k.id', 'k.track_id'])
          .where('k.id', 'in', ids)
          .where(c.scope)
          .execute(),
      );
    } catch (error) {
      await searchRefusal(reply, error, timeoutMs);
      return null;
    }
    if (rows.length !== ids.length) {
      const seen = new Set(rows.map((r) => r.id));
      const missing = ids.findIndex((id) => !seen.has(id));
      await invalidFields(reply, { [`tickets.${missing}`]: 'not_on_board' });
      return null;
    }
    for (const trackId of new Set(rows.map((r) => r.track_id))) {
      const held = await request.authz.track(trackId);
      if (!held.has('schedule_tickets') && !held.has('edit_tickets')) {
        await forbidden(reply, 'schedule_tickets');
        return null;
      }
    }
    return ids;
  }

  app.post('/api/v1/sprints/:id/tickets', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = sprintTicketsBody.safeParse(request.body);
    const found = await sprintAndBoard(request, reply);
    if (!found) return reply;
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const { sprint, board } = found;
    if (sprint.state === 'closed') return reply.code(409).send({ error: 'sprint_closed' });
    const ids = await ticketsFor(request, reply, board, parsed.data.tickets);
    if (!ids) return reply;
    const outcome = await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('sprint')
        .select('state')
        .where('id', '=', sprint.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.state === 'closed') return { error: 'sprint_closed' as const };
      const open = await trx
        .selectFrom('sprint_ticket as st')
        .innerJoin('sprint as s', 's.id', 'st.sprint_id')
        .select(['st.ticket_id', 'st.sprint_id', 's.state', 's.board_id'])
        .where('st.ticket_id', 'in', ids)
        .where('st.open', '=', true)
        .forUpdate()
        .execute();
      const already = new Set(
        open.filter((o) => o.sprint_id === sprint.id).map((o) => o.ticket_id),
      );
      const moving = open.filter((o) => o.sprint_id !== sprint.id);
      const now = new Date();
      // Leaving another open sprint: removed from it (scope change there once started).
      const bySource = new Map<number, { state: string; tickets: number[] }>();
      for (const o of moving) {
        const entry = bySource.get(o.sprint_id) ?? { state: o.state, tickets: [] };
        entry.tickets.push(o.ticket_id);
        bySource.set(o.sprint_id, entry);
      }
      for (const [sourceId, entry] of bySource) {
        await recordChanges(trx, request, board.settings, sourceId, 'removed', entry.tickets, {
          afterStart: entry.state === 'active',
          toSprintId: sprint.id,
          at: now,
        });
        await trx
          .deleteFrom('sprint_ticket')
          .where('sprint_id', '=', sourceId)
          .where('ticket_id', 'in', entry.tickets)
          .execute();
      }
      const adding = ids.filter((id) => !already.has(id));
      if (adding.length > 0) {
        await trx
          .insertInto('sprint_ticket')
          .values(
            adding.map((ticketId) => ({
              workspace_id: request.workspaceId,
              sprint_id: sprint.id,
              ticket_id: ticketId,
              added_at: now,
            })),
          )
          .execute();
        await recordChanges(trx, request, board.settings, sprint.id, 'added', adding, {
          afterStart: current.state === 'active',
          at: now,
        });
      }
      await emit(trx, by(request), {
        type: 'sprint.tickets_added',
        subjectId: sprint.id,
        payload: {
          ticketIds: adding,
          fromSprintIds: [...bySource.keys()],
          afterStart: current.state === 'active',
        },
      });
      return { added: adding.length, afterStart: current.state === 'active' };
    });
    if ('error' in outcome) return reply.code(409).send(outcome);
    return outcome;
  });

  app.post('/api/v1/sprints/:id/tickets/remove', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = sprintTicketsBody.safeParse(request.body);
    const found = await sprintAndBoard(request, reply);
    if (!found) return reply;
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const { sprint, board } = found;
    if (sprint.state === 'closed') return reply.code(409).send({ error: 'sprint_closed' });
    const ids = await ticketsFor(request, reply, board, parsed.data.tickets);
    if (!ids) return reply;
    const outcome = await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('sprint')
        .select('state')
        .where('id', '=', sprint.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.state === 'closed') return { error: 'sprint_closed' as const };
      const members = await trx
        .selectFrom('sprint_ticket')
        .select('ticket_id')
        .where('sprint_id', '=', sprint.id)
        .where('ticket_id', 'in', ids)
        .forUpdate()
        .execute();
      const removing = members.map((m) => m.ticket_id);
      if (removing.length !== ids.length) return { error: 'not_in_sprint' as const };
      await recordChanges(trx, request, board.settings, sprint.id, 'removed', removing, {
        afterStart: current.state === 'active',
      });
      await trx
        .deleteFrom('sprint_ticket')
        .where('sprint_id', '=', sprint.id)
        .where('ticket_id', 'in', removing)
        .execute();
      await emit(trx, by(request), {
        type: 'sprint.tickets_removed',
        subjectId: sprint.id,
        payload: { ticketIds: removing, afterStart: current.state === 'active' },
      });
      return { removed: removing.length, afterStart: current.state === 'active' };
    });
    if ('error' in outcome) {
      if (outcome.error === 'not_in_sprint')
        return invalidFields(reply, { tickets: outcome.error });
      return reply.code(409).send(outcome);
    }
    return outcome;
  });

  // ---- Report ----

  app.get('/api/v1/sprints/:id/report', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const found = await sprintAndBoard(request, reply);
    if (!found) return reply;
    const { sprint, board } = found;
    if (sprint.state === 'future') return reply.code(409).send({ error: 'sprint_not_started' });
    const scope = await boardScope(db, catalogs, request);
    const done = doneStatuses(board.record);
    const statistic = board.settings.estimation.statistic;
    const changes = await db
      .selectFrom('sprint_change')
      .selectAll()
      .where('sprint_id', '=', sprint.id)
      .orderBy('at')
      .orderBy('id')
      .execute();
    const ticketIds = [...new Set(changes.map((c) => c.ticket_id))];
    const members = await db
      .selectFrom('sprint_ticket')
      .select('ticket_id')
      .where('sprint_id', '=', sprint.id)
      .execute();
    for (const m of members) if (!ticketIds.includes(m.ticket_id)) ticketIds.push(m.ticket_id);
    interface TicketRow {
      id: number;
      key: string;
      summary: string;
      status_id: number;
      status_name: string;
      estimate: number | string | null;
      remaining_estimate: number | null;
    }
    // Only the tickets the viewer may see (the ticket filter over `ticket k`).
    const live =
      ticketIds.length === 0
        ? []
        : (
            await sql<TicketRow>`
          SELECT k.id, t.key || '-' || k.number AS key, k.summary, k.status_id,
                 s.name AS status_name, ${estimateSql(board.settings)} AS estimate,
                 k.remaining_estimate
            FROM ticket k JOIN track t ON t.id = k.track_id JOIN status s ON s.id = k.status_id
           WHERE k.id = ANY(${ticketIds}::int[]) AND k.workspace_id = ${request.workspaceId}::int
             AND k.deleted_at IS NULL AND ${scope.filter.sql}`.execute(db)
          ).rows;
    const visible = new Map(live.map((r) => [r.id, r]));
    const valueAt = (c: (typeof changes)[number] | undefined): number | null => {
      if (!c) return null;
      if (statistic === 'ticketCount') return 1;
      if (statistic === 'originalEstimate') return c.original_estimate;
      return num(c.points);
    };
    const doneSet = new Set(done);
    const closed = sprint.state === 'closed';
    const groups = {
      completed: [] as unknown[],
      notCompleted: [] as unknown[],
      removed: [] as unknown[],
    };
    const totals = {
      committed: 0,
      added: 0,
      removed: 0,
      completed: 0,
      notCompleted: 0,
      estimateChange: 0,
    };
    let remaining = 0;
    for (const id of ticketIds) {
      const t = visible.get(id);
      if (!t) continue;
      const mine = changes.filter((c) => c.ticket_id === id);
      const last = mine[mine.length - 1];
      const removedRow = last?.kind === 'removed' ? last : undefined;
      // Taken out before the start: never part of the sprint, so not scope change either.
      if (removedRow && !removedRow.after_start) continue;
      // The estimate at the start for committed tickets, else when the ticket was added.
      const committed = mine.find((c) => c.kind === 'committed');
      const entry = committed ?? mine.find((c) => c.kind === 'added' && c.after_start) ?? mine[0];
      const addedAfterStart = mine.some((c) => c.kind === 'added' && c.after_start);
      const ending = mine.find((c) => c.kind === 'completed' || c.kind === 'carried_over');
      const atEntry = valueAt(entry);
      const atEnd = removedRow
        ? valueAt(removedRow)
        : ending
          ? valueAt(ending)
          : statistic === 'ticketCount'
            ? 1
            : num(t.estimate);
      const isDone = ending ? ending.kind === 'completed' : doneSet.has(t.status_id);
      const item = {
        id: t.id,
        key: t.key,
        summary: t.summary,
        status: { id: t.status_id, name: t.status_name },
        addedAfterStart,
        estimateAtEntry: atEntry,
        estimate: atEnd,
        estimateChanged: entry !== undefined && atEntry !== atEnd,
        ...(ending?.kind === 'carried_over' ? { carriedTo: ending.to_sprint_id } : {}),
      };
      if (committed) totals.committed += atEntry ?? 0;
      if (addedAfterStart) totals.added += atEntry ?? 0;
      if (item.estimateChanged) totals.estimateChange += (atEnd ?? 0) - (atEntry ?? 0);
      if (removedRow) {
        groups.removed.push(item);
        totals.removed += atEnd ?? 0;
      } else if (isDone) {
        groups.completed.push(item);
        totals.completed += atEnd ?? 0;
      } else {
        groups.notCompleted.push(item);
        totals.notCompleted += atEnd ?? 0;
        if (!closed) remaining += t.remaining_estimate ?? 0;
      }
    }
    return {
      sprint: sprintView(sprint),
      statistic: board.settings.estimation,
      ...groups,
      totals: {
        ...totals,
        ...(board.settings.timeTracking === 'remainingEstimate' && !closed ? { remaining } : {}),
      },
    };
  });
}
