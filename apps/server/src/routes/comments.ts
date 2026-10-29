import type { Database, JsonValue } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireGlobal, requireUser } from '../auth';
import type { TrackPermission } from '../authz/permissions';
import { emit } from '../events/bus';
import {
  type CommentVisibility,
  onceAudience,
  readsComment,
  visibilityOf,
} from '../tickets/comments';
import { autoFollow } from '../tickets/followers';
import { type FieldChange, recordChanges } from '../tickets/history';
import { canonicalJson, ticketKey } from '../tickets/model';
import { readRichText, requestedFormat, writeRichText } from '../tickets/rich-text';
import { loadTicket, resolveTicket, type TicketRow } from '../tickets/store';
import { type Lock, lockedBody, statusGate, statusLock } from '../workflows/locks';

/**
 * Comments (M1-018; CORE-020, CORE-022, NTF-001 (3); ADR-044).
 *
 * - A comment is rich text in the shared document schema, written and read in `?format=`
 *   (`doc`, `adf` or `markdown`, as descriptions). It may be restricted to one role or one
 *   group; who reads it is `readsComment` (tickets/comments.ts) on every path.
 * - Writing needs "Add comments"; changing or deleting one's own needs "Edit/Delete own
 *   comments" (or "all"), someone else's "Edit/Delete all comments". A status can reserve
 *   commenting to some roles or groups (WF-007, ADR-042): that lock holds for adding, editing
 *   and deleting. A restriction names a role of the workspace or a group the writer is in.
 * - Editing keeps the replaced state (`ticket_comment_version`) and marks the comment edited;
 *   site administrators read every state, deleted comments included. Deleting is soft.
 * - Anyone who reads a comment may react to it, once per emoji.
 * - A new or deleted comment is a history row on its ticket (the comment's id, never its
 *   text) and touches the ticket's updated time, not its version.
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015).
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const visibility = z
  .union([z.object({ roleId: id }).strict(), z.object({ groupId: id }).strict()])
  .nullable();
const createBody = z.object({ body: z.unknown(), visibility: visibility.optional() }).strict();
const updateBody = z
  .object({ body: z.unknown().optional(), visibility: visibility.optional() })
  .strict();
const listQuery = z
  .object({
    cursor: z.coerce.number().int().positive().max(MAX_INT).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    order: z.enum(['asc', 'desc']).default('asc'),
    format: z.string().optional(),
  })
  .strict();
const formatQuery = z.object({ format: z.string().optional() }).strict();
/**
 * One emoji: a single grapheme that is a pictograph (with its modifiers and joiners), a flag or
 * a keycap. Letters and digits alone are not.
 */
const EMOJI_PARTS =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Emoji_Modifier}|\u200d|\ufe0f|\u20e3)+$/u;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const isEmoji = (value: string) =>
  value.length <= 32 &&
  EMOJI_PARTS.test(value) &&
  [...segmenter.segment(value)].length === 1 &&
  (/\p{Extended_Pictographic}/u.test(value) ||
    /^\p{Regional_Indicator}{2}$/u.test(value) ||
    /^[0-9#*]\ufe0f?\u20e3$/u.test(value));

type Db = Kysely<Database> | Transaction<Database>;

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const forbidden = (reply: FastifyReply, permission: TrackPermission) =>
  reply.code(403).send({ error: 'forbidden', permission });

function commentQuery(db: Db) {
  return db
    .selectFrom('ticket_comment as c')
    .leftJoin('app_user as a', 'a.id', 'c.author_id')
    .leftJoin('app_user as e', 'e.id', 'c.edited_by')
    .leftJoin('role as r', 'r.id', 'c.visible_role_id')
    .leftJoin('user_group as g', 'g.id', 'c.visible_group_id')
    .select([
      'c.id',
      'c.ticket_id',
      'c.author_id',
      'a.name as author_name',
      'c.body',
      'c.visible_role_id',
      'c.visible_group_id',
      'r.name as role_name',
      'g.name as group_name',
      'c.version',
      'c.created_at',
      'c.updated_at',
      'c.edited_at',
      'c.edited_by',
      'e.name as editor_name',
      'c.deleted_at',
    ]);
}
type CommentRow = Awaited<ReturnType<ReturnType<typeof commentQuery>['executeTakeFirstOrThrow']>>;

export interface ReactionView {
  emoji: string;
  count: number;
  /** Whether the reader is one of them. */
  mine: boolean;
}

/** Reactions to some comments, by comment, in the order each emoji was first given. */
async function reactionsOf(
  db: Db,
  commentIds: readonly number[],
  userId: number | null,
): Promise<Map<number, ReactionView[]>> {
  const out = new Map<number, ReactionView[]>();
  if (commentIds.length === 0) return out;
  const rows = await db
    .selectFrom('ticket_comment_reaction')
    .select([
      'comment_id',
      'emoji',
      sql<number>`count(*)::int`.as('count'),
      sql<boolean>`bool_or(user_id = ${userId ?? 0})`.as('mine'),
      sql<Date>`min(created_at)`.as('first'),
    ])
    .where('comment_id', 'in', [...commentIds])
    .groupBy(['comment_id', 'emoji'])
    .orderBy('first')
    .orderBy('emoji')
    .execute();
  for (const r of rows) {
    const list = out.get(r.comment_id) ?? [];
    list.push({ emoji: r.emoji, count: r.count, mine: r.mine });
    out.set(r.comment_id, list);
  }
  return out;
}

const audienceName = (c: CommentRow) =>
  c.visible_role_id !== null
    ? { roleId: c.visible_role_id, name: c.role_name ?? '' }
    : c.visible_group_id !== null
      ? { groupId: c.visible_group_id, name: c.group_name ?? '' }
      : null;

/** The history row of a comment added or deleted: its id, never its text. */
const commentChange = (ticketId: number, commentId: number, added: boolean): FieldChange => ({
  ticketId,
  field: 'comment',
  from: added ? null : String(commentId),
  to: added ? String(commentId) : null,
  fromDisplay: null,
  toDisplay: null,
});

export function registerCommentRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  /** The route's ticket: outside the trash and seen by the caller; or the refusal. */
  async function routeTicket(request: FastifyRequest, reply: FastifyReply, writing: boolean) {
    const params = z.object({ id: z.string().min(1).max(300) }).safeParse(request.params);
    if (!params.success) {
      await invalid(reply);
      return null;
    }
    const found = await resolveTicket(db, request.workspaceId, params.data.id);
    const row = found ? await loadTicket(db, request.workspaceId, found.id) : undefined;
    if (!row || row.deleted_at || !(await request.authz.seesTicket(row))) {
      await notFound(reply);
      return null;
    }
    if (writing && row.track_archived_at) {
      await reply.code(409).send({ error: 'track_archived' });
      return null;
    }
    return row;
  }

  const readerOf = (request: FastifyRequest, ticket: TicketRow) => {
    const audience = onceAudience(() => request.authz.audience(ticket.track_id));
    return (c: CommentRow) => readsComment(c, request.user?.id ?? null, audience);
  };

  /** The lock of a status that reserves commenting to some (WF-007). */
  async function commentLock(request: FastifyRequest, ticket: TicketRow): Promise<Lock | null> {
    const allowed = (await statusGate(db, request, ticket.track_id, ticket.ticket_type_id)).check(
      ticket.status_id,
      'comment',
    );
    return allowed ? statusLock(db, request.workspaceId, ticket.status_id, allowed) : null;
  }

  /** What the caller may do with comments on a ticket, for the views. */
  async function abilities(request: FastifyRequest, ticket: TicketRow) {
    const held = await request.authz.ticket(ticket);
    const signedIn = request.user !== null && request.user !== undefined;
    const writable = signedIn && !ticket.track_archived_at;
    const lock = writable ? await commentLock(request, ticket) : null;
    const open = writable && lock === null;
    return {
      lock,
      add: open && held.has('add_comments'),
      react: writable,
      edit: (own: boolean) =>
        open && (held.has('edit_all_comments') || (own && held.has('edit_own_comments'))),
      remove: (own: boolean) =>
        open && (held.has('delete_all_comments') || (own && held.has('delete_own_comments'))),
    };
  }

  async function views(
    request: FastifyRequest,
    ticket: TicketRow,
    rows: readonly CommentRow[],
    format: NonNullable<ReturnType<typeof requestedFormat>>,
    can?: Awaited<ReturnType<typeof abilities>>,
  ) {
    const userId = request.user?.id ?? null;
    const reactions = await reactionsOf(
      db,
      rows.map((c) => c.id),
      userId,
    );
    const allowed = can ?? (await abilities(request, ticket));
    return rows.map((c) => {
      const own = userId !== null && c.author_id === userId;
      return {
        id: c.id,
        author: c.author_id === null ? null : { id: c.author_id, name: c.author_name ?? '' },
        body: writeRichText(c.body as JsonValue, format),
        visibility: audienceName(c),
        version: c.version,
        createdAt: c.created_at.toISOString(),
        updatedAt: c.updated_at.toISOString(),
        edited:
          c.edited_at === null
            ? null
            : {
                at: c.edited_at.toISOString(),
                by: c.edited_by === null ? null : { id: c.edited_by, name: c.editor_name ?? '' },
              },
        reactions: reactions.get(c.id) ?? [],
        can: { edit: allowed.edit(own), delete: allowed.remove(own) },
      };
    });
  }

  /** A restriction the caller may give: a role of the workspace, or a group they are in. */
  async function checkVisibility(
    request: FastifyRequest,
    trackId: number,
    value: z.infer<typeof visibility> | undefined,
  ): Promise<string | null> {
    if (!value) return null;
    if ('roleId' in value) {
      const role = await db
        .selectFrom('role')
        .select('id')
        .where('id', '=', value.roleId)
        .where('workspace_id', '=', request.workspaceId)
        .executeTakeFirst();
      return role ? null : 'not_found';
    }
    const audience = await request.authz.audience(trackId);
    return audience.groupIds.has(value.groupId) ? null : 'not_a_member';
  }

  /** The comment of the route, as the caller reads it; null after answering 404. */
  async function routeComment(request: FastifyRequest, reply: FastifyReply, ticket: TicketRow) {
    const commentId = id.safeParse((request.params as { commentId?: string }).commentId);
    if (!commentId.success) {
      await invalid(reply);
      return null;
    }
    const comment = await commentQuery(db)
      .where('c.id', '=', commentId.data)
      .where('c.ticket_id', '=', ticket.id)
      .executeTakeFirst();
    if (!comment || !(await readerOf(request, ticket)(comment))) {
      await notFound(reply);
      return null;
    }
    return comment;
  }

  /** Locks a comment for a write and reads it as it is, still on its ticket and not deleted. */
  async function lockComment(trx: Transaction<Database>, ticketId: number, commentId: number) {
    const locked = await trx
      .selectFrom('ticket_comment')
      .select('id')
      .where('id', '=', commentId)
      .where('ticket_id', '=', ticketId)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    return locked
      ? commentQuery(trx).where('c.id', '=', commentId).executeTakeFirstOrThrow()
      : undefined;
  }

  const touchTicket = (trx: Transaction<Database>, ticketId: number) =>
    trx.updateTable('ticket').set({ updated_at: new Date() }).where('id', '=', ticketId).execute();

  // Reading

  app.get('/api/v1/tickets/:id/comments', async (request, reply) => {
    const ticket = await routeTicket(request, reply, false);
    if (!ticket) return reply;
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const q = parsed.data;
    const format = requestedFormat(q.format === undefined ? {} : { format: q.format });
    if (!format) return invalid(reply, 'format');
    // In pages by id, oldest first unless asked otherwise; comments the caller may not read are
    // left out of the page, so a page can be shorter than the limit while `next` goes on.
    let query = commentQuery(db)
      .where('c.ticket_id', '=', ticket.id)
      .where('c.deleted_at', 'is', null);
    if (q.cursor !== undefined)
      query = query.where('c.id', q.order === 'asc' ? '>' : '<', q.cursor);
    const rows = await query
      .orderBy('c.id', q.order)
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    const reads = readerOf(request, ticket);
    const readable: CommentRow[] = [];
    for (const c of page) if (await reads(c)) readable.push(c);
    const can = await abilities(request, ticket);
    return {
      comments: await views(request, ticket, readable, format, can),
      next: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
      can: { add: can.add, react: can.react },
      lock: can.lock,
    };
  });

  // A comment's own address (CORE-020 permalinks).
  app.get('/api/v1/tickets/:id/comments/:commentId', async (request, reply) => {
    const ticket = await routeTicket(request, reply, false);
    if (!ticket) return reply;
    const format = requestedFormat(request.query);
    if (!format || !formatQuery.safeParse(request.query).success) return invalid(reply, 'format');
    const comment = await routeComment(request, reply, ticket);
    if (!comment) return reply;
    const [view] = await views(request, ticket, [comment], format);
    return { comment: view };
  });

  // Where a comment may be restricted: the roles someone holds in this track, those the caller
  // holds first, and the groups the caller is in.
  app.get('/api/v1/tickets/:id/comment-audiences', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const ticket = await routeTicket(request, reply, false);
    if (!ticket) return reply;
    const audience = await request.authz.audience(ticket.track_id);
    const roles = await db
      .selectFrom('role')
      .select(['id', 'name'])
      .where('workspace_id', '=', request.workspaceId)
      .where((eb) =>
        eb.or([
          eb(
            'id',
            'in',
            eb
              .selectFrom('track_role_actor')
              .select('role_id')
              .where('track_id', '=', ticket.track_id),
          ),
          ...(audience.roleIds.size > 0 ? [eb('id', 'in', [...audience.roleIds])] : []),
        ]),
      )
      .orderBy('name')
      .orderBy('id')
      .execute();
    const groups =
      audience.groupIds.size === 0
        ? []
        : await db
            .selectFrom('user_group')
            .select(['id', 'name'])
            .where('id', 'in', [...audience.groupIds])
            .orderBy('name')
            .orderBy('id')
            .execute();
    return {
      roles: roles
        .map((r) => ({ id: r.id, name: r.name, held: audience.roleIds.has(r.id) }))
        .sort((a, b) => Number(b.held) - Number(a.held)),
      groups,
    };
  });

  // Every state of a comment, for site administrators (CORE-020 (3)), deleted ones included.
  app.get('/api/v1/tickets/:id/comments/:commentId/versions', async (request, reply) => {
    if (!(await requireGlobal(request, reply, 'site_admin'))) return reply;
    const params = z
      .object({ id: z.string().min(1).max(300), commentId: id })
      .safeParse(request.params);
    const format = requestedFormat(request.query);
    if (!params.success || !format || !formatQuery.safeParse(request.query).success) {
      return invalid(reply);
    }
    const found = await resolveTicket(db, request.workspaceId, params.data.id);
    if (!found) return notFound(reply);
    const comment = await commentQuery(db)
      .where('c.id', '=', params.data.commentId)
      .where('c.ticket_id', '=', found.id)
      .executeTakeFirst();
    if (!comment) return notFound(reply);
    const earlier = await db
      .selectFrom('ticket_comment_version as v')
      .leftJoin('app_user as w', 'w.id', 'v.written_by')
      .leftJoin('app_user as p', 'p.id', 'v.replaced_by')
      .select([
        'v.version',
        'v.body',
        'v.visible_role_id',
        'v.visible_group_id',
        'v.written_by',
        'w.name as writer_name',
        'v.written_at',
        'v.replaced_by',
        'p.name as replacer_name',
        'v.replaced_at',
      ])
      .where('v.comment_id', '=', comment.id)
      .orderBy('v.version', 'desc')
      .execute();
    const person = (userId: number | null, name: string | null) =>
      userId === null ? null : { id: userId, name: name ?? '' };
    return {
      comment: {
        id: comment.id,
        deletedAt: comment.deleted_at?.toISOString() ?? null,
      },
      versions: [
        {
          version: comment.version,
          body: writeRichText(comment.body as JsonValue, format),
          visibility: visibilityOf(comment),
          writtenBy:
            comment.edited_at === null
              ? person(comment.author_id, comment.author_name)
              : person(comment.edited_by, comment.editor_name),
          writtenAt: (comment.edited_at ?? comment.created_at).toISOString(),
          replacedAt: null,
          replacedBy: null,
        },
        ...earlier.map((v) => ({
          version: v.version,
          body: writeRichText(v.body as JsonValue, format),
          visibility: visibilityOf({ author_id: null, ...v }),
          writtenBy: person(v.written_by, v.writer_name),
          writtenAt: v.written_at.toISOString(),
          replacedAt: v.replaced_at.toISOString(),
          replacedBy: person(v.replaced_by, v.replacer_name),
        })),
      ],
    };
  });

  // Writing

  app.post('/api/v1/tickets/:id/comments', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const ticket = await routeTicket(request, reply, true);
    if (!ticket) return reply;
    const format = requestedFormat(request.query);
    if (!format || !formatQuery.safeParse(request.query).success) return invalid(reply, 'format');
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    if (!(await request.authz.canTicket('add_comments', ticket))) {
      return forbidden(reply, 'add_comments');
    }
    const lock = await commentLock(request, ticket);
    if (lock) return reply.code(403).send(lockedBody('comment', [lock]));
    const fields: Record<string, string> = {};
    const read = readRichText(parsed.data.body ?? null, format);
    if (!read.ok) fields.body = read.problem;
    else if (read.text.doc === null) fields.body = 'required';
    const problem = await checkVisibility(request, ticket.track_id, parsed.data.visibility);
    if (problem) fields.visibility = problem;
    if (Object.keys(fields).length > 0) return invalidFields(reply, fields);
    const doc = (read as { text: { doc: JsonValue } }).text.doc;
    const given = parsed.data.visibility ?? null;
    const ws = request.workspaceId;

    const created = await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('ticket')
        .select('id')
        .where('id', '=', ticket.id)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return null;
      const row = await insertComment(trx, ws, ticket, user.id, doc, given);
      await emit(trx, by(request), {
        type: 'comment.created',
        subjectId: row.id,
        payload: {
          key: ticketKey(ticket.track_key, ticket.number),
          ticketId: ticket.id,
          visibility: given,
        },
      });
      return commentQuery(trx).where('c.id', '=', row.id).executeTakeFirstOrThrow();
    });
    if (!created) return notFound(reply);
    const [view] = await views(request, ticket, [created], format);
    return reply.code(201).send({ comment: view });
  });

  app.patch('/api/v1/tickets/:id/comments/:commentId', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const ticket = await routeTicket(request, reply, true);
    if (!ticket) return reply;
    const format = requestedFormat(request.query);
    if (!format || !formatQuery.safeParse(request.query).success) return invalid(reply, 'format');
    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const comment = await routeComment(request, reply, ticket);
    if (!comment) return reply;
    const own = comment.author_id === user.id;
    const held = await request.authz.ticket(ticket);
    if (!held.has('edit_all_comments') && !(own && held.has('edit_own_comments'))) {
      return forbidden(reply, own ? 'edit_own_comments' : 'edit_all_comments');
    }
    const lock = await commentLock(request, ticket);
    if (lock) return reply.code(403).send(lockedBody('comment', [lock]));
    const body = parsed.data;
    const fields: Record<string, string> = {};
    let doc: JsonValue | undefined;
    if (body.body !== undefined) {
      const read = readRichText(body.body, format);
      if (!read.ok) fields.body = read.problem;
      else if (read.text.doc === null) fields.body = 'required';
      else doc = read.text.doc;
    }
    if (body.visibility !== undefined) {
      const problem = await checkVisibility(request, ticket.track_id, body.visibility);
      if (problem) fields.visibility = problem;
    }
    if (Object.keys(fields).length > 0) return invalidFields(reply, fields);
    const ws = request.workspaceId;

    const result = await db.transaction().execute(async (trx) => {
      const current = await lockComment(trx, ticket.id, comment.id);
      if (!current) return null;
      const changed: string[] = [];
      if (doc !== undefined && canonicalJson(doc) !== canonicalJson(current.body as JsonValue)) {
        changed.push('body');
      }
      const next: CommentVisibility | undefined = body.visibility;
      if (next !== undefined && JSON.stringify(next) !== JSON.stringify(visibilityOf(current))) {
        changed.push('visibility');
      }
      if (changed.length === 0) return current;
      await trx
        .insertInto('ticket_comment_version')
        .values({
          comment_id: current.id,
          version: current.version,
          workspace_id: ws,
          body: JSON.stringify(current.body),
          visible_role_id: current.visible_role_id,
          visible_group_id: current.visible_group_id,
          written_by: current.edited_at === null ? current.author_id : current.edited_by,
          written_at: current.edited_at ?? current.created_at,
          replaced_by: user.id,
        })
        .execute();
      const now = new Date();
      await trx
        .updateTable('ticket_comment')
        .set({
          ...(changed.includes('body') ? { body: JSON.stringify(doc) } : {}),
          ...(changed.includes('visibility')
            ? {
                visible_role_id: next && 'roleId' in next ? next.roleId : null,
                visible_group_id: next && 'groupId' in next ? next.groupId : null,
              }
            : {}),
          version: current.version + 1,
          edited_at: now,
          edited_by: user.id,
          updated_at: now,
        })
        .where('id', '=', current.id)
        .execute();
      await emit(trx, by(request), {
        type: 'comment.updated',
        subjectId: current.id,
        payload: {
          key: ticketKey(ticket.track_key, ticket.number),
          ticketId: ticket.id,
          fields: changed,
        },
      });
      return commentQuery(trx).where('c.id', '=', current.id).executeTakeFirstOrThrow();
    });
    if (!result) return notFound(reply);
    const [view] = await views(request, ticket, [result], format);
    return { comment: view };
  });

  app.delete('/api/v1/tickets/:id/comments/:commentId', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const ticket = await routeTicket(request, reply, true);
    if (!ticket) return reply;
    const comment = await routeComment(request, reply, ticket);
    if (!comment) return reply;
    const own = comment.author_id === user.id;
    const held = await request.authz.ticket(ticket);
    if (!held.has('delete_all_comments') && !(own && held.has('delete_own_comments'))) {
      return forbidden(reply, own ? 'delete_own_comments' : 'delete_all_comments');
    }
    const lock = await commentLock(request, ticket);
    if (lock) return reply.code(403).send(lockedBody('comment', [lock]));
    const ws = request.workspaceId;
    const done = await db.transaction().execute(async (trx) => {
      const current = await lockComment(trx, ticket.id, comment.id);
      if (!current) return false;
      await trx
        .updateTable('ticket_comment')
        .set({ deleted_at: new Date(), deleted_by: user.id })
        .where('id', '=', current.id)
        .execute();
      await touchTicket(trx, ticket.id);
      await recordChanges(trx, ws, user.id, [commentChange(ticket.id, current.id, false)]);
      await emit(trx, by(request), {
        type: 'comment.deleted',
        subjectId: current.id,
        payload: { key: ticketKey(ticket.track_key, ticket.number), ticketId: ticket.id, own },
      });
      return true;
    });
    if (!done) return notFound(reply);
    return reply.code(204).send();
  });

  // Reactions (CORE-020 (2)): putting one twice, or removing one never given, changes nothing.

  async function react(request: FastifyRequest, reply: FastifyReply, adding: boolean) {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const ticket = await routeTicket(request, reply, true);
    if (!ticket) return reply;
    const emoji = z
      .string()
      .min(1)
      .max(64)
      .safeParse((request.params as { emoji?: string }).emoji);
    if (!emoji.success || !isEmoji(emoji.data.normalize('NFC'))) {
      return invalidFields(reply, { emoji: 'invalid' });
    }
    const value = emoji.data.normalize('NFC');
    const comment = await routeComment(request, reply, ticket);
    if (!comment) return reply;
    const ws = request.workspaceId;
    const changed = await db.transaction().execute(async (trx) => {
      const current = await lockComment(trx, ticket.id, comment.id);
      if (!current) return null;
      const result = adding
        ? await trx
            .insertInto('ticket_comment_reaction')
            .values({ comment_id: current.id, emoji: value, user_id: user.id, workspace_id: ws })
            .onConflict((oc) => oc.doNothing())
            .executeTakeFirst()
        : await trx
            .deleteFrom('ticket_comment_reaction')
            .where('comment_id', '=', current.id)
            .where('emoji', '=', value)
            .where('user_id', '=', user.id)
            .executeTakeFirst();
      const count = Number(
        'numInsertedOrUpdatedRows' in result
          ? (result.numInsertedOrUpdatedRows ?? 0n)
          : result.numDeletedRows,
      );
      if (count === 0) return false;
      await emit(trx, by(request), {
        type: adding ? 'comment.reacted' : 'comment.unreacted',
        subjectId: current.id,
        payload: {
          key: ticketKey(ticket.track_key, ticket.number),
          ticketId: ticket.id,
          emoji: value,
        },
      });
      return true;
    });
    if (changed === null) return notFound(reply);
    const reactions = await reactionsOf(db, [comment.id], user.id);
    return reply.send({ reactions: reactions.get(comment.id) ?? [] });
  }

  app.put('/api/v1/tickets/:id/comments/:commentId/reactions/:emoji', (request, reply) =>
    react(request, reply, true),
  );
  app.delete('/api/v1/tickets/:id/comments/:commentId/reactions/:emoji', (request, reply) =>
    react(request, reply, false),
  );
}

/**
 * Writes a new comment with its history row, touches the ticket and follows it for the author
 * when they follow what they comment on (CORE-019). The ticket row must be locked. A
 * transition with a comment (WF-006) writes it here too, inside its own transaction.
 */
export async function insertComment(
  trx: Transaction<Database>,
  workspaceId: number,
  ticket: { id: number },
  authorId: number,
  doc: JsonValue,
  visibility: CommentVisibility,
) {
  const row = await trx
    .insertInto('ticket_comment')
    .values({
      workspace_id: workspaceId,
      ticket_id: ticket.id,
      author_id: authorId,
      body: JSON.stringify(doc),
      visible_role_id: visibility && 'roleId' in visibility ? visibility.roleId : null,
      visible_group_id: visibility && 'groupId' in visibility ? visibility.groupId : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .updateTable('ticket')
    .set({ updated_at: new Date() })
    .where('id', '=', ticket.id)
    .execute();
  await recordChanges(trx, workspaceId, authorId, [commentChange(ticket.id, row.id, true)]);
  await autoFollow(trx, workspaceId, ticket.id, authorId);
  return row;
}
