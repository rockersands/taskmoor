import type { Database } from '@taskmoor/db';
import { QueryError } from '@taskmoor/query';
import { type Kysely, sql } from 'kysely';
import type { Authorizer } from '../authz/authorizer';
import type { MailTransport } from '../email/transport';
import type { FieldCatalogs } from '../fields/catalog';
import { SearchError } from './bind';
import { queryCatalogue } from './catalogue';
import { DEFAULT_QUERY_TIMEOUT_MS, prepareSearch, runPage } from './run';
import { savedSearchVisible } from './saved';
import { nextRun } from './schedule';

/**
 * Search subscriptions (M1-063; QRY-012; ADR-053): every due subscription emails its saved
 * search's results to its person, or to each member of its group, run as that recipient: each
 * one gets only the tickets they may see (QRY-012 (1)), and only while they may see the saved
 * search itself. With "only if results" an empty result sends nothing (QRY-012 (2)).
 *
 * A worker claims a subscription by moving its `next_run_at` on with a compare-and-set, so two
 * workers never send one run twice. A recipient whose query fails (a field gone, a saved search
 * no longer visible) is skipped and the subscription records the error.
 */
export interface SubscriptionMailer {
  transport: MailTransport;
  from: string;
  publicUrl: string;
  now?: Date;
  /** Tickets listed in one email; the count says how many matched. */
  limit?: number;
  timeoutMs?: number;
}

export interface SubscriptionRun {
  due: number;
  sent: number;
  skipped: number;
  failed: number;
}

interface Recipient {
  id: number;
  email: string;
  name: string;
  time_zone: string | null;
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

export async function deliverSubscriptions(
  db: Kysely<Database>,
  authorizer: Authorizer,
  catalogs: FieldCatalogs,
  options: SubscriptionMailer,
): Promise<SubscriptionRun> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const run: SubscriptionRun = { due: 0, sent: 0, skipped: 0, failed: 0 };
  const due = await db
    .selectFrom('saved_search_subscription as u')
    .innerJoin('saved_search as s', 's.id', 'u.saved_search_id')
    .select([
      'u.id',
      'u.workspace_id',
      'u.recipient_user_id',
      'u.recipient_group_id',
      'u.schedule',
      'u.hour',
      'u.minute',
      'u.weekday',
      'u.day_of_month',
      'u.cron',
      'u.time_zone',
      'u.only_if_results',
      'u.next_run_at',
      's.id as search_id',
      's.name',
      's.query',
    ])
    .where('u.next_run_at', '<=', now)
    .orderBy('u.next_run_at')
    .limit(100)
    .execute();
  const base = options.publicUrl.replace(/\/$/, '');
  for (const sub of due) {
    const next =
      nextRun(
        {
          schedule: sub.schedule,
          hour: sub.hour,
          minute: sub.minute,
          weekday: sub.weekday,
          dayOfMonth: sub.day_of_month,
          cron: sub.cron,
          timeZone: sub.time_zone,
        },
        now,
      ) ?? new Date(now.getTime() + 365 * 24 * 3600 * 1000);
    const claimed = await db
      .updateTable('saved_search_subscription')
      .set({ next_run_at: next, last_run_at: now })
      .where('id', '=', sub.id)
      .where('next_run_at', '=', sub.next_run_at)
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) !== 1) continue;
    run.due += 1;
    const ws = sub.workspace_id;
    const recipients: Recipient[] =
      sub.recipient_user_id !== null
        ? await db
            .selectFrom('app_user')
            .select(['id', 'email', 'name', 'time_zone'])
            .where('id', '=', sub.recipient_user_id)
            .where('workspace_id', '=', ws)
            .where('deactivated_at', 'is', null)
            .where('kind', '=', 'person')
            .execute()
        : (
            await sql<Recipient>`
              WITH RECURSIVE g(id) AS (
                SELECT ${sub.recipient_group_id}::integer
                UNION
                SELECT n.child_id FROM group_nesting n JOIN g ON n.parent_id = g.id
                 WHERE n.workspace_id = ${ws}
              )
              SELECT DISTINCT u.id, u.email, u.name, u.time_zone
                FROM group_member m JOIN app_user u ON u.id = m.user_id
               WHERE m.group_id IN (SELECT id FROM g) AND m.workspace_id = ${ws}
                 AND u.deactivated_at IS NULL AND u.kind = 'person'
               ORDER BY u.id`.execute(db)
          ).rows;
    let sent = 0;
    let lastError: string | null = null;
    for (const person of recipients) {
      try {
        const sees = await db
          .selectFrom('saved_search as s')
          .select('s.id')
          .where('s.id', '=', sub.search_id)
          .where(savedSearchVisible(ws, person.id))
          .executeTakeFirst();
        if (!sees) {
          run.skipped += 1;
          continue;
        }
        const principal = { userId: person.id };
        const filter = await authorizer.ticketFilter(ws, principal);
        const catalog = await catalogs.get(ws);
        const catalogue = await queryCatalogue(db, ws, catalog, filter.tracks);
        const { compiled } = await prepareSearch({
          db,
          workspaceId: ws,
          catalog,
          catalogue,
          filter,
          q: sub.query,
          currentUserId: person.id,
          timeZone: person.time_zone,
          now,
          allowedTracks: (permission) => authorizer.allowedTracks(ws, principal, permission),
        });
        const nothing = filter.tracks !== 'all' && filter.tracks.length === 0;
        const page = nothing
          ? { ids: [] as number[], total: { count: 0, exact: true } }
          : await runPage(db, compiled, { limit, count: true, timeoutMs });
        const total = page.total ?? { count: page.ids.length, exact: true };
        if (total.count === 0 && sub.only_if_results) {
          run.skipped += 1;
          continue;
        }
        const rows =
          page.ids.length === 0
            ? []
            : await db
                .selectFrom('ticket as k')
                .innerJoin('track as t', 't.id', 'k.track_id')
                .innerJoin('status as st', 'st.id', 'k.status_id')
                .select([
                  'k.id',
                  'k.summary',
                  'st.name as status',
                  sql<string>`t.key || '-' || k.number`.as('key'),
                ])
                .where('k.id', 'in', page.ids)
                .where(filter.sql)
                .execute();
        const byId = new Map(rows.map((r) => [r.id, r]));
        const tickets = page.ids.flatMap((id) => {
          const r = byId.get(id);
          return r ? [r] : [];
        });
        const link = `${base}/#/search?savedSearch=${sub.search_id}`;
        const count = `${total.count}${total.exact ? '' : '+'}`;
        const subject = `[Taskmoor] ${sub.name}: ${count} ticket${total.count === 1 ? '' : 's'}`;
        const lines = tickets.map((t) => `${t.key}  ${t.summary}  (${t.status})`);
        const more =
          total.count > tickets.length ? [`… and ${total.count - tickets.length} more`] : [];
        const text = [
          `${sub.name}: ${count} matching ticket${total.count === 1 ? '' : 's'}`,
          '',
          ...lines,
          ...more,
          '',
          `Open the saved search: ${link}`,
        ].join('\n');
        const html = `<p><strong>${escapeHtml(sub.name)}</strong>: ${count} matching ticket${
          total.count === 1 ? '' : 's'
        }</p><table>${tickets
          .map(
            (t) =>
              `<tr><td><a href="${escapeHtml(`${base}/#/tickets/${t.key}`)}">${escapeHtml(t.key)}</a></td><td>${escapeHtml(t.summary)}</td><td>${escapeHtml(t.status)}</td></tr>`,
          )
          .join(
            '',
          )}</table>${more.length ? `<p>${escapeHtml(more[0] as string)}</p>` : ''}<p><a href="${escapeHtml(link)}">Open the saved search</a></p>`;
        await options.transport.send({
          from: options.from,
          to: person.email,
          subject,
          text,
          html,
          headers: { 'Auto-Submitted': 'auto-generated' },
        });
        sent += 1;
        run.sent += 1;
      } catch (error) {
        run.failed += 1;
        lastError =
          error instanceof QueryError || error instanceof SearchError
            ? error.message
            : 'The email could not be sent';
      }
    }
    await db
      .updateTable('saved_search_subscription')
      .set({ last_sent: sent, last_error: lastError })
      .where('id', '=', sub.id)
      .execute();
  }
  return run;
}
