import type { Database, NotificationChannel } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Authorizer } from '../authz/authorizer';
import type { DomainEvent, EventType } from '../events/catalogue';
import { CHANNELS } from './model';

/**
 * Checklist notices (T-196a; NTF-015; ADR-120): telling a ticket's followers that its checklists
 * changed, on a track whose administrators turned it on (`track.notify_checklist_changes`, off
 * by default). It is a product event, `checklist_changed`, outside notification policies: it
 * reaches the ticket's followers and nobody else, in the inbox and by email as each person's
 * preferences say (per channel for this event, and their email delivery).
 *
 * - **Never one's own change**: the person who made it is left out, whatever "Tell me about
 *   changes I make myself" says, because a run of ticks is theirs to know.
 * - **Only those who may see the ticket**, at its visibility level, when the change is handled;
 *   the inbox and the mailer judge it again before showing or sending, as for every ticket
 *   notification. A notice holds no checklist's name and no item's text, only the ticket, who
 *   changed it and how many changes, so it says nothing the reader could not read on the ticket.
 * - **One notice for a run of changes**: as the mailer gathers one ticket's changes within the
 *   workspace's batch window into one email (NTF-002), a change joins the person's open notice
 *   about the same ticket on each channel instead of writing another. A notice is open while it
 *   is unread, not snoozed and not yet emailed, for the batch window from its first change, and
 *   up to `MAX_NOTICE_CHANGES` changes; after that the next change starts a new one. The notice
 *   counts its changes and keeps who made them.
 * - **An email stays within one inbox notice**, so that reading the notice settles every email it
 *   covers (NTF-003 (2)). An instant email holds a run that is still gathering (`email/deliver.ts`),
 *   but a digest at its hour, or a mailer that runs while a change made inside the window is still
 *   on its way to the worker, sends one in mid-run: the inbox notice goes on and the next change
 *   starts another email, so one notice can cover several emails. The reverse never happens: when
 *   the inbox notice closes, by a snooze or its window, the email closes with it, even with room
 *   left, and the next change starts both afresh.
 *
 * Delivery is at least once: a notice lists the events it holds, so an event delivered twice
 * counts once. Changes to one ticket are written one at a time (an advisory lock on the ticket),
 * so two workers never both start a notice for the same run.
 */
export const CHECKLIST_EVENT = 'checklist_changed';

/** The domain events that tell followers of a checklist change. */
export const CHECKLIST_NOTICES = [
  'ticket.checklist_changed',
] as const satisfies readonly EventType[];

/** Changes one notice gathers at most; the next starts another. */
export const MAX_NOTICE_CHANGES = 100;
/** People a notice names at most; more are counted in the changes alone. */
const MAX_PEOPLE = 50;
/** The batch window when a workspace has set none (M1-057). */
const DEFAULT_WINDOW_SECONDS = 120;

/** What a checklist notice carries: the ticket, how many changes, who made them. */
export interface ChecklistNotice {
  key: string;
  summary: string;
  type: 'ticket.checklist_changed';
  /** Changes it gathers. */
  changes: number;
  /** Who made them, first one first, each once. */
  people: number[];
  /** The domain events it holds, so a second delivery of one counts nothing. */
  events: string[];
}

/** How many changes a notice gathers and how many other people made them, from its payload. */
export function noticeCounts(payload: Record<string, unknown>): {
  changes: number;
  others: number;
} {
  const changes =
    typeof payload.changes === 'number' && Number.isSafeInteger(payload.changes)
      ? Math.max(1, payload.changes)
      : 1;
  const people = Array.isArray(payload.people) ? payload.people.length : 1;
  return { changes, others: Math.max(0, people - 1) };
}

type Db = Kysely<Database>;
type Bump = (
  trx: Kysely<Database> | Transaction<Database>,
  workspaceId: number,
  userIds: Iterable<number>,
) => Promise<void>;

/** Writes or extends the notices one checklist change produces; returns how many it touched. */
export async function notifyChecklist(
  db: Db,
  authorizer: Authorizer,
  event: DomainEvent,
  bump: Bump,
): Promise<number> {
  const ws = event.workspaceId;
  const ticketId = Number(event.subjectId);
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0) return 0;
  const ticket = await db
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
      'k.deleted_at',
      sql<string>`t.key || '-' || k.number`.as('key'),
      't.notify_checklist_changes',
    ])
    .where('k.id', '=', ticketId)
    .where('k.workspace_id', '=', ws)
    .executeTakeFirst();
  // Off for the track, or the ticket gone or in the trash since: nobody to tell.
  if (!ticket?.notify_checklist_changes || ticket.deleted_at) return 0;

  // The followers, active, never the one who made the change.
  let followers = db
    .selectFrom('ticket_follower as f')
    .innerJoin('app_user as u', 'u.id', 'f.user_id')
    .leftJoin('user_preference as p', 'p.user_id', 'u.id')
    .select(['u.id', 'p.email_delivery'])
    .where('f.ticket_id', '=', ticket.id)
    .where('u.workspace_id', '=', ws)
    .where('u.deactivated_at', 'is', null);
  if (event.actorId !== null) followers = followers.where('u.id', '!=', event.actorId);
  const people = await followers.orderBy('u.id').execute();
  if (people.length === 0) return 0;

  // Nobody hears of a ticket they cannot see (NTF-001 (3)).
  const seeing: typeof people = [];
  for (const person of people) {
    const held = await authorizer.ticketPermissions(ws, { userId: person.id }, ticket);
    if (held.has('browse_track')) seeing.push(person);
  }
  if (seeing.length === 0) return 0;

  const muted = new Set(
    (
      await db
        .selectFrom('notification_preference')
        .select(['user_id', 'channel'])
        .where(
          'user_id',
          'in',
          seeing.map((p) => p.id),
        )
        .where('event', '=', CHECKLIST_EVENT)
        .where('enabled', '=', false)
        .execute()
    ).map((p) => `${p.user_id}:${p.channel}`),
  );
  const wanted = seeing.flatMap((person) =>
    CHANNELS.filter(
      (channel: NotificationChannel) =>
        !muted.has(`${person.id}:${channel}`) &&
        !(channel === 'email' && person.email_delivery === 'off'),
    ).map((channel) => ({ userId: person.id, channel })),
  );
  if (wanted.length === 0) return 0;
  const windowSeconds =
    (
      await db
        .selectFrom('email_setting')
        .select('batch_window_seconds')
        .where('workspace_id', '=', ws)
        .executeTakeFirst()
    )?.batch_window_seconds ?? DEFAULT_WINDOW_SECONDS;
  const opensAfter = new Date(event.occurredAt.getTime() - windowSeconds * 1000);
  const userIds = [...new Set(wanted.map((w) => w.userId))];

  return db.transaction().execute(async (trx) => {
    // One writer of this ticket's notices at a time.
    await sql`SELECT pg_advisory_xact_lock(hashtext('checklist-notice'), ${ticket.id}::int)`.execute(
      trx,
    );
    const mine = await trx
      .selectFrom('notification')
      .select(['id', 'user_id', 'channel', 'domain_event_id', 'payload'])
      .select(
        sql<boolean>`read_at IS NULL AND delivered_at IS NULL AND snoozed_until IS NULL
          AND coalesce((payload->>'changes')::int, 1) < ${MAX_NOTICE_CHANGES}`.as('open'),
      )
      .where('user_id', 'in', userIds)
      .where('ticket_id', '=', ticket.id)
      .where('event', '=', CHECKLIST_EVENT)
      // Those that may still take this change, inside the window from their first change (the one
      // place the window is read: any other row here holds the change and so takes nothing), and
      // any that holds it already.
      .where(
        sql<boolean>`(created_at > ${opensAfter} OR domain_event_id = ${event.id}::bigint
          OR payload->'events' ? ${event.id}::text)`,
      )
      // Inbox rows first, as a reader takes them (the notice, then its emails), so the two never
      // wait on each other; newest first within a channel.
      .orderBy('channel', 'desc')
      .orderBy('id', 'desc')
      .forUpdate()
      .execute();
    const holds = (row: (typeof mine)[number]) =>
      row.domain_event_id === event.id ||
      (Array.isArray(row.payload.events) && row.payload.events.includes(event.id));
    const eventsOf = (row: (typeof mine)[number]): unknown[] =>
      Array.isArray(row.payload.events) ? row.payload.events : [row.domain_event_id];
    /** Whether an inbox notice holds every change an email does. */
    const covers = (inbox: (typeof mine)[number], email: (typeof mine)[number]) =>
      eventsOf(email).every((id) => eventsOf(inbox).includes(id));
    const fresh: typeof wanted = [];
    const extend: string[] = [];
    for (const userId of userIds) {
      const rows = mine.filter((r) => r.user_id === userId);
      // Delivered before: nothing more to write.
      if (rows.some(holds)) continue;
      const channels = wanted.filter((w) => w.userId === userId).map((w) => w.channel);
      const inboxWanted = channels.includes('inbox');
      const openOn = (channel: NotificationChannel) =>
        channels.includes(channel) ? rows.find((r) => r.channel === channel && r.open) : undefined;
      const inbox = openOn('inbox');
      if (channels.includes('email')) {
        const email = openOn('email');
        // The email goes on only inside the inbox notice this change joins; with no inbox for
        // this change, only if no inbox notice still in its window holds the email's changes.
        const joins =
          email !== undefined &&
          (inboxWanted
            ? inbox !== undefined && covers(inbox, email)
            : !rows.some((r) => r.channel === 'inbox' && covers(r, email)));
        if (joins) extend.push(email.id);
        else fresh.push({ userId, channel: 'email' });
      }
      if (inbox) extend.push(inbox.id);
      else if (inboxWanted) fresh.push({ userId, channel: 'inbox' });
    }
    const touchedInbox = new Set<number>();
    if (extend.length > 0) {
      const had = sql`coalesce(payload->'people', '[]'::jsonb)`;
      // The person joins the list once, and only while it has room.
      const people =
        event.actorId === null
          ? had
          : sql`CASE WHEN ${had} @> to_jsonb(${event.actorId}::int)
                       OR jsonb_array_length(${had}) >= ${MAX_PEOPLE}
                     THEN ${had} ELSE ${had} || to_jsonb(${event.actorId}::int) END`;
      const extended = await trx
        .updateTable('notification')
        .set({
          payload: sql`payload || jsonb_build_object(
            'changes', coalesce((payload->>'changes')::int, 1) + 1,
            'events', coalesce(payload->'events', '[]'::jsonb) || to_jsonb(${event.id}::text),
            'people', ${people})`,
        })
        .where('id', 'in', extend)
        .returning(['user_id', 'channel'])
        .execute();
      for (const row of extended) if (row.channel === 'inbox') touchedInbox.add(row.user_id);
    }
    let written = 0;
    if (fresh.length > 0) {
      const notice: ChecklistNotice = {
        key: ticket.key,
        summary: ticket.summary,
        type: 'ticket.checklist_changed',
        changes: 1,
        people: event.actorId === null ? [] : [event.actorId],
        events: [event.id],
      };
      const inserted = await trx
        .insertInto('notification')
        .values(
          fresh.map(({ userId, channel }) => ({
            workspace_id: ws,
            user_id: userId,
            channel,
            event: CHECKLIST_EVENT,
            ticket_id: ticket.id,
            domain_event_id: event.id,
            actor_id: event.actorId,
            payload: JSON.stringify(notice),
            created_at: event.occurredAt,
          })),
        )
        .onConflict((oc) => oc.columns(['domain_event_id', 'user_id', 'channel']).doNothing())
        .returning(['user_id', 'channel'])
        .execute();
      written = inserted.length;
      for (const row of inserted) if (row.channel === 'inbox') touchedInbox.add(row.user_id);
    }
    await bump(trx, ws, touchedInbox);
    return written + extend.length;
  });
}
