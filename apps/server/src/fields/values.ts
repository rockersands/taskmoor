import type { Database, JsonValue } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { effectiveMemberIds } from '../directory';
import type { FieldChange } from '../tickets/history';
import type { Catalog, ContextDef, FieldDef } from './catalog';
import {
  fold,
  parseValue,
  REFERENCE_OF,
  type Reference,
  type Resolver,
  referencedIds,
  restValue,
  type Stored,
  serialise,
} from './types';

/**
 * Custom field values on tickets (M1-010): checking what a create or an edit gives against the
 * catalogue and the objects values name, the REST view, and history rows.
 *
 * References are not foreign keys: a value that names an object since deleted reads as empty
 * in the view and keeps its id in the ticket until the field is next written.
 */
type Db = Kysely<Database> | Transaction<Database>;
export type FieldValues = Record<string, JsonValue>;
export type Channel = 'ui' | 'rest' | 'automation';

/** The name history and the query language give a custom field (ADR-010). */
export const historyName = (fieldId: number) => `cf[${fieldId}]`;
/** The key a refused value is reported under, as the body names it. */
export const errorKey = (fieldId: number | string) => `fields.${fieldId}`;

export interface Placement {
  workspaceId: number;
  trackId: number;
  ticketTypeId: number;
}

export type Checked =
  | { ok: true; fields: FieldValues; labels: { fieldId: number; names: string[] }[] }
  | { ok: false; errors: Record<string, string> };

/**
 * The ticket's custom values after a create or an edit: `current` with the given ones set or
 * cleared and, for a new ticket, the defaults of the fields left out. Values of fields that do
 * not apply to the ticket stay as they are (CORE-013 (2): kept, not shown).
 */
export async function checkCustomValues(
  db: Db,
  catalog: Catalog,
  at: Placement,
  channel: Channel,
  current: FieldValues,
  input: Record<string, unknown> | undefined,
  creating: boolean,
): Promise<Checked> {
  const errors: Record<string, string> = {};
  const next: FieldValues = { ...current };
  const written: { field: FieldDef; context: ContextDef; value: Stored }[] = [];
  for (const [key, raw] of Object.entries(input ?? {})) {
    const field = /^[1-9][0-9]{0,9}$/.test(key) ? catalog.fields.get(Number(key)) : undefined;
    if (!field) {
      errors[errorKey(key)] = 'unknown_field';
      continue;
    }
    const context = catalog.contextOf(field.id, at.trackId, at.ticketTypeId);
    if (!context) {
      errors[errorKey(key)] = 'not_applicable';
      continue;
    }
    // Read-only text is written by integrations and automation, never from the UI.
    if (field.type === 'read-only-text' && channel === 'ui') {
      errors[errorKey(key)] = 'read_only';
      continue;
    }
    const parsed = parseValue(field, raw);
    if (!parsed.ok) {
      errors[errorKey(key)] = parsed.problem;
      continue;
    }
    if (parsed.value === undefined) {
      delete next[key];
      continue;
    }
    next[key] = parsed.value as JsonValue;
    written.push({ field, context, value: parsed.value });
  }
  if (creating) {
    for (const field of catalog.applicable(at.trackId, at.ticketTypeId)) {
      const key = String(field.id);
      if (input !== undefined && key in input) continue;
      const context = catalog.contextOf(field.id, at.trackId, at.ticketTypeId) as ContextDef;
      if (context.defaultValue === undefined) continue;
      // A default that no longer holds (an option disabled since) is left out, not refused.
      const problem = await referenceProblem(
        db,
        catalog,
        at,
        field,
        context,
        context.defaultValue,
        undefined,
      );
      if (problem === null) next[key] = context.defaultValue as JsonValue;
    }
  }
  for (const { field, context, value } of written) {
    const problem = await referenceProblem(
      db,
      catalog,
      at,
      field,
      context,
      value,
      current[field.id],
    );
    if (problem !== null) errors[errorKey(field.id)] = problem;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const labels = written
    .filter((w) => w.field.type === 'labels')
    .map((w) => ({ fieldId: w.field.id, names: w.value as string[] }));
  return { ok: true, fields: next, labels };
}

/**
 * Why a value's references do not hold where the ticket sits, or null. An option must be one of
 * the context's (a cascade's child under its parent) and enabled, unless the ticket already has
 * it (CORE-009 (3)); people must be active and, where the context says so, in its group or track
 * role (CORE-009 (2)); releases and areas must be the ticket's track's.
 */
export async function referenceProblem(
  db: Db,
  catalog: Catalog,
  at: Placement,
  field: FieldDef,
  context: ContextDef,
  value: Stored,
  had: JsonValue | undefined,
): Promise<string | null> {
  const ref = REFERENCE_OF[field.type];
  if (ref === undefined) return null;
  const ids = referencedIds(field, value);
  const kept = new Set(had === undefined ? [] : referencedIds(field, had as Stored));
  switch (ref) {
    case 'option': {
      const parents = field.type === 'cascading-select' ? [null, ids[0] ?? null] : [];
      for (const [i, id] of ids.entries()) {
        const option = catalog.options.get(id);
        const parent = field.type === 'cascading-select' ? parents[i] : null;
        if (!option || option.contextId !== context.id || option.parentId !== (parent ?? null)) {
          return 'not_found';
        }
        if (option.disabled && !kept.has(id)) return 'disabled_option';
      }
      return null;
    }
    case 'user': {
      const rows = await db
        .selectFrom('app_user')
        .select('id')
        .where('workspace_id', '=', at.workspaceId)
        .where('id', 'in', ids)
        .where('deactivated_at', 'is', null)
        .execute();
      if (rows.length !== ids.length) return 'not_found';
      const allowed = await allowedPeople(db, at, context);
      return allowed === 'all' || ids.every((id) => allowed.has(id)) ? null : 'not_allowed';
    }
    case 'group': {
      const rows = await db
        .selectFrom('user_group')
        .select('id')
        .where('workspace_id', '=', at.workspaceId)
        .where('id', 'in', ids)
        .execute();
      return rows.length === ids.length ? null : 'not_found';
    }
    case 'release':
    case 'area': {
      const rows = await db
        .selectFrom(ref)
        .select('id')
        .where('workspace_id', '=', at.workspaceId)
        .where('track_id', '=', at.trackId)
        .where('id', 'in', ids)
        .execute();
      return rows.length === ids.length ? null : 'not_in_track';
    }
  }
}

/** The people a user picker offers in a context: everyone, or a group's or a track role's. */
export async function allowedPeople(
  db: Db,
  at: Placement,
  context: ContextDef,
): Promise<'all' | Set<number>> {
  const { userGroupId, userRoleId } = context.config;
  if (userGroupId === undefined && userRoleId === undefined) return 'all';
  const out = new Set<number>();
  if (userGroupId !== undefined) {
    for (const id of await effectiveMemberIds(db, at.workspaceId, userGroupId)) out.add(id);
  }
  if (userRoleId !== undefined) {
    const { rows } = await sql<{ user_id: number }>`
      WITH RECURSIVE d(id) AS (
        SELECT group_id FROM track_role_actor
         WHERE track_id = ${at.trackId} AND role_id = ${userRoleId} AND group_id IS NOT NULL
        UNION
        SELECT n.child_id FROM group_nesting n JOIN d ON n.parent_id = d.id
         WHERE n.workspace_id = ${at.workspaceId}
      )
      SELECT user_id FROM track_role_actor
       WHERE track_id = ${at.trackId} AND role_id = ${userRoleId} AND user_id IS NOT NULL
      UNION
      SELECT m.user_id FROM group_member m JOIN d ON m.group_id = d.id`.execute(db);
    for (const r of rows) out.add(r.user_id);
  }
  return out;
}

/** Adds labels to each labels field's own vocabulary (spec 01a section 1.4). */
export async function rememberFieldLabels(
  trx: Transaction<Database>,
  workspaceId: number,
  labels: readonly { fieldId: number; names: readonly string[] }[],
): Promise<void> {
  const rows = labels.flatMap((l) =>
    l.names.map((name) => ({ workspace_id: workspaceId, field_id: l.fieldId, name })),
  );
  if (rows.length === 0) return;
  await trx
    .insertInto('field_label')
    .values(rows)
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/** Names and order of the objects values name, read in one query per kind. */
export async function loadResolver(
  db: Db,
  workspaceId: number,
  catalog: Catalog,
  wanted: ReadonlyMap<Reference, ReadonlySet<number>>,
): Promise<Resolver> {
  const found = new Map<string, { name: string; rank: string | number }>();
  const key = (ref: Reference, id: number) => `${ref}:${id}`;
  for (const id of wanted.get('option') ?? []) {
    const option = catalog.options.get(id);
    if (option) found.set(key('option', id), { name: option.value, rank: option.sortOrder });
  }
  const read = async (
    ref: Reference,
    rows: () => Promise<{ id: number; name: string; sort_order?: number }[]>,
  ) => {
    if ((wanted.get(ref)?.size ?? 0) === 0) return;
    for (const r of await rows()) {
      found.set(key(ref, r.id), { name: r.name, rank: r.sort_order ?? fold(r.name) });
    }
  };
  const ids = (ref: Reference) => [...(wanted.get(ref) ?? [])];
  await read('user', () =>
    db
      .selectFrom('app_user')
      .select(['id', 'name'])
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', ids('user'))
      .execute(),
  );
  await read('group', () =>
    db
      .selectFrom('user_group')
      .select(['id', 'name'])
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', ids('group'))
      .execute(),
  );
  await read('release', () =>
    db
      .selectFrom('release')
      .select(['id', 'name', 'sort_order'])
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', ids('release'))
      .execute(),
  );
  await read('area', () =>
    db
      .selectFrom('area')
      .select(['id', 'name'])
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', ids('area'))
      .execute(),
  );
  return {
    rank: (ref, id) => found.get(key(ref, id))?.rank ?? Number.MAX_SAFE_INTEGER,
    name: (ref, id) => found.get(key(ref, id))?.name ?? null,
  };
}

/** Collects what the values of `fields` name, by kind. */
function wantedOf(
  catalog: Catalog,
  values: readonly FieldValues[],
  out = new Map<Reference, Set<number>>(),
): Map<Reference, Set<number>> {
  for (const fields of values) {
    for (const [key, value] of Object.entries(fields)) {
      const field = catalog.fields.get(Number(key));
      const ref = field ? REFERENCE_OF[field.type] : undefined;
      if (!field || !ref) continue;
      const set = out.get(ref) ?? new Set<number>();
      out.set(ref, set);
      for (const id of referencedIds(field, value as Stored)) set.add(id);
    }
  }
  return out;
}

/** Drops references to objects that are gone; undefined when none is left. */
function present(field: FieldDef, value: Stored, resolver: Resolver): Stored | undefined {
  const ref = REFERENCE_OF[field.type];
  if (!ref) return value;
  const alive = (id: number) => resolver.name(ref, id) !== null;
  if (field.type === 'cascading-select') {
    const [parent, child] = value as number[];
    if (!alive(parent as number)) return undefined;
    return child !== undefined && alive(child) ? [parent as number, child] : [parent as number];
  }
  if (!field.multiple) return alive(value as number) ? value : undefined;
  const ids = (value as number[]).filter(alive);
  return ids.length === 0 ? undefined : ids;
}

export interface ViewRow {
  id: number;
  track_id: number;
  ticket_type_id: number;
  fields: FieldValues;
}

/**
 * The custom values tickets show, by ticket id: the fields that apply to each, keyed by field
 * id, in REST form.
 */
export async function customFieldViews(
  db: Db,
  workspaceId: number,
  catalog: Catalog,
  rows: readonly ViewRow[],
): Promise<Map<number, FieldValues>> {
  const out = new Map<number, FieldValues>();
  if (catalog.fields.size === 0) {
    for (const r of rows) out.set(r.id, {});
    return out;
  }
  const resolver = await loadResolver(
    db,
    workspaceId,
    catalog,
    wantedOf(
      catalog,
      rows.map((r) => r.fields),
    ),
  );
  for (const row of rows) {
    const view: FieldValues = {};
    for (const [key, value] of Object.entries(row.fields)) {
      const field = catalog.fields.get(Number(key));
      if (!field || !catalog.contextOf(field.id, row.track_id, row.ticket_type_id)) continue;
      const shown = present(field, value as Stored, resolver);
      if (shown !== undefined) view[key] = restValue(field, shown, resolver);
    }
    out.set(row.id, view);
  }
  return out;
}

/**
 * History rows for custom values that changed between two versions of a ticket: the values as
 * text (`serialise`) and, for references, the names they had.
 */
export async function customChanges(
  db: Db,
  workspaceId: number,
  catalog: Catalog,
  ticketId: number,
  before: FieldValues,
  after: FieldValues,
): Promise<FieldChange[]> {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map(Number)
    .filter((id) => catalog.fields.has(id))
    .sort((a, b) => a - b);
  const text = (field: FieldDef, value: JsonValue | undefined) =>
    value === undefined ? null : serialise(field, value as Stored);
  const changed = keys.filter((id) => {
    const field = catalog.fields.get(id) as FieldDef;
    return text(field, before[id]) !== text(field, after[id]);
  });
  if (changed.length === 0) return [];
  // Names only of what changed: a ticket may hold hundreds of other values.
  const pick = (fields: FieldValues) =>
    Object.fromEntries(changed.filter((id) => id in fields).map((id) => [id, fields[id]]));
  const resolver = await loadResolver(
    db,
    workspaceId,
    catalog,
    wantedOf(catalog, [pick(before), pick(after)] as FieldValues[]),
  );
  const display = (field: FieldDef, value: JsonValue | undefined) => {
    const ref = REFERENCE_OF[field.type];
    if (value === undefined || !ref) return null;
    const names = referencedIds(field, value as Stored).map(
      (id) => resolver.name(ref, id) ?? String(id),
    );
    return names.join(field.type === 'cascading-select' ? ' / ' : ', ');
  };
  return changed.map((id) => {
    const field = catalog.fields.get(id) as FieldDef;
    return {
      ticketId,
      field: historyName(id),
      from: text(field, before[id]),
      to: text(field, after[id]),
      fromDisplay: display(field, before[id]),
      toDisplay: display(field, after[id]),
    };
  });
}

/**
 * A ticket's values without those that name its track's objects (release and area pickers),
 * for a move to another track; null when it has none.
 */
export function withoutTrackValues(catalog: Catalog, fields: FieldValues): FieldValues | null {
  const kept: FieldValues = {};
  let dropped = false;
  for (const [key, value] of Object.entries(fields)) {
    const type = catalog.fields.get(Number(key))?.type;
    if (type === 'release' || type === 'area') dropped = true;
    else kept[key] = value;
  }
  return dropped ? kept : null;
}
