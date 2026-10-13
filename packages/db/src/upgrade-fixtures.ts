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
  '0004_authorization': {
    tables: {
      role: "name = 'Seed role'",
      access_policy: "name = 'Seed policy'",
      access_grant: "permission = 'seed_permission'",
      track: "key = 'SEED'",
      track_role_actor: "track_id IN (SELECT id FROM track WHERE key = 'SEED')",
      global_grant: "permission = 'seed_global'",
      authz_epoch: 'workspace_id = 1',
    },
    seed: async (db) => {
      await sql`INSERT INTO role (workspace_id, name) VALUES (1, 'Seed role')`.execute(db);
      await sql`INSERT INTO access_policy (workspace_id, name) VALUES (1, 'Seed policy')`.execute(
        db,
      );
      await sql`INSERT INTO access_grant (workspace_id, policy_id, permission, grantee, role_id)
        SELECT 1, p.id, 'seed_permission', 'role', r.id FROM access_policy p, role r
         WHERE p.name = 'Seed policy' AND r.name = 'Seed role'`.execute(db);
      await sql`INSERT INTO track (workspace_id, key, name, access_policy_id)
        SELECT 1, 'SEED', 'Seed', id FROM access_policy WHERE name = 'Seed policy'`.execute(db);
      await sql`INSERT INTO track_role_actor (workspace_id, track_id, role_id, user_id)
        SELECT 1, t.id, r.id, u.id FROM track t, role r, app_user u
         WHERE t.key = 'SEED' AND r.name = 'Seed role' AND u.email = 'seed@example.com'`.execute(
        db,
      );
      await sql`INSERT INTO global_grant (workspace_id, permission, grantee)
        VALUES (1, 'seed_global', 'any_user')`.execute(db);
    },
  },
  '0005_events': {
    tables: { domain_event: "type = 'seed.happened'", job: "key = 'seed-job'" },
    seed: async (db) => {
      await sql`INSERT INTO domain_event (workspace_id, type, subject_type, subject_id, payload)
        VALUES (1, 'seed.happened', 'seed', '1', '{"from": "0005"}')`.execute(db);
      await sql`INSERT INTO job (workspace_id, task, key) VALUES (1, 'seed', 'seed-job')`.execute(
        db,
      );
    },
  },
  '0006_audit': {
    tables: {
      domain_event: "ip = '192.0.2.6'",
      audit_event: "action = 'seed.recorded'",
      audit_chain: 'workspace_id = 1',
    },
    seed: async (db) => {
      await sql`INSERT INTO domain_event (workspace_id, type, subject_type, subject_id, ip)
        VALUES (1, 'seed.audited', 'seed', '1', '192.0.2.6')`.execute(db);
      // Partitions follow the application's naming (audit_event_pYYYYMM), months in UTC.
      await sql`CREATE TABLE audit_event_p200001 PARTITION OF audit_event
        FOR VALUES FROM ('2000-01-01 00:00:00+00') TO ('2000-02-01 00:00:00+00')`.execute(db);
      await sql`INSERT INTO audit_event (workspace_id, seq, recorded_at, occurred_at, action,
          details, prev_hash, hash)
        VALUES (1, 1, '2000-01-15 00:00:00+00', '2000-01-15 00:00:00+00', 'seed.recorded',
          '{"from": "0006"}', repeat('0', 64), repeat('a', 64))`.execute(db);
      await sql`INSERT INTO audit_chain (workspace_id, head_seq, head_hash, head_recorded_at)
        VALUES (1, 1, repeat('a', 64), '2000-01-15 00:00:00+00')`.execute(db);
    },
  },
  '0007_tokens': {
    // The service account is checked through its token, so app_user keeps 0002's check.
    tables: {
      api_token: `token_hash = 'seed-api-token' AND user_id IN
        (SELECT id FROM app_user WHERE kind = 'service' AND description = 'Upgrade seed')`,
      token_policy: 'workspace_id = 1 AND max_lifetime_days = 400',
    },
    seed: async (db) => {
      await sql`INSERT INTO app_user (workspace_id, email, name, kind, description)
        VALUES (1, 'seed-robot@service.invalid', 'Seed robot', 'service', 'Upgrade seed')`.execute(
        db,
      );
      await sql`INSERT INTO api_token (workspace_id, user_id, name, token_hash, scopes, expires_at)
        SELECT 1, id, 'Seed', 'seed-api-token', ARRAY['read', 'write'], now() + interval '30 days'
          FROM app_user WHERE email = 'seed-robot@service.invalid'`.execute(db);
      await sql`UPDATE token_policy SET max_lifetime_days = 400 WHERE workspace_id = 1`.execute(db);
    },
  },
  '0008_tracks': {
    tables: {
      track_category: "name = 'Seed category'",
      track: "key = 'SEEDNEW' AND category_id IS NOT NULL AND archived_at IS NOT NULL",
      track_key_history: "key = 'SEEDOLD' AND replaced_at IS NOT NULL",
      access_policy: "name = 'Seed local policy' AND owner_track_id IS NOT NULL",
    },
    seed: async (db) => {
      await sql`INSERT INTO track_category (workspace_id, name) VALUES (1, 'Seed category')`.execute(
        db,
      );
      await sql`INSERT INTO access_policy (workspace_id, name) VALUES (1, 'Seed local policy')`.execute(
        db,
      );
      await sql`INSERT INTO track (workspace_id, key, name, access_policy_id, type, mode,
                                   category_id, feature_sprints)
        SELECT 1, 'SEEDOLD', 'Seed local', p.id, 'business', 'local', c.id, false
          FROM access_policy p, track_category c
         WHERE p.name = 'Seed local policy' AND c.name = 'Seed category'`.execute(db);
      await sql`UPDATE access_policy SET owner_track_id = (SELECT id FROM track WHERE key = 'SEEDOLD')
         WHERE name = 'Seed local policy'`.execute(db);
      // A renamed key stays in the history; archiving keeps the row.
      await sql`UPDATE track SET key = 'SEEDNEW', archived_at = now() WHERE key = 'SEEDOLD'`.execute(
        db,
      );
    },
  },
  '0009_two_factor': {
    tables: {
      totp_credential: "secret_sealed = 'plain:SEED'",
      webauthn_credential: "credential_id = 'seed-credential'",
      recovery_code: "code_hash = 'seed-code'",
      sign_in_challenge: "token_hash = 'seed-challenge'",
      two_factor_policy: 'workspace_id = 1',
      two_factor_policy_group: 'workspace_id = 1',
    },
    seed: async (db) => {
      const user = sql`(SELECT id FROM app_user WHERE email = 'seed@example.com')`;
      await sql`INSERT INTO totp_credential (user_id, workspace_id, secret_sealed)
        VALUES (${user}, 1, 'plain:SEED')`.execute(db);
      await sql`INSERT INTO webauthn_credential (workspace_id, user_id, credential_id, public_key, name)
        VALUES (1, ${user}, 'seed-credential', 'AAAA', 'Seed key')`.execute(db);
      await sql`INSERT INTO recovery_code (workspace_id, user_id, code_hash)
        VALUES (1, ${user}, 'seed-code')`.execute(db);
      await sql`INSERT INTO sign_in_challenge (workspace_id, user_id, token_hash, purpose, expires_at)
        VALUES (1, ${user}, 'seed-challenge', 'second_factor', now() + interval '5 minutes')`.execute(
        db,
      );
      await sql`INSERT INTO two_factor_policy (workspace_id, required) VALUES (1, 'site_admins')`.execute(
        db,
      );
      await sql`INSERT INTO two_factor_policy_group (workspace_id, group_id)
        SELECT 1, id FROM user_group WHERE name = 'seed-group'`.execute(db);
    },
  },
  '0010_identity_providers': {
    tables: {
      identity_provider: "name = 'Seed IdP'",
      identity_provider_group: "claim_value = 'seed-claim'",
      user_identity: "subject = 'seed-subject'",
      oidc_login: "state_hash = 'seed-state'",
    },
    seed: async (db) => {
      await sql`INSERT INTO identity_provider (workspace_id, name, issuer, client_id, domains)
        VALUES (1, 'Seed IdP', 'https://idp.example.com', 'taskmoor', '{example.com}')`.execute(db);
      const provider = sql`(SELECT id FROM identity_provider WHERE name = 'Seed IdP')`;
      await sql`INSERT INTO identity_provider_group (workspace_id, provider_id, claim_value, group_id)
        SELECT 1, ${provider}, 'seed-claim', id FROM user_group WHERE name = 'seed-group'`.execute(
        db,
      );
      await sql`INSERT INTO user_identity (workspace_id, provider_id, subject, user_id)
        SELECT 1, ${provider}, 'seed-subject', id FROM app_user WHERE email = 'seed@example.com'`.execute(
        db,
      );
      await sql`INSERT INTO oidc_login (workspace_id, provider_id, state_hash, browser_hash, nonce,
          code_verifier_sealed, expires_at)
        VALUES (1, ${provider}, 'seed-state', 'seed-browser', 'n', 'plain:v', now() + interval '5 minutes')`.execute(
        db,
      );
    },
  },
  '0013_appearance': {
    tables: { app_user: "email = 'seed@example.com' AND appearance = 'dark'" },
    seed: async (db) => {
      await sql`UPDATE app_user SET appearance = 'dark' WHERE email = 'seed@example.com'`.execute(
        db,
      );
    },
  },
};

/**
 * How many of the rows the named seeds wrote are still there: one per seed and table when
 * nothing was lost.
 */
export async function seededRows(
  db: Kysely<unknown>,
  seedNames: readonly string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const name of seedNames) {
    for (const [table, where] of Object.entries(UPGRADE_SEEDS[name]?.tables ?? {})) {
      const { rows } = await sql<{ n: string }>`
        SELECT count(*) AS n FROM ${sql.table(table)} WHERE ${sql.raw(where)}`.execute(db);
      // Keyed by seed too: a later migration that changes a table seeds its own row there.
      counts[`${name}: ${table}`] = Number(rows[0]?.n ?? 0);
    }
  }
  return counts;
}
