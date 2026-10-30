import type { Database, StatusStage } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { TRACK_PERMISSIONS } from '../authz/permissions';
import { lockList } from '../tickets/fields';
import { isKnownField } from './fields';
import type { WorkflowDefinition } from './model';
import {
  type EntryInfo,
  entriesOf,
  type ImportProblem,
  type Mapper,
  mapDefinition,
  problemsOf,
  type RefKind,
  toDocument,
  type WorkflowDocument,
} from './transfer';

/**
 * The workspace side of workflow files (M1-127; `workflows/transfer.ts` has the format): the
 * names an export writes, and an import's lookups by name. Statuses match by name without
 * case and are created when the workspace has none of that name; groups, roles, priorities,
 * close reasons and ticket types match by name, people by email, releases and areas by their
 * track's key and their name. Nothing else is created.
 */
type Db = Kysely<Database> | Transaction<Database>;

const known: Pick<Mapper, 'field' | 'permission'> = {
  field: isKnownField,
  permission: (key) => (TRACK_PERMISSIONS as readonly string[]).includes(key),
};

/** The objects of each kind a definition names, by id. */
function referencesOf(definition: WorkflowDefinition): Map<RefKind, Set<number>> {
  const refs = new Map<RefKind, Set<number>>();
  mapDefinition(definition, {
    ...known,
    ref(kind, id) {
      refs.set(kind, (refs.get(kind) ?? new Set()).add(id));
      return id;
    },
  });
  return refs;
}

/** What the export writes about each object it names; ids the workspace lacks are missing. */
async function entriesFor(
  db: Db,
  workspaceId: number,
  refs: ReadonlyMap<RefKind, ReadonlySet<number>>,
): Promise<Map<RefKind, Map<number, EntryInfo>>> {
  const out = new Map<RefKind, Map<number, EntryInfo>>();
  const ids = (kind: RefKind) => [...(refs.get(kind) ?? [])];
  const keep = (kind: RefKind, rows: readonly ({ id: number } & EntryInfo)[]) =>
    out.set(kind, new Map(rows.map(({ id, ...entry }) => [id, entry])));
  const named = async (
    kind: RefKind,
    table: 'user_group' | 'role' | 'priority' | 'close_reason' | 'ticket_type',
  ) => {
    if (ids(kind).length === 0) return;
    const { rows } = await sql<{ id: number; name: string }>`
      SELECT id, name FROM ${sql.table(table)}
       WHERE workspace_id = ${workspaceId} AND id = ANY(${ids(kind)}::int[])`.execute(db);
    keep(kind, rows);
  };
  const inTrack = async (kind: RefKind, table: 'release' | 'area') => {
    if (ids(kind).length === 0) return;
    const { rows } = await sql<{ id: number; name: string; track: string }>`
      SELECT x.id, x.name, t.key AS track FROM ${sql.table(table)} x JOIN track t ON t.id = x.track_id
       WHERE x.workspace_id = ${workspaceId} AND x.id = ANY(${ids(kind)}::int[])`.execute(db);
    keep(kind, rows);
  };
  if (ids('status').length > 0) {
    const rows = await db
      .selectFrom('status')
      .select(['id', 'name', 'stage', 'description'])
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', ids('status'))
      .execute();
    keep('status', rows);
  }
  if (ids('user').length > 0) {
    const rows = await db
      .selectFrom('app_user')
      .select(['id', 'name', 'email'])
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', ids('user'))
      .execute();
    keep('user', rows);
  }
  await named('group', 'user_group');
  await named('role', 'role');
  await named('priority', 'priority');
  await named('closeReason', 'close_reason');
  await named('ticketType', 'ticket_type');
  await inTrack('release', 'release');
  await inTrack('area', 'area');
  return out;
}

/** A workflow version as a document. */
export async function exportDocument(
  db: Db,
  workspaceId: number,
  workflow: { name: string; description: string },
  definition: WorkflowDefinition,
): Promise<WorkflowDocument> {
  const entries = await entriesFor(db, workspaceId, referencesOf(definition));
  return toDocument(workflow, definition, (kind, id) => entries.get(kind)?.get(id), known);
}

/** How a document's status came into the workspace. */
export interface StatusOutcome {
  name: string;
  stage: StatusStage;
  statusId: number;
  outcome: 'matched' | 'created';
  /** The stage of the status the name matched, when it is not the document's. */
  stageHere?: StatusStage;
}

export interface ImportResult {
  definition: WorkflowDefinition;
  statuses: StatusOutcome[];
  problems: ImportProblem[];
}

const lower = (s: string) => s.toLowerCase();

/**
 * The statuses the definition names, by name, created when missing (with the document's stage
 * and description, after the last), holding the status list's lock for the rest of the
 * transaction.
 */
async function resolveStatuses(
  trx: Transaction<Database>,
  workspaceId: number,
  document: WorkflowDocument,
): Promise<{ ids: Map<number, number>; statuses: StatusOutcome[] }> {
  await lockList(trx, workspaceId, 'status');
  const rows = await trx
    .selectFrom('status')
    .select(['id', 'name', 'stage', 'sort_order'])
    .where('workspace_id', '=', workspaceId)
    .execute();
  const byName = new Map(rows.map((r) => [lower(r.name), r]));
  let last = Math.max(0, ...rows.map((r) => r.sort_order));
  const ids = new Map<number, number>();
  const statuses: StatusOutcome[] = [];
  // Only statuses the definition names: a table row nothing uses makes nothing.
  const named = referencesOf(document.definition).get('status') ?? new Set<number>();
  for (const entry of document.statuses) {
    if (!named.has(entry.id)) continue;
    const found = byName.get(lower(entry.name));
    if (found) {
      ids.set(entry.id, found.id);
      statuses.push({
        name: entry.name,
        stage: entry.stage,
        statusId: found.id,
        outcome: 'matched',
        ...(found.stage !== entry.stage ? { stageHere: found.stage } : {}),
      });
      continue;
    }
    const created = await trx
      .insertInto('status')
      .values({
        workspace_id: workspaceId,
        name: entry.name,
        description: entry.description,
        stage: entry.stage,
        sort_order: ++last,
      })
      .returning(['id', 'name', 'stage', 'sort_order'])
      .executeTakeFirstOrThrow();
    byName.set(lower(created.name), created);
    ids.set(entry.id, created.id);
    statuses.push({
      name: entry.name,
      stage: entry.stage,
      statusId: created.id,
      outcome: 'created',
    });
  }
  return { ids, statuses };
}

/** The target's id for each document id of a kind, matched by `key` (lower case). */
async function resolveBy(
  document: WorkflowDocument,
  kind: RefKind,
  key: (entry: EntryInfo) => string,
  find: (keys: string[]) => Promise<{ id: number; key: string }[]>,
): Promise<Map<number, number>> {
  const entries = entriesOf(document, kind);
  if (entries.length === 0) return new Map();
  const keys = [...new Set(entries.map((e) => lower(key(e))))];
  const rows = await find(keys);
  // The first row of a key wins: `find` orders the better match first.
  const byKey = new Map<string, number>();
  for (const row of rows) if (!byKey.has(row.key)) byKey.set(row.key, row.id);
  const out = new Map<number, number>();
  for (const e of entries) {
    const id = byKey.get(lower(key(e)));
    if (id !== undefined) out.set(e.id, id);
  }
  return out;
}

/**
 * A document's definition in this workspace: statuses matched or created, everything else
 * matched by name where the workspace has it, and what could not be (`workflows/transfer.ts`
 * says what becomes of those parts). `ownerTrackId` is the local-mode track the workflow
 * belongs to: its own ticket types match before shared ones.
 */
export async function importDocument(
  trx: Transaction<Database>,
  workspaceId: number,
  document: WorkflowDocument,
  ownerTrackId: number | null,
): Promise<ImportResult> {
  const { ids: statusIds, statuses } = await resolveStatuses(trx, workspaceId, document);
  const named =
    (table: 'user_group' | 'role' | 'priority' | 'close_reason') => async (keys: string[]) =>
      (
        await sql<{ id: number; key: string }>`
          SELECT id, lower(name) AS key FROM ${sql.table(table)}
           WHERE workspace_id = ${workspaceId} AND lower(name) = ANY(${keys}::text[])`.execute(trx)
      ).rows;
  const inTrack = (table: 'release' | 'area') => async (keys: string[]) =>
    (
      await sql<{ id: number; key: string }>`
        SELECT x.id, lower(t.key) || '/' || lower(x.name) AS key
          FROM ${sql.table(table)} x JOIN track t ON t.id = x.track_id
         WHERE x.workspace_id = ${workspaceId}
           AND lower(t.key) || '/' || lower(x.name) = ANY(${keys}::text[])`.execute(trx)
    ).rows;
  const byName = (e: EntryInfo) => e.name;
  const byTrack = (e: EntryInfo) => `${e.track ?? ''}/${e.name}`;
  const resolved = new Map<RefKind, Map<number, number>>([
    ['status', statusIds],
    ['group', await resolveBy(document, 'group', byName, named('user_group'))],
    ['role', await resolveBy(document, 'role', byName, named('role'))],
    [
      'user',
      await resolveBy(
        document,
        'user',
        (e) => e.email ?? '',
        async (keys) =>
          (
            await sql<{ id: number; key: string }>`
              SELECT id, lower(email) AS key FROM app_user
               WHERE workspace_id = ${workspaceId} AND lower(email) = ANY(${keys}::text[])`.execute(
              trx,
            )
          ).rows,
      ),
    ],
    ['priority', await resolveBy(document, 'priority', byName, named('priority'))],
    ['closeReason', await resolveBy(document, 'closeReason', byName, named('close_reason'))],
    [
      'ticketType',
      await resolveBy(
        document,
        'ticketType',
        byName,
        async (keys) =>
          (
            await sql<{ id: number; key: string }>`
              SELECT id, lower(name) AS key FROM ticket_type
               WHERE workspace_id = ${workspaceId} AND lower(name) = ANY(${keys}::text[])
                 AND (owner_track_id IS NULL OR owner_track_id = ${ownerTrackId})
               ORDER BY owner_track_id IS NULL, id`.execute(trx)
          ).rows,
      ),
    ],
    ['release', await resolveBy(document, 'release', byTrack, inTrack('release'))],
    ['area', await resolveBy(document, 'area', byTrack, inTrack('area'))],
  ]);
  const { definition, findings } = mapDefinition(document.definition, {
    ...known,
    ref: (kind, id) => resolved.get(kind)?.get(id) ?? null,
  });
  return { definition, statuses, problems: problemsOf(document, findings) };
}
