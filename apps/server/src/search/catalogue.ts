import type { Database } from '@taskmoor/db';
import { outputValueType } from '@taskmoor/formula';
import {
  type Catalogue,
  type CustomField,
  type CustomType,
  makeCatalogue,
  type PropertyField,
  printField,
} from '@taskmoor/query';
import type { Kysely, Transaction } from 'kysely';
import type { Catalog, FieldDef } from '../fields/catalog';
import { type IndexType, propertyIndexes } from '../properties/model';

/**
 * What a person's queries can name (M1-036; QRY-003): the system fields, the workspace's shared
 * custom fields and the local ones of tracks they may browse, and the keys of those tracks (old
 * keys too, so a query saved before a rename keeps working).
 */
type Db = Kysely<Database> | Transaction<Database>;

/**
 * How the query language reads each custom field type (ADR-010). A formula reads as its output
 * (M1-013): numbers (durations in seconds), dates or text, as the side table it is kept in.
 */
export function queryType(field: Pick<FieldDef, 'type' | 'multiple' | 'config'>): CustomType {
  switch (field.type) {
    case 'formula': {
      const kind = outputValueType(field.config.output ?? 'number');
      return kind === 'duration' ? 'number' : kind;
    }
    case 'text':
    case 'paragraph':
    case 'url':
    case 'read-only-text':
      return 'text';
    case 'select':
      return field.multiple ? 'multi' : 'option';
    case 'cascading-select':
      return 'cascade';
    default:
      return field.type;
  }
}

export async function queryCatalogue(
  db: Db,
  workspaceId: number,
  catalog: Catalog,
  browse: readonly number[] | 'all',
): Promise<Catalogue> {
  const visible = (trackId: number | null) =>
    trackId === null || browse === 'all' || browse.includes(trackId);
  const properties = await propertyFields(db, workspaceId);
  const customs: CustomField[] = [...catalog.fields.values()]
    .filter((f) => visible(f.trackId))
    .map((f) => ({ kind: 'custom', id: f.id, name: f.name, type: queryType(f) }));
  let tracks = db
    .selectFrom('track')
    .select(['id', 'key'])
    .where('workspace_id', '=', workspaceId)
    .where('deleted_at', 'is', null);
  let history = db
    .selectFrom('track_key_history as h')
    .innerJoin('track as t', 't.id', 'h.track_id')
    .select(['t.id', 'h.key'])
    .where('t.workspace_id', '=', workspaceId)
    .where('t.deleted_at', 'is', null);
  if (browse !== 'all') {
    if (browse.length === 0) return makeCatalogue(customs, {}, properties);
    tracks = tracks.where('id', 'in', [...browse]);
    history = history.where('t.id', 'in', [...browse]);
  }
  const keys: Record<string, number> = {};
  for (const row of await history.execute()) keys[row.key.toUpperCase()] = row.id;
  // Current keys win over a key another track had before.
  for (const row of await tracks.execute()) keys[row.key.toUpperCase()] = row.id;
  return makeCatalogue(customs, keys, properties);
}

/** How each index type compares (M1-129): strings exactly, like labels; text by words. */
const PROPERTY_TYPE: Record<IndexType, PropertyField['type']> = {
  number: 'number',
  string: 'labels',
  text: 'text',
  date: 'datetime',
  user: 'user',
};

/** The declared ticket property indexes a query may name (M1-129; ADR-083). */
export async function propertyFields(db: Db, workspaceId: number): Promise<PropertyField[]> {
  return (await propertyIndexes(db, workspaceId)).map((i) => ({
    kind: 'property',
    indexId: i.id,
    key: i.key,
    path: i.path,
    name: printField({
      name: 'ticket.property',
      property: { key: i.key, path: i.path },
      span: { start: 0, end: 0 },
    }),
    alias: i.alias,
    type: PROPERTY_TYPE[i.type],
  }));
}
