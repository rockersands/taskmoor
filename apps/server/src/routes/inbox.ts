import type { Database, JsonValue } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { emit } from '../events/bus';
import { isNotificationEvent, isPreferenceEvent } from '../notifications/model';
import { bumpInbox } from '../notifications/subscriber';
import { commentText } from '../tickets/comments';
import { resolveTrack } from '../tickets/store';

/**
 * The in-app inbox (M1-058; NTF-003; ADR-047): a person's `inbox` notifications.
 *
 * - `GET /api/v1/inbox?view=all|priority|snoozed&unread=&event=&track=&cursor=&limit=`: items
 *   newest first (a snoozed item that came back sorts at the time it came back), with the unread
 *   counts of the inbox and of its Priority tab (direct asks: mentions and assignments to the
 *   person, NTF-003 (3)) and an opaque cursor for the next page. `GET /api/v1/inbox/count`
 *   gives the counts alone.
 * - Every item is judged again when it is shown, by the reader's current permissions: an item
 *   about a ticket they may no longer see, or in the trash, is left out, and so is one about a
 *   comment they may not read (deleted, or restricted to a role or group they left). Counts
 *   apply the same rule. A comment is quoted only to those who may read it.
 * - `PATCH /api/v1/inbox/:id` `{read?, snoozedUntil?}`: read or unread; snoozed until a time
 *   (it comes back unread then) or back now (`null`). Marking read also marks the same
 *   notification's email read, so a digest leaves it out (NTF-003 (2)).
 * - `POST /api/v1/inbox/read` `{view?, event?, track?, upTo?}`: marks what the list shows read,
 *   up to the newest item the person saw (`upTo`), so one that arrived meanwhile stays unread.
 *
 * Each change bumps the person's `inbox_state`, which the realtime socket pushes to their open
 * inboxes. Every successful change emits exactly one domain event (ADR-015); no change, none.
 */
const VIEWS = ['all', 'priority', 'snoozed'] as const;
/** Unread items counted at most: past this the badge says "999+". */
export const COUNT_CAP = 1000;
const SNOOZE_MAX_MS = 366 * 24 * 60 * 60 * 1000;

const eventFilter = z
  .string()
  .max(120)
  .refine((e) => isPreferenceEvent(e) || isNotificationEvent(e), 'a notification event');
const listQuery = z
  .object({
    view: z.enum(VIEWS).default('all'),
    unread: z.enum(['true', 'false']).optional(),
    event: eventFilter.optional(),
    track: z.string().min(1).max(300).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const itemParams = z.object({
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const patchBody = z
  .object({
    read: z.boolean().optional(),
    snoozedUntil: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .refine((b) => b.read !== undefined || b.snoozedUntil !== undefined, 'read or snoozedUntil');
const readAllBody = z
  .object({
    view: z.enum(['all', 'priority']).default('all'),
    event: eventFilter.optional(),
    track: z.string().min(1).max(300).optional(),
    upTo: z
      .string()
      .regex(/^[1-9]\d{0,17}$/)
      .optional(),
  })
  .strict();

type Db = Kysely<Database> | Transaction<Database>;

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const zodDetail = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');

/** The sort key of an item: when it arrived, or when it came back from a snooze. */
const SORT_AT = sql`coalesce(n.snoozed_until, n.created_at)`;

interface Cursor {
  at: string;
  id: string;
}
const encodeCursor = (c: Cursor) => Buffer.from(`${c.at}~${c.id}`).toString('base64url');
function decodeCursor(text: string): Cursor | null {
  const [at, id] = Buffer.from(text, 'base64url').toString().split('~');
  if (!at || !id || !/^[1-9]\d{0,17}$/.test(id)) return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?$/.test(at)) return null;
  return { at, id };
}

interface ItemRow {
  id: string;
  event: string;
  direct: boolean;
  payload: Record<string, unknown>;
  created_at: Date;
  read_at: Date | null;
  snoozed_until: Date | null;
  sort_at: string;
  actor_id: number | null;
  actor_name: string | null;
  ticket_id: number;
  ticket_key: string;
  summary: string;
  track_id: number;
  track_key: string;
  comment_id: number | null;
  comment_body: JsonValue | null;
  comment_readable: boolean | null;
}

export function registerInboxRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  /**
   * The statement part every inbox read shares: the person's inbox items whose ticket they may
   * see now (outside the trash) and, for an item about a comment, whose comment they may read.
   */
  async function visibleItems(request: FastifyRequest, userId: number) {
    const ws = request.workspaceId;
    const filter = await request.authz.ticketFilter();
    if (filter.tracks !== 'all' && filter.tracks.length === 0) return null;
    // The comment an item is about (`commentId`) must be readable; a transition's comment
    // (`quotedCommentId`) is only quoted when it is. Same rule as `commentReadableSql`.
    const groups = sql`(WITH RECURSIVE g(id) AS (
        SELECT group_id FROM group_member WHERE workspace_id = ${ws} AND user_id = ${userId}
        UNION
        SELECT gn.parent_id FROM group_nesting gn JOIN g ON gn.child_id = g.id
         WHERE gn.workspace_id = ${ws})
      SELECT id FROM g)`;
    const readable = sql<boolean>`(c.id IS NOT NULL AND c.deleted_at IS NULL AND (
        (c.visible_role_id IS NULL AND c.visible_group_id IS NULL)
        OR c.author_id = ${userId}
        OR c.visible_group_id IN ${groups}
        OR c.visible_role_id IN (SELECT a.role_id FROM track_role_actor a
             WHERE a.track_id = k.track_id
               AND (a.user_id = ${userId} OR a.group_id IN ${groups}))))`;
    return {
      from: sql`notification n
        JOIN ticket k ON k.id = n.ticket_id
        JOIN track t ON t.id = k.track_id
        LEFT JOIN ticket_comment c ON c.ticket_id = k.id AND c.id = coalesce(
          (n.payload->>'commentId')::int, (n.payload->>'quotedCommentId')::int)`,
      where: sql<boolean>`n.user_id = ${userId} AND n.workspace_id = ${ws}
        AND n.channel = 'inbox' AND k.deleted_at IS NULL AND ${filter.sql}
        AND (NOT n.payload ? 'commentId' OR ${readable})`,
      readable,
    };
  }

  const shownNow = sql<boolean>`(n.snoozed_until IS NULL OR n.snoozed_until <= now())`;

  /** Unread counts of the inbox and its Priority tab, each up to the cap. */
  async function counts(request: FastifyRequest, userId: number) {
    const items = await visibleItems(request, userId);
    if (!items) return { all: 0, priority: 0 };
    const { rows } = await sql<{ direct: boolean }>`
      SELECT n.direct FROM ${items.from}
       WHERE ${items.where} AND n.read_at IS NULL AND ${shownNow}
       LIMIT ${COUNT_CAP}`.execute(db);
    return { all: rows.length, priority: rows.filter((r) => r.direct).length };
  }

  const itemView = (r: ItemRow) => {
    const fields = Array.isArray(r.payload.fields) ? (r.payload.fields as string[]) : undefined;
    const mentionedIn = Array.isArray(r.payload.mentionedIn)
      ? (r.payload.mentionedIn as string[])
      : undefined;
    return {
      id: r.id,
      event: r.event,
      direct: r.direct,
      ticket: {
        id: r.ticket_id,
        key: r.ticket_key,
        summary: r.summary,
        track: { id: r.track_id, key: r.track_key },
      },
      actor: r.actor_id === null ? null : { id: r.actor_id, name: r.actor_name ?? '' },
      ...(fields ? { fields } : {}),
      ...(mentionedIn ? { mentionedIn } : {}),
      // Quoted only to those who may read it.
      comment:
        r.comment_id !== null && r.comment_readable
          ? { id: r.comment_id, excerpt: commentText(r.comment_body as JsonValue, 280) }
          : null,
      createdAt: r.created_at.toISOString(),
      read: r.read_at !== null,
      snoozedUntil:
        r.snoozed_until !== null && r.snoozed_until.getTime() > Date.now()
          ? r.snoozed_until.toISOString()
          : null,
    };
  };

  async function selectItems(
    request: FastifyRequest,
    userId: number,
    extra: RawBuilder<boolean>,
    limit: number,
    cursor: Cursor | null,
  ): Promise<ItemRow[]> {
    const items = await visibleItems(request, userId);
    if (!items) return [];
    const after = cursor
      ? sql<boolean>`(${SORT_AT}, n.id) < (${`${cursor.at}Z`}::timestamptz, ${cursor.id}::bigint)`
      : sql<boolean>`true`;
    const { rows } = await sql<ItemRow>`
      SELECT n.id::text AS id, n.event, n.direct, n.payload, n.created_at, n.read_at,
             n.snoozed_until, n.actor_id, u.name AS actor_name,
             to_char(${SORT_AT} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS sort_at,
             k.id AS ticket_id, t.key || '-' || k.number AS ticket_key, k.summary,
             k.track_id, t.key AS track_key,
             c.id AS comment_id, CASE WHEN ${items.readable} THEN c.body END AS comment_body,
             ${items.readable} AS comment_readable
        FROM ${items.from}
        LEFT JOIN app_user u ON u.id = n.actor_id
       WHERE ${items.where} AND ${extra} AND ${after}
       ORDER BY ${SORT_AT} DESC, n.id DESC
       LIMIT ${limit}`.execute(db);
    return rows;
  }

  /** The filters a list or a "mark all read" names, as a condition; null when one is unknown. */
  async function filters(
    request: FastifyRequest,
    q: {
      view: (typeof VIEWS)[number];
      unread?: boolean;
      event?: string | undefined;
      track?: string | undefined;
    },
  ): Promise<{ sql: RawBuilder<boolean>; trackId: number | null } | null> {
    const parts: RawBuilder<boolean>[] = [];
    if (q.view === 'snoozed') parts.push(sql<boolean>`n.snoozed_until > now()`);
    else parts.push(shownNow);
    if (q.view === 'priority') parts.push(sql<boolean>`n.direct`);
    if (q.unread) parts.push(sql<boolean>`n.read_at IS NULL`);
    if (q.event !== undefined) parts.push(sql<boolean>`n.event = ${q.event}`);
    let trackId: number | null = null;
    if (q.track !== undefined) {
      trackId = await resolveTrack(db, request.workspaceId, q.track);
      if (trackId === null) return null;
      parts.push(sql<boolean>`k.track_id = ${trackId}`);
    }
    return { sql: sql<boolean>`(${sql.join(parts, sql` AND `)})`, trackId };
  }

  app.get('/api/v1/inbox', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const q = parsed.data;
    const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
    if (q.cursor !== undefined && !cursor) return invalid(reply, 'cursor');
    const where = await filters(request, { ...q, unread: q.unread === 'true' });
    if (!where) return notFound(reply);
    // The page and the counts at once: an open inbox reads both on every push.
    const [rows, unread] = await Promise.all([
      selectItems(request, user.id, where.sql, q.limit + 1, cursor),
      counts(request, user.id),
    ]);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(itemView),
      unread,
      next: rows.length > q.limit && last ? encodeCursor({ at: last.sort_at, id: last.id }) : null,
    };
  });

  app.get('/api/v1/inbox/count', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    return { unread: await counts(request, user.id) };
  });

  /** Marks the email of the same notifications read or unread too (NTF-003 (2)). */
  async function mirrorEmail(trx: Db, userId: number, ids: readonly string[], read: Date | null) {
    if (ids.length === 0) return;
    await sql`
      UPDATE notification e SET read_at = ${read}
        FROM notification i
       WHERE i.id = ANY(${ids.map(Number)}::bigint[]) AND i.user_id = ${userId}
         AND e.domain_event_id = i.domain_event_id AND e.user_id = i.user_id
         AND e.channel = 'email'`.execute(trx);
  }

  app.patch('/api/v1/inbox/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = itemParams.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const parsed = patchBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const body = parsed.data;
    let snoozedUntil: Date | null | undefined;
    if (body.snoozedUntil !== undefined && body.snoozedUntil !== null) {
      snoozedUntil = new Date(body.snoozedUntil);
      const ahead = snoozedUntil.getTime() - Date.now();
      if (ahead <= 0 || ahead > SNOOZE_MAX_MS) return invalid(reply, 'snoozedUntil');
    } else if (body.snoozedUntil === null) {
      snoozedUntil = null;
    }
    const id = String(p.data.id);
    // Only an item the person may see now can be changed.
    const [shown] = await selectItems(
      request,
      user.id,
      sql<boolean>`n.id = ${id}::bigint`,
      1,
      null,
    );
    if (!shown) return notFound(reply);
    const ws = request.workspaceId;
    const changed = await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('notification')
        .select(['id', 'read_at', 'snoozed_until'])
        .where('id', '=', id)
        .where('user_id', '=', user.id)
        .where('channel', '=', 'inbox')
        .forUpdate()
        .executeTakeFirst();
      if (!current) return null;
      const now = new Date();
      const wasRead = current.read_at !== null;
      const wasSnoozed =
        current.snoozed_until !== null && current.snoozed_until.getTime() > now.getTime()
          ? current.snoozed_until.toISOString()
          : null;
      // A snooze brings the item back unread, unless the same change says otherwise.
      const read = body.read ?? (snoozedUntil ? false : wasRead);
      const snooze =
        snoozedUntil === undefined ? wasSnoozed : (snoozedUntil?.toISOString() ?? null);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (read !== wasRead) changes.read = { from: wasRead, to: read };
      if (snooze !== wasSnoozed) changes.snoozedUntil = { from: wasSnoozed, to: snooze };
      if (Object.keys(changes).length === 0) return {};
      await trx
        .updateTable('notification')
        .set({
          ...(changes.read ? { read_at: read ? now : null } : {}),
          ...(changes.snoozedUntil
            ? { snoozed_until: snooze === null ? null : new Date(snooze) }
            : {}),
        })
        .where('id', '=', id)
        .execute();
      if (changes.read) await mirrorEmail(trx, user.id, [id], read ? now : null);
      await bumpInbox(trx, ws, [user.id]);
      await emit(
        trx,
        { workspaceId: ws, actorId: user.id },
        { type: 'inbox.item_updated', subjectId: id, payload: { changes } },
      );
      return changes;
    });
    if (!changed) return notFound(reply);
    const [item] = await selectItems(request, user.id, sql<boolean>`n.id = ${id}::bigint`, 1, null);
    if (!item) return notFound(reply);
    return { item: itemView(item), unread: await counts(request, user.id) };
  });

  app.post('/api/v1/inbox/read', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = readAllBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const body = parsed.data;
    const where = await filters(request, { ...body, unread: true });
    if (!where) return notFound(reply);
    const items = await visibleItems(request, user.id);
    const upTo =
      body.upTo === undefined ? sql<boolean>`true` : sql<boolean>`n.id <= ${body.upTo}::bigint`;
    const ws = request.workspaceId;
    const count = items
      ? await db.transaction().execute(async (trx) => {
          const { rows } = await sql<{ id: string }>`
            SELECT n.id::text AS id FROM ${items.from}
             WHERE ${items.where} AND ${where.sql} AND ${upTo}
             FOR UPDATE OF n SKIP LOCKED`.execute(trx);
          if (rows.length === 0) return 0;
          const ids = rows.map((r) => r.id);
          const now = new Date();
          await trx
            .updateTable('notification')
            .set({ read_at: now })
            .where('id', 'in', ids)
            .execute();
          await mirrorEmail(trx, user.id, ids, now);
          await bumpInbox(trx, ws, [user.id]);
          await emit(
            trx,
            { workspaceId: ws, actorId: user.id },
            {
              type: 'inbox.marked_read',
              subjectId: user.id,
              payload: {
                count: ids.length,
                view: body.view,
                event: body.event ?? null,
                trackId: where.trackId,
              },
            },
          );
          return ids.length;
        })
      : 0;
    return { marked: count, unread: await counts(request, user.id) };
  });
}
