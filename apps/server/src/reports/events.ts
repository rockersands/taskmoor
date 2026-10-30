import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { historyName } from '../fields/values';

/**
 * The report event store (M1-059; RPT-003; ADR-056): the append-only facts reports are computed
 * from, read as one ordered stream per ticket, and folded into a ticket's state at any moment.
 *
 * - **Field events** come from the change history (M1-009, `ticket_change`): the track, type,
 *   status, close reason, assignee and parent; the original and remaining estimate and time
 *   spent; the trash; and custom number fields (story points) as `cf[<id>]`. Every ticket
 *   mutation records them in its transaction, creation included (from nothing to the first
 *   values), so a state is a fold from nothing.
 * - **Sprint events** come from `sprint_change` (M1-044): added, removed, committed, completed
 *   and carried over, with the estimates at that moment. A ticket is in a sprint from `added`
 *   until `removed`, `completed` or `carried_over`. Rows of a deleted future sprint are gone with
 *   it; a deleted completed sprint keeps them.
 * - **Replay**: folding every event of a ticket to now gives the ticket as it is; `replayCheck`
 *   compares the two for every ticket and names what differs, so a write that skipped the
 *   history shows up. A report for a past moment folds the events up to that moment only, so
 *   later edits never change it (RPT-003 (1)).
 *
 * No copy of these rows is kept: both tables are append-only already, and a copy could drift.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** The system fields reports read, as the change history names them. */
export const REPORT_FIELDS = [
  'track',
  'type',
  'status',
  'closeReason',
  'assignee',
  'parent',
  'originalEstimate',
  'remainingEstimate',
  'timeSpent',
  'trash',
] as const;
export type ReportField = (typeof REPORT_FIELDS)[number];

export type SprintChangeKind = 'added' | 'removed' | 'committed' | 'completed' | 'carried_over';

export type ReportEvent =
  | {
      kind: 'field';
      ticketId: number;
      at: Date;
      /** The history row's id: the order of changes made at the same moment. */
      seq: string;
      /** A report field, or `cf[<id>]` for a custom number field. */
      field: string;
      to: string | null;
    }
  | {
      kind: 'sprint';
      ticketId: number;
      at: Date;
      seq: string;
      sprintId: number;
      change: SprintChangeKind;
      afterStart: boolean;
      toSprintId: number | null;
      originalEstimate: number | null;
      remainingEstimate: number | null;
      points: number | null;
    };

/** A ticket as reports see it at one moment. */
export interface ReportState {
  trackId: number | null;
  typeId: number | null;
  statusId: number | null;
  closeReasonId: number | null;
  assigneeId: number | null;
  parentId: number | null;
  originalEstimate: number | null;
  remainingEstimate: number | null;
  timeSpent: number;
  inTrash: boolean;
  /** Custom number fields by id. */
  numbers: Record<number, number | null>;
  /** The open sprints the ticket is in: future or active ones (completing a sprint closes it). */
  sprints: Set<number>;
}

const emptyState = (): ReportState => ({
  trackId: null,
  typeId: null,
  statusId: null,
  closeReasonId: null,
  assigneeId: null,
  parentId: null,
  originalEstimate: null,
  remainingEstimate: null,
  timeSpent: 0,
  inTrash: false,
  numbers: {},
  sprints: new Set(),
});

const int = (text: string | null) => (text === null ? null : Number(text));
const CUSTOM = /^cf\[(\d+)\]$/;

/** Applies one event to a state, in place. */
export function apply(state: ReportState, event: ReportEvent): void {
  if (event.kind === 'sprint') {
    if (event.change === 'added') state.sprints.add(event.sprintId);
    else if (event.change !== 'committed') state.sprints.delete(event.sprintId);
    return;
  }
  const v = event.to;
  switch (event.field) {
    case 'track':
      state.trackId = int(v);
      return;
    case 'type':
      state.typeId = int(v);
      return;
    case 'status':
      state.statusId = int(v);
      return;
    case 'closeReason':
      state.closeReasonId = int(v);
      return;
    case 'assignee':
      state.assigneeId = int(v);
      return;
    case 'parent':
      state.parentId = int(v);
      return;
    case 'originalEstimate':
      state.originalEstimate = int(v);
      return;
    case 'remainingEstimate':
      state.remainingEstimate = int(v);
      return;
    case 'timeSpent':
      state.timeSpent = v === null ? 0 : Number(v);
      return;
    case 'trash':
      state.inTrash = v !== null;
      return;
    default: {
      const m = CUSTOM.exec(event.field);
      if (m) state.numbers[Number(m[1])] = v === null ? null : Number(v);
    }
  }
}

/** Orders events as they happened: by time, then by when they were written. */
export function byTime(a: ReportEvent, b: ReportEvent): number {
  const t = a.at.getTime() - b.at.getTime();
  if (t !== 0) return t;
  // Same moment: a field change and a sprint change of one transaction touch different facts.
  if (a.kind !== b.kind) return a.kind === 'field' ? -1 : 1;
  return Number(BigInt(a.seq) - BigInt(b.seq));
}

/** Each ticket's state after the events up to and including `until` (all of them without). */
export function fold(events: readonly ReportEvent[], until?: Date): Map<number, ReportState> {
  const out = new Map<number, ReportState>();
  const limit = until?.getTime() ?? Number.POSITIVE_INFINITY;
  for (const e of [...events].sort(byTime)) {
    if (e.at.getTime() > limit) continue;
    let state = out.get(e.ticketId);
    if (!state) {
      state = emptyState();
      out.set(e.ticketId, state);
    }
    apply(state, e);
  }
  return out;
}

export interface ReadOptions {
  /** Only events up to and including this moment. */
  until?: Date;
  /** Custom number fields to follow (story points). */
  numberFields?: readonly number[];
}

/** The report events of these tickets, in order. */
export async function readReportEvents(
  db: Db,
  workspaceId: number,
  ticketIds: readonly number[],
  options: ReadOptions = {},
): Promise<ReportEvent[]> {
  if (ticketIds.length === 0) return [];
  const ids = [...new Set(ticketIds)];
  const fields: string[] = [...REPORT_FIELDS, ...(options.numberFields ?? []).map(historyName)];
  const until = options.until ?? null;
  const changes = await sql<{
    ticket_id: number;
    at: Date;
    id: string;
    field: string;
    to_value: string | null;
  }>`
    SELECT ticket_id, at, id, field, to_value FROM ticket_change
     WHERE workspace_id = ${workspaceId}::int AND ticket_id = ANY(${ids}::int[])
       AND field = ANY(${fields}::text[])
       AND (${until}::timestamptz IS NULL OR at <= ${until}::timestamptz)
     ORDER BY at, id`.execute(db);
  const scope = await sql<{
    ticket_id: number;
    at: Date;
    id: string;
    sprint_id: number;
    kind: SprintChangeKind;
    after_start: boolean;
    to_sprint_id: number | null;
    original_estimate: number | null;
    remaining_estimate: number | null;
    points: string | null;
  }>`
    SELECT ticket_id, at, id, sprint_id, kind, after_start, to_sprint_id, original_estimate,
           remaining_estimate, points
      FROM sprint_change
     WHERE workspace_id = ${workspaceId}::int AND ticket_id = ANY(${ids}::int[])
       AND (${until}::timestamptz IS NULL OR at <= ${until}::timestamptz)
     ORDER BY at, id`.execute(db);
  const events: ReportEvent[] = [
    ...changes.rows.map(
      (r): ReportEvent => ({
        kind: 'field',
        ticketId: r.ticket_id,
        at: r.at,
        seq: String(r.id),
        field: r.field,
        to: r.to_value,
      }),
    ),
    ...scope.rows.map(
      (r): ReportEvent => ({
        kind: 'sprint',
        ticketId: r.ticket_id,
        at: r.at,
        seq: String(r.id),
        sprintId: r.sprint_id,
        change: r.kind,
        afterStart: r.after_start,
        toSprintId: r.to_sprint_id,
        originalEstimate: r.original_estimate,
        remainingEstimate: r.remaining_estimate,
        points: r.points === null ? null : Number(r.points),
      }),
    ),
  ];
  return events.sort(byTime);
}

/**
 * Each ticket's status changes in time order, creation first (M1-061): what the flow reports
 * read. Only the status rows, grouped by ticket, so 100,000 tickets stay a few hundred
 * thousand small rows.
 */
export async function readStatusChanges(
  db: Db,
  workspaceId: number,
  ticketIds: readonly number[],
  until: Date,
): Promise<{ id: number; changes: { at: number; statusId: number | null }[] }[]> {
  if (ticketIds.length === 0) return [];
  const ids = [...new Set(ticketIds)];
  const { rows } = await sql<{ ticket_id: number; at: Date; to_value: string | null }>`
    SELECT ticket_id, at, to_value FROM ticket_change
     WHERE workspace_id = ${workspaceId}::int AND ticket_id = ANY(${ids}::int[])
       AND field = 'status' AND at <= ${until}::timestamptz
     ORDER BY ticket_id, at, id`.execute(db);
  const out: { id: number; changes: { at: number; statusId: number | null }[] }[] = [];
  let current: (typeof out)[number] | undefined;
  for (const r of rows) {
    if (current?.id !== r.ticket_id) {
      current = { id: r.ticket_id, changes: [] };
      out.push(current);
    }
    current.changes.push({ at: r.at.getTime(), statusId: int(r.to_value) });
  }
  return out;
}

/** These tickets as reports saw them at `at`; a ticket created later is absent. */
export async function stateAt(
  db: Db,
  workspaceId: number,
  ticketIds: readonly number[],
  at: Date,
  options: Omit<ReadOptions, 'until'> = {},
): Promise<Map<number, ReportState>> {
  return fold(await readReportEvents(db, workspaceId, ticketIds, { ...options, until: at }), at);
}

export interface ReplayMismatch {
  ticketId: number;
  /** A report field, `cf[<id>]`, `sprints`, or `history` for a ticket without any. */
  field: string;
  replayed: unknown;
  live: unknown;
}

/**
 * Folds every event of the workspace's tickets to now and compares the result with the tickets
 * and open sprint memberships as they are: an empty list means every report can be recomputed
 * from the events alone. Custom number fields are those of `numberFields`. Checks tickets in
 * batches, so a large workspace never holds all of its history at once.
 */
export async function replayCheck(
  db: Db,
  workspaceId: number,
  options: { numberFields?: readonly number[]; batch?: number; ticketIds?: readonly number[] } = {},
): Promise<ReplayMismatch[]> {
  const batch = options.batch ?? 1000;
  const numberFields = options.numberFields ?? [];
  const mismatches: ReplayMismatch[] = [];
  let after = 0;
  for (;;) {
    let query = db
      .selectFrom('ticket')
      .select([
        'id',
        'track_id',
        'ticket_type_id',
        'status_id',
        'close_reason_id',
        'assignee_id',
        'parent_id',
        'original_estimate',
        'remaining_estimate',
        'time_spent',
        'deleted_at',
        'fields',
      ])
      .where('workspace_id', '=', workspaceId)
      .where('id', '>', after)
      .orderBy('id')
      .limit(batch);
    if (options.ticketIds) query = query.where('id', 'in', [...options.ticketIds, 0]);
    const tickets = await query.execute();
    if (tickets.length === 0) return mismatches;
    after = tickets[tickets.length - 1]?.id ?? after;
    const ids = tickets.map((t) => t.id);
    const states = fold(await readReportEvents(db, workspaceId, ids, { numberFields }));
    const open = await db
      .selectFrom('sprint_ticket')
      .select(['ticket_id', 'sprint_id'])
      .where('ticket_id', 'in', ids)
      .where('open', '=', true)
      .execute();
    const openOf = new Map<number, number[]>();
    for (const o of open)
      openOf.set(o.ticket_id, [...(openOf.get(o.ticket_id) ?? []), o.sprint_id]);
    for (const t of tickets) {
      const s = states.get(t.id);
      if (!s) {
        mismatches.push({ ticketId: t.id, field: 'history', replayed: null, live: 'exists' });
        continue;
      }
      const live: Record<string, unknown> = {
        track: t.track_id,
        type: t.ticket_type_id,
        status: t.status_id,
        closeReason: t.close_reason_id,
        assignee: t.assignee_id,
        parent: t.parent_id,
        originalEstimate: t.original_estimate,
        remainingEstimate: t.remaining_estimate,
        timeSpent: t.time_spent,
        trash: t.deleted_at !== null,
      };
      const replayed: Record<string, unknown> = {
        track: s.trackId,
        type: s.typeId,
        status: s.statusId,
        closeReason: s.closeReasonId,
        assignee: s.assigneeId,
        parent: s.parentId,
        originalEstimate: s.originalEstimate,
        remainingEstimate: s.remainingEstimate,
        timeSpent: s.timeSpent,
        trash: s.inTrash,
      };
      for (const id of numberFields) {
        const value = (t.fields as Record<string, unknown>)[String(id)];
        live[historyName(id)] = typeof value === 'number' ? value : null;
        replayed[historyName(id)] = s.numbers[id] ?? null;
      }
      for (const [field, value] of Object.entries(live)) {
        if (replayed[field] !== value) {
          mismatches.push({ ticketId: t.id, field, replayed: replayed[field], live: value });
        }
      }
      const liveSprints = (openOf.get(t.id) ?? []).sort((a, b) => a - b);
      const replayedSprints = [...s.sprints].sort((a, b) => a - b);
      if (liveSprints.join(',') !== replayedSprints.join(',')) {
        mismatches.push({
          ticketId: t.id,
          field: 'sprints',
          replayed: replayedSprints,
          live: liveSprints,
        });
      }
    }
    if (tickets.length < batch) return mismatches;
  }
}
