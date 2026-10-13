import { type Kysely, sql } from 'kysely';

export interface UpgradeSeed {
  /** Tables the seed writes, with the WHERE clause that finds its row afterwards. */
  tables: Record<string, string>;
  seed: (db: Kysely<unknown>) => Promise<void>;
}

/**
 * Data a release's database holds, written with that release's schema, so the upgrade harness
 * can prove later migrations carry it through. Keyed by the migration that created the tables;
 * each seed runs right after its migration. Add a seed for every migration that ships, with a
 * row for every table it creates or changes.
 */
export const UPGRADE_SEEDS: Record<string, UpgradeSeed> = {
  '0001_foundation': {
    tables: { instance_setting: "key = 'seed'" },
    seed: async (db) => {
      await sql`INSERT INTO instance_setting (key, value) VALUES ('seed', '{"from": "0001"}')`.execute(
        db,
      );
    },
  },
  '0002_users_and_sessions': {
    tables: { app_user: "email = 'seed@example.com'", session: "id = 'seed-session'" },
    seed: async (db) => {
      await sql`INSERT INTO app_user (email, name, password_hash, is_site_admin)
        VALUES ('seed@example.com', 'Seed', 'scrypt$x', true)`.execute(db);
      await sql`INSERT INTO session (id, user_id, expires_at)
        SELECT 'seed-session', id, now() + interval '1 day'
          FROM app_user WHERE email = 'seed@example.com'`.execute(db);
    },
  },
  '0003_identity': {
    tables: {
      workspace: "key = 'seed'",
      user_group: "name = 'seed-group'",
      group_member: "group_id IN (SELECT id FROM user_group WHERE name = 'seed-group')",
      group_nesting: "child_id IN (SELECT id FROM user_group WHERE name = 'seed-group')",
      user_session: "token_hash = 'seed-hash'",
      sign_in_throttle: "key = 'email:seed@example.com'",
      password_link: "token_hash = 'seed-link'",
    },
    seed: async (db) => {
      await sql`INSERT INTO workspace (key, name) VALUES ('seed', 'Seed')`.execute(db);
      await sql`INSERT INTO user_group (workspace_id, name) VALUES (1, 'seed-group'), (1, 'seed-parent')`.execute(
        db,
      );
      await sql`INSERT INTO group_member (workspace_id, group_id, user_id)
        SELECT 1, g.id, u.id FROM user_group g, app_user u
         WHERE g.name = 'seed-group' AND u.email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO group_nesting (workspace_id, parent_id, child_id)
        SELECT 1, p.id, c.id FROM user_group p, user_group c
         WHERE p.name = 'seed-parent' AND c.name = 'seed-group'`.execute(db);
      await sql`INSERT INTO user_session (workspace_id, user_id, token_hash, expires_at)
        SELECT 1, id, 'seed-hash', now() + interval '1 day' FROM app_user
         WHERE email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO sign_in_throttle (workspace_id, key, failures)
        VALUES (1, 'email:seed@example.com', 2)`.execute(db);
      await sql`INSERT INTO password_link (workspace_id, user_id, token_hash, purpose, expires_at)
        SELECT 1, id, 'seed-link', 'reset', now() + interval '1 day' FROM app_user
         WHERE email = 'seed@example.com'`.execute(db);
    },
  },
};

/** How many of the rows the named seeds wrote are still there: one per table when nothing was lost. */
export async function seededRows(
  db: Kysely<unknown>,
  seedNames: readonly string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const name of seedNames) {
    for (const [table, where] of Object.entries(UPGRADE_SEEDS[name]?.tables ?? {})) {
      const { rows } = await sql<{ n: string }>`
        SELECT count(*) AS n FROM ${sql.table(table)} WHERE ${sql.raw(where)}`.execute(db);
      counts[table] = Number(rows[0]?.n ?? 0);
    }
  }
  return counts;
}
