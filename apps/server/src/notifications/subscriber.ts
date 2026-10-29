import type { Database, NotificationChannel } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import { Authorizer } from '../authz/authorizer';
import type { TicketAccessRow } from '../authz/visibility';
import { fieldIdOf } from '../authz/visibility';
import type { Subscriber } from '../events/bus';
import type { DomainEvent, EventType } from '../events/catalogue';
import { readsComment } from '../tickets/comments';
import { CHANNELS, CUSTOM_PREFIX, isNotificationEvent } from './model';

/**
 * The notification subscriber (M1-056; NTF-001, NTF-004): turns ticket and time entry events
 * into notifications. For each event it finds the notification event it stands for, the rules
 * of the ticket's notification policy for that event and the people they name, then keeps only
 * active people who may see the ticket at its visibility level (and, for a restricted time
 * entry or comment, its role or group), not the person who made the change unless they asked to hear of
 * their own changes, and writes one notification per channel each of them keeps on. Email
 * (M1-057) and the inbox (M1-058) deliver them.
 *
 * Recipients are judged when the event is handled, a moment after the change: the ticket as it
 * then is decides who hears of it. Delivery is at least once; a notification is unique per
 * event, person and channel, so a second delivery writes nothing.
 */
const HANDLED: readonly EventType[] = [
  'ticket.created',
  'ticket.updated',
  'ticket.transitioned',
  'ticket.deleted',
  'ticket.moved',
  'time_entry.created',
  'time_entry.updated',
  'time_entry.deleted',
  'comment.created',
];

/** What an event means for notifications: its notification event and the ticket it is about. */
export interface Occurrence {
  event: string;
  ticketId: number;
  timeEntryId: number | null;
  /** The comment a ticket_commented event is about (M1-018): only its readers hear of it. */
  commentId?: number;
  /** A comment written with a transition: quoted to those who may read it, if any. */
  quotedCommentId?: number;
  /** The fields an update changed, as the API names them. */
  fields: string[];
}

type Db = Kysely<Database>;

/** The notification event a domain event stands for; null for one that notifies nobody. */
export async function occurrenceOf(db: Db, event: DomainEvent): Promise<Occurrence | null> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const ticketId = Number(event.subjectId);
  const base = { ticketId, timeEntryId: null, fields: [] as string[] };
  switch (event.type) {
    case 'ticket.created':
      return { ...base, event: 'ticket_created' };
    case 'ticket.deleted':
      return { ...base, event: 'ticket_deleted' };
    case 'ticket.moved':
      return { ...base, event: 'ticket_moved' };
    case 'ticket.updated': {
      const changes = (payload.changes ?? {}) as Record<string, { to?: unknown }>;
      const fields = Object.keys(changes);
      // An assignment is its own event; so is a close reason being set (spec 01c section 3).
      const kind =
        'assigneeId' in changes
          ? 'ticket_assigned'
          : changes.closeReasonId && changes.closeReasonId.to != null
            ? 'ticket_close_reason_set'
            : 'ticket_updated';
      return { ...base, event: kind, fields };
    }
    case 'ticket.transitioned': {
      // A transition's own event wins (NTF-001 (2)); otherwise its stages name it.
      const quoted =
        typeof payload.commentId === 'number' ? { quotedCommentId: payload.commentId } : {};
      const own = typeof payload.event === 'string' ? payload.event : 'generic';
      if (own !== 'generic' && own !== '') {
        const custom = `${CUSTOM_PREFIX}${own}`;
        return { ...base, ...quoted, event: isNotificationEvent(custom) ? custom : 'generic' };
      }
      const statuses = await db
        .selectFrom('status')
        .select(['id', 'stage'])
        .where('id', 'in', [Number(payload.from), Number(payload.to)])
        .execute();
      const stage = (id: unknown) => statuses.find((s) => s.id === Number(id))?.stage;
      const from = stage(payload.from);
      const to = stage(payload.to);
      const kind =
        to === 'closed' && from !== 'closed'
          ? 'ticket_closed'
          : from === 'closed' && to !== 'closed'
            ? 'ticket_reopened'
            : from === 'new' && to === 'active'
              ? 'work_started'
              : from === 'active' && to === 'new'
                ? 'work_stopped'
                : 'generic';
      return { ...base, ...quoted, event: kind };
    }
    case 'time_entry.created':
    case 'time_entry.updated':
    case 'time_entry.deleted': {
      const kind = {
        'time_entry.created': 'time_entry_added',
        'time_entry.updated': 'time_entry_updated',
        'time_entry.deleted': 'time_entry_deleted',
      }[event.type];
      return {
        event: kind,
        ticketId: Number(payload.ticketId),
        timeEntryId: Number(event.subjectId),
        fields: Array.isArray(payload.fields) ? (payload.fields as string[]) : [],
      };
    }
    case 'comment.created':
      return {
        event: 'ticket_commented',
        ticketId: Number(payload.ticketId),
        timeEntryId: null,
        commentId: Number(event.subjectId),
        fields: [],
      };
    default:
      return null;
  }
}

/** Ids a user or group field holds on a ticket. */
function fieldIds(fields: Readonly<Record<string, unknown>>, fieldKey: string | null): number[] {
  const id = fieldIdOf(fieldKey);
  if (id === null) return [];
  const value = fields[String(id)];
  if (typeof value === 'number') return [value];
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
}

/** The people in these groups, nested groups included. */
async function membersOf(db: Db, workspaceId: number, groupIds: number[]): Promise<number[]> {
  if (groupIds.length === 0) return [];
  const { rows } = await sql<{ user_id: number }>`
    WITH RECURSIVE sub(id) AS (
      SELECT unnest(${groupIds}::int[])
      UNION
      SELECT n.child_id FROM group_nesting n JOIN sub ON n.parent_id = sub.id
       WHERE n.workspace_id = ${workspaceId}
    )
    SELECT DISTINCT user_id FROM group_member WHERE group_id IN (SELECT id FROM sub)`.execute(db);
  return rows.map((r) => r.user_id);
}

interface TicketFacts extends TicketAccessRow {
  key: string;
  summary: string;
  owner_id: number | null;
  policy_id: number | null;
}

/** The people a policy's rules for an event name, before any check. */
async function named(
  db: Db,
  workspaceId: number,
  ticket: TicketFacts,
  event: string,
  actorId: number | null,
): Promise<Set<number>> {
  const policyId =
    ticket.policy_id ??
    (
      await db
        .selectFrom('notification_policy')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('is_default', '=', true)
        .executeTakeFirst()
    )?.id;
  if (policyId === undefined) return new Set();
  const rules = await db
    .selectFrom('notification_rule')
    .select(['recipient', 'user_id', 'group_id', 'role_id', 'field_key'])
    .where('policy_id', '=', policyId)
    .where('event', '=', event)
    .execute();
  const out = new Set<number>();
  const add = (ids: Iterable<number | null | undefined>) => {
    for (const id of ids) if (id != null) out.add(id);
  };
  const groups: number[] = [];
  for (const rule of rules) {
    switch (rule.recipient) {
      case 'assignee':
        add([ticket.assignee_id]);
        break;
      case 'requester':
        add([ticket.requester_id]);
        break;
      case 'current_user':
        add([actorId]);
        break;
      case 'track_owner':
        add([ticket.owner_id]);
        break;
      case 'user':
        add([rule.user_id]);
        break;
      case 'user_field':
        add(fieldIds(ticket.fields, rule.field_key));
        break;
      case 'group':
        if (rule.group_id !== null) groups.push(rule.group_id);
        break;
      case 'group_field':
        groups.push(...fieldIds(ticket.fields, rule.field_key));
        break;
      case 'follower': {
        const rows = await db
          .selectFrom('ticket_follower')
          .select('user_id')
          .where('ticket_id', '=', ticket.id)
          .execute();
        add(rows.map((r) => r.user_id));
        break;
      }
      case 'area_owner': {
        const rows = await db
          .selectFrom('ticket_area as ta')
          .innerJoin('area as a', 'a.id', 'ta.area_id')
          .select('a.owner_id')
          .where('ta.ticket_id', '=', ticket.id)
          .execute();
        add(rows.map((r) => r.owner_id));
        break;
      }
      case 'role': {
        const actors = await db
          .selectFrom('track_role_actor')
          .select(['user_id', 'group_id'])
          .where('track_id', '=', ticket.track_id)
          .where('role_id', '=', rule.role_id as number)
          .execute();
        add(actors.map((a) => a.user_id));
        groups.push(...actors.flatMap((a) => (a.group_id === null ? [] : [a.group_id])));
        break;
      }
    }
  }
  add(await membersOf(db, workspaceId, [...new Set(groups)]));
  return out;
}

/** Writes the notifications one event produces; returns how many it wrote. */
export async function notify(db: Db, authorizer: Authorizer, event: DomainEvent): Promise<number> {
  const occurrence = await occurrenceOf(db, event);
  if (!occurrence) return 0;
  const ws = event.workspaceId;
  const ticket = (await db
    .selectFrom('ticket as k')
    .innerJoin('track as t', 't.id', 'k.track_id')
    .select([
      'k.id',
      'k.track_id',
      'k.requester_id',
      'k.assignee_id',
      'k.visibility_level_id',
      'k.fields',
      'k.summary',
      sql<string>`t.key || '-' || k.number`.as('key'),
      't.owner_id',
      't.notification_policy_id as policy_id',
    ])
    .where('k.id', '=', occurrence.ticketId)
    .where('k.workspace_id', '=', ws)
    .executeTakeFirst()) as TicketFacts | undefined;
  // A ticket purged since has nobody left to tell.
  if (!ticket) return 0;
  const candidates = await named(db, ws, ticket, occurrence.event, event.actorId);
  if (candidates.size === 0) return 0;

  // Active people only, and the one who made the change only if they asked for it.
  const people = await db
    .selectFrom('app_user as u')
    .leftJoin('user_preference as p', 'p.user_id', 'u.id')
    .select(['u.id', 'p.notify_own_changes', 'p.email_delivery'])
    .where('u.id', 'in', [...candidates])
    .where('u.workspace_id', '=', ws)
    .where('u.deactivated_at', 'is', null)
    .execute();
  const entry =
    occurrence.timeEntryId === null
      ? undefined
      : await db
          .selectFrom('time_entry')
          .select(['visible_role_id', 'visible_group_id'])
          .where('id', '=', occurrence.timeEntryId)
          .executeTakeFirst();
  const comment =
    occurrence.commentId === undefined
      ? undefined
      : await db
          .selectFrom('ticket_comment')
          .select(['author_id', 'visible_role_id', 'visible_group_id', 'deleted_at'])
          .where('id', '=', occurrence.commentId)
          .executeTakeFirst();
  // A comment deleted since has nothing left to tell.
  if (occurrence.commentId !== undefined && (!comment || comment.deleted_at)) return 0;
  const recipients: number[] = [];
  // People who turned email off get none written (M1-057).
  const noEmail = new Set(people.filter((p) => p.email_delivery === 'off').map((p) => p.id));
  for (const person of people) {
    if (person.id === event.actorId && !person.notify_own_changes) continue;
    // Nobody hears of a ticket they cannot see (NTF-001 (3)).
    const held = await authorizer.ticketPermissions(ws, { userId: person.id }, ticket);
    if (!held.has('browse_track')) continue;
    // A restricted time entry reaches only its role or group (M1-019).
    if (entry && (entry.visible_role_id !== null || entry.visible_group_id !== null)) {
      const audience = await authorizer.audience(ws, person.id, ticket.track_id);
      const inRole = entry.visible_role_id !== null && audience.roleIds.has(entry.visible_role_id);
      const inGroup =
        entry.visible_group_id !== null && audience.groupIds.has(entry.visible_group_id);
      if (!inRole && !inGroup) continue;
    }
    // A restricted comment reaches only its role or group (M1-018; NTF-001 (3)).
    if (
      comment &&
      !(await readsComment(comment, person.id, () =>
        authorizer.audience(ws, person.id, ticket.track_id),
      ))
    ) {
      continue;
    }
    recipients.push(person.id);
  }
  if (recipients.length === 0) return 0;

  const off = await db
    .selectFrom('notification_preference')
    .select(['user_id', 'channel'])
    .where('user_id', 'in', recipients)
    .where('event', '=', occurrence.event)
    .where('enabled', '=', false)
    .execute();
  const muted = new Set(off.map((p) => `${p.user_id}:${p.channel}`));
  for (const userId of noEmail) muted.add(`${userId}:email`);
  const payload = JSON.stringify({
    key: ticket.key,
    summary: ticket.summary,
    type: event.type,
    ...(occurrence.fields.length > 0 ? { fields: occurrence.fields } : {}),
    ...(occurrence.commentId !== undefined ? { commentId: occurrence.commentId } : {}),
    ...(occurrence.quotedCommentId !== undefined
      ? { quotedCommentId: occurrence.quotedCommentId }
      : {}),
  });
  const rows = recipients.flatMap((userId) =>
    CHANNELS.filter((channel) => !muted.has(`${userId}:${channel}`)).map(
      (channel: NotificationChannel) => ({
        workspace_id: ws,
        user_id: userId,
        channel,
        event: occurrence.event,
        ticket_id: ticket.id,
        domain_event_id: event.id,
        actor_id: event.actorId,
        payload,
        created_at: event.occurredAt,
      }),
    ),
  );
  if (rows.length === 0) return 0;
  const written = await db
    .insertInto('notification')
    .values(rows)
    .onConflict((oc) => oc.columns(['domain_event_id', 'user_id', 'channel']).doNothing())
    .returning('id')
    .execute();
  return written.length;
}

export function notificationSubscriber(db: Db): Subscriber {
  const authorizer = new Authorizer(db);
  return {
    name: 'notifications',
    types: HANDLED,
    handle: async (event) => {
      await notify(db, authorizer, event);
    },
  };
}
