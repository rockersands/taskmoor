import { stableJson } from '@tracksmith/testkit';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { useMigratedDatabase } from './testing';

describe('migrated schema', () => {
  const database = useMigratedDatabase();

  // Any schema change shows up as a diff in __golden__/schema.json, so it gets reviewed.
  // After an intended change, run `pnpm verify --update` and commit the new file.
  it('matches the reviewed snapshot', async () => {
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
       ORDER BY table_name, ordinal_position`.execute(database.db);

    const indexes = await sql<{ tablename: string; indexname: string; indexdef: string }>`
      SELECT tablename, indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public'
       ORDER BY tablename, indexname`.execute(database.db);

    const tables: Record<string, { columns: string[]; indexes: string[] }> = {};
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

    await expect(stableJson(tables)).toMatchFileSnapshot('./__golden__/schema.json');
  });
});
