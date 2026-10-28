import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';
import type { FieldConfig, FieldShape, FieldType, Stored } from './types';

/**
 * The workspace's custom field catalogue (M1-010; CORE-009): fields, their contexts and
 * options, read once and kept per process until `field_epoch` moves (a trigger moves it on
 * every change to the field tables, cascades from deleted tracks and types included).
 *
 * The context of a field for a ticket is the most specific one covering the ticket's track and
 * type: track and type, then track, then type, then the field's global context. A field
 * applies to a ticket when it has such a context.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** Who a user picker offers (CORE-009 (2)): members of a group, or holders of a track role. */
export interface ContextConfig {
  userGroupId?: number;
  userRoleId?: number;
}

export interface FieldDef extends FieldShape {
  id: number;
  /** The local-mode track that owns the field; null when shared. */
  trackId: number | null;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextDef {
  id: number;
  fieldId: number;
  name: string;
  description: string;
  /** Null for every track; empty when the tracks it named are gone. */
  trackIds: number[] | null;
  /** Null for every ticket type. */
  ticketTypeIds: number[] | null;
  defaultValue: Stored | undefined;
  config: ContextConfig;
}

export interface OptionDef {
  id: number;
  fieldId: number;
  contextId: number;
  parentId: number | null;
  value: string;
  sortOrder: number;
  disabled: boolean;
}

const scopeKey = (trackId: number | null, typeId: number | null) =>
  `${trackId ?? 0}:${typeId ?? 0}`;

export class Catalog {
  /** Context ids by field and scope key. */
  private readonly scopes = new Map<number, Map<string, number>>();
  private readonly byContext = new Map<number, OptionDef[]>();
  private readonly applicableCache = new Map<string, FieldDef[]>();

  constructor(
    readonly epoch: string,
    readonly fields: ReadonlyMap<number, FieldDef>,
    readonly contexts: ReadonlyMap<number, ContextDef>,
    readonly options: ReadonlyMap<number, OptionDef>,
    scopeRows: readonly { field_id: number; context_id: number; key: string }[],
  ) {
    for (const option of options.values()) {
      const list = this.byContext.get(option.contextId);
      if (list) list.push(option);
      else this.byContext.set(option.contextId, [option]);
    }
    for (const list of this.byContext.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    }
    for (const row of scopeRows) {
      const byKey = this.scopes.get(row.field_id) ?? new Map<string, number>();
      this.scopes.set(row.field_id, byKey);
      byKey.set(row.key, row.context_id);
    }
  }

  /** The field's context for a ticket in a track with a type, or null where it does not apply. */
  contextOf(fieldId: number, trackId: number, typeId: number): ContextDef | null {
    const byKey = this.scopes.get(fieldId);
    if (!byKey) return null;
    for (const key of [
      scopeKey(trackId, typeId),
      scopeKey(trackId, null),
      scopeKey(null, typeId),
      scopeKey(null, null),
    ]) {
      const contextId = byKey.get(key);
      if (contextId !== undefined) return this.contexts.get(contextId) ?? null;
    }
    return null;
  }

  /** The fields that apply to tickets of a type in a track, by name. */
  applicable(trackId: number, typeId: number): FieldDef[] {
    const key = scopeKey(trackId, typeId);
    let out = this.applicableCache.get(key);
    if (!out) {
      out = [...this.fields.values()]
        .filter((f) => this.contextOf(f.id, trackId, typeId) !== null)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
      this.applicableCache.set(key, out);
    }
    return out;
  }

  /** A context's options in order; children of `parentId` when given, top level otherwise. */
  optionsOf(contextId: number, parentId: number | null = null): OptionDef[] {
    return (this.byContext.get(contextId) ?? []).filter((o) => o.parentId === parentId);
  }
}

export async function readEpoch(db: Db, workspaceId: number): Promise<string> {
  const row = await db
    .selectFrom('field_epoch')
    .select('epoch')
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  return String(row?.epoch ?? '0');
}

/** Reads the catalogue of a workspace, or of one field in it. */
export async function loadCatalog(
  db: Db,
  workspaceId: number,
  epoch?: string,
  fieldId?: number,
): Promise<Catalog> {
  const at = epoch ?? (await readEpoch(db, workspaceId));
  let fieldQuery = db.selectFrom('field').selectAll().where('workspace_id', '=', workspaceId);
  let contextQuery = db
    .selectFrom('field_context')
    .selectAll()
    .where('workspace_id', '=', workspaceId);
  let scopeQuery = db
    .selectFrom('field_context_scope')
    .selectAll()
    .where('workspace_id', '=', workspaceId);
  let optionQuery = db
    .selectFrom('field_option')
    .selectAll()
    .where('workspace_id', '=', workspaceId);
  if (fieldId !== undefined) {
    fieldQuery = fieldQuery.where('id', '=', fieldId);
    contextQuery = contextQuery.where('field_id', '=', fieldId);
    scopeQuery = scopeQuery.where('field_id', '=', fieldId);
    optionQuery = optionQuery.where('field_id', '=', fieldId);
  }
  const [fieldRows, contextRows, scopeRows, optionRows] = await Promise.all([
    fieldQuery.execute(),
    contextQuery.execute(),
    scopeQuery.execute(),
    optionQuery.execute(),
  ]);
  const fields = new Map<number, FieldDef>(
    fieldRows.map((r) => [
      r.id,
      {
        id: r.id,
        trackId: r.track_id,
        name: r.name,
        description: r.description,
        type: r.type as FieldType,
        multiple: r.multiple,
        config: r.config as FieldConfig,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      },
    ]),
  );
  const scopesByContext = new Map<
    number,
    { track_id: number | null; ticket_type_id: number | null }[]
  >();
  for (const s of scopeRows) {
    scopesByContext.set(s.context_id, [...(scopesByContext.get(s.context_id) ?? []), s]);
  }
  const distinct = (ids: (number | null)[]): number[] | null =>
    ids.includes(null) ? null : [...new Set(ids as number[])].sort((a, b) => a - b);
  const contexts = new Map<number, ContextDef>(
    contextRows.map((r) => {
      const scopes = scopesByContext.get(r.id) ?? [];
      return [
        r.id,
        {
          id: r.id,
          fieldId: r.field_id,
          name: r.name,
          description: r.description,
          // A context's rows are every pair of its tracks and types; none left means nowhere.
          trackIds: scopes.length === 0 ? [] : distinct(scopes.map((s) => s.track_id)),
          ticketTypeIds: scopes.length === 0 ? [] : distinct(scopes.map((s) => s.ticket_type_id)),
          defaultValue: (r.default_value ?? undefined) as Stored | undefined,
          config: r.config as ContextConfig,
        },
      ];
    }),
  );
  const options = new Map<number, OptionDef>(
    optionRows.map((r) => [
      r.id,
      {
        id: r.id,
        fieldId: r.field_id,
        contextId: r.context_id,
        parentId: r.parent_id,
        value: r.value,
        sortOrder: r.sort_order,
        disabled: r.disabled,
      },
    ]),
  );
  return new Catalog(
    at,
    fields,
    contexts,
    options,
    scopeRows.map((s) => ({
      field_id: s.field_id,
      context_id: s.context_id,
      key: scopeKey(s.track_id, s.ticket_type_id),
    })),
  );
}

/** Catalogues per workspace, reloaded when the epoch moves. One per server process. */
export class FieldCatalogs {
  private readonly cache = new Map<number, Catalog>();

  constructor(private readonly db: Kysely<Database>) {}

  async get(workspaceId: number, db: Db = this.db): Promise<Catalog> {
    const epoch = await readEpoch(db, workspaceId);
    const hit = this.cache.get(workspaceId);
    if (hit && hit.epoch === epoch) return hit;
    const catalog = await loadCatalog(db, workspaceId, epoch);
    // Inside a transaction that changed the catalogue, the copy is not yet everyone's.
    if (db === this.db) this.cache.set(workspaceId, catalog);
    return catalog;
  }
}
