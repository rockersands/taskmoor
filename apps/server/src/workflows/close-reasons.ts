import type { Database } from '@taskmoor/db';
import type { EffectDef } from '@taskmoor/workflow';
import { type Kysely, sql, type Transaction } from 'kysely';
import { type DefinitionProblem, definitionSchema, type WorkflowDefinition } from './model';
import {
  type CurrentVersions,
  holdCurrentVersions,
  rewriteCurrentVersions,
  statusInfo,
} from './store';

/**
 * Workflows that name a close reason (WF-008). A transition that sets a reason holds its id, so a
 * deleted reason would make every move into that closing status fail: the default workflow's
 * Closed holds Completed. Deleting one that a published version or a draft sets is refused, or the
 * workflows take the replacement. Earlier versions stay as they were written, so one that names a
 * deleted reason cannot come back: `closeReasonProblem` refuses it, as it refuses a draft that
 * names one.
 */
const CLOSE_REASON = 'close-reason';

const setsReason = (effect: EffectDef, reason: string): boolean =>
  (effect.type === 'update-system-field' || effect.type === 'update-field') &&
  effect.field === CLOSE_REASON &&
  String(effect.value) === reason;

/** Every close reason a definition sets, and where: a transition's id, or null on creation. */
function reasonsSet(definition: Pick<WorkflowDefinition, 'transitions' | 'onCreate' | 'rules'>) {
  const set: { transitionId: number | null; value: unknown }[] = [];
  const read = (
    transitionId: number | null,
    effects: readonly { type: string; field?: string; value?: unknown }[],
  ) => {
    for (const e of effects) {
      const writes = e.type === 'update-system-field' || e.type === 'update-field';
      if (writes && e.field === CLOSE_REASON && e.value != null) {
        set.push({ transitionId, value: e.value });
      }
    }
  };
  for (const t of definition.transitions) read(t.id, t.effects ?? []);
  read(null, definition.onCreate?.effects ?? []);
  for (const [id, list] of Object.entries(definition.rules ?? {})) read(Number(id), list);
  return set;
}

/**
 * Why a definition cannot be saved or published as it stands, for what `definitionProblem` cannot
 * see from the definition alone: a close reason it sets that the workspace no longer has. Every
 * move through that transition would be refused.
 */
export async function closeReasonProblem(
  db: Kysely<Database>,
  workspaceId: number,
  definition: WorkflowDefinition,
): Promise<DefinitionProblem | null> {
  const set = reasonsSet(definition);
  if (set.length === 0) return null;
  const rows = await db
    .selectFrom('close_reason')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .execute();
  const known = new Set(rows.map((r) => String(r.id)));
  const missing = set.find((s) => !known.has(String(s.value)));
  return missing
    ? {
        problem: 'unknown_close_reason',
        transitionId: missing.transitionId,
        reasonId: Number(missing.value),
      }
    : null;
}

/**
 * The reason the default workflow sets on entering a closed-stage status, or null. It follows the
 * reason Completed through a rename and a replacement, which a lookup by name cannot.
 */
export async function defaultClosingReason(
  db: Kysely<Database>,
  workspaceId: number,
): Promise<number | null> {
  const { rows } = await sql<{ definition: unknown }>`
    SELECT v.definition
      FROM workflow w
      JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
     WHERE w.workspace_id = ${workspaceId} AND w.is_default`.execute(db);
  if (!rows[0]) return null;
  const definition = definitionSchema.parse(rows[0].definition);
  if (await closeReasonProblem(db, workspaceId, definition)) return null;
  const stages = await statusInfo(
    db,
    workspaceId,
    definition.transitions.map((t) => t.to),
  );
  const closing = definition.transitions.filter((t) => stages.get(t.to)?.stage === 'closed');
  const set = reasonsSet({ transitions: closing });
  return set[0] ? Number(set[0].value) : null;
}

/** Whether a definition sets this close reason. */
export function definitionSetsCloseReason(definition: WorkflowDefinition, reasonId: number) {
  const reason = String(reasonId);
  return reasonsSet(definition).some((s) => String(s.value) === reason);
}

/** The definition with every place that sets one close reason setting another. */
export function withCloseReason(
  definition: WorkflowDefinition,
  from: number,
  to: number,
): WorkflowDefinition {
  const reason = String(from);
  const swap = (effects: EffectDef[]) =>
    effects.map((e) => (setsReason(e, reason) ? ({ ...e, value: String(to) } as EffectDef) : e));
  return {
    ...definition,
    transitions: definition.transitions.map((t) =>
      t.effects ? { ...t, effects: swap(t.effects) } : t,
    ),
    ...(definition.onCreate?.effects
      ? { onCreate: { ...definition.onCreate, effects: swap(definition.onCreate.effects) } }
      : {}),
    ...(definition.rules
      ? {
          rules: Object.fromEntries(
            Object.entries(definition.rules).map(([id, list]) => [
              id,
              list.map((r) =>
                r.type === 'update-field' && r.field === CLOSE_REASON && String(r.value) === reason
                  ? { ...r, value: String(to) }
                  : r,
              ),
            ]),
          ),
        }
      : {}),
  };
}

export type WorkflowWithReason = CurrentVersions;

/**
 * The workflows of a workspace whose published version or draft sets this close reason, by id,
 * each row held until the transaction ends.
 */
export async function workflowsSettingCloseReason(
  trx: Transaction<Database>,
  workspaceId: number,
  reasonId: number,
): Promise<WorkflowWithReason[]> {
  const { rows } = await sql<{
    id: number;
    name: string;
    published_version: number;
    draft_version: number | null;
    version: number;
    definition: unknown;
  }>`
    SELECT w.id, w.name, w.published_version, w.draft_version, v.version, v.definition
      FROM workflow w
      JOIN workflow_version v
        ON v.workflow_id = w.id AND v.version IN (w.published_version, w.draft_version)
     WHERE w.workspace_id = ${workspaceId}
       AND v.definition::text LIKE ${`%${CLOSE_REASON}%`}
     ORDER BY w.id, v.version`.execute(trx);
  const holding = new Set<number>();
  for (const row of rows) {
    if (definitionSetsCloseReason(definitionSchema.parse(row.definition), reasonId)) {
      holding.add(row.id);
    }
  }
  return holdCurrentVersions(trx, [...holding]);
}

/**
 * Has these workflows set `to` where they set `from`: a new published version where that one does,
 * and the draft rewritten. A draft always numbers above the published version, so a new published
 * version moves the draft up. Statuses do not change, so no ticket moves.
 */
export async function replaceCloseReason(
  trx: Transaction<Database>,
  workspaceId: number,
  actorId: number | null,
  workflows: readonly WorkflowWithReason[],
  from: number,
  to: number,
): Promise<void> {
  for (const w of workflows) {
    const draft = w.draft && withCloseReason(w.draft, from, to);
    const published = definitionSetsCloseReason(w.published, from)
      ? withCloseReason(w.published, from, to)
      : null;
    await rewriteCurrentVersions(trx, workspaceId, actorId, w, published, draft);
  }
}
