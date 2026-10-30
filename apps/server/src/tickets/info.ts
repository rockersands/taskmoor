import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';

/**
 * A ticket's read-only info fields (M1-125; CORE-012), as the ticket page shows them:
 *
 * - **Date of first response** and the **last comment**, from the columns Postgres keeps
 *   (migration 0058), and the whole **days since the last comment**;
 * - **Participants:** the requester, the assignee and the authors of counted comments;
 * - **Time in status:** for each status the ticket has been in, the sum of its intervals in the
 *   change history, from creation to now.
 *
 * Counted comments are those everyone who sees the ticket may read (not restricted, not in the
 * trash), the same rule the query fields use, so nobody learns of a comment they cannot read.
 */
export interface StatusTime {
  status: { id: number; name: string };
  /** Whole seconds spent in it, over every visit. */
  seconds: number;
  /** How many times the ticket entered it (creation counts for the first status). */
  visits: number;
}

export interface TicketInfo {
  firstResponse: string | null;
  lastComment: string | null;
  daysSinceLastComment: number | null;
  participants: { id: number; name: string }[];
  timeInStatus: StatusTime[];
}

interface InfoTicket {
  id: number;
  status_id: number;
  requester_id: number | null;
  assignee_id: number | null;
  created_at: Date;
  first_response_at: Date | null;
  last_comment_at: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Time in each status from the ticket's status changes, oldest first: each change's new status
 * until the next change, the last until `now`. Creation is the first change (from nothing); a
 * ticket without any change has been in its current status since creation.
 */
export function timeInStatus(
  createdAt: Date,
  currentStatus: number,
  changes: readonly { at: Date; from: number | null; to: number | null }[],
  now: Date,
): Map<number, { ms: number; visits: number }> {
  const spent = new Map<number, { ms: number; visits: number }>();
  // One visit: entered at `from`, left at `to`.
  const visit = (status: number | null, from: Date, to: Date) => {
    if (status === null) return;
    const entry = spent.get(status) ?? { ms: 0, visits: 0 };
    entry.ms += Math.max(0, to.getTime() - from.getTime());
    entry.visits += 1;
    spent.set(status, entry);
  };
  // Creation records the first status as a change from nothing; history from before the
  // status was recorded starts in the status the first change left.
  let status: number | null = changes.length === 0 ? currentStatus : (changes[0]?.from ?? null);
  let since = createdAt;
  for (const change of changes) {
    visit(status, since, change.at);
    status = change.to;
    since = change.at;
  }
  visit(status, since, now);
  return spent;
}

export async function ticketInfo(
  db: Kysely<Database>,
  workspaceId: number,
  ticket: InfoTicket,
  now = new Date(),
): Promise<TicketInfo> {
  const [changes, commenters, statuses] = await Promise.all([
    db
      .selectFrom('ticket_change')
      .select(['at', 'from_value', 'to_value', 'from_display', 'to_display'])
      .where('workspace_id', '=', workspaceId)
      .where('ticket_id', '=', ticket.id)
      .where('field', '=', 'status')
      .orderBy('at')
      .orderBy('id')
      .execute(),
    sql<{ id: number }>`
      SELECT author_id AS id FROM ticket_comment
       WHERE ticket_id = ${ticket.id} AND author_id IS NOT NULL AND deleted_at IS NULL
         AND visible_role_id IS NULL AND visible_group_id IS NULL
       GROUP BY author_id ORDER BY min(created_at)`.execute(db),
    db
      .selectFrom('status')
      .select(['id', 'name', 'sort_order'])
      .where('workspace_id', '=', workspaceId)
      .execute(),
  ]);
  const number = (v: string | null) => (v === null || !/^\d+$/.test(v) ? null : Number(v));
  // A status deleted since keeps the name the history gave it.
  const names = new Map<number, string>();
  for (const c of changes) {
    const from = number(c.from_value);
    const to = number(c.to_value);
    if (from !== null && c.from_display) names.set(from, c.from_display);
    if (to !== null && c.to_display) names.set(to, c.to_display);
  }
  const order = new Map<number, number>();
  for (const s of statuses) {
    names.set(s.id, s.name);
    order.set(s.id, s.sort_order);
  }
  const spent = timeInStatus(
    ticket.created_at,
    ticket.status_id,
    changes.map((c) => ({ at: c.at, from: number(c.from_value), to: number(c.to_value) })),
    now,
  );

  const ids = [
    ...new Set(
      [ticket.requester_id, ticket.assignee_id, ...commenters.rows.map((r) => r.id)].filter(
        (id): id is number => id !== null,
      ),
    ),
  ];
  const people =
    ids.length === 0
      ? []
      : await db.selectFrom('app_user').select(['id', 'name']).where('id', 'in', ids).execute();
  const nameOf = new Map(people.map((p) => [p.id, p.name]));

  return {
    firstResponse: ticket.first_response_at?.toISOString() ?? null,
    lastComment: ticket.last_comment_at?.toISOString() ?? null,
    daysSinceLastComment:
      ticket.last_comment_at === null
        ? null
        : Math.floor((now.getTime() - ticket.last_comment_at.getTime()) / DAY_MS),
    participants: ids.map((id) => ({ id, name: nameOf.get(id) ?? '' })),
    timeInStatus: [...spent]
      .map(([id, s]) => ({
        status: { id, name: names.get(id) ?? '' },
        seconds: Math.floor(s.ms / 1000),
        visits: s.visits,
      }))
      .sort(
        (a, b) =>
          (order.get(a.status.id) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(b.status.id) ?? Number.MAX_SAFE_INTEGER) || a.status.id - b.status.id,
      ),
  };
}
