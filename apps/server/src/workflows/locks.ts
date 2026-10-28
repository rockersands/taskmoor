import type { Database } from '@taskmoor/db';
import type { StatusPermissions } from '@taskmoor/workflow';
import type { Kysely, Transaction } from 'kysely';
import { loadDefinition, trackWorkflowId } from './store';

/**
 * Per-status locks (WF-007) and per-field edit permissions (M1-029).
 *
 * - A workflow may name, per status, the roles and groups that alone may edit a ticket, comment
 *   on it, attach files to it, assign it or move it along (`statusPermissions`). Everyone else
 *   keeps their track permissions but is refused these actions while the ticket sits there.
 * - A field rule may name the roles and groups that alone may set the field
 *   (`editableBy`), on create, edit and transition layouts.
 * - Neither grants anything: a person still needs the track permission for the action.
 * - A refusal carries the lock (what refused and who may), so the client explains it in the
 *   reader's language instead of only greying the control out (WF-007 (2)).
 */
type Db = Kysely<Database> | Transaction<Database>;

export type LockAction = keyof StatusPermissions;
export const LOCK_ACTIONS: readonly LockAction[] = [
  'edit',
  'comment',
  'attach',
  'assign',
  'transition',
];

/** A role or group a lock lets through. */
export interface Holder {
  type: 'role' | 'group';
  id: number;
}
export interface NamedHolder extends Holder {
  name: string;
}

export type Lock =
  | { by: 'status'; statusId: number; statusName: string; allowed: NamedHolder[] }
  | { by: 'field'; field: string; allowed: NamedHolder[] };

/** Who the person is in a track, as locks read it. */
export interface Audience {
  roleIds: ReadonlySet<number>;
  groupIds: ReadonlySet<number>;
}

export const holds = (audience: Audience, holder: Holder) =>
  holder.type === 'role' ? audience.roleIds.has(holder.id) : audience.groupIds.has(holder.id);

/**
 * The holders a lock lets through, or null when the person is one of them or there is no lock.
 * An empty list lets nobody through, as the workflow engine reads it (a frozen status).
 */
export function lockedOut(audience: Audience, allowed: readonly Holder[] | null | undefined) {
  if (!allowed) return null;
  return allowed.some((h) => holds(audience, h)) ? null : [...allowed];
}

/** A track's per-status lists, keyed by status id (published versions never change). */
type StatusTable = ReadonlyMap<number, Partial<Record<LockAction, Holder[]>>>;
const tables = new Map<string, StatusTable>();

function tableOf(definition: Awaited<ReturnType<typeof loadDefinition>>): StatusTable {
  const out = new Map<number, Partial<Record<LockAction, Holder[]>>>();
  for (const [status, permissions] of Object.entries(definition.statusPermissions ?? {})) {
    const entry: Partial<Record<LockAction, Holder[]>> = {};
    for (const action of LOCK_ACTIONS) {
      const list = permissions[action];
      if (list) {
        entry[action] = list.map((p) =>
          'role' in p
            ? { type: 'role', id: Number(p.role) }
            : { type: 'group', id: Number(p.group) },
        );
      }
    }
    out.set(Number(status), entry);
  }
  return out;
}

async function statusTable(db: Db, workspaceId: number, trackId: number): Promise<StatusTable> {
  const workflowId = await trackWorkflowId(db, workspaceId, trackId);
  const row = await db
    .selectFrom('workflow')
    .select('published_version')
    .where('id', '=', workflowId)
    .executeTakeFirstOrThrow();
  const key = `${workflowId}:${row.published_version}`;
  let table = tables.get(key);
  if (!table) {
    table = tableOf(await loadDefinition(db, workflowId, row.published_version));
    if (tables.size >= 500) tables.delete(tables.keys().next().value as string);
    tables.set(key, table);
  }
  return table;
}

/**
 * The status locks of a track for one person, read before a write's transaction (which never
 * waits for a second pooled connection): `check` then answers inside it, for the status the
 * locked ticket row has then.
 */
export interface StatusGate {
  audience: Audience;
  /** The holders an action is limited to in a status, when the person is not one of them. */
  check(statusId: number, action: LockAction): Holder[] | null;
}

export async function statusGate(
  db: Db,
  request: { workspaceId: number; authz: { audience(trackId: number): Promise<Audience> } },
  trackId: number,
): Promise<StatusGate> {
  const [table, audience] = await Promise.all([
    statusTable(db, request.workspaceId, trackId),
    request.authz.audience(trackId),
  ]);
  return gateOf(table, audience);
}

/** The same, for a person known by their audience (co-editing has no request). */
export async function statusGateFor(
  db: Db,
  workspaceId: number,
  trackId: number,
  audience: Audience,
): Promise<StatusGate> {
  return gateOf(await statusTable(db, workspaceId, trackId), audience);
}

const gateOf = (table: StatusTable, audience: Audience): StatusGate => ({
  audience,
  check: (statusId, action) => lockedOut(audience, table.get(statusId)?.[action]),
});

/** Names the holders, for a refusal or the lock listing. */
export async function nameHolders(db: Db, holders: readonly Holder[]): Promise<NamedHolder[]> {
  const roleIds = holders.filter((h) => h.type === 'role').map((h) => h.id);
  const groupIds = holders.filter((h) => h.type === 'group').map((h) => h.id);
  const [roles, groups] = await Promise.all([
    roleIds.length === 0
      ? []
      : db.selectFrom('role').select(['id', 'name']).where('id', 'in', roleIds).execute(),
    groupIds.length === 0
      ? []
      : db.selectFrom('user_group').select(['id', 'name']).where('id', 'in', groupIds).execute(),
  ]);
  const names = new Map<string, string>([
    ...roles.map((r) => [`role:${r.id}`, r.name] as const),
    ...groups.map((g) => [`group:${g.id}`, g.name] as const),
  ]);
  return holders.map((h) => ({ ...h, name: names.get(`${h.type}:${h.id}`) ?? '' }));
}

/** A status lock as a refusal or the listing shows it. */
export async function statusLock(
  db: Db,
  workspaceId: number,
  statusId: number,
  holders: readonly Holder[],
): Promise<Lock> {
  const status = await db
    .selectFrom('status')
    .select('name')
    .where('id', '=', statusId)
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  return {
    by: 'status',
    statusId,
    statusName: status?.name ?? '',
    allowed: await nameHolders(db, holders),
  };
}

/** The 403 body of a lock: the action refused and the lock that refused it. */
export const lockedBody = (action: LockAction | 'edit_field', locks: Lock[]) => ({
  error: 'forbidden',
  permission: action,
  locks,
});

/** Field locks as a refusal or the layout shows them. */
export function fieldLockList(
  db: Db,
  locked: ReadonlyMap<string, readonly Holder[]>,
): Promise<Lock[]> {
  return Promise.all(
    [...locked].map(
      async ([field, holders]): Promise<Lock> => ({
        by: 'field',
        field,
        allowed: await nameHolders(db, holders),
      }),
    ),
  );
}

/** The audience of an engine actor (whose role and group ids are text). */
export const audienceOf = (actor: { roles?: readonly string[]; groups?: readonly string[] }) => ({
  roleIds: new Set((actor.roles ?? []).map(Number)),
  groupIds: new Set((actor.groups ?? []).map(Number)),
});
