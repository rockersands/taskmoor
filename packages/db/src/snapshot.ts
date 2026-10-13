import { type Kysely, sql } from 'kysely';

export type SchemaSnapshot = Record<string, { columns: string[]; indexes: string[] }>;

/**
 * The public schema as the reviewed golden file records it: one line per column and index.
 * Used by the schema test and by the upgrade harness, which must land on the same snapshot
 * whichever release a database started from.
 *
 * Partitions are left out: they are created as data arrives (the audit log's months) and
 * share the columns and indexes of their partitioned table, which the snapshot shows.
 */
export async function snapshotSchema<DB>(db: Kysely<DB>): Promise<SchemaSnapshot> {
  const partitions = sql`
    SELECT c.relname::text FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relispartition`;
  const columns = await sql<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>`
    SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name::text NOT IN (${partitions})
     ORDER BY table_name, ordinal_position`.execute(db);

  const indexes = await sql<{ tablename: string; indexname: string; indexdef: string }>`
    SELECT tablename, indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename::text NOT IN (${partitions})
     ORDER BY tablename, indexname`.execute(db);

  const tables: SchemaSnapshot = {};
  const table = (name: string) => {
    tables[name] ??= { columns: [], indexes: [] };
    return tables[name];
  };
  for (const c of columns.rows) {
    const nullable = c.is_nullable === 'YES' ? '' : ' not null';
    const fallback = c.column_default ? ` default ${c.column_default}` : '';
    table(c.table_name).columns.push(`${c.column_name} ${c.data_type}${nullable}${fallback}`);
  }
  for (const i of indexes.rows) table(i.tablename).indexes.push(i.indexdef);
  return tables;
}
