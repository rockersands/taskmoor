import type { Database } from '@taskmoor/db';
import { sql, type Transaction } from 'kysely';
import { canonicalJson, ticketKey } from './model';
import type { TicketRow } from './store';

/**
 * The change history of tickets (M1-009; CORE-022). Every ticket mutation records, in its own
 * transaction, one row per field it changed: the value before and after as text (ids for
 * references, ISO days for dates, canonical JSON for rich text) and the names those values had
 * at that moment. Rows of one mutation share a change set, also across tickets (a move with
 * its subtickets, a deletion that detaches children).
 */
export interface FieldChange {
  ticketId: number;
  field: string;
  from: string | null;
  to: string | null;
  fromDisplay: string | null;
  toDisplay: string | null;
}

const idText = (id: number | null) => (id === null ? null : String(id));
const richText = (doc: unknown) => (doc === null || doc === undefined ? null : canonicalJson(doc));
/** A list of values: labels by spaces, as a label holds none; empty is no value. */
const listText = (values: readonly string[]) => (values.length === 0 ? null : values.join(' '));
/** A list of references: ids by commas in the ticket's order, names by ", ". */
const idList = (items: readonly { id: number }[]) =>
  items.length === 0 ? null : items.map((i) => i.id).join(',');
const nameList = (items: readonly { name: string }[]) =>
  items.length === 0 ? null : items.map((i) => i.name).join(', ');

interface Tracked {
  field: string;
  value: (row: TicketRow) => string | null;
  display?: (row: TicketRow) => string | null;
}

/**
 * The fields history follows, named as the query language names them (ADR-010), in the order
 * a ticket view lists them.
 */
export const TRACKED_FIELDS: readonly Tracked[] = [
  { field: 'track', value: (r) => String(r.track_id), display: (r) => r.track_key },
  { field: 'key', value: (r) => ticketKey(r.track_key, r.number) },
  { field: 'type', value: (r) => String(r.ticket_type_id), display: (r) => r.type_name },
  {
    field: 'parent',
    value: (r) => idText(r.parent_id),
    display: (r) =>
      r.parent_id === null || r.parent_track_key === null || r.parent_number === null
        ? null
        : ticketKey(r.parent_track_key, r.parent_number),
  },
  { field: 'status', value: (r) => String(r.status_id), display: (r) => r.status_name },
  { field: 'summary', value: (r) => r.summary },
  { field: 'description', value: (r) => richText(r.description) },
  { field: 'environment', value: (r) => richText(r.environment) },
  { field: 'assignee', value: (r) => idText(r.assignee_id), display: (r) => r.assignee_name },
  { field: 'requester', value: (r) => idText(r.requester_id), display: (r) => r.requester_name },
  { field: 'startDate', value: (r) => r.start_date },
  { field: 'dueDate', value: (r) => r.due_date },
  { field: 'priority', value: (r) => idText(r.priority_id), display: (r) => r.priority_name },
  {
    field: 'closeReason',
    value: (r) => idText(r.close_reason_id),
    display: (r) => r.close_reason_name,
  },
  { field: 'labels', value: (r) => listText(r.labels) },
  {
    field: 'targetRelease',
    value: (r) => idList(r.target_releases),
    display: (r) => nameList(r.target_releases),
  },
  {
    field: 'foundInRelease',
    value: (r) => idList(r.found_releases),
    display: (r) => nameList(r.found_releases),
  },
  { field: 'area', value: (r) => idList(r.areas), display: (r) => nameList(r.areas) },
  // Seconds; a client formats them with the settings it reads them with.
  { field: 'originalEstimate', value: (r) => idText(r.original_estimate) },
  { field: 'remainingEstimate', value: (r) => idText(r.remaining_estimate) },
  { field: 'timeSpent', value: (r) => (r.time_spent === 0 ? null : String(r.time_spent)) },
  { field: 'rank', value: (r) => r.rank },
  { field: 'trash', value: (r) => (r.deleted_at === null ? null : 'in_trash') },
];

/**
 * What changed from `before` to `after`; a new ticket (`before` null) records every value it
 * starts with.
 */
export function ticketChanges(before: TicketRow | null, after: TicketRow): FieldChange[] {
  const out: FieldChange[] = [];
  for (const tracked of TRACKED_FIELDS) {
    const from = before ? tracked.value(before) : null;
    const to = tracked.value(after);
    if (from === to) continue;
    out.push({
      ticketId: after.id,
      field: tracked.field,
      from,
      to,
      fromDisplay: before && from !== null ? (tracked.display?.(before) ?? null) : null,
      toDisplay: to !== null ? (tracked.display?.(after) ?? null) : null,
    });
  }
  return out;
}

/**
 * Writes changes as one change set, or adds them to `changeSet` when given (a mutation that
 * writes in slices); returns the change set, or null when nothing changed.
 */
export async function recordChanges(
  trx: Transaction<Database>,
  workspaceId: number,
  actorId: number | null,
  changes: readonly FieldChange[],
  changeSet: string | null = null,
): Promise<string | null> {
  if (changes.length === 0) return changeSet;
  changeSet ??= (
    await sql<{ n: string }>`SELECT nextval('ticket_change_set_seq') AS n`.execute(trx)
  ).rows[0]?.n as string;
  await trx
    .insertInto('ticket_change')
    .values(
      changes.map((c) => ({
        workspace_id: workspaceId,
        ticket_id: c.ticketId,
        change_set: changeSet,
        actor_id: actorId,
        field: c.field,
        from_value: c.from,
        to_value: c.to,
        from_display: c.fromDisplay,
        to_display: c.toDisplay,
      })),
    )
    .execute();
  return changeSet;
}

/** The changes between two snapshots of several tickets, by id. */
export function changesOf(
  before: ReadonlyMap<number, TicketRow>,
  after: ReadonlyMap<number, TicketRow>,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const [id, row] of after) out.push(...ticketChanges(before.get(id) ?? null, row));
  return out;
}
