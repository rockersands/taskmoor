import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';
import type { Catalog } from './catalog';
import { customFieldId, FIXED_FIELDS, type LayoutDefinition, type Operation } from './form-model';

/**
 * Writing the rules of a field rule set and the layouts of a layout set (M1-012; CORE-003,
 * CORE-008, CORE-013): the checks every save makes, and the replacement of a set's rules or
 * layouts as a whole. The routes (`routes/layouts.ts`) and the importer (`import/load-forms.ts`,
 * M1-089) both go through here, so an imported set obeys the same rules as one saved by hand.
 */
type Db = Kysely<Database> | Transaction<Database>;

export type SetProblem = { status: number; body: Record<string, unknown> };
export const setProblem = (
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
): SetProblem => ({ status, body: { error, ...extra } });

export interface RuleInput {
  ticketTypeId: number | null;
  field: string;
  required: boolean;
  hidden: boolean;
  description: string | null;
  /** The API's form: `{roleId}` or `{groupId}`; null for everyone. */
  editableBy: ({ roleId: number } | { groupId: number })[] | null;
}

export interface LayoutInput {
  ticketTypeId: number | null;
  operation: Operation;
  definition: LayoutDefinition;
}

/** Fields a set names must exist; a local set's custom fields are shared or its track's. */
function fieldProblem(catalog: Catalog, ownerTrackId: number | null, key: string): string | null {
  const fieldId = customFieldId(key);
  if (fieldId === null) return null;
  const field = catalog.fields.get(fieldId);
  if (!field) return `unknown field ${key}`;
  if (field.trackId !== null && field.trackId !== ownerTrackId)
    return `${key} belongs to another track`;
  return null;
}

async function typeProblem(db: Db, ws: number, typeIds: (number | null)[]) {
  const ids = [...new Set(typeIds.filter((t): t is number => t !== null))];
  if (ids.length === 0) return null;
  const rows = await db
    .selectFrom('ticket_type')
    .select('id')
    .where('workspace_id', '=', ws)
    .where('id', 'in', ids)
    .execute();
  return rows.length === ids.length ? null : setProblem(400, 'unknown_ticket_type');
}

/** Roles and groups a rule names must exist in the workspace. */
async function holderProblem(
  db: Db,
  ws: number,
  holders: readonly ({ roleId: number } | { groupId: number })[],
) {
  const roleIds = [...new Set(holders.flatMap((h) => ('roleId' in h ? [h.roleId] : [])))];
  const groupIds = [...new Set(holders.flatMap((h) => ('groupId' in h ? [h.groupId] : [])))];
  if (roleIds.length > 0) {
    const rows = await db
      .selectFrom('role')
      .select('id')
      .where('workspace_id', '=', ws)
      .where('id', 'in', roleIds)
      .execute();
    if (rows.length !== roleIds.length) return setProblem(400, 'unknown_role');
  }
  if (groupIds.length > 0) {
    const rows = await db
      .selectFrom('user_group')
      .select('id')
      .where('workspace_id', '=', ws)
      .where('id', 'in', groupIds)
      .execute();
    if (rows.length !== groupIds.length) return setProblem(400, 'unknown_group');
  }
  return null;
}

/**
 * Why rules cannot be saved, or null: known fields, never the summary, never a formula made
 * required, each field once per type, existing types, roles and groups.
 */
export async function checkRules(
  db: Db,
  ws: number,
  catalog: Catalog,
  ownerTrackId: number | null,
  rules: readonly RuleInput[],
): Promise<SetProblem | null> {
  const seen = new Set<string>();
  for (const r of rules) {
    if (FIXED_FIELDS.has(r.field)) {
      return setProblem(400, 'invalid_request', {
        detail: `${r.field} is always required and shown`,
      });
    }
    const issue = fieldProblem(catalog, ownerTrackId, r.field);
    if (issue) return setProblem(400, 'invalid_request', { detail: issue });
    const fieldId = customFieldId(r.field);
    if (r.required && fieldId !== null && catalog.fields.get(fieldId)?.type === 'formula') {
      // A formula's value is computed (M1-013): no one could fill it in.
      return setProblem(400, 'invalid_request', { detail: `${r.field} is computed` });
    }
    const key = `${r.ticketTypeId ?? 0}|${r.field}`;
    if (seen.has(key)) return setProblem(400, 'invalid_request', { detail: `${r.field} twice` });
    seen.add(key);
  }
  const types = await typeProblem(
    db,
    ws,
    rules.map((r) => r.ticketTypeId),
  );
  if (types) return types;
  return holderProblem(
    db,
    ws,
    rules.flatMap((r) => r.editableBy ?? []),
  );
}

/** Replaces a set's rules (checked with `checkRules` first). */
export async function replaceRules(
  trx: Transaction<Database>,
  ws: number,
  setId: number,
  rules: readonly RuleInput[],
): Promise<void> {
  await trx.deleteFrom('field_rule').where('rule_set_id', '=', setId).execute();
  for (let i = 0; i < rules.length; i += 2000) {
    await trx
      .insertInto('field_rule')
      .values(
        rules.slice(i, i + 2000).map((r) => ({
          workspace_id: ws,
          rule_set_id: setId,
          ticket_type_id: r.ticketTypeId,
          field: r.field,
          required: r.required,
          hidden: r.hidden,
          description: r.description,
          editable_by: r.editableBy ? JSON.stringify(r.editableBy) : null,
        })),
      )
      .execute();
  }
}

/** Checks and replaces a set's rules; a problem changes nothing. */
export async function writeRules(
  trx: Transaction<Database>,
  ws: number,
  catalog: Catalog,
  setId: number,
  ownerTrackId: number | null,
  rules: readonly RuleInput[],
): Promise<SetProblem | null> {
  const problem = await checkRules(trx, ws, catalog, ownerTrackId, rules);
  if (problem) return problem;
  await replaceRules(trx, ws, setId, rules);
  return null;
}

/** Why layouts cannot be saved, or null: one per type and operation, known fields and types. */
export async function checkLayouts(
  db: Db,
  ws: number,
  catalog: Catalog,
  ownerTrackId: number | null,
  layouts: readonly LayoutInput[],
): Promise<SetProblem | null> {
  const seen = new Set<string>();
  for (const l of layouts) {
    const key = `${l.ticketTypeId ?? 0}|${l.operation}`;
    if (seen.has(key)) {
      return setProblem(400, 'invalid_request', {
        detail: `two ${l.operation} layouts for one type`,
      });
    }
    seen.add(key);
    for (const f of l.definition.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields))) {
      const issue = fieldProblem(catalog, ownerTrackId, f);
      if (issue) return setProblem(400, 'invalid_request', { detail: issue });
    }
  }
  return typeProblem(
    db,
    ws,
    layouts.map((l) => l.ticketTypeId),
  );
}

/** Replaces a set's layouts (checked with `checkLayouts` first). */
export async function replaceLayouts(
  trx: Transaction<Database>,
  ws: number,
  setId: number,
  layouts: readonly LayoutInput[],
): Promise<void> {
  await trx.deleteFrom('layout').where('layout_set_id', '=', setId).execute();
  if (layouts.length > 0) {
    await trx
      .insertInto('layout')
      .values(
        layouts.map((l) => ({
          workspace_id: ws,
          layout_set_id: setId,
          ticket_type_id: l.ticketTypeId,
          operation: l.operation,
          definition: JSON.stringify(l.definition),
        })),
      )
      .execute();
  }
}

/** Checks and replaces a set's layouts; a problem changes nothing. */
export async function writeLayouts(
  trx: Transaction<Database>,
  ws: number,
  catalog: Catalog,
  setId: number,
  ownerTrackId: number | null,
  layouts: readonly LayoutInput[],
): Promise<SetProblem | null> {
  const problem = await checkLayouts(trx, ws, catalog, ownerTrackId, layouts);
  if (problem) return problem;
  await replaceLayouts(trx, ws, setId, layouts);
  return null;
}
