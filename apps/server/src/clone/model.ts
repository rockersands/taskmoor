import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import type { AuthzContext } from '../authz/authorizer';
import { SUBTICKET_RANK } from '../tickets/hierarchy';
import { ticketKey } from '../tickets/model';

/**
 * Clone and deep clone (M1-124; CORE-023; ADR-077): what a person asks for, and the tickets a
 * clone copies.
 *
 * - A clone copies one ticket into its own track or another, with its subtickets, attachments
 *   and links unless told not to; each copy gets a Copies link to its original (CORE-023 (1)).
 * - A deep clone also copies every ticket below it, at every level, into the same track
 *   (CORE-023 (2)); its subtickets come too unless `subtickets` is false.
 * - Only tickets the person may see are copied, and nothing below one they may not see; tickets
 *   in the trash stay behind.
 */
const MAX_INT = 2_147_483_647;
const ref = z.union([z.number().int().positive().max(MAX_INT), z.string().trim().min(1).max(300)]);

export const cloneBody = z
  .object({
    /** Where the copies go: the ticket's own track by default. */
    track: ref.optional(),
    /** The copy's summary: the original's by default. */
    summary: z.string().optional(),
    subtickets: z.boolean().default(true),
    /** Every ticket below it as well, at every level: a deep clone. */
    descendants: z.boolean().default(false),
    attachments: z.boolean().default(true),
    links: z.boolean().default(true),
  })
  .strict();
export type CloneRequest = z.infer<typeof cloneBody>;

/** What a clone operation stores to run (`bulk_operation.params`). */
export interface CloneParams {
  /** The ticket asked for, and the track the copies go to. */
  ticket: number;
  key: string;
  track: number;
  trackKey: string;
  /** The first copy's summary, when the person gave one. */
  summary?: string;
  subtickets: boolean;
  descendants: boolean;
  attachments: boolean;
  links: boolean;
}

/** What a finished clone item stores and shows (`bulk_item.result`). */
export interface CloneResult {
  key: string;
  attachments: number;
  links: number;
  webLinks: number;
  /**
   * What the copy does not have: values the person could not set or the track does not take
   * (as the create body names them, such as `assigneeId` or `fields.12`), and `attachments` or
   * `links` when they may not add those there.
   */
  left: string[];
}

export interface PlannedTicket {
  id: number;
  key: string;
}

type Db = Kysely<Database>;

/**
 * The tickets a clone of `root` copies, parents before their children and children in rank
 * order (a depth-first walk), or `too_many` past `max`. Each level below is read in one
 * statement, and only the tickets the person may see go on.
 */
export async function clonePlan(
  db: Db,
  authz: AuthzContext,
  root: { id: number; trackKey: string; number: number },
  options: { subtickets: boolean; descendants: boolean },
  max: number,
): Promise<PlannedTicket[] | 'too_many'> {
  const children = new Map<number, PlannedTicket[]>();
  const seen = new Set([root.id]);
  let count = 1;
  let frontier = [root.id];
  while (frontier.length > 0) {
    const { rows } = await sql<{
      id: number;
      parent_id: number;
      number: number;
      track_key: string;
      level: number;
    }>`
      SELECT k.id, k.parent_id, k.number, t.key AS track_key, l.rank AS level
        FROM ticket k
        JOIN track t ON t.id = k.track_id
        JOIN ticket_type ty ON ty.id = k.ticket_type_id
        JOIN hierarchy_level l ON l.id = ty.level_id
       WHERE k.parent_id = ANY(${frontier}::int[]) AND k.deleted_at IS NULL
       ORDER BY k.rank`.execute(db);
    const wanted = rows.filter(
      (r) =>
        !seen.has(r.id) && (r.level === SUBTICKET_RANK ? options.subtickets : options.descendants),
    );
    const visible = await authz.visibleTickets(wanted.map((r) => r.id));
    const next: number[] = [];
    for (const r of wanted) {
      if (!visible.has(r.id)) continue;
      seen.add(r.id);
      count += 1;
      if (count > max) return 'too_many';
      const list = children.get(r.parent_id) ?? [];
      list.push({ id: r.id, key: ticketKey(r.track_key, r.number) });
      children.set(r.parent_id, list);
      next.push(r.id);
    }
    // Without a deep clone only the ticket's own subtickets come, and they have none below.
    frontier = options.descendants ? next : [];
  }
  const order: PlannedTicket[] = [];
  const walk = (ticket: PlannedTicket) => {
    order.push(ticket);
    for (const child of children.get(ticket.id) ?? []) walk(child);
  };
  walk({ id: root.id, key: ticketKey(root.trackKey, root.number) });
  return order;
}
