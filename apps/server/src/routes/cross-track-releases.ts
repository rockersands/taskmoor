import type { CrossTrackEndRule, Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import { requireUser } from '../auth';
import { boardScope, compileQuery } from '../boards/data';
import { diff, emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import {
  type CrossTrackState,
  candidatesQuery,
  createBody,
  crossTrackState,
  idParam,
  LIST_PAGE,
  listQuery,
  MAX_CANDIDATES,
  MAX_MEMBERS,
  type MoveOutcome,
  memberBody,
  memberParam,
  moveBody,
  moveOutcome,
  moveQuery,
  PLAN_RELEASES,
  planReleasesQuery,
  updateBody,
} from '../plans/cross-track';
import { browsedTracks, planTickets, sourceRows } from '../plans/query';
import { viewerDay } from '../reports/zone';
import { type CrossTrackSight, requestSight, seenLinkedTracks } from '../search/cross-track';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { planVisible } from './plans';
import { countQuery, listTicketsWhere } from './release-hub';
import { releaseQuery, releaseView } from './releases';
import { searchRefusal } from './search';

/**
 * Releases across tracks (T-089c; PLN-007; ADR-122 stage 4): one lines up several tracks' own
 * releases on one end. It belongs to the workspace, not to a plan, and holds no tickets: its work
 * is the target tickets of its linked releases. Each linked release stays the track's own.
 *
 * - Seen by its owner, site and configuration administrators and anyone who may see one of its
 *   linked tracks (`search/cross-track.ts`); everyone else gets the 404 of an id that does not
 *   exist, on every route.
 * - A viewer is told of the linked releases of tracks they may see, and only counts of the rest:
 *   `hidden: { releases, open }`, one number each, never per release. No route takes a filter or a
 *   period and nobody can link a release of a track they do not administer, so nobody can narrow
 *   that count to read someone else's work.
 * - The state is judged on all the work, hidden work too (`crossTrackState`); nothing ships by
 *   itself. Stage counts, warnings and tickets read through the search runner as the viewer, so
 *   each number equals its search.
 * - Moving the date is the owner's and administrators', after a change list that changes nothing.
 *   Each release moves only if the mover could `PATCH` it, and says why when it does not.
 *
 * Each write emits one `cross_track_release.*` event in its transaction; a move also emits a
 * `release.updated` per release it moved, so each track's own trail hears of it.
 */
type Db = Kysely<Database> | Transaction<Database>;

interface Row {
  id: number;
  name: string;
  description: string;
  owner_id: number;
  owner_name: string;
  end_rule: CrossTrackEndRule;
  release_date: string | null;
  version: number;
}

interface MemberRow {
  cross_track_release_id: number;
  release_id: number;
  track_id: number;
  name: string;
  start_date: string | null;
  release_date: string | null;
  shipped_at: Date | null;
  archived_at: Date | null;
  track_key: string;
  track_name: string;
  track_archived: boolean;
  track_deleted: boolean;
}

interface Work {
  tickets: number;
  open: number;
  seen: number;
  seenOpen: number;
}

const NO_WORK: Work = { tickets: 0, open: 0, seen: 0, seenOpen: 0 };

export interface CrossTrackRouteOptions {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });
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

const rowQuery = (db: Db, ws: number) =>
  db
    .selectFrom('cross_track_release as c')
    .innerJoin('app_user as o', 'o.id', 'c.owner_id')
    .select([
      'c.id',
      'c.name',
      'c.description',
      'c.owner_id',
      'o.name as owner_name',
      'c.end_rule',
      'c.release_date',
      'c.version',
    ])
    .where('c.workspace_id', '=', ws);

/** The linked releases of these, whichever the viewer sees, with their tracks. */
async function readMembers(db: Db, ids: readonly number[]): Promise<MemberRow[]> {
  if (ids.length === 0) return [];
  return (
    await sql<MemberRow>`
      SELECT m.cross_track_release_id, m.release_id, m.track_id, r.name,
             r.start_date::text AS start_date, r.release_date::text AS release_date, r.shipped_at,
             r.archived_at, t.key AS track_key, t.name AS track_name,
             t.archived_at IS NOT NULL AS track_archived,
             t.deleted_at IS NOT NULL AS track_deleted
        FROM cross_track_release_member m
        JOIN release r ON r.id = m.release_id
        JOIN track t ON t.id = m.track_id
       WHERE m.cross_track_release_id = ANY(${[...ids]}::int[])
       ORDER BY m.cross_track_release_id, t.key, r.id`.execute(db)
  ).rows;
}

/**
 * Target tickets of these per linked release, all of them and those the viewer sees, in one
 * statement, under a search's conditions: outside the trash and archived tracks.
 */
async function readWork(
  db: Db,
  ids: readonly number[],
  visible: RawBuilder<boolean>,
): Promise<Map<number, Work>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<Work & { release_id: number }>`
    SELECT m.release_id,
           count(*)::int AS tickets,
           count(*) FILTER (WHERE st.stage <> 'closed')::int AS open,
           count(*) FILTER (WHERE ${visible})::int AS seen,
           count(*) FILTER (WHERE st.stage <> 'closed' AND ${visible})::int AS "seenOpen"
      FROM cross_track_release_member m
      JOIN ticket_release tr ON tr.release_id = m.release_id AND tr.role = 'target'
      JOIN ticket k ON k.id = tr.ticket_id
      JOIN track kt ON kt.id = k.track_id
      JOIN status st ON st.id = k.status_id
     WHERE m.cross_track_release_id = ANY(${[...ids]}::int[])
       AND k.deleted_at IS NULL AND kt.deleted_at IS NULL AND kt.archived_at IS NULL
     GROUP BY m.release_id`.execute(db);
  return new Map(rows.map((r) => [r.release_id, r]));
}

/** What every viewer is told and judged by, for one release across tracks. */
interface Summary {
  state: CrossTrackState;
  /** Linked releases the viewer may see, by their tracks. */
  seen: MemberRow[];
  hidden: { releases: number; open: number };
  progress: { tickets: number; closed: number; open: number };
}

/**
 * `today` is the viewer's own day (`viewerDay`, T-287), as for a track's own releases (T-282): a
 * fixed day that has passed where they are is overdue to them, whatever the day is in UTC.
 */
function summarize(
  row: Pick<Row, 'end_rule' | 'release_date'>,
  members: readonly MemberRow[],
  work: ReadonlyMap<number, Work>,
  sees: (trackId: number) => boolean,
  today: string,
): Summary {
  // A track in the trash drops out for everyone until it is restored.
  const live = members.filter((m) => !m.track_deleted);
  // An archived release, or one of an archived track, stops counting towards the state.
  const counting = live.filter((m) => m.archived_at === null && !m.track_archived);
  const of = (m: MemberRow) => work.get(m.release_id) ?? NO_WORK;
  const seen = live.filter((m) => sees(m.track_id));
  const allOpen = live.reduce((n, m) => n + of(m).open, 0);
  // A hidden release's tickets never count as seen, even one seen through a ticket-level grant, or
  // the count would say that ticket is linked here. It equals the search, which binds the same way.
  const seenTickets = seen.reduce((n, m) => n + of(m).seen, 0);
  const seenOpen = seen.reduce((n, m) => n + of(m).seenOpen, 0);
  return {
    state: crossTrackState({
      endRule: row.end_rule,
      date: row.release_date,
      today,
      releases: counting.length,
      shipped: counting.filter((m) => m.shipped_at !== null).length,
      tickets: counting.reduce((n, m) => n + of(m).tickets, 0),
      open: counting.reduce((n, m) => n + of(m).open, 0),
    }),
    seen,
    hidden: { releases: live.length - seen.length, open: allOpen - seenOpen },
    progress: { tickets: seenTickets, closed: seenTickets - seenOpen, open: seenOpen },
  };
}

/** Upcoming, with a day other than the release across tracks' fixed day. */
const outOfStep = (row: Pick<Row, 'end_rule' | 'release_date'>, m: MemberRow) =>
  row.end_rule === 'fixed_date' &&
  m.shipped_at === null &&
  m.archived_at === null &&
  !m.track_archived &&
  m.release_date !== row.release_date;

const trackOf = (m: MemberRow) => ({ id: m.track_id, key: m.track_key, name: m.track_name });

/** A linked release as the viewer sees it, overdue against their own `today` (T-287). */
function memberView(
  row: Pick<Row, 'end_rule' | 'release_date'>,
  m: MemberRow,
  today: string,
  work?: Work,
) {
  const counts = work ?? NO_WORK;
  // A release of an archived track counts as archived, as it does for the state.
  const archived = m.archived_at !== null || m.track_archived;
  return {
    id: m.release_id,
    name: m.name,
    track: trackOf(m),
    startDate: m.start_date,
    releaseDate: m.release_date,
    shipped: m.shipped_at !== null,
    archived,
    trackArchived: m.track_archived,
    overdue:
      !archived && m.shipped_at === null && m.release_date !== null && m.release_date < today,
    outOfStep: outOfStep(row, m),
    // Only what this viewer may see counts here: the rest is the one hidden number.
    progress: {
      tickets: counts.seen,
      closed: counts.seen - counts.seenOpen,
      open: counts.seenOpen,
    },
  };
}

export function registerCrossTrackReleaseRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: CrossTrackRouteOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  /** A function from a track to whether the viewer may see it; loads once per call. */
  async function trackSight(request: FastifyRequest, sight: CrossTrackSight) {
    const tracks = await seenLinkedTracks(db, request.workspaceId, sight);
    return (trackId: number) => tracks === 'all' || tracks.has(trackId);
  }

  /**
   * The release across tracks with its members, when the person sees it; else null, and the route
   * answers as for an id that does not exist.
   */
  async function open(request: FastifyRequest, id: number) {
    const ws = request.workspaceId;
    const row = (await rowQuery(db, ws).where('c.id', '=', id).executeTakeFirst()) as
      | Row
      | undefined;
    if (!row) return null;
    const sight = requestSight(request);
    const admin = await sight.admin();
    const sees = await trackSight(request, sight);
    const members = await readMembers(db, [id]);
    const mine = row.owner_id === request.user?.id;
    const linked = members.some((m) => !m.track_deleted && sees(m.track_id));
    if (!admin && !mine && !linked) return null;
    return { row, members, sees, mayManage: admin || mine };
  }

  /** Whether the person may change a track's releases: its administrators and administrators. */
  async function mayChangeTrack(request: FastifyRequest, trackId: number): Promise<boolean> {
    if (await request.authz.can('administer_track', trackId)) return true;
    return requestSight(request).admin();
  }

  /** The tracks of these members the person may change, once each. */
  async function changeable(request: FastifyRequest, members: readonly MemberRow[]) {
    const out = new Set<number>();
    for (const trackId of new Set(members.map((m) => m.track_id))) {
      if (await mayChangeTrack(request, trackId)) out.add(trackId);
    }
    return out;
  }

  const visibleFilter = async (request: FastifyRequest) => (await request.authz.ticketFilter()).sql;

  /**
   * Why a release may not be linked by this person, or null. `not_found` for one they may not see,
   * as for none; the rest only of one they see.
   */
  async function linkProblem(
    request: FastifyRequest,
    trx: Db,
    releaseId: number,
  ): Promise<{ code: string; trackId: number; name: string } | { missing: true } | null> {
    const release = await trx
      .selectFrom('release as r')
      .innerJoin('track as t', 't.id', 'r.track_id')
      .select([
        'r.id',
        'r.track_id',
        'r.name',
        'r.shipped_at',
        'r.archived_at',
        't.archived_at as track_archived_at',
        't.deleted_at as track_deleted_at',
      ])
      .where('r.id', '=', releaseId)
      .where('r.workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    if (!release || release.track_deleted_at) return { missing: true };
    const sight = requestSight(request);
    if (!(await sight.admin()) && !(await sight.track(release.track_id))) return { missing: true };
    const problem = (code: string) => ({ code, trackId: release.track_id, name: release.name });
    if (!(await mayChangeTrack(request, release.track_id))) return problem('forbidden');
    if (release.track_archived_at) return problem('track_archived');
    if (release.archived_at) return problem('release_archived');
    if (release.shipped_at) return problem('release_shipped');
    return null;
  }

  /** A refused link as the routes answer it. */
  const refuseLink = (reply: FastifyReply, code: string) =>
    code === 'forbidden'
      ? forbidden(reply, 'administer_track')
      : reply.code(409).send({ error: code });

  /** Which of the unique rules a failed insert broke, or null when it was none of them. */
  function takenCode(error: unknown): 'release_taken' | 'track_taken' | null {
    const e = error as { code?: string; constraint?: string };
    if (e.code !== '23505') return null;
    if (e.constraint === 'cross_track_release_member_pkey') return 'release_taken';
    if (e.constraint === 'cross_track_release_member_track_key') return 'track_taken';
    return null;
  }

  /** The full answer of `GET /cross-track-releases/:id`. */
  async function fullAnswer(
    request: FastifyRequest,
    reply: FastifyReply,
    opened: NonNullable<Awaited<ReturnType<typeof open>>>,
  ) {
    const { row, members, sees, mayManage } = opened;
    try {
      const scope = await boardScope(db, options.catalogs, request);
      const visible = await visibleFilter(request);
      const work = await readWork(db, [row.id], visible);
      const today = viewerDay(request);
      const summary = summarize(row, members, work, sees, today);
      const base = `crossTrackRelease = ${row.id}`;
      const q = `${base} AND stage != closed`;
      const count = (text: string) => countQuery(db, timeoutMs, request, scope, text);
      const [newCount, activeCount, closedCount, openCount, unassigned] = await Promise.all([
        count(`${base} AND stage = new`),
        count(`${base} AND stage = active`),
        count(`${base} AND stage = closed`),
        count(q),
        count(`${q} AND assignee IS EMPTY`),
      ]);
      const where = await compileQuery(db, scope, base, new Date());
      const tickets = await readOnly(db, timeoutMs, (trx) => listTicketsWhere(trx, where));
      const steps = summary.seen.filter((m) => outOfStep(row, m)).length;
      const warnings = [
        ...(summary.state === 'overdue' && openCount.count > 0
          ? [{ code: 'overdue' as const, count: openCount.count, query: q }]
          : []),
        ...(summary.state !== 'shipped' && unassigned.count > 0
          ? [{ code: 'unassigned' as const, count: unassigned.count, query: unassigned.query }]
          : []),
        // Hidden releases out of step are not even counted.
        ...(steps > 0 ? [{ code: 'out_of_step' as const, count: steps }] : []),
      ];
      const yours = await changeable(request, summary.seen);
      const sight = requestSight(request);
      const administered = (await sight.admin()) ? 'all' : await sight.allowed('administer_track');
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        endRule: row.end_rule,
        date: row.release_date,
        state: summary.state,
        owner: { id: row.owner_id, name: row.owner_name },
        version: row.version,
        stages: { new: newCount, active: activeCount, closed: closedCount },
        open: openCount,
        warnings,
        members: summary.seen.map((m) => ({
          ...memberView(row, m, today, work.get(m.release_id)),
          // Unlinking: the track's administrators, or the owner and administrators.
          mayRemove: mayManage || yours.has(m.track_id),
        })),
        hidden: summary.hidden,
        tickets: tickets.rows,
        truncated: tickets.truncated,
        viewer: {
          mayManage,
          // Linking asks for a track of their own: someone with none is not offered it.
          mayLink: administered === 'all' || administered.length > 0,
        },
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  }

  // The list: those the person sees, `upcoming` or `shipped`, a page at a time.
  app.get('/api/v1/cross-track-releases', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const q = listQuery.safeParse(request.query ?? {});
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const ws = request.workspaceId;
    const sight = requestSight(request);
    const tracks = await seenLinkedTracks(db, ws, sight);
    const shipped = q.data.state === 'shipped';
    const live = sql`
      SELECT 1 FROM cross_track_release_member lm
        JOIN release lr ON lr.id = lm.release_id
        JOIN track lt ON lt.id = lm.track_id
       WHERE lm.cross_track_release_id = c.id AND lr.archived_at IS NULL
         AND lt.archived_at IS NULL AND lt.deleted_at IS NULL`;
    const allShipped = sql<boolean>`(EXISTS (${live})
      AND NOT EXISTS (${live} AND lr.shipped_at IS NULL))`;
    const end = sql`COALESCE(c.release_date, DATE '9999-12-31')`;
    const at = q.data.cursor?.split('_');
    let query = rowQuery(db, ws)
      .select(sql<string>`${end}::text`.as('end_day'))
      .where(shipped ? allShipped : sql<boolean>`NOT ${allShipped}`);
    if (tracks !== 'all') {
      const ids = [...tracks];
      query = query.where(
        sql<boolean>`(c.owner_id = ${user.id} OR EXISTS (
          SELECT 1 FROM cross_track_release_member sm
           WHERE sm.cross_track_release_id = c.id AND sm.track_id = ANY(${ids}::int[])))`,
      );
    }
    if (at) {
      const [day, id] = at;
      query = query.where(
        shipped
          ? sql<boolean>`(${end}, c.id) < (${day}::date, ${Number(id)}::int)`
          : sql<boolean>`(${end}, c.id) > (${day}::date, ${Number(id)}::int)`,
      );
    }
    const found = (await query
      .orderBy(sql`${end} ${sql.raw(shipped ? 'DESC' : 'ASC')}`)
      .orderBy('c.id', shipped ? 'desc' : 'asc')
      .limit(LIST_PAGE + 1)
      .execute()) as (Row & { end_day: string })[];
    const page = found.slice(0, LIST_PAGE);
    const ids = page.map((r) => r.id);
    const members = await readMembers(db, ids);
    const work = await readWork(db, ids, await visibleFilter(request));
    const sees = (trackId: number) => tracks === 'all' || tracks.has(trackId);
    const today = viewerDay(request);
    const last = page[page.length - 1];
    return {
      releases: page.map((row) => {
        const own = members.filter((m) => m.cross_track_release_id === row.id);
        const summary = summarize(row, own, work, sees, today);
        return {
          id: row.id,
          name: row.name,
          endRule: row.end_rule,
          date: row.release_date,
          state: summary.state,
          owner: { id: row.owner_id, name: row.owner_name },
          tracks: summary.seen.map(trackOf),
          progress: summary.progress,
          hidden: summary.hidden,
          version: row.version,
        };
      }),
      next: found.length > LIST_PAGE && last ? `${last.end_day}_${last.id}` : null,
    };
  });

  // Upcoming unlinked releases of tracks the person administers: what they may link.
  app.get('/api/v1/cross-track-releases/candidates', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = candidatesQuery.safeParse(request.query ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const sight = requestSight(request);
    const admin = await sight.admin();
    const tracks = admin ? 'all' : await sight.allowed('administer_track');
    if (tracks !== 'all' && tracks.length === 0) return { releases: [], truncated: false };
    let query = db
      .selectFrom('release as r')
      .innerJoin('track as t', 't.id', 'r.track_id')
      .leftJoin('cross_track_release_member as m', 'm.release_id', 'r.id')
      .select([
        'r.id',
        'r.name',
        sql<string | null>`r.start_date::text`.as('start_date'),
        sql<string | null>`r.release_date::text`.as('release_date'),
        't.id as track_id',
        't.key as track_key',
        't.name as track_name',
      ])
      .where('r.workspace_id', '=', request.workspaceId)
      .where('m.release_id', 'is', null)
      .where('r.shipped_at', 'is', null)
      .where('r.archived_at', 'is', null)
      .where('t.archived_at', 'is', null)
      .where('t.deleted_at', 'is', null);
    if (tracks !== 'all') query = query.where('r.track_id', 'in', [...tracks]);
    // The list stops at a limit, so a word has to narrow it here for the rest to be found at all.
    if (parsed.data.q) {
      const like = `%${parsed.data.q.replace(/[\\%_]/g, '\\$&')}%`;
      query = query.where(sql<boolean>`(t.key || ' ' || t.name || ' ' || r.name) ILIKE ${like}`);
    }
    const rows = await query
      .orderBy('t.key')
      .orderBy('r.sort_order')
      .orderBy('r.id')
      .limit(MAX_CANDIDATES + 1)
      .execute();
    return {
      releases: rows.slice(0, MAX_CANDIDATES).map((r) => ({
        id: r.id,
        name: r.name,
        startDate: r.start_date,
        releaseDate: r.release_date,
        track: { id: r.track_id, key: r.track_key, name: r.track_name },
      })),
      truncated: rows.length > MAX_CANDIDATES,
    };
  });

  app.post('/api/v1/cross-track-releases', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = createBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    if (body.endRule === 'fixed_date' && !body.date) {
      return invalidFields(reply, { date: 'required' });
    }
    if (body.endRule === 'work_complete' && body.date) {
      return invalidFields(reply, { date: 'not_with_work_complete' });
    }
    if (new Set(body.releaseIds).size !== body.releaseIds.length) {
      return invalidFields(reply, { releaseIds: 'duplicate' });
    }
    const ws = request.workspaceId;
    const fields: Record<string, string> = {};
    const trackIds = new Map<number, number>();
    for (const [i, releaseId] of body.releaseIds.entries()) {
      const problem = await linkProblem(request, db, releaseId);
      if (problem && 'missing' in problem) {
        fields[`releaseIds.${i}`] = 'not_found';
      } else if (problem) {
        return refuseLink(reply, problem.code);
      } else {
        const row = await db
          .selectFrom('release')
          .select('track_id')
          .where('id', '=', releaseId)
          .executeTakeFirstOrThrow();
        trackIds.set(releaseId, row.track_id);
      }
    }
    if (Object.keys(fields).length > 0) return invalidFields(reply, fields);
    if (new Set(trackIds.values()).size !== trackIds.size) {
      return reply.code(409).send({ error: 'track_taken' });
    }
    try {
      const id = await db.transaction().execute(async (trx) => {
        const made = await trx
          .insertInto('cross_track_release')
          .values({
            workspace_id: ws,
            owner_id: user.id,
            name: body.name,
            description: body.description ?? '',
            end_rule: body.endRule,
            release_date: body.date ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('cross_track_release_member')
          .values(
            body.releaseIds.map((releaseId) => ({
              workspace_id: ws,
              cross_track_release_id: made.id,
              release_id: releaseId,
              track_id: trackIds.get(releaseId) as number,
            })),
          )
          .execute();
        await emit(trx, by(request), {
          type: 'cross_track_release.created',
          subjectId: made.id,
          payload: {
            name: body.name,
            endRule: body.endRule,
            date: body.date ?? null,
            releaseIds: body.releaseIds,
          },
        });
        return made.id;
      });
      const opened = await open(request, id);
      if (!opened) return notFound(reply);
      const answer = await fullAnswer(request, reply, opened);
      return reply.sent ? reply : reply.code(201).send(answer);
    } catch (error) {
      const code = takenCode(error);
      if (code) return reply.code(409).send({ error: code });
      throw error;
    }
  });

  app.get('/api/v1/cross-track-releases/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const opened = await open(request, p.data.id);
    if (!opened) return notFound(reply);
    return fullAnswer(request, reply, opened);
  });

  /** A stale version as the routes answer it. */
  const stale = (reply: FastifyReply, version: number) =>
    reply.code(409).send({ error: 'version_conflict', version });

  app.patch('/api/v1/cross-track-releases/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const parsed = updateBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const opened = await open(request, p.data.id);
    if (!opened) return notFound(reply);
    if (!opened.mayManage) return forbidden(reply, 'edit_cross_track_release');
    const outcome = await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('cross_track_release')
        .select(['version', 'name', 'description', 'end_rule', 'release_date'])
        .where('id', '=', p.data.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return { missing: true as const };
      if (locked.version !== body.version) return { conflict: locked.version };
      const toWork = body.endRule === 'work_complete' && locked.end_rule !== 'work_complete';
      const changes = diff<Record<string, unknown>>(
        {
          name: locked.name,
          description: locked.description,
          endRule: locked.end_rule,
          date: locked.release_date,
        },
        {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(toWork ? { endRule: 'work_complete', date: null } : {}),
        },
      );
      if (Object.keys(changes).length === 0) return { unchanged: true as const };
      await trx
        .updateTable('cross_track_release')
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(toWork ? { end_rule: 'work_complete' as const, release_date: null } : {}),
          version: locked.version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', p.data.id)
        .execute();
      await emit(trx, by(request), {
        type: 'cross_track_release.updated',
        subjectId: p.data.id,
        payload: { changes },
      });
      return { updated: true as const };
    });
    if ('missing' in outcome) return notFound(reply);
    if ('conflict' in outcome) return stale(reply, outcome.conflict);
    const fresh = await open(request, p.data.id);
    if (!fresh) return notFound(reply);
    return fullAnswer(request, reply, fresh);
  });

  app.delete('/api/v1/cross-track-releases/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const opened = await open(request, p.data.id);
    if (!opened) return notFound(reply);
    if (!opened.mayManage) return forbidden(reply, 'edit_cross_track_release');
    await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('cross_track_release')
        .select('id')
        .where('id', '=', p.data.id)
        .forUpdate()
        .execute();
      const members = await readMembers(trx, [p.data.id]);
      await trx.deleteFrom('cross_track_release').where('id', '=', p.data.id).execute();
      await emit(trx, by(request), {
        type: 'cross_track_release.deleted',
        subjectId: p.data.id,
        payload: { name: opened.row.name, releaseIds: members.map((m) => m.release_id) },
      });
    });
    return reply.code(204).send();
  });

  /** One line of a change list. */
  type Line = {
    id: number;
    name: string;
    track: { id: number; key: string; name: string };
    from: string | null;
    to: string;
  } & MoveOutcome;

  /** What a move to `date` does, line by line, for the releases this person sees. */
  function changeList(
    members: readonly MemberRow[],
    date: string,
    sees: (trackId: number) => boolean,
    yours: ReadonlySet<number>,
  ) {
    const live = members.filter((m) => !m.track_deleted);
    const seen = live.filter((m) => sees(m.track_id));
    const lines: Line[] = seen.map((m) => ({
      id: m.release_id,
      name: m.name,
      track: trackOf(m),
      from: m.release_date,
      to: date,
      ...moveOutcome(
        {
          releaseDate: m.release_date,
          startDate: m.start_date,
          shipped: m.shipped_at !== null,
          archived: m.archived_at !== null,
          trackArchived: m.track_archived,
          mayChange: yours.has(m.track_id),
        },
        date,
      ),
    }));
    return { lines, hidden: live.length - seen.length };
  }

  /** Whether every release that counts towards the state has shipped. */
  const allShipped = (members: readonly MemberRow[]) => {
    const counting = members.filter(
      (m) => !m.track_deleted && m.archived_at === null && !m.track_archived,
    );
    return counting.length > 0 && counting.every((m) => m.shipped_at !== null);
  };

  // The change list: changes nothing.
  app.get('/api/v1/cross-track-releases/:id/move', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const q = moveQuery.safeParse(request.query ?? {});
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const opened = await open(request, p.data.id);
    if (!opened) return notFound(reply);
    if (!opened.mayManage) return forbidden(reply, 'edit_cross_track_release');
    if (allShipped(opened.members)) {
      return reply.code(409).send({ error: 'already_shipped' });
    }
    const yours = await changeable(request, opened.members);
    const { lines, hidden } = changeList(opened.members, q.data.date, opened.sees, yours);
    return {
      from: opened.row.release_date,
      to: q.data.date,
      version: opened.row.version,
      lines,
      hidden: { releases: hidden },
      changed: false,
    };
  });

  app.post('/api/v1/cross-track-releases/:id/move', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const parsed = moveBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const { date, version } = parsed.data;
    const opened = await open(request, p.data.id);
    if (!opened) return notFound(reply);
    if (!opened.mayManage) return forbidden(reply, 'edit_cross_track_release');
    // Who may change what is read first: a member added since has changed the version.
    const yours = await changeable(request, opened.members);
    const result = await db.transaction().execute(async (trx) => {
      // The release across tracks first, then its releases by id. `PATCH /releases/:id` locks only
      // its release, and a merge or a delete locks the release across tracks first, so none of them
      // can deadlock with this.
      const locked = await trx
        .selectFrom('cross_track_release')
        .select(['version', 'end_rule', 'release_date'])
        .where('id', '=', p.data.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return { missing: true as const };
      if (locked.version !== version) return { conflict: locked.version };
      const memberIds = await trx
        .selectFrom('cross_track_release_member')
        .select('release_id')
        .where('cross_track_release_id', '=', p.data.id)
        .execute();
      if (memberIds.length > 0) {
        await trx
          .selectFrom('release')
          .select('id')
          .where(
            'id',
            'in',
            memberIds.map((m) => m.release_id),
          )
          .orderBy('id')
          .forNoKeyUpdate()
          .execute();
      }
      const members = await readMembers(trx, [p.data.id]);
      if (allShipped(members)) return { shipped: true as const };
      const { lines, hidden } = changeList(members, date, opened.sees, yours);
      // The same day still brings back what is out of step; with nothing to bring it changes nothing.
      const sameDay = locked.end_rule === 'fixed_date' && locked.release_date === date;
      if (sameDay && !lines.some((l) => l.outcome === 'moves')) return { same: { lines, hidden } };
      const now = new Date();
      const moved: { releaseId: number; from: string | null }[] = [];
      for (const line of lines) {
        if (line.outcome !== 'moves') continue;
        await trx
          .updateTable('release')
          .set({ release_date: date, updated_at: now })
          .where('id', '=', line.id)
          .execute();
        await emit(trx, by(request), {
          type: 'release.updated',
          subjectId: line.id,
          payload: { changes: { releaseDate: { from: line.from, to: date } } },
        });
        moved.push({ releaseId: line.id, from: line.from });
      }
      await trx
        .updateTable('cross_track_release')
        .set({
          end_rule: 'fixed_date',
          release_date: date,
          version: locked.version + 1,
          updated_at: now,
        })
        .where('id', '=', p.data.id)
        .execute();
      await emit(trx, by(request), {
        type: 'cross_track_release.moved',
        subjectId: p.data.id,
        payload: {
          from: locked.release_date,
          to: date,
          moved,
          refused: lines.flatMap((l) =>
            l.outcome === 'stays' ? [{ releaseId: l.id, reason: l.reason }] : [],
          ),
          hidden,
        },
      });
      return {
        done: { lines, hidden, from: locked.release_date, version: locked.version + 1 },
      };
    });
    if ('missing' in result) return notFound(reply);
    if ('conflict' in result) return stale(reply, result.conflict as number);
    if ('shipped' in result) return reply.code(409).send({ error: 'already_shipped' });
    if ('same' in result) {
      return {
        from: date,
        to: date,
        version,
        lines: result.same.lines,
        hidden: { releases: result.same.hidden },
        changed: false,
      };
    }
    return {
      from: result.done.from,
      to: date,
      version: result.done.version,
      lines: result.done.lines,
      hidden: { releases: result.done.hidden },
      changed: true,
    };
  });

  app.post('/api/v1/cross-track-releases/:id/members', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const parsed = memberBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const { releaseId } = parsed.data;
    const opened = await open(request, p.data.id);
    if (!opened) return notFound(reply);
    const problem = await linkProblem(request, db, releaseId);
    if (problem && 'missing' in problem) return invalidFields(reply, { releaseId: 'not_found' });
    if (problem) return refuseLink(reply, problem.code);
    const ws = request.workspaceId;
    try {
      const result = await db.transaction().execute(async (trx) => {
        const locked = await trx
          .selectFrom('cross_track_release')
          .select('version')
          .where('id', '=', p.data.id)
          .forUpdate()
          .executeTakeFirst();
        if (!locked) return { missing: true as const };
        const members = await trx
          .selectFrom('cross_track_release_member')
          .select('release_id')
          .where('cross_track_release_id', '=', p.data.id)
          .execute();
        if (members.length >= MAX_MEMBERS) return { refused: 'too_many_members' };
        const release = await trx
          .selectFrom('release')
          .select('track_id')
          .where('id', '=', releaseId)
          .executeTakeFirst();
        if (!release) return { missing: true as const };
        await trx
          .insertInto('cross_track_release_member')
          .values({
            workspace_id: ws,
            cross_track_release_id: p.data.id,
            release_id: releaseId,
            track_id: release.track_id,
          })
          .execute();
        await trx
          .updateTable('cross_track_release')
          .set({ version: locked.version + 1, updated_at: new Date() })
          .where('id', '=', p.data.id)
          .execute();
        await emit(trx, by(request), {
          type: 'cross_track_release.member_added',
          subjectId: p.data.id,
          payload: { releaseId, trackId: release.track_id },
        });
        return { done: true as const };
      });
      if ('missing' in result) return notFound(reply);
      if ('refused' in result) return reply.code(409).send({ error: result.refused });
    } catch (error) {
      const code = takenCode(error);
      if (code) return reply.code(409).send({ error: code });
      throw error;
    }
    const fresh = await open(request, p.data.id);
    if (!fresh) return notFound(reply);
    const answer = await fullAnswer(request, reply, fresh);
    return reply.sent ? reply : reply.code(201).send(answer);
  });

  app.delete('/api/v1/cross-track-releases/:id/members/:releaseId', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = memberParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const opened = await open(request, p.data.id);
    if (!opened) return notFound(reply);
    const member = opened.members.find((m) => m.release_id === p.data.releaseId);
    // Nobody removes what they cannot see, and one hidden answers as one not linked.
    if (!member || member.track_deleted || !opened.sees(member.track_id)) return notFound(reply);
    if (!opened.mayManage && !(await mayChangeTrack(request, member.track_id))) {
      return forbidden(reply, 'administer_track');
    }
    const gone = await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('cross_track_release')
        .select('version')
        .where('id', '=', p.data.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return false;
      const removed = await trx
        .deleteFrom('cross_track_release_member')
        .where('cross_track_release_id', '=', p.data.id)
        .where('release_id', '=', p.data.releaseId)
        .executeTakeFirst();
      if (Number(removed.numDeletedRows) === 0) return false;
      await trx
        .updateTable('cross_track_release')
        .set({ version: locked.version + 1, updated_at: new Date() })
        .where('id', '=', p.data.id)
        .execute();
      await emit(trx, by(request), {
        type: 'cross_track_release.member_removed',
        subjectId: p.data.id,
        payload: {
          releaseId: p.data.releaseId,
          trackId: member.track_id,
          reason: 'removed',
        },
      });
      return true;
    });
    return gone ? reply.code(204).send() : notFound(reply);
  });

  // A plan's Releases tab: the releases of its tracks the viewer browses, those of a release
  // across tracks gathered under it first, then the rest by track, upcoming first.
  app.get('/api/v1/plans/:id/releases', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const q = planReleasesQuery.safeParse(request.query ?? {});
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const ws = request.workspaceId;
    let planQuery = db
      .selectFrom('plan as p')
      .select('p.id')
      .where('p.workspace_id', '=', ws)
      .where('p.id', '=', p.data.id);
    if (!(await request.authz.isSiteAdmin())) planQuery = planQuery.where(planVisible(ws, user.id));
    const plan = await planQuery.executeTakeFirst();
    if (!plan) return notFound(reply);
    try {
      const tickets = await planTickets(
        db,
        options.catalogs,
        request,
        await sourceRows(db, [plan.id]),
      );
      const empty = { crossTrack: [], tracks: [], truncated: false };
      if (!tickets.where) return empty;
      const where = tickets.where;
      const browses = await browsedTracks(request);
      // The plan's tracks: those `choices` reads, and its track sources with nothing listed yet. A
      // track known only through a ticket-level grant adds no row.
      const found = await readOnly(db, timeoutMs, async (trx) =>
        sql<{ track_id: number }>`
          SELECT DISTINCT k.track_id FROM ticket k WHERE ${where}`.execute(trx),
      );
      const listed = new Set(
        [
          ...found.rows.map((r) => r.track_id),
          ...tickets.sources.flatMap((s) =>
            s.kind === 'track' && s.state === 'visible' ? [s.id] : [],
          ),
        ].filter(browses),
      );
      if (listed.size === 0) return empty;
      const visible = await visibleFilter(request);
      let query = releaseQuery(db, ws, visible)
        .innerJoin('track as t', 't.id', 'r.track_id')
        .select(['t.key as track_key', 't.name as track_name'])
        .where('r.track_id', 'in', [...listed])
        .where('r.archived_at', 'is', null);
      if (q.data.track) {
        query = query.where(sql<boolean>`upper(t.key) = upper(${q.data.track})`);
      }
      const rows = await query
        .orderBy(sql`ctm.cross_track_release_id IS NULL`)
        .orderBy(sql`ctm.cross_track_release_id`)
        .orderBy('t.key')
        .orderBy(sql`r.shipped_at IS NOT NULL`)
        .orderBy('r.sort_order')
        .orderBy('r.id')
        .limit(PLAN_RELEASES + 1)
        .execute();
      const page = rows.slice(0, PLAN_RELEASES);
      const groupIds = [
        ...new Set(page.flatMap((r) => (r.cross_id === null ? [] : [r.cross_id as number]))),
      ];
      const groups =
        groupIds.length === 0
          ? []
          : ((await rowQuery(db, ws).where('c.id', 'in', groupIds).execute()) as Row[]);
      const members = await readMembers(db, groupIds);
      const work = await readWork(db, groupIds, visible);
      const sees = await trackSight(request, requestSight(request));
      // Overdue against the viewer's own day, as on a track's own release list (T-282, T-287).
      const today = viewerDay(request);
      const byTrack = new Map<
        number,
        {
          track: { id: number; key: string; name: string };
          releases: ReturnType<typeof releaseView>[];
        }
      >();
      for (const r of page) {
        if (r.cross_id !== null) continue;
        const entry = byTrack.get(r.track_id) ?? {
          track: { id: r.track_id, key: r.track_key, name: r.track_name },
          releases: [],
        };
        entry.releases.push(releaseView(r, today));
        byTrack.set(r.track_id, entry);
      }
      return {
        crossTrack: groups.map((row) => {
          const own = members.filter((m) => m.cross_track_release_id === row.id);
          const summary = summarize(row, own, work, sees, today);
          return {
            id: row.id,
            name: row.name,
            endRule: row.end_rule,
            date: row.release_date,
            state: summary.state,
            owner: { id: row.owner_id, name: row.owner_name },
            progress: summary.progress,
            hidden: summary.hidden,
            releases: summary.seen.map((m) => memberView(row, m, today, work.get(m.release_id))),
          };
        }),
        tracks: [...byTrack.values()],
        truncated: rows.length > PLAN_RELEASES,
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });
}
