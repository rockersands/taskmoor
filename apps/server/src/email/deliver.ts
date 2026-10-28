import { createHash, randomBytes } from 'node:crypto';
import type { Database, EmailDelivery } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Authorizer } from '../authz/authorizer';
import { type EmailKind, type EmailTicket, fieldLabel, renderEmail } from './render';
import type { MailTransport } from './transport';

/**
 * The notification mailer (M1-057; NTF-002, NTF-004): sends the email notifications the
 * notification subscriber wrote (M1-056, ADR-041).
 *
 * - **Instant** recipients get one email per ticket once its first unsent notification is as old
 *   as the workspace's batch window (two minutes by default), carrying every change made to the
 *   ticket meanwhile: five edits within the window make one email.
 * - **Daily** and **weekly** recipients get one digest of everything at the workspace's digest
 *   hour in their own time zone (weekly on Mondays), at most once a day or a week.
 * - **Quiet hours** hold email until they end, in the person's time zone.
 * - At send time the ticket is checked again: a notification about a ticket the person can no
 *   longer see is dropped, as are those of deactivated people.
 * - Each person's unsent notifications are locked while their email goes out (SKIP LOCKED), so
 *   several workers never send the same notification twice. A failed send is recorded and the
 *   notifications stay unsent for the next run. There is no daily cap.
 */
export interface MailerOptions {
  transport: MailTransport;
  from: string;
  publicUrl: string;
  now?: Date;
}

export interface MailerRun {
  sent: number;
  failed: number;
  dropped: number;
  held: number;
}

type Db = Kysely<Database>;

/** The hour, weekday and calendar day in a time zone (UTC when unknown). */
function localTime(at: Date, timeZone: string | null) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone ?? 'UTC',
      hour: 'numeric',
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);
  } catch {
    return localTime(at, null);
  }
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    hour: Number(part('hour')),
    weekday: part('weekday'),
    day: `${part('year')}-${part('month')}-${part('day')}`,
  };
}

export function inQuietHours(hour: number, start: number | null, end: number | null): boolean {
  if (start === null || end === null || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** A one-click unsubscribe link for one event, or for all email when `event` is null. */
async function unsubscribeUrl(
  trx: Transaction<Database>,
  publicUrl: string,
  workspaceId: number,
  userId: number,
  event: string | null,
): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await trx
    .insertInto('email_unsubscribe')
    .values({
      token_hash: createHash('sha256').update(token).digest(),
      workspace_id: workspaceId,
      user_id: userId,
      event,
    })
    .execute();
  return `${publicUrl.replace(/\/$/, '')}/#/unsubscribe?token=${token}`;
}

/** The token of an unsubscribe link, as stored. */
export const unsubscribeHash = (token: string) => createHash('sha256').update(token).digest();

/** Sends what is due; returns what it did. */
export async function deliverEmail(
  db: Db,
  authorizer: Authorizer,
  options: MailerOptions,
): Promise<MailerRun> {
  const now = options.now ?? new Date();
  const run: MailerRun = { sent: 0, failed: 0, dropped: 0, held: 0 };
  const people = await db
    .selectFrom('notification')
    .select(['user_id', 'workspace_id'])
    .distinct()
    .where('channel', '=', 'email')
    .where('delivered_at', 'is', null)
    .orderBy('user_id')
    .execute();
  const settings = new Map(
    (await db.selectFrom('email_setting').selectAll().execute()).map((s) => [s.workspace_id, s]),
  );
  for (const person of people) {
    const setting = settings.get(person.workspace_id);
    // Who may see which ticket is read before the transaction, which never waits for a second
    // pooled connection; notifications that arrive meanwhile wait for the next run.
    const tickets = await db
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
      ])
      .where(
        sql<boolean>`k.id IN (SELECT ticket_id FROM notification
          WHERE user_id = ${person.user_id} AND channel = 'email' AND delivered_at IS NULL)`,
      )
      .execute();
    const visible = new Map<number, (typeof tickets)[number]>();
    for (const ticket of tickets) {
      const held = await authorizer.ticketPermissions(
        person.workspace_id,
        { userId: person.user_id },
        ticket,
      );
      if (held.has('browse_track')) visible.set(ticket.id, ticket);
    }
    const judged = new Set(tickets.map((t) => t.id));
    await db.transaction().execute(async (trx) => {
      const pending = await trx
        .selectFrom('notification')
        .select(['id', 'event', 'ticket_id', 'actor_id', 'payload', 'created_at'])
        .where('user_id', '=', person.user_id)
        .where('channel', '=', 'email')
        .where('delivered_at', 'is', null)
        .orderBy('id')
        .forUpdate()
        .skipLocked()
        .execute();
      // Notifications about tickets judged above; any others wait for the next run.
      const ready = pending.filter((n) => n.ticket_id === null || judged.has(n.ticket_id));
      run.held += pending.length - ready.length;
      if (ready.length === 0) return;
      const user = await trx
        .selectFrom('app_user as u')
        .leftJoin('user_preference as p', 'p.user_id', 'u.id')
        .select([
          'u.email',
          'u.locale',
          'u.time_zone',
          'u.deactivated_at',
          'p.email_delivery',
          'p.quiet_start',
          'p.quiet_end',
        ])
        .where('u.id', '=', person.user_id)
        .executeTakeFirst();
      const drop = async (ids: readonly string[]) => {
        if (ids.length === 0) return;
        await trx
          .updateTable('notification')
          .set({ delivered_at: now })
          .where('id', 'in', [...ids])
          .execute();
        run.dropped += ids.length;
      };
      if (!user || user.deactivated_at) {
        await drop(ready.map((n) => n.id));
        return;
      }
      const local = localTime(now, user.time_zone);
      if (inQuietHours(local.hour, user.quiet_start, user.quiet_end)) {
        run.held += ready.length;
        return;
      }
      const delivery: EmailDelivery = user.email_delivery ?? 'instant';
      // Email turned off since the notifications were written: nothing goes out.
      if (delivery === 'off') {
        await drop(ready.map((n) => n.id));
        return;
      }
      const windowMs = (setting?.batch_window_seconds ?? 120) * 1000;
      let batches: (typeof ready)[] = [];
      if (delivery === 'instant') {
        const byTicket = new Map<number | null, typeof ready>();
        for (const n of ready) {
          const list = byTicket.get(n.ticket_id) ?? [];
          list.push(n);
          byTicket.set(n.ticket_id, list);
        }
        for (const list of byTicket.values()) {
          const oldest = list[0]?.created_at.getTime() ?? now.getTime();
          if (now.getTime() - oldest >= windowMs) batches.push(list);
          else run.held += list.length;
        }
      } else {
        const hour = setting?.digest_hour ?? 8;
        const due = local.hour >= hour && (delivery === 'daily' || local.weekday === 'Mon');
        const last = await trx
          .selectFrom('email_delivery')
          .select('sent_at')
          .where('user_id', '=', person.user_id)
          .where('kind', '=', delivery)
          .where('error', 'is', null)
          .orderBy('sent_at', 'desc')
          .executeTakeFirst();
        const sentToday = last && localTime(last.sent_at, user.time_zone).day === local.day;
        const sentThisWeek =
          last && now.getTime() - last.sent_at.getTime() < 6 * 24 * 60 * 60 * 1000;
        if (due && !(delivery === 'daily' ? sentToday : sentThisWeek)) batches = [ready];
        else run.held += ready.length;
      }

      for (const batch of batches) {
        // Kept only where the person may still see the ticket.
        const kept = batch.filter((n) => n.ticket_id !== null && visible.has(n.ticket_id));
        await drop(batch.filter((n) => !kept.includes(n)).map((n) => n.id));
        if (kept.length === 0) continue;

        const actorIds = [
          ...new Set(kept.flatMap((n) => (n.actor_id === null ? [] : [n.actor_id]))),
        ];
        const actors = new Map(
          actorIds.length
            ? (
                await trx
                  .selectFrom('app_user')
                  .select(['id', 'name'])
                  .where('id', 'in', actorIds)
                  .execute()
              ).map((a) => [a.id, a.name])
            : [],
        );
        const customIds = [
          ...new Set(
            kept.flatMap((n) =>
              ((n.payload.fields as string[] | undefined) ?? []).flatMap((f) => {
                const m = /^cf\[(\d+)\]$/.exec(f);
                return m ? [Number(m[1])] : [];
              }),
            ),
          ),
        ];
        const customNames = new Map(
          customIds.length
            ? (
                await trx
                  .selectFrom('field')
                  .select(['id', 'name'])
                  .where('id', 'in', customIds)
                  .execute()
              ).map((f) => [f.id, f.name])
            : [],
        );
        const base = options.publicUrl.replace(/\/$/, '');
        const byTicket = new Map<number, EmailTicket>();
        for (const n of kept) {
          const ticket = visible.get(n.ticket_id as number) as (typeof tickets)[number];
          const entry = byTicket.get(ticket.id) ?? {
            key: ticket.key,
            summary: ticket.summary,
            url: `${base}/#/tickets/${encodeURIComponent(ticket.key)}`,
            items: [],
          };
          entry.items.push({
            event: n.event,
            actorName: n.actor_id === null ? null : (actors.get(n.actor_id) ?? null),
            fields: ((n.payload.fields as string[] | undefined) ?? []).map((f) =>
              fieldLabel(f, customNames),
            ),
            at: n.created_at,
          });
          byTicket.set(ticket.id, entry);
        }
        const kind: EmailKind = delivery;
        const events = new Set(kept.map((n) => n.event));
        const unsubscribe = await unsubscribeUrl(
          trx,
          options.publicUrl,
          person.workspace_id,
          person.user_id,
          kind === 'instant' && events.size === 1 ? (kept[0]?.event as string) : null,
        );
        const email = renderEmail(
          kind,
          [...byTicket.values()],
          { settingsUrl: `${base}/#/account/notifications`, unsubscribeUrl: unsubscribe },
          user.locale,
        );
        const oneClick = unsubscribe.replace('/#/unsubscribe?', '/api/v1/unsubscribe?');
        let messageId: string | null = null;
        let error: string | null = null;
        try {
          ({ messageId } = await options.transport.send({
            from: options.from,
            to: user.email,
            subject: email.subject,
            text: email.text,
            html: email.html,
            headers: {
              'List-Unsubscribe': `<${oneClick}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
              'Auto-Submitted': 'auto-generated',
            },
          }));
        } catch (e) {
          error = e instanceof Error ? e.message.slice(0, 500) : 'send failed';
        }
        const record = await trx
          .insertInto('email_delivery')
          .values({
            workspace_id: person.workspace_id,
            user_id: person.user_id,
            kind,
            ticket_id: kind === 'instant' ? (kept[0]?.ticket_id ?? null) : null,
            notification_count: kept.length,
            subject: email.subject,
            message_id: messageId,
            error,
            sent_at: now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (error) {
          run.failed += 1;
          continue;
        }
        await trx
          .updateTable('notification')
          .set({ delivered_at: now, email_delivery_id: record.id })
          .where(
            'id',
            'in',
            kept.map((n) => n.id),
          )
          .execute();
        run.sent += 1;
      }
    });
  }
  return run;
}
