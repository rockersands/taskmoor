import type { Database } from '@taskmoor/db';
import type { EffectDef } from '@taskmoor/workflow';
import { sql, type Transaction } from 'kysely';
import { definitionSchema, type WorkflowDefinition } from './model';
import { writeVersion } from './store';

/**
 * Workflows that name a close reason (WF-008). A transition that sets a reason holds its id, so a
 * deleted reason would make every move into that closing status fail: the default workflow's
 * Closed holds Completed. Deleting one that a published version or a draft sets is refused, or the
 * workflows take the replacement. Earlier versions stay as they were written.
 */
const CLOSE_REASON = 'close-reason';

const setsReason = (effect: EffectDef, reason: string): boolean =>
  (effect.type === 'update-system-field' || effect.type === 'update-field') &&
  effect.field === CLOSE_REASON &&
  String(effect.value) === reason;

/** Whether a definition sets this close reason. */
export function definitionSetsCloseReason(definition: WorkflowDefinition, reasonId: number) {
  const reason = String(reasonId);
  return (
    definition.transitions.some((t) => t.effects?.some((e) => setsReason(e, reason))) ||
    (definition.onCreate?.effects ?? []).some((e) => setsReason(e, reason)) ||
    Object.values(definition.rules ?? {}).some((list) =>
      list.some(
        (r) => r.type === 'update-field' && r.field === CLOSE_REASON && String(r.value) === reason,
      ),
    )
  );
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

export interface WorkflowWithReason {
  id: number;
  name: string;
  publishedVersion: number;
  draftVersion: number | null;
  published: WorkflowDefinition;
  draft: WorkflowDefinition | null;
}

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
  if (holding.size === 0) return [];
  const held = await sql<{
    id: number;
    name: string;
    published_version: number;
    draft_version: number | null;
  }>`
    SELECT id, name, published_version, draft_version FROM workflow
     WHERE id = ANY(${[...holding]}::int[]) ORDER BY id FOR UPDATE`.execute(trx);
  const out: WorkflowWithReason[] = [];
  for (const row of held.rows) {
    const read = async (version: number) => {
      const found = await sql<{ definition: unknown }>`
        SELECT definition FROM workflow_version
         WHERE workflow_id = ${row.id} AND version = ${version}`.execute(trx);
      return definitionSchema.parse(found.rows[0]?.definition);
    };
    out.push({
      id: row.id,
      name: row.name,
      publishedVersion: row.published_version,
      draftVersion: row.draft_version,
      published: await read(row.published_version),
      draft: row.draft_version === null ? null : await read(row.draft_version),
    });
  }
  return out;
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
    if (!definitionSetsCloseReason(w.published, from)) {
      if (draft)
        await writeVersion(trx, workspaceId, w.id, w.draftVersion as number, draft, actorId, false);
      continue;
    }
    const latest = await sql<{ v: number }>`
      SELECT max(version)::int AS v FROM workflow_version WHERE workflow_id = ${w.id}`.execute(trx);
    const published = Number(latest.rows[0]?.v) + 1;
    const definition = withCloseReason(w.published, from, to);
    await writeVersion(trx, workspaceId, w.id, published, definition, actorId, true);
    const draftVersion = draft ? published + 1 : null;
    if (draft) {
      await writeVersion(trx, workspaceId, w.id, draftVersion as number, draft, actorId, false);
    }
    await trx
      .updateTable('workflow')
      .set({ published_version: published, draft_version: draftVersion, updated_at: new Date() })
      .where('id', '=', w.id)
      .execute();
    if (draft) {
      await trx
        .deleteFrom('workflow_version')
        .where('workflow_id', '=', w.id)
        .where('version', '=', w.draftVersion as number)
        .execute();
    }
  }
}
