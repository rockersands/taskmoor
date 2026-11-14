import type { Database, JsonValue } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import type { FieldCatalogs } from '../fields/catalog';
import { historyFieldOf } from '../fields/values';
import { commentText, onceAudience, readsComment } from '../tickets/comments';
import { loadTicket, resolveTicket, resolveTrack } from '../tickets/store';
import { entryQuery, entryView, visibleTo } from './time';

/**
 * Activity streams (M1-058; CORE-022, NTF-003; ADR-047): what happened, newest first, built
 * from the ticket history (`ticket_change`, which is never truncated), one entry per change set
 * of one ticket: who, when, and the fields it changed.
 *
 * - `GET /api/v1/tickets/:id/activity?kind=all|comments|history|time&cursor=&limit=`: one
 *   ticket's stream, for those who may see it (a ticket in the trash for those who may delete
 *   it, as its history).
 * - `GET /api/v1/tracks/:id/activity?cursor=&limit=`: a track's stream, over the tickets of the
 *   track the reader may see now (the list predicate in the statement, outside the trash).
 *
 * Only what the reader may see: comment entries of comments they may not read are left out (a
 * readable one carries a short excerpt), as in the ticket history. Rich text values are not
 * repeated (the entry says the description changed). A custom field's change says the field's
 * name and how its values read, as the ticket history does (T-277, T-282): the name only while
 * the field applies to the ticket where it is now, so the reader sees the field on it. `limit` counts history rows; a change set
 * is never split across pages, so a page can hold a few more rows.
 *
 * A ticket's `kind=all` page also carries time entries (`timeEntries`, those the reader may see,
 * as the time entries list shows them), newest first by when the work started, `limit` of them
 * at most (T-309): those after the cursor's entry back to the start of the stretch of time the
 * page's history rows cover (the last page: back to the start). A time entry may have no history
 * row (an import writes none), and its row says neither whose work it was nor when it began. Its
 * cursor names the history row and the time entry it stops at (`<row>.<µs>.<entry>`, row `0`
 * once the history is read), so each time entry comes once across the pages, whatever order
 * the history rows' times are in, and no page holds more than `limit` of either.
 */
const MAX_INT = 2_147_483_647;
const RICH_TEXT = new Set(['description', 'environment']);
const KINDS = ['all', 'comments', 'history', 'time'] as const;
const TIME_FIELDS = ['timeEntry', 'timeSpent', 'originalEstimate', 'remainingEstimate'];
const cursorParam = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .optional();
/** A `kind=all` cursor: the history row, then the time entry (its start in µs, its id). */
const ALL_CURSOR = /^(0|[1-9][0-9]{0,18})(?:\.(-?[0-9]{1,17})\.([1-9][0-9]{0,17}))?$/;
const ticketQuery = z
  .object({
    kind: z.enum(KINDS).default('all'),
    cursor: z.string().regex(ALL_CURSOR).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
const trackQuery = z
  .object({ cursor: cursorParam, limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();
const params = z.object({ id: z.string().min(1).max(300) });

const invalid = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_request' });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

interface ChangeRow {
  id: string;
  ticket_id: number;
  change_set: string;
  at: Date;
  actor_id: number | null;
  actor_name: string | null;
  field: string;
  from_value: string | null;
  to_value: string | null;
  from_display: string | null;
  to_display: string | null;
  transition_id: number | null;
  ticket_key: string;
  summary: string;
  track_id: number;
  ticket_type_id: number;
}

const COLUMNS = sql`c.id::text AS id, c.ticket_id, c.change_set::text AS change_set, c.at,
  c.actor_id, u.name AS actor_name, c.field, c.from_value, c.to_value, c.from_display,
  c.to_display, c.transition_id, t.key || '-' || k.number AS ticket_key, k.summary, k.track_id, k.ticket_type_id`;

function kindFilter(kind: (typeof KINDS)[number]): RawBuilder<boolean> {
  switch (kind) {
    case 'comments':
      return sql<boolean>`c.field = 'comment'`;
    case 'time':
      return sql<boolean>`c.field IN (${sql.join(TIME_FIELDS)})`;
    case 'history':
      return sql<boolean>`c.field NOT IN (${sql.join(['comment', ...TIME_FIELDS])})`;
    default:
      return sql<boolean>`true`;
  }
}

export function registerActivityRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
): void {
  /**
   * Turns history rows (newest first) into entries, leaving out rows of comments the reader may
   * not read, and quoting the readable ones.
   */
  async function entries(request: FastifyRequest, rows: readonly ChangeRow[]) {
    const commentRows = rows.filter((r) => r.field === 'comment');
    const ids = [
      ...new Set(
        commentRows
          .map((r) => Number(r.to_value ?? r.from_value))
          .filter((n) => Number.isInteger(n) && n > 0 && n <= MAX_INT),
      ),
    ];
    const comments = new Map(
      ids.length === 0
        ? []
        : (
            await db
              .selectFrom('ticket_comment')
              .select([
                'id',
                'author_id',
                'visible_role_id',
                'visible_group_id',
                'deleted_at',
                'body',
              ])
              .where('id', 'in', ids)
              .execute()
          ).map((c) => [c.id, c]),
    );
    const audiences = new Map<number, ReturnType<typeof onceAudience>>();
    const audienceOf = (trackId: number) => {
      let found = audiences.get(trackId);
      if (!found) {
        found = onceAudience(() => request.authz.audience(trackId));
        audiences.set(trackId, found);
      }
      return found;
    };
    const userId = request.user?.id ?? null;
    const readable = new Map<number, string | null>();
    for (const row of commentRows) {
      const id = Number(row.to_value ?? row.from_value);
      const comment = comments.get(id);
      if (!comment || readable.has(id)) continue;
      // A deleted comment's row stays for those who could read it; its text is gone.
      const reads = await readsComment(
        { ...comment, deleted_at: null },
        userId,
        audienceOf(row.track_id),
      );
      if (reads) {
        readable.set(id, comment.deleted_at ? null : commentText(comment.body as JsonValue, 280));
      }
    }
    // A custom field's change names the field and says how its values read (T-282).
    const catalog = rows.some((r) => r.field.startsWith('cf['))
      ? await catalogs.get(request.workspaceId)
      : null;
    const out: {
      changeSet: string;
      at: string;
      actor: { id: number; name: string } | null;
      ticket: { id: number; key: string; summary: string };
      transitionId: number | null;
      comment: { id: number; excerpt: string | null } | null;
      changes: {
        field: string;
        fieldName?: string | null;
        valueType?: 'date' | 'datetime' | null;
        from: { value: string | null; display: string | null };
        to: { value: string | null; display: string | null };
      }[];
    }[] = [];
    for (const row of rows) {
      let comment: { id: number; excerpt: string | null } | null = null;
      if (row.field === 'comment') {
        const id = Number(row.to_value ?? row.from_value);
        if (!readable.has(id)) continue;
        comment = { id, excerpt: readable.get(id) ?? null };
      }
      const rich = RICH_TEXT.has(row.field);
      const change = {
        field: row.field,
        ...(catalog
          ? historyFieldOf(
              catalog,
              { trackId: row.track_id, ticketTypeId: row.ticket_type_id },
              row.field,
            )
          : null),
        from: { value: rich ? null : row.from_value, display: rich ? null : row.from_display },
        to: { value: rich ? null : row.to_value, display: rich ? null : row.to_display },
      };
      const last = out[out.length - 1];
      if (last && last.changeSet === row.change_set && last.ticket.id === row.ticket_id) {
        last.changes.push(change);
        last.comment ??= comment;
        continue;
      }
      out.push({
        changeSet: row.change_set,
        at: row.at.toISOString(),
        actor: row.actor_id === null ? null : { id: row.actor_id, name: row.actor_name ?? '' },
        ticket: { id: row.ticket_id, key: row.ticket_key, summary: row.summary },
        transitionId: row.transition_id,
        comment,
        changes: [change],
      });
    }
    return out;
  }

  /**
   * A page of rows: `limit` rows, then the rest of the last row's change set on that ticket, so
   * no entry is split; the cursor is the oldest row taken.
   */
  async function page(
    rows: ChangeRow[],
    limit: number,
    rest: (last: ChangeRow) => Promise<ChangeRow[]>,
  ): Promise<{ rows: ChangeRow[]; next: string | null }> {
    if (rows.length <= limit) return { rows, next: null };
    const taken = rows.slice(0, limit);
    const last = taken[taken.length - 1] as ChangeRow;
    const more = await rest(last);
    const all = [...taken, ...more];
    const oldest = all[all.length - 1] as ChangeRow;
    return { rows: all, next: oldest.id };
  }

  app.get('/api/v1/tickets/:id/activity', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = params.safeParse(request.params);
    const q = ticketQuery.safeParse(request.query);
    if (!p.success || !q.success) return invalid(reply);
    const ws = request.workspaceId;
    const found = await resolveTicket(db, ws, p.data.id);
    const ticket = found ? await loadTicket(db, ws, found.id) : undefined;
    if (!ticket || !(await request.authz.seesTicket(ticket))) return notFound(reply);
    if (ticket.deleted_at && !(await request.authz.canTicket('delete_tickets', ticket))) {
      return notFound(reply);
    }
    const { kind, limit } = q.data;
    const parts = q.data.cursor === undefined ? null : ALL_CURSOR.exec(q.data.cursor);
    // Only an All page's cursor names a time entry (and the end of the history).
    if (parts && kind !== 'all' && (parts[2] !== undefined || parts[1] === '0')) {
      return invalid(reply);
    }
    const cursor = parts?.[1];
    const afterEntry = parts?.[2] === undefined ? null : { us: parts[2], id: parts[3] as string };
    const select = (extra: RawBuilder<boolean>, max: number) =>
      sql<ChangeRow>`
        SELECT ${COLUMNS}
          FROM ticket_change c
          JOIN ticket k ON k.id = c.ticket_id
          JOIN track t ON t.id = k.track_id
          LEFT JOIN app_user u ON u.id = c.actor_id
         WHERE c.ticket_id = ${ticket.id} AND c.workspace_id = ${ws} AND ${kindFilter(kind)}
           AND ${extra}
         ORDER BY c.id DESC
         LIMIT ${max}`.execute(db);
    const before =
      cursor === undefined ? sql<boolean>`true` : sql<boolean>`c.id < ${cursor}::bigint`;
    const { rows } = await select(before, limit + 1);
    const result = await page(
      rows,
      limit,
      async (last) =>
        (
          await select(
            sql<boolean>`c.change_set = ${last.change_set}::bigint AND c.id < ${last.id}::bigint`,
            1000,
          )
        ).rows,
    );
    const activity = await entries(request, result.rows);
    if (kind !== 'all') return { activity, next: result.next };
    // Time entries past the cursor's, back to the oldest row of this page (the last page: all),
    // `limit` at most; the next page goes on from the last one looked at.
    const oldest = result.next === null ? null : result.rows[result.rows.length - 1];
    let query = entryQuery(db)
      .select(
        sql<string>`(extract(epoch FROM e.started_at) * 1000000)::bigint::text`.as('started_us'),
      )
      .where('e.ticket_id', '=', ticket.id);
    if (afterEntry) {
      query = query.where(
        sql<boolean>`(e.started_at, e.id) < (TIMESTAMPTZ 'epoch' + ${afterEntry.us}::bigint * INTERVAL '1 microsecond', ${afterEntry.id}::bigint)`,
      );
    }
    if (oldest) query = query.where('e.started_at', '>=', oldest.at);
    const inStretch = await query
      .orderBy('e.started_at', 'desc')
      .orderBy('e.id', 'desc')
      .limit(limit + 1)
      .execute();
    const looked = inStretch.slice(0, limit);
    const sees = await visibleTo(request, ticket.track_id);
    const timeEntries = [];
    for (const e of looked) if (await sees(e)) timeEntries.push(entryView(e));
    const last = looked[looked.length - 1];
    const entryPart = last
      ? `.${last.started_us}.${last.id}`
      : afterEntry
        ? `.${afterEntry.us}.${afterEntry.id}`
        : '';
    const next =
      result.next === null && inStretch.length <= limit
        ? null
        : `${result.next ?? '0'}${entryPart}`;
    return { activity, timeEntries, next };
  });

  app.get('/api/v1/tracks/:id/activity', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = params.safeParse(request.params);
    const q = trackQuery.safeParse(request.query);
    if (!p.success || !q.success) return invalid(reply);
    const ws = request.workspaceId;
    const trackId = await resolveTrack(db, ws, p.data.id);
    if (trackId === null) return notFound(reply);
    const filter = await request.authz.ticketFilter();
    if (filter.tracks !== 'all' && !filter.tracks.includes(trackId)) return notFound(reply);
    const { cursor, limit } = q.data;
    const before =
      cursor === undefined ? sql<boolean>`true` : sql<boolean>`c.id < ${cursor}::bigint`;
    // Each visible ticket's newest rows (its history is read by its primary key), merged.
    const { rows } = await sql<ChangeRow>`
      SELECT ${COLUMNS}
        FROM ticket k
        JOIN track t ON t.id = k.track_id
        CROSS JOIN LATERAL (
          SELECT * FROM ticket_change c
           WHERE c.ticket_id = k.id AND ${before}
           ORDER BY c.id DESC
           LIMIT ${limit + 1}
        ) c
        LEFT JOIN app_user u ON u.id = c.actor_id
       WHERE k.workspace_id = ${ws} AND k.track_id = ${trackId} AND k.deleted_at IS NULL
         AND ${filter.sql}
       ORDER BY c.id DESC
       LIMIT ${limit + 1}`.execute(db);
    const result = await page(rows, limit, async (last) => {
      const more = await sql<ChangeRow>`
        SELECT ${COLUMNS}
          FROM ticket_change c
          JOIN ticket k ON k.id = c.ticket_id
          JOIN track t ON t.id = k.track_id
          LEFT JOIN app_user u ON u.id = c.actor_id
         WHERE c.ticket_id = ${last.ticket_id} AND c.change_set = ${last.change_set}::bigint
           AND c.id < ${last.id}::bigint
         ORDER BY c.id DESC
         LIMIT 1000`.execute(db);
      return more.rows;
    });
    return { activity: await entries(request, result.rows), next: result.next };
  });
}
