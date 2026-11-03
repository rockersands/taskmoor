import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';

/**
 * Checklists on a ticket (CORE-033; ADR-120): what the routes, clone and export share.
 */
type Db = Kysely<Database> | Transaction<Database>;

export const ITEM_STATES = ['open', 'in_progress', 'done', 'rejected'] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/** Enough for a real list; a ticket that needs more is several tickets. */
export const MAX_CHECKLISTS = 20;
export const MAX_ITEMS = 200;

export interface ChecklistProgress {
  done: number;
  /** Items that count: all but the rejected ones. */
  counted: number;
  /** A whole percent, or null when nothing counts. */
  percent: number | null;
}

/**
 * The one place that says how items make a percentage. A rejected item is left out, because it
 * will never be done: 3 done, 1 open and 1 rejected reads 75% (the user's decision, 2026-11-03).
 */
export function checklistProgress(items: readonly { state: string }[]): ChecklistProgress {
  const counted = items.filter((item) => item.state !== 'rejected');
  const done = counted.filter((item) => item.state === 'done').length;
  return {
    done,
    counted: counted.length,
    percent: counted.length === 0 ? null : Math.round((done / counted.length) * 100),
  };
}

export interface ChecklistItemRow {
  id: number;
  checklist_id: number;
  text: string;
  state: string;
  position: number;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface ChecklistRow {
  id: number;
  ticket_id: number;
  name: string;
  position: number;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

/** The items of some checklists, in order, by checklist. */
export async function itemsOf(
  db: Db,
  checklistIds: readonly number[],
): Promise<Map<number, ChecklistItemRow[]>> {
  const out = new Map<number, ChecklistItemRow[]>(checklistIds.map((id) => [id, []]));
  if (checklistIds.length === 0) return out;
  const rows = await db
    .selectFrom('ticket_checklist_item')
    .select([
      'id',
      'checklist_id',
      'text',
      'state',
      'position',
      'created_by',
      'created_at',
      'updated_at',
    ])
    .where('checklist_id', 'in', [...checklistIds])
    .orderBy('position')
    .orderBy('id')
    .execute();
  for (const row of rows) out.get(row.checklist_id)?.push(row);
  return out;
}

/** A ticket's checklists in order. */
export function checklistsOf(db: Db, ticketId: number): Promise<ChecklistRow[]> {
  return db
    .selectFrom('ticket_checklist')
    .select(['id', 'ticket_id', 'name', 'position', 'created_by', 'created_at', 'updated_at'])
    .where('ticket_id', '=', ticketId)
    .orderBy('position')
    .orderBy('id')
    .execute();
}

/** A ticket's checklists as the API shows them, with progress per list and overall. */
export async function checklistsView(db: Db, ticketId: number) {
  const lists = await checklistsOf(db, ticketId);
  const items = await itemsOf(
    db,
    lists.map((list) => list.id),
  );
  return {
    checklists: lists.map((list) => {
      const own = items.get(list.id) ?? [];
      return {
        id: list.id,
        name: list.name,
        items: own.map((item) => ({
          id: item.id,
          text: item.text,
          state: item.state as ItemState,
          createdAt: item.created_at.toISOString(),
          updatedAt: item.updated_at.toISOString(),
        })),
        progress: checklistProgress(own),
        createdAt: list.created_at.toISOString(),
        updatedAt: list.updated_at.toISOString(),
      };
    }),
    progress: checklistProgress([...items.values()].flat()),
  };
}

/**
 * Copies a ticket's checklists onto another (clone, CORE-033): the same names, items and order,
 * every item open again, since a copy starts its work from the beginning. Returns how many lists
 * it copied.
 */
export async function copyChecklists(
  trx: Transaction<Database>,
  workspaceId: number,
  fromTicket: number,
  toTicket: number,
  actorId: number,
): Promise<{ name: string }[]> {
  const lists = await checklistsOf(trx, fromTicket);
  const items = await itemsOf(
    trx,
    lists.map((list) => list.id),
  );
  for (const list of lists) {
    const copy = await trx
      .insertInto('ticket_checklist')
      .values({
        workspace_id: workspaceId,
        ticket_id: toTicket,
        name: list.name,
        position: list.position,
        created_by: actorId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const own = items.get(list.id) ?? [];
    if (own.length > 0) {
      await trx
        .insertInto('ticket_checklist_item')
        .values(
          own.map((item) => ({
            workspace_id: workspaceId,
            checklist_id: copy.id,
            text: item.text,
            state: 'open',
            position: item.position,
            created_by: actorId,
          })),
        )
        .execute();
    }
  }
  return lists.map((list) => ({ name: list.name }));
}
