import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { MIGRATION_LOCK_TABLE, MIGRATION_TABLE } from './migrate';
import { useMigratedDatabase } from './testing';

/**
 * Tables that hold no workspace data, each with the reason. Everything else must carry a
 * non-null `workspace_id` so one database can serve several workspaces and every query is
 * scoped by construction (ADR-006). Adding a table here needs a reason a reviewer accepts.
 */
const INSTANCE_TABLES: Record<string, string> = {
  workspace: 'the workspaces themselves',
  instance_setting: 'instance-wide settings: setup state, instance name, mail configuration',
  session: 'the M0 session table, kept for rolling upgrades until a later release drops it',
  [MIGRATION_TABLE]: 'migration bookkeeping',
  [MIGRATION_LOCK_TABLE]: 'migration bookkeeping',
};

describe('workspace scoping (ADR-006 fitness test)', () => {
  const database = useMigratedDatabase();

  it('gives every table that holds workspace data a non-null workspace_id', async () => {
    const { rows } = await sql<{ table_name: string; nullable: string | null }>`
      SELECT t.table_name, c.is_nullable AS nullable
        FROM information_schema.tables t
        LEFT JOIN information_schema.columns c
          ON c.table_schema = t.table_schema
         AND c.table_name = t.table_name
         AND c.column_name = 'workspace_id'
       WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       ORDER BY t.table_name`.execute(database.db);
    const scoped = rows.filter((r) => !(r.table_name in INSTANCE_TABLES));
    expect(scoped.filter((r) => r.nullable === null).map((r) => r.table_name)).toEqual([]);
    expect(scoped.filter((r) => r.nullable === 'YES').map((r) => r.table_name)).toEqual([]);
    // The exemption list holds only tables that exist, so it cannot hide a renamed one.
    const names = new Set(rows.map((r) => r.table_name));
    expect(Object.keys(INSTANCE_TABLES).filter((t) => !names.has(t))).toEqual([]);
  });

  it('references the workspace from every scoped table', async () => {
    const { rows } = await sql<{ table_name: string }>`
      SELECT DISTINCT tc.table_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage k
          ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = 'public'
         AND k.column_name = 'workspace_id'
         AND ccu.table_name = 'workspace'`.execute(database.db);
    const { rows: all } = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`.execute(database.db);
    const referenced = new Set(rows.map((r) => r.table_name));
    const missing = all
      .map((r) => r.table_name)
      .filter((t) => !(t in INSTANCE_TABLES) && !referenced.has(t))
      .sort();
    expect(missing).toEqual([]);
  });
});
