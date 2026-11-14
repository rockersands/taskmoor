import type { Database } from '@taskmoor/db';
import { knownTimeZone, localDate } from '@taskmoor/query';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { boardScope } from '../boards/data';
import { fold, type ReportState, readReportEvents } from '../reports/events';
import { datesBetween } from '../reports/flow';
import { type ScopeInput, scopeBurndown, scopeByDay } from '../reports/scope-burndown';
import { type Statistic, ticketValue } from '../reports/sprint-charts';
import { viewerTimeZone } from '../reports/zone';
import { doneStatuses } from '../sprints/lifecycle';
import { resolveTicket } from '../tickets/store';
import type { SprintBoard, SprintRouteDeps } from './sprints';

/**
 * Release and outcome reports of a Scrum board (M1-062; RPT-001; ADR-059): the release burndown
 * and the outcome burndown sprint by sprint, and the release report day by day, by the board's
 * estimation statistic and done statuses. The tickets are those that ever targeted the release
 * or were ever under the outcome, as far as the viewer may see them now.
 */
const MAX_INT = 2_147_483_647;
const MAX_DAYS = 731;
const idParam = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) }).strict();
const releaseQuery = z
  .object({
    release: z.coerce.number().int().positive().max(MAX_INT),
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .refine((zone) => knownTimeZone(zone))
      .optional(),
  })
  .strict();
const outcomeQuery = z
  .object({
    outcome: z
      .string()
      .min(1)
      .max(64)
      .regex(/^(\d+|[A-Za-z][A-Za-z0-9_]*-\d+)$/),
  })
  .strict();

const outcomeReportQuery = outcomeQuery.extend({ timeZone: releaseQuery.shape.timeZone }).strict();

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

export function registerScopeReportRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  deps: SprintRouteDeps,
): void {
  const { catalogs } = deps;

  /** A Scrum board the caller sees; kanban boards answer 409 `not_scrum`. */
  async function scrumBoard(request: FastifyRequest, reply: FastifyReply) {
    const p = idParam.safeParse(request.params);
    if (!p.success) {
      await notFound(reply);
      return null;
    }
    const board = await deps.board(request, reply, p.data.id);
    if (!board) return null;
    if (board.kind !== 'scrum') {
      await reply.code(409).send({ error: 'not_scrum' });
      return null;
    }
    return board;
  }

  /** The release, if its track is one the caller browses. */
  async function visibleRelease(request: FastifyRequest, id: number) {
    const release = await db
      .selectFrom('release as r')
      .innerJoin('track as t', 't.id', 'r.track_id')
      .select([
        'r.id',
        'r.name',
        'r.track_id',
        'r.start_date',
        'r.release_date',
        'r.shipped_at',
        'r.created_at',
      ])
      .where('r.id', '=', id)
      .where('r.workspace_id', '=', request.workspaceId)
      .where('t.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!release) return null;
    const held = await request.authz.track(release.track_id);
    if (held.has('browse_track') || held.has('administer_track')) return release;
    const global = await request.authz.global();
    return global.has('site_admin') || global.has('configuration_admin') ? release : null;
  }

  /** The report inputs of the tickets in `candidates` the caller sees. */
  async function inputs(
    request: FastifyRequest,
    board: SprintBoard,
    candidates: readonly number[],
    member: ScopeInput['member'],
  ): Promise<ScopeInput> {
    const scope = await boardScope(db, catalogs, request);
    const visible =
      candidates.length === 0
        ? []
        : (
            await sql<{ id: number }>`
              SELECT k.id FROM ticket k
               WHERE k.id = ANY(${[...candidates]}::int[]) AND k.workspace_id = ${request.workspaceId}::int
                 AND ${scope.filter.sql}`.execute(db)
          ).rows.map((r) => r.id);
    const estimation = board.settings.estimation;
    const statistic: Statistic =
      estimation.statistic === 'field'
        ? { statistic: 'field', fieldId: estimation.fieldId as number }
        : { statistic: estimation.statistic };
    return {
      member,
      estimation: statistic,
      burnRemaining:
        board.settings.timeTracking === 'remainingEstimate' &&
        estimation.statistic === 'originalEstimate',
      done: new Set(doneStatuses(board.record)),
      events: await readReportEvents(
        db,
        request.workspaceId,
        visible,
        statistic.statistic === 'field' ? { numberFields: [statistic.fieldId] } : {},
      ),
      now: new Date(),
    };
  }

  /** Every ticket that ever targeted the release, by its history. */
  const everInRelease = async (workspaceId: number, releaseId: number) =>
    (
      await sql<{ ticket_id: number }>`
        SELECT DISTINCT ticket_id FROM ticket_change
         WHERE workspace_id = ${workspaceId}::int AND field = 'targetRelease'
           AND ${String(releaseId)} = ANY(string_to_array(to_value, ','))`.execute(db)
    ).rows.map((r) => r.ticket_id);

  /** The outcome by key or id, if the caller may see it. */
  async function visibleOutcome(request: FastifyRequest, keyOrId: string) {
    const found = await resolveTicket(db, request.workspaceId, keyOrId);
    if (!found) return undefined;
    const scope = await boardScope(db, catalogs, request);
    return (
      await sql<{ id: number; key: string; summary: string; createdAt: Date }>`
        SELECT k.id, t.key || '-' || k.number AS key, k.summary, k.created_at AS "createdAt"
          FROM ticket k JOIN track t ON t.id = k.track_id
         WHERE k.id = ${found.id}::int AND k.workspace_id = ${request.workspaceId}::int
           AND k.deleted_at IS NULL AND ${scope.filter.sql}`.execute(db)
    ).rows[0];
  }

  /** Every ticket that was ever under the outcome, by its history. */
  const everUnder = async (workspaceId: number, outcomeId: number) =>
    (
      await sql<{ ticket_id: number }>`
        SELECT DISTINCT ticket_id FROM ticket_change
         WHERE workspace_id = ${workspaceId}::int AND field = 'parent'
           AND to_value = ${String(outcomeId)}`.execute(db)
    ).rows.map((r) => r.ticket_id);

  /** The board's sprints that started, in start order. */
  const startedSprints = (boardId: number) =>
    db
      .selectFrom('sprint')
      .select(['id', 'name', 'state', 'started_at', 'completed_at'])
      .where('board_id', '=', boardId)
      .where('deleted_at', 'is', null)
      .where('started_at', 'is not', null)
      .orderBy('started_at')
      .orderBy('id')
      .execute();

  const burndown = async (board: SprintBoard, input: ScopeInput) => {
    const sprints = await startedSprints(board.record.id);
    const report = scopeBurndown({
      ...input,
      sprints: sprints.map((s) => ({
        id: s.id,
        startedAt: s.started_at as Date,
        completedAt: s.state === 'closed' ? s.completed_at : null,
      })),
    });
    const byId = new Map(sprints.map((s) => [s.id, s]));
    return {
      statistic: board.settings.estimation,
      ...report,
      sprints: report.sprints.map((w) => {
        const s = byId.get(w.sprintId);
        return {
          ...w,
          name: s?.name ?? '',
          state: s?.state ?? 'closed',
          startedAt: s?.started_at?.toISOString() ?? null,
          completedAt: s?.completed_at?.toISOString() ?? null,
        };
      }),
    };
  };

  // Release burndown: the release's remaining work at each sprint of the board.
  app.get('/api/v1/boards/:id/reports/release-burndown', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const q = releaseQuery.safeParse(request.query);
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const board = await scrumBoard(request, reply);
    if (!board) return reply;
    const release = await visibleRelease(request, q.data.release);
    if (!release) return notFound(reply);
    const candidates = await everInRelease(request.workspaceId, release.id);
    const input = await inputs(request, board, candidates, (s: ReportState) =>
      s.targetReleases.has(release.id),
    );
    return { release: { id: release.id, name: release.name }, ...(await burndown(board, input)) };
  });

  // Outcome burndown: the work under an outcome at each sprint of the board.
  app.get('/api/v1/boards/:id/reports/outcome-burndown', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const q = outcomeQuery.safeParse(request.query);
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const board = await scrumBoard(request, reply);
    if (!board) return reply;
    const outcome = await visibleOutcome(request, q.data.outcome);
    if (!outcome) return notFound(reply);
    const candidates = await everUnder(request.workspaceId, outcome.id);
    const input = await inputs(request, board, candidates, (s) => s.parentId === outcome.id);
    const { createdAt: _, ...shown } = outcome;
    return { outcome: shown, ...(await burndown(board, input)) };
  });

  // Release report: the release's scope and completed work day by day, with a forecast date.
  app.get('/api/v1/boards/:id/reports/release-report', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const q = releaseQuery.safeParse(request.query);
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const board = await scrumBoard(request, reply);
    if (!board) return reply;
    const release = await visibleRelease(request, q.data.release);
    if (!release) return notFound(reply);
    const timeZone = viewerTimeZone(request, q.data.timeZone);
    const candidates = await everInRelease(request.workspaceId, release.id);
    const input = await inputs(request, board, candidates, (s: ReportState) =>
      s.targetReleases.has(release.id),
    );
    // From the release's start, else the first day a ticket targeted it; at most two years.
    const first = input.events.find(
      (e) =>
        e.kind === 'field' &&
        e.field === 'targetRelease' &&
        (e.to ?? '').split(',').includes(String(release.id)),
    );
    const today = localDate(input.now, timeZone);
    let from = release.start_date ?? localDate(first?.at ?? release.created_at, timeZone);
    if (from > today) from = today;
    const span = datesBetween(from, today);
    if (span.length > MAX_DAYS) from = span[span.length - MAX_DAYS] as string;
    const report = scopeByDay({ ...input, from, timeZone });
    return {
      release: {
        id: release.id,
        name: release.name,
        startDate: release.start_date,
        releaseDate: release.release_date,
        shippedAt: release.shipped_at?.toISOString() ?? null,
      },
      statistic: board.settings.estimation,
      timeZone,
      ...report,
    };
  });

  // Outcome report: the work under an outcome day by day, and its tickets as they stand now.
  app.get('/api/v1/boards/:id/reports/outcome-report', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const q = outcomeReportQuery.safeParse(request.query);
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const board = await scrumBoard(request, reply);
    if (!board) return reply;
    const outcome = await visibleOutcome(request, q.data.outcome);
    if (!outcome) return notFound(reply);
    const timeZone = viewerTimeZone(request, q.data.timeZone);
    const candidates = await everUnder(request.workspaceId, outcome.id);
    const member = (s: ReportState) => s.parentId === outcome.id;
    const input = await inputs(request, board, candidates, member);
    // From the first day a ticket came under it, else the day it was made; at most two years.
    const first = input.events.find(
      (e) => e.kind === 'field' && e.field === 'parent' && e.to === String(outcome.id),
    );
    const today = localDate(input.now, timeZone);
    let from = localDate(first?.at ?? outcome.createdAt, timeZone);
    if (from > today) from = today;
    const span = datesBetween(from, today);
    if (span.length > MAX_DAYS) from = span[span.length - MAX_DAYS] as string;
    const report = scopeByDay({ ...input, from, timeZone });
    // The tickets under it now, by the same events, as the board measures and finishes them.
    const now = [...fold(input.events)].filter(([, s]) => !s.inTrash && member(s));
    const shown = new Map(
      now.length === 0
        ? []
        : (
            await sql<{ id: number; key: string; summary: string; status: string }>`
              SELECT k.id, t.key || '-' || k.number AS key, k.summary, st.name AS status
                FROM ticket k JOIN track t ON t.id = k.track_id
                JOIN status st ON st.id = k.status_id
               WHERE k.id = ANY(${now.map(([id]) => id)}::int[])`.execute(db)
          ).rows.map((r) => [r.id, r]),
    );
    const estimated = (s: ReportState) => {
      const e = input.estimation;
      if (e.statistic === 'ticketCount') return true;
      if (e.statistic === 'originalEstimate') {
        return (input.burnRemaining ? s.remainingEstimate : s.originalEstimate) !== null;
      }
      return (s.numbers[e.fieldId] ?? null) !== null;
    };
    const tickets = now
      .flatMap(([id, s]) => {
        const row = shown.get(id);
        return row
          ? [
              {
                ...row,
                done: s.statusId !== null && input.done.has(s.statusId),
                value: ticketValue(s, input),
                estimated: estimated(s),
              },
            ]
          : [];
      })
      .sort((a, b) => Number(a.done) - Number(b.done) || a.id - b.id);
    const { createdAt: _, ...about } = outcome;
    return {
      outcome: about,
      statistic: board.settings.estimation,
      timeZone,
      ...report,
      tickets,
      counts: {
        done: tickets.filter((t) => t.done).length,
        open: tickets.filter((t) => !t.done).length,
        unestimated: tickets.filter((t) => !t.done && !t.estimated).length,
      },
    };
  });
}
