import type { Database } from '@taskmoor/db';
import type { Actor, Channel, HistoryEntry, TicketState, WorkflowDef } from '@taskmoor/workflow';
import { type Kysely, sql, type Transaction, type Updateable } from 'kysely';
import type { AuthzContext } from '../authz/authorizer';
import { SUBTICKET_RANK } from '../tickets/hierarchy';
import { loadTicket, type TicketRow } from '../tickets/store';
import { engineFields, type FieldValue, parseField } from './fields';
import { definitionSchema, toEngine, type WorkflowDefinition } from './model';
import { statusInfo } from './store';

/**
 * Between the database and the workflow engine (M1-024 to M1-027): a ticket as the engine's
 * `TicketState`, the caller as its `Actor`, and the engine's result back as column values.
 * The engine decides; this module only translates and checks what is stored.
 */
type Db = Kysely<Database> | Transaction<Database>;
const text = (id: number | null) => (id === null ? null : String(id));

/** A workflow version as stored and as the engine reads it. */
export async function engineWorkflow(
  db: Db,
  workspaceId: number,
  workflowId: number,
  version: number,
): Promise<{ definition: WorkflowDefinition; workflow: WorkflowDef }> {
  const row = await db
    .selectFrom('workflow_version')
    .select('definition')
    .where('workflow_id', '=', workflowId)
    .where('version', '=', version)
    .executeTakeFirstOrThrow();
  const definition = definitionSchema.parse(row.definition);
  const statuses = await statusInfo(
    db,
    workspaceId,
    definition.statuses.map((s) => s.statusId),
  );
  return { definition, workflow: toEngine(workflowId, definition, statuses) };
}

/** A ticket as the engine sees it: values, status history, parent, subtickets and owners. */
export async function ticketState(
  db: Db,
  workspaceId: number,
  row: TicketRow,
): Promise<TicketState> {
  const moves = await db
    .selectFrom('ticket_change')
    .select(['from_value', 'to_value', 'actor_id', 'transition_id'])
    .where('ticket_id', '=', row.id)
    .where('field', '=', 'status')
    .orderBy('id')
    .execute();
  const history: HistoryEntry[] = moves.map((m) => ({
    field: 'status',
    from: m.from_value,
    to: m.to_value,
    by: m.actor_id === null ? 'system' : String(m.actor_id),
    ...(m.transition_id !== null
      ? { transition: String(m.transition_id) }
      : m.from_value === null
        ? { transition: 'create' }
        : {}),
  }));
  const parent =
    row.parent_id === null ? undefined : await loadTicket(db, workspaceId, row.parent_id);
  const subtickets = await db
    .selectFrom('ticket as k')
    .innerJoin('ticket_type as ty', 'ty.id', 'k.ticket_type_id')
    .innerJoin('hierarchy_level as l', 'l.id', 'ty.level_id')
    .select('k.status_id')
    .where('k.parent_id', '=', row.id)
    .where('k.deleted_at', 'is', null)
    .where('l.rank', '=', SUBTICKET_RANK)
    .orderBy('k.id')
    .execute();
  const owners = await db
    .selectFrom('track as t')
    .select([
      't.owner_id',
      (eb) =>
        eb
          .selectFrom('ticket_area as ta')
          .innerJoin('area as a', 'a.id', 'ta.area_id')
          .select('a.owner_id')
          .where('ta.ticket_id', '=', row.id)
          .where('a.owner_id', 'is not', null)
          .orderBy(sql`lower(a.name)`)
          .limit(1)
          .as('area_owner_id'),
    ])
    .where('t.id', '=', row.track_id)
    .executeTakeFirst();
  return {
    status: String(row.status_id),
    assignee: text(row.assignee_id),
    requester: String(row.requester_id),
    closeReason: text(row.close_reason_id),
    closedAt: row.closed_at?.toISOString() ?? null,
    visibilityLevel: null,
    fields: engineFields(row),
    history,
    ...(parent
      ? { parent: { status: String(parent.status_id), fields: engineFields(parent) } }
      : {}),
    subtickets: subtickets.map((s) => ({ status: String(s.status_id) })),
    areaOwner: text(owners?.area_owner_id ?? null),
    trackOwner: text(owners?.owner_id ?? null),
  };
}

/** The caller as the engine sees them in a track: groups, roles there and permissions there. */
export async function engineActor(
  request: { user: { id: number } | null; authz: AuthzContext },
  trackId: number,
): Promise<Actor> {
  const audience = await request.authz.audience(trackId);
  const held = await request.authz.track(trackId);
  return {
    user: String(request.user?.id ?? 'anonymous'),
    groups: [...audience.groupIds].map(String),
    roles: [...audience.roleIds].map(String),
    permissions: [...held],
  };
}

/** A browser session is the UI; a token is REST (WF-003 (3): "hide from user"). */
export const channelOf = (request: { apiToken: unknown }): Extract<Channel, 'ui' | 'rest'> =>
  request.apiToken ? 'rest' : 'ui';

export interface StoredChanges {
  ticket: Updateable<Database['ticket']>;
  /** New sets of releases and areas, when they changed. */
  targetReleases?: number[];
  foundReleases?: number[];
  areas?: number[];
  /** Ids the write points at, to check before storing. */
  assigneeId?: number | null;
  priorityId?: number | null;
  closeReasonId?: number | null;
}

const ids = (value: FieldValue) => (value as string[]).map(Number);

/**
 * The columns a transition's result changes, or the first field whose new value cannot be
 * stored (an effect that copies a value into a field of another kind, say).
 */
export function storedChanges(
  before: TicketRow,
  after: TicketState,
): { ok: true; changes: StoredChanges } | { ok: false; field: string; problem: string } {
  const set: Updateable<Database['ticket']> = {};
  const out: StoredChanges = { ticket: set };
  if (after.status !== String(before.status_id)) set.status_id = Number(after.status);
  const assignee = after.assignee ?? null;
  if (assignee !== text(before.assignee_id)) {
    const parsed = parseField('assignee', assignee);
    if (!parsed.ok) return { ok: false, field: 'assignee', problem: parsed.problem };
    out.assigneeId = parsed.value === null ? null : Number(parsed.value);
    set.assignee_id = out.assigneeId;
  }
  const reason = after.closeReason ?? null;
  if (
    reason !== text(before.close_reason_id) ||
    (after.closedAt ?? null) !== (before.closed_at?.toISOString() ?? null)
  ) {
    const parsed = parseField('close-reason', reason);
    if (!parsed.ok) return { ok: false, field: 'close-reason', problem: parsed.problem };
    out.closeReasonId = parsed.value === null ? null : Number(parsed.value);
    set.close_reason_id = out.closeReasonId;
    set.closed_at = after.closedAt ? new Date(after.closedAt) : null;
  }
  const was = engineFields(before);
  const names = new Set([...Object.keys(was), ...Object.keys(after.fields)]);
  for (const name of names) {
    const value = after.fields[name] ?? null;
    if (JSON.stringify(value) === JSON.stringify(was[name] ?? null)) continue;
    const parsed = parseField(name, value);
    if (!parsed.ok) return { ok: false, field: name, problem: parsed.problem };
    const v = parsed.value;
    switch (name) {
      case 'summary':
        set.summary = v as string;
        break;
      case 'description':
      case 'environment':
        set[name] = v === null ? null : JSON.stringify(v);
        break;
      case 'priority':
        out.priorityId = v === null ? null : Number(v);
        set.priority_id = out.priorityId;
        break;
      case 'labels':
        set.labels = v as string[];
        break;
      case 'start-date':
        set.start_date = v as string | null;
        break;
      case 'due-date':
        set.due_date = v as string | null;
        break;
      case 'original-estimate':
        set.original_estimate = v as number | null;
        break;
      case 'remaining-estimate':
        set.remaining_estimate = v as number | null;
        break;
      case 'target-release':
        out.targetReleases = ids(v);
        break;
      case 'found-in-release':
        out.foundReleases = ids(v);
        break;
      case 'area':
        out.areas = ids(v);
        break;
      default:
        return { ok: false, field: name, problem: 'not_writable' };
    }
  }
  return { ok: true, changes: out };
}

/** Loads a ticket and its engine state together. */
export async function stateOf(db: Db, workspaceId: number, ticketId: number) {
  const row = await loadTicket(db, workspaceId, ticketId);
  return row ? { row, state: await ticketState(db, workspaceId, row) } : null;
}
