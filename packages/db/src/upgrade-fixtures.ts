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
    // Its session row is not checked afterwards: 0003 copies it to user_session and 0055 drops
    // the M0 table (M1-121).
    tables: { app_user: "email = 'seed@example.com'" },
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
  '0011_ticket_types': {
    tables: {
      hierarchy_level: "name = 'Seed level' AND rank = 2",
      ticket_type: "name = 'Seed type'",
      type_set: "name = 'Seed type set' AND default_type_id IS NOT NULL",
      type_set_member: "ticket_type_id IN (SELECT id FROM ticket_type WHERE name = 'Seed type')",
      type_set_default:
        "workspace_id = 1 AND track_type = 'service' AND type_set_id IN (SELECT id FROM type_set WHERE name = 'Seed type set')",
      track:
        "key = 'SEED' AND type_set_id IN (SELECT id FROM type_set WHERE name = 'Seed type set')",
    },
    seed: async (db) => {
      await sql`INSERT INTO hierarchy_level (workspace_id, kind, rank, name)
        VALUES (1, 'custom', 2, 'Seed level')`.execute(db);
      await sql`INSERT INTO ticket_type (workspace_id, name, level_id)
        SELECT 1, 'Seed type', id FROM hierarchy_level WHERE name = 'Seed level'`.execute(db);
      await sql`INSERT INTO type_set (workspace_id, name) VALUES (1, 'Seed type set')`.execute(db);
      await sql`INSERT INTO type_set_member (workspace_id, type_set_id, ticket_type_id, sort_order)
        SELECT 1, s.id, t.id, 1 FROM type_set s, ticket_type t
         WHERE s.name = 'Seed type set' AND t.name = 'Seed type'`.execute(db);
      await sql`UPDATE type_set SET default_type_id = (SELECT id FROM ticket_type WHERE name = 'Seed type')
         WHERE name = 'Seed type set'`.execute(db);
      await sql`UPDATE type_set_default
           SET type_set_id = (SELECT id FROM type_set WHERE name = 'Seed type set')
         WHERE workspace_id = 1 AND track_type = 'service'`.execute(db);
      await sql`UPDATE track SET type_set_id = (SELECT id FROM type_set WHERE name = 'Seed type set')
         WHERE key = 'SEED'`.execute(db);
    },
  },
  '0012_scim': {
    tables: {
      api_token: "token_hash = 'seed-scim-token' AND scopes = ARRAY['scim']",
      scim_user: "user_name = 'seed.person' AND external_id = 'seed-external'",
      scim_group: "external_id = 'seed-group-external'",
    },
    seed: async (db) => {
      await sql`INSERT INTO api_token (workspace_id, user_id, name, token_hash, scopes, expires_at)
        SELECT 1, id, 'Seed provisioning', 'seed-scim-token', ARRAY['scim'], now() + interval '30 days'
          FROM app_user WHERE email = 'seed-robot@service.invalid'`.execute(db);
      await sql`INSERT INTO scim_user (workspace_id, user_id, user_name, external_id, attributes)
        SELECT 1, id, 'seed.person', 'seed-external', '{"title": "Seed"}'
          FROM app_user WHERE email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO scim_group (workspace_id, group_id, external_id)
        SELECT 1, id, 'seed-group-external' FROM user_group WHERE name = 'seed-group'`.execute(db);
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
  '0014_tickets': {
    tables: {
      ticket: "summary = 'Seed ticket' AND number = 1 AND start_date = '2026-10-01'",
      ticket_counter: "last_number = 2 AND track_id IN (SELECT id FROM track WHERE key = 'SEED')",
      ticket_key_history:
        "replaced_at IS NULL AND ticket_id IN (SELECT id FROM ticket WHERE summary = 'Seed ticket')",
      ticket_detached_parent: "ticket_id IN (SELECT id FROM ticket WHERE summary = 'Seed child')",
    },
    seed: async (db) => {
      await sql`INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary,
          description, requester_id, creator_id, start_date, rank)
        SELECT 1, t.id, n.number, ty.id, n.summary, '{"type": "doc", "content": []}', u.id, u.id,
               '2026-10-01', n.rank
          FROM track t, ticket_type ty, app_user u,
               (VALUES (1, 'Seed ticket', 'a1'), (2, 'Seed child', 'a2')) AS n (number, summary, rank)
         WHERE t.key = 'SEED' AND ty.name = 'Seed type' AND u.email = 'seed@example.com'`.execute(
        db,
      );
      await sql`INSERT INTO ticket_counter (workspace_id, track_id, last_number)
        SELECT 1, id, 2 FROM track WHERE key = 'SEED'`.execute(db);
      await sql`INSERT INTO ticket_detached_parent (workspace_id, ticket_id, parent_id)
        SELECT 1, c.id, p.id FROM ticket c, ticket p
         WHERE c.summary = 'Seed child' AND p.summary = 'Seed ticket'`.execute(db);
    },
  },
  '0015_ticket_history': {
    tables: {
      ticket_change:
        "field = 'summary' AND to_value = 'Seed ticket' AND to_display IS NULL AND change_set = 1",
    },
    seed: async (db) => {
      await sql`INSERT INTO ticket_change (workspace_id, ticket_id, change_set, actor_id, field,
          from_value, to_value)
        SELECT 1, t.id, 1, u.id, 'summary', NULL, 'Seed ticket'
          FROM ticket t, app_user u
         WHERE t.summary = 'Seed ticket' AND u.email = 'seed@example.com'`.execute(db);
    },
  },
  '0018_ticket_fields': {
    tables: {
      priority: "name = 'Seed priority'",
      priority_set: "name = 'Seed priority set' AND default_priority_id IS NOT NULL",
      priority_set_member: "priority_id IN (SELECT id FROM priority WHERE name = 'Seed priority')",
      close_reason: "name = 'Seed reason'",
      label: "name = 'seed-label'",
      release: "name = 'Seed release' AND release_date = '2026-12-01'",
      release_approver: "decision = 'approved'",
      area: "name = 'Seed area' AND default_assignee = 'area_owner'",
      track: "key = 'SEED' AND priority_set_id IS NOT NULL",
      ticket:
        "summary = 'Seed ticket' AND labels = ARRAY['seed-label'] AND priority_id IS NOT NULL",
      ticket_release: "role = 'target'",
      ticket_area: "area_id IN (SELECT id FROM area WHERE name = 'Seed area')",
    },
    seed: async (db) => {
      await sql`INSERT INTO priority (workspace_id, name, sort_order) VALUES (1, 'Seed priority', 5)`.execute(
        db,
      );
      await sql`INSERT INTO priority_set (workspace_id, name) VALUES (1, 'Seed priority set')`.execute(
        db,
      );
      await sql`INSERT INTO priority_set_member (workspace_id, priority_set_id, priority_id)
        SELECT 1, s.id, p.id FROM priority_set s, priority p
         WHERE s.name = 'Seed priority set' AND p.name = 'Seed priority'`.execute(db);
      await sql`UPDATE priority_set SET default_priority_id = (SELECT id FROM priority WHERE name = 'Seed priority')
         WHERE name = 'Seed priority set'`.execute(db);
      await sql`UPDATE track SET priority_set_id = (SELECT id FROM priority_set WHERE name = 'Seed priority set')
         WHERE key = 'SEED'`.execute(db);
      await sql`INSERT INTO close_reason (workspace_id, name, sort_order) VALUES (1, 'Seed reason', 5)`.execute(
        db,
      );
      await sql`INSERT INTO label (workspace_id, name) VALUES (1, 'seed-label')`.execute(db);
      await sql`INSERT INTO release (workspace_id, track_id, name, release_date, sort_order)
        SELECT 1, id, 'Seed release', '2026-12-01', 1 FROM track WHERE key = 'SEED'`.execute(db);
      await sql`INSERT INTO release_approver (workspace_id, release_id, user_id, decision, decided_at)
        SELECT 1, r.id, u.id, 'approved', now() FROM release r, app_user u
         WHERE r.name = 'Seed release' AND u.email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO area (workspace_id, track_id, name, owner_id, default_assignee)
        SELECT 1, t.id, 'Seed area', u.id, 'area_owner' FROM track t, app_user u
         WHERE t.key = 'SEED' AND u.email = 'seed@example.com'`.execute(db);
      await sql`UPDATE ticket SET labels = ARRAY['seed-label'],
          priority_id = (SELECT id FROM priority WHERE name = 'Seed priority')
         WHERE summary = 'Seed ticket'`.execute(db);
      await sql`INSERT INTO ticket_release (workspace_id, ticket_id, release_id, role)
        SELECT 1, k.id, r.id, 'target' FROM ticket k, release r
         WHERE k.summary = 'Seed ticket' AND r.name = 'Seed release'`.execute(db);
      await sql`INSERT INTO ticket_area (workspace_id, ticket_id, area_id)
        SELECT 1, k.id, a.id FROM ticket k, area a
         WHERE k.summary = 'Seed ticket' AND a.name = 'Seed area'`.execute(db);
    },
  },
  '0019_links': {
    tables: {
      link_type: "name = 'Seed link type' AND inward = 'is seeded by'",
      ticket_link: "link_type_id IN (SELECT id FROM link_type WHERE name = 'Seed link type')",
      link_policy: 'enabled = false',
      ticket_web_link: "global_id = 'seed-global-id'",
      ticket_follower: "user_id IN (SELECT id FROM app_user WHERE email = 'seed@example.com')",
      ticket_vote: "user_id IN (SELECT id FROM app_user WHERE email = 'seed@example.com')",
      user_preference: 'auto_follow = false',
    },
    seed: async (db) => {
      await sql`INSERT INTO link_type (workspace_id, name, outward, inward)
        VALUES (1, 'Seed link type', 'seeds', 'is seeded by')`.execute(db);
      await sql`INSERT INTO ticket_link (workspace_id, link_type_id, source_id, target_id)
        SELECT 1, lt.id, s.id, t.id FROM link_type lt, ticket s, ticket t
         WHERE lt.name = 'Seed link type' AND s.summary = 'Seed ticket'
           AND t.summary = 'Seed child'`.execute(db);
      await sql`UPDATE link_policy SET enabled = false WHERE workspace_id = 1`.execute(db);
      await sql`INSERT INTO ticket_web_link (workspace_id, ticket_id, url, title, global_id)
        SELECT 1, id, 'https://example.com/seed', 'Seed page', 'seed-global-id' FROM ticket
         WHERE summary = 'Seed ticket'`.execute(db);
      for (const table of ['ticket_follower', 'ticket_vote']) {
        await sql`INSERT INTO ${sql.table(table)} (workspace_id, ticket_id, user_id)
          SELECT 1, k.id, u.id FROM ticket k, app_user u
           WHERE k.summary = 'Seed ticket' AND u.email = 'seed@example.com'`.execute(db);
      }
      await sql`INSERT INTO user_preference (user_id, workspace_id, auto_follow)
        SELECT id, 1, false FROM app_user WHERE email = 'seed@example.com'`.execute(db);
    },
  },
  '0021_ldap': {
    tables: {
      ldap_directory:
        "name = 'Seed directory' AND kind = 'openldap' AND position = 1 AND sync_cursor IS NOT NULL",
      ldap_user: "external_id = 'seed-entry-uuid' AND deactivated_by_sync = false",
      ldap_group: "external_id = 'seed-group-uuid'",
      ldap_sync_run: "status = 'succeeded' AND mode = 'full'",
    },
    seed: async (db) => {
      // The sealed password is a placeholder that opens to nothing: no credential in the repo.
      await sql`INSERT INTO ldap_directory (workspace_id, name, kind, url, bind_dn,
          bind_password_sealed, base_dn, user_filter, group_filter, position, sync_cursor)
        VALUES (1, 'Seed directory', 'openldap', 'ldaps://ldap.example.com',
          'cn=sync,dc=example,dc=com', 'sealed-placeholder', 'dc=example,dc=com',
          '(objectClass=inetOrgPerson)', '(objectClass=groupOfNames)', 1,
          '{"kind": "timestamp", "value": "20261001000000Z"}')`.execute(db);
      const directory = sql`(SELECT id FROM ldap_directory WHERE name = 'Seed directory')`;
      await sql`INSERT INTO ldap_user (workspace_id, directory_id, user_id, external_id, dn, username)
        SELECT 1, ${directory}, id, 'seed-entry-uuid', 'uid=seed,ou=people,dc=example,dc=com', 'seed'
          FROM app_user WHERE email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO ldap_group (workspace_id, directory_id, group_id, external_id, dn)
        SELECT 1, ${directory}, id, 'seed-group-uuid', 'cn=seed-parent,ou=groups,dc=example,dc=com'
          FROM user_group WHERE name = 'seed-parent'`.execute(db);
      await sql`INSERT INTO ldap_sync_run (workspace_id, directory_id, mode, trigger, status,
          started_at, finished_at, stats)
        VALUES (1, ${directory}, 'full', 'schedule', 'succeeded', now(), now(),
          '{"usersCreated": 1}')`.execute(db);
    },
  },
  '0022_trash_backups': {
    tables: {
      track: "key = 'SEEDTRASH' AND deleted_at IS NOT NULL AND purge_started_at IS NULL",
      trash_policy: 'retention_days = 45',
      backup_run: "kind = 'scheduled' AND path = '/data/backups/seed'",
    },
    seed: async (db) => {
      await sql`INSERT INTO track (workspace_id, key, name, access_policy_id, deleted_at, deleted_by)
        SELECT 1, 'SEEDTRASH', 'Seed trash', ap.id, now(), u.id
          FROM access_policy ap, app_user u
         WHERE ap.name = 'Seed policy' AND u.email = 'seed@example.com'`.execute(db);
      await sql`UPDATE trash_policy SET retention_days = 45 WHERE workspace_id = 1`.execute(db);
      await sql`INSERT INTO backup_run (kind, state, finished_at, path, size_bytes, details)
        VALUES ('scheduled', 'succeeded', now(), '/data/backups/seed', 1024,
                '{"entries": 3}')`.execute(db);
    },
  },
  '0023_time_tracking': {
    tables: {
      time_tracking_setting: "hours_per_day = 7.5 AND default_unit = 'hour'",
      ticket: "summary = 'Seed ticket' AND original_estimate = 36000 AND time_spent = 5400",
      time_entry: "duration = 5400 AND description = 'Seed work'",
    },
    seed: async (db) => {
      await sql`UPDATE time_tracking_setting SET hours_per_day = 7.5, default_unit = 'hour'
         WHERE workspace_id = 1`.execute(db);
      await sql`UPDATE ticket SET original_estimate = 36000, remaining_estimate = 30600,
          time_spent = 5400 WHERE summary = 'Seed ticket'`.execute(db);
      await sql`INSERT INTO time_entry (workspace_id, ticket_id, author_id, started_at, duration,
          description)
        SELECT 1, k.id, u.id, '2026-10-01T09:00:00Z', 5400, 'Seed work' FROM ticket k, app_user u
         WHERE k.summary = 'Seed ticket' AND u.email = 'seed@example.com'`.execute(db);
    },
  },
  '0020_saml': {
    tables: {
      identity_provider:
        "name = 'Seed SAML IdP' AND kind = 'saml' AND client_id IS NULL AND cardinality(saml_certificates) = 1",
      saml_login: "request_id = 'seed-request'",
      saml_assertion: "assertion_id = 'seed-assertion'",
    },
    seed: async (db) => {
      await sql`INSERT INTO identity_provider (workspace_id, name, kind, issuer, saml_sso_url,
          saml_certificates, domains)
        VALUES (1, 'Seed SAML IdP', 'saml', 'https://saml.example.com/idp',
          'https://saml.example.com/sso', ARRAY['-----BEGIN CERTIFICATE-----'], '{saml.example.com}')`.execute(
        db,
      );
      const provider = sql`(SELECT id FROM identity_provider WHERE name = 'Seed SAML IdP')`;
      await sql`INSERT INTO saml_login (workspace_id, provider_id, request_id, browser_hash, expires_at)
        VALUES (1, ${provider}, 'seed-request', 'seed-browser', now() + interval '5 minutes')`.execute(
        db,
      );
      await sql`INSERT INTO saml_assertion (workspace_id, assertion_id, provider_id, expires_at)
        VALUES (1, 'seed-assertion', ${provider}, now() + interval '5 minutes')`.execute(db);
    },
  },
  '0024_workflows': {
    tables: {
      status: "name = 'Seed status' AND stage = 'active'",
      workflow: "name = 'Seed workflow' AND draft_version = 2",
      workflow_version:
        "workflow_id IN (SELECT id FROM workflow WHERE name = 'Seed workflow') AND version = 2",
      workflow_version_status:
        "status_id IN (SELECT id FROM status WHERE name = 'Seed status') AND version = 2",
      // Its workflow lives on as the default of the track's workflow map since 0042.
      track:
        "key = 'SEED' AND workflow_map_id IN (SELECT id FROM workflow_map WHERE default_workflow_id IN (SELECT id FROM workflow WHERE name = 'Seed workflow'))",
      ticket:
        "summary = 'Seed ticket' AND status_id IN (SELECT id FROM status WHERE name = 'Seed status')",
    },
    seed: async (db) => {
      await sql`INSERT INTO status (workspace_id, name, stage, sort_order)
        VALUES (1, 'Seed status', 'active', 100)`.execute(db);
      await sql`INSERT INTO workflow (workspace_id, name, published_version, draft_version)
        VALUES (1, 'Seed workflow', 1, 2)`.execute(db);
      const workflow = sql`(SELECT id FROM workflow WHERE name = 'Seed workflow')`;
      const status = sql`(SELECT id FROM status WHERE name = 'Seed status')`;
      for (const version of [1, 2]) {
        await sql`INSERT INTO workflow_version (workspace_id, workflow_id, version, definition)
          SELECT 1, ${workflow}, ${version}, jsonb_build_object('initialStatusId', ${status},
            'statuses', jsonb_build_array(jsonb_build_object('statusId', ${status})),
            'transitions', '[]'::jsonb)`.execute(db);
        await sql`INSERT INTO workflow_version_status (workspace_id, workflow_id, version, status_id)
          SELECT 1, ${workflow}, ${version}, ${status}`.execute(db);
      }
      const legacy = await sql<{ n: number }>`SELECT count(*)::int AS n
        FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'track'
         AND column_name = 'workflow_id'`.execute(db);
      if ((legacy.rows[0]?.n ?? 0) > 0) {
        await sql`UPDATE track SET workflow_id = ${workflow} WHERE key = 'SEED'`.execute(db);
      } else {
        // Seeded on 0042 or later (an upgrade that starts there): the map 0042 would have made.
        await sql`INSERT INTO workflow_map (workspace_id, name, default_workflow_id)
          SELECT 1, 'Seed workflow map', ${workflow}`.execute(db);
        await sql`UPDATE track SET workflow_map_id = (SELECT id FROM workflow_map WHERE name = 'Seed workflow map')
          WHERE key = 'SEED'`.execute(db);
      }
      await sql`UPDATE ticket SET status_id = ${status} WHERE summary = 'Seed ticket'`.execute(db);
    },
  },
  '0025_transition_history': {
    tables: {
      ticket_change: "field = 'status' AND transition_id = 7 AND to_display = 'Seeded'",
    },
    seed: async (db) => {
      await sql`INSERT INTO ticket_change (workspace_id, ticket_id, change_set, field, to_value,
          to_display, transition_id)
        SELECT 1, id, 990001, 'status', '1', 'Seeded', 7 FROM ticket
         WHERE summary = 'Seed ticket'`.execute(db);
    },
  },
  '0026_custom_fields': {
    tables: {
      field: "name = 'Seed field' AND type = 'select' AND multiple",
      field_context: "name = 'Seed context' AND default_value IS NOT NULL",
      field_context_scope:
        "context_id IN (SELECT id FROM field_context WHERE name = 'Seed context') AND track_id IS NULL",
      field_option: "value = 'Seed option' AND NOT disabled",
      field_label: "name = 'seed-label'",
      field_epoch: 'epoch > 1',
      ticket: "summary = 'Seed ticket' AND fields <> '{}'::jsonb",
    },
    seed: async (db) => {
      await sql`INSERT INTO field (workspace_id, name, type, multiple)
        VALUES (1, 'Seed field', 'select', true)`.execute(db);
      const field = sql`(SELECT id FROM field WHERE name = 'Seed field')`;
      await sql`INSERT INTO field_context (workspace_id, field_id, name, default_value)
        SELECT 1, ${field}, 'Seed context', '[1]'::jsonb`.execute(db);
      const context = sql`(SELECT id FROM field_context WHERE name = 'Seed context')`;
      await sql`INSERT INTO field_context_scope (workspace_id, field_id, context_id)
        SELECT 1, ${field}, ${context}`.execute(db);
      await sql`INSERT INTO field_option (workspace_id, field_id, context_id, value, sort_order)
        SELECT 1, ${field}, ${context}, 'Seed option', 1`.execute(db);
      await sql`INSERT INTO field_label (workspace_id, field_id, name)
        SELECT 1, ${field}, 'seed-label'`.execute(db);
      await sql`UPDATE ticket SET fields = jsonb_build_object(${field}::text,
          jsonb_build_array((SELECT id FROM field_option WHERE value = 'Seed option')))
        WHERE summary = 'Seed ticket'`.execute(db);
    },
  },
  '0027_field_values': {
    tables: {
      v_text: "value = 'seed text' AND sort_key = 'seed text'",
      v_number: 'value = 1.235',
      v_date: "value = '2026-10-28'",
      v_time: "value = '2026-10-28T12:00:00Z'",
      v_user: "value IN (SELECT id FROM app_user WHERE email = 'seed@example.com')",
      v_option: "value IN (SELECT id FROM field_option WHERE value = 'Seed option')",
    },
    seed: async (db) => {
      const row = sql`SELECT t.workspace_id, t.id, t.track_id, f.id, t.created_at
        FROM ticket t, field f WHERE t.summary = 'Seed ticket' AND f.name = 'Seed field'`;
      await sql`INSERT INTO v_text (workspace_id, ticket_id, track_id, field_id, created_at, value, sort_key)
        SELECT *, 'seed text', 'seed text' FROM (${row}) r`.execute(db);
      await sql`INSERT INTO v_number (workspace_id, ticket_id, track_id, field_id, created_at, value)
        SELECT *, 1.235 FROM (${row}) r`.execute(db);
      await sql`INSERT INTO v_date (workspace_id, ticket_id, track_id, field_id, created_at, value)
        SELECT *, '2026-10-28'::date FROM (${row}) r`.execute(db);
      await sql`INSERT INTO v_time (workspace_id, ticket_id, track_id, field_id, created_at, value)
        SELECT *, '2026-10-28T12:00:00Z'::timestamptz FROM (${row}) r`.execute(db);
      await sql`INSERT INTO v_user (workspace_id, ticket_id, track_id, field_id, created_at, value)
        SELECT r.*, u.id FROM (${row}) r, app_user u WHERE u.email = 'seed@example.com'`.execute(
        db,
      );
      await sql`INSERT INTO v_option (workspace_id, ticket_id, track_id, field_id, created_at, value)
        SELECT r.*, o.id FROM (${row}) r, field_option o WHERE o.value = 'Seed option'`.execute(db);
    },
  },
  '0028_field_rules_layouts': {
    tables: {
      field_rule_set: "name = 'Seed rules' AND NOT is_default",
      field_rule: "field = 'dueDate' AND required",
      layout_set: "name = 'Seed layouts'",
      layout: "operation = 'create' AND definition ? 'tabs'",
      track: "key = 'SEED' AND field_rule_set_id IS NOT NULL AND layout_set_id IS NOT NULL",
    },
    seed: async (db) => {
      await sql`INSERT INTO field_rule_set (workspace_id, name) VALUES (1, 'Seed rules')`.execute(
        db,
      );
      await sql`INSERT INTO field_rule (workspace_id, rule_set_id, field, required)
        SELECT 1, id, 'dueDate', true FROM field_rule_set WHERE name = 'Seed rules'`.execute(db);
      await sql`INSERT INTO layout_set (workspace_id, name) VALUES (1, 'Seed layouts')`.execute(db);
      await sql`INSERT INTO layout (workspace_id, layout_set_id, operation, definition)
        SELECT 1, id, 'create', '{"tabs": [], "others": "show"}'::jsonb
          FROM layout_set WHERE name = 'Seed layouts'`.execute(db);
      await sql`UPDATE track SET
          field_rule_set_id = (SELECT id FROM field_rule_set WHERE name = 'Seed rules'),
          layout_set_id = (SELECT id FROM layout_set WHERE name = 'Seed layouts')
        WHERE key = 'SEED'`.execute(db);
    },
  },
  '0029_visibility_levels': {
    tables: {
      visibility_policy: "name = 'Seed visibility' AND default_level_id IS NOT NULL",
      visibility_level: "name = 'Internal' AND position = 0",
      visibility_member: "grantee = 'user' AND user_id IS NOT NULL",
      track: "key = 'SEED' AND visibility_policy_id IS NOT NULL",
      ticket: "summary = 'Seed ticket' AND visibility_level_id IS NOT NULL",
    },
    seed: async (db) => {
      await sql`INSERT INTO visibility_policy (workspace_id, name) VALUES (1, 'Seed visibility')`.execute(
        db,
      );
      await sql`INSERT INTO visibility_level (workspace_id, policy_id, name, position)
        SELECT 1, id, 'Internal', 0 FROM visibility_policy WHERE name = 'Seed visibility'`.execute(
        db,
      );
      await sql`UPDATE visibility_policy SET default_level_id =
          (SELECT id FROM visibility_level WHERE name = 'Internal')
        WHERE name = 'Seed visibility'`.execute(db);
      await sql`INSERT INTO visibility_member (workspace_id, level_id, grantee, user_id)
        SELECT 1, l.id, 'user', u.id FROM visibility_level l, app_user u
         WHERE l.name = 'Internal' AND u.email = 'seed@example.com'`.execute(db);
      await sql`UPDATE track SET visibility_policy_id =
          (SELECT id FROM visibility_policy WHERE name = 'Seed visibility')
        WHERE key = 'SEED'`.execute(db);
      await sql`UPDATE ticket SET visibility_level_id =
          (SELECT id FROM visibility_level WHERE name = 'Internal')
        WHERE summary = 'Seed ticket'`.execute(db);
    },
  },
  '0030_notifications': {
    tables: {
      notification_policy: "name = 'Seed notifications' AND NOT is_default",
      notification_rule: "event = 'ticket_created' AND recipient = 'track_owner'",
      notification_preference: "event = 'ticket_updated' AND channel = 'email' AND NOT enabled",
      user_preference: 'notify_own_changes',
      notification: "event = 'ticket_created' AND channel = 'inbox' AND payload ? 'key'",
      track: "key = 'SEED' AND notification_policy_id IS NOT NULL",
    },
    seed: async (db) => {
      await sql`INSERT INTO notification_policy (workspace_id, name)
        VALUES (1, 'Seed notifications')`.execute(db);
      await sql`INSERT INTO notification_rule (workspace_id, policy_id, event, recipient)
        SELECT 1, id, 'ticket_created', 'track_owner' FROM notification_policy
         WHERE name = 'Seed notifications'`.execute(db);
      await sql`UPDATE track SET notification_policy_id =
          (SELECT id FROM notification_policy WHERE name = 'Seed notifications')
        WHERE key = 'SEED'`.execute(db);
      await sql`INSERT INTO notification_preference (user_id, workspace_id, event, channel, enabled)
        SELECT id, 1, 'ticket_updated', 'email', false FROM app_user
         WHERE email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO user_preference (user_id, workspace_id, notify_own_changes)
        SELECT id, 1, true FROM app_user WHERE email = 'seed@example.com'
        ON CONFLICT (user_id) DO UPDATE SET notify_own_changes = true`.execute(db);
      await sql`INSERT INTO notification (workspace_id, user_id, channel, event, ticket_id,
          domain_event_id, payload)
        SELECT 1, u.id, 'inbox', 'ticket_created', k.id, 1, '{"key": "SEED-1"}'::jsonb
          FROM app_user u, ticket k
         WHERE u.email = 'seed@example.com' AND k.summary = 'Seed ticket'`.execute(db);
    },
  },
  '0031_attachments': {
    tables: {
      attachment_setting: 'max_file_size = 3221225472',
      attachment:
        "name = 'seed.png' AND scan_state = 'clean' AND thumbnail_state = 'ready' AND size = 2048",
      storage_cleanup: "storage_key = 'w1/00/11/00112233445566778899aabbccddeeff'",
    },
    seed: async (db) => {
      await sql`UPDATE attachment_setting SET max_file_size = 3221225472 WHERE workspace_id = 1`.execute(
        db,
      );
      await sql`INSERT INTO attachment (workspace_id, ticket_id, name, declared_type, sniffed_type,
          size, sha256, storage, storage_key, scan_state, scanned_at, thumbnail_state,
          thumbnail_key, width, height, author_id)
        SELECT 1, k.id, 'seed.png', 'image/png', 'image/png', 2048, repeat('ab', 32), 'local',
          'w1/ab/cd/abcd0000000000000000000000000000', 'clean', now(), 'ready',
          'w1/ef/01/ef010000000000000000000000000000', 64, 48, u.id
          FROM ticket k, app_user u
         WHERE k.summary = 'Seed ticket' AND u.email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO storage_cleanup (workspace_id, storage, storage_key, reason, not_before)
        VALUES (1, 's3', 'w1/00/11/00112233445566778899aabbccddeeff', 'upload',
          now() + interval '1 day')`.execute(db);
    },
  },
  '0032_email': {
    tables: {
      email_setting: 'batch_window_seconds = 300 AND digest_hour = 7',
      user_preference: "email_delivery = 'daily' AND quiet_start = 22 AND quiet_end = 7",
      email_delivery: "kind = 'daily' AND notification_count = 1 AND subject = 'Seed digest'",
      notification: 'email_delivery_id IS NOT NULL',
      email_unsubscribe: "event = 'ticket_updated' AND used_at IS NULL",
    },
    seed: async (db) => {
      await sql`UPDATE email_setting SET batch_window_seconds = 300, digest_hour = 7
        WHERE workspace_id = 1`.execute(db);
      await sql`INSERT INTO user_preference (user_id, workspace_id, email_delivery, quiet_start,
          quiet_end)
        SELECT id, 1, 'daily', 22, 7 FROM app_user WHERE email = 'seed@example.com'
        ON CONFLICT (user_id) DO UPDATE
          SET email_delivery = 'daily', quiet_start = 22, quiet_end = 7`.execute(db);
      await sql`INSERT INTO email_delivery (workspace_id, user_id, kind, notification_count,
          subject, message_id)
        SELECT 1, id, 'daily', 1, 'Seed digest', '<seed@example.com>' FROM app_user
         WHERE email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO notification (workspace_id, user_id, channel, event, ticket_id,
          domain_event_id, payload, delivered_at, email_delivery_id)
        SELECT 1, u.id, 'email', 'ticket_updated', k.id, 2, '{"key": "SEED-1"}'::jsonb, now(),
               (SELECT id FROM email_delivery WHERE subject = 'Seed digest')
          FROM app_user u, ticket k
         WHERE u.email = 'seed@example.com' AND k.summary = 'Seed ticket'`.execute(db);
      await sql`INSERT INTO email_unsubscribe (token_hash, workspace_id, user_id, event)
        SELECT sha256('seed-token'::bytea), 1, id, 'ticket_updated' FROM app_user
         WHERE email = 'seed@example.com'`.execute(db);
    },
  },
  '0033_formula_fields': {
    tables: {
      field: "type = 'formula' AND config ->> 'output' = 'number'",
    },
    seed: async (db) => {
      await sql`INSERT INTO field (workspace_id, name, type, config)
        VALUES (1, 'Seed formula', 'formula', '{"expression": "{due} - {created}", "output": "number"}')`.execute(
        db,
      );
    },
  },
  '0034_rich_text': {
    tables: {
      ticket_text_original: "field = 'description' AND format = 'adf' AND source ? 'version'",
      ticket_text_state: "field = 'environment' AND octet_length(state) = 3",
    },
    seed: async (db) => {
      await sql`INSERT INTO ticket_text_original (ticket_id, workspace_id, field, format, source,
          doc_sha256, written_by)
        SELECT k.id, 1, 'description', 'adf', '{"version": 1, "type": "doc", "content": []}',
          repeat('cd', 32), u.id
          FROM ticket k, app_user u
         WHERE k.summary = 'Seed ticket' AND u.email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO ticket_text_state (ticket_id, workspace_id, field, state, doc_sha256)
        SELECT id, 1, 'environment', '\\x000102'::bytea, repeat('ef', 32)
          FROM ticket WHERE summary = 'Seed ticket'`.execute(db);
    },
  },
  '0036_change_log': {
    tables: {
      change_log:
        "entity = 'ticket' AND op = 'upsert' AND seq IS NOT NULL AND data->>'summary' = 'Logged ticket'",
      change_log_floor: 'retention_days = 45',
    },
    seed: async (db) => {
      // A ticket made after the log exists: a row with its snapshot, numbered at commit. Its
      // own ticket, so the other seeds' rows (logged too when they run later) do not count.
      await sql`INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary,
          requester_id, creator_id, rank)
        SELECT 1, t.id, 36, ty.id, 'Logged ticket', u.id, u.id, 'a36'
          FROM track t, ticket_type ty, app_user u
         WHERE t.key = 'SEED' AND ty.name = 'Seed type' AND u.email = 'seed@example.com'`.execute(
        db,
      );
      await sql`UPDATE change_log_floor SET retention_days = 45 WHERE workspace_id = 1`.execute(db);
    },
  },
  '0037_mutation_receipts': {
    tables: {
      mutation_receipt: "client_id = 'seed-client' AND status = 'done' AND status_code = 200",
    },
    seed: async (db) => {
      await sql`INSERT INTO mutation_receipt (workspace_id, user_id, client_id, mutation_id,
          method, path, status, status_code, body, position, finished_at)
        SELECT 1, id, 'seed-client', 'm-1', 'PATCH', '/api/v1/tickets/SEED-1', 'done', 200,
               '{"ticket": {"key": "SEED-1"}}'::jsonb, 1, now()
          FROM app_user WHERE email = 'seed@example.com'`.execute(db);
    },
  },
  '0038_field_edit_permissions': {
    tables: {
      field_rule: "field = 'startDate' AND editable_by @> '[{\"roleId\": 1}]'",
    },
    seed: async (db) => {
      await sql`INSERT INTO field_rule (workspace_id, rule_set_id, field, editable_by)
        SELECT 1, id, 'startDate', '[{"roleId": 1}]'::jsonb
          FROM field_rule_set WHERE name = 'Seed rules'`.execute(db);
    },
  },
  '0040_bulk_operations': {
    tables: {
      bulk_operation: "action = 'edit' AND total = 1 AND status = 'done' AND succeeded = 1",
      bulk_item: "ref = 'SEED-1' AND outcome = 'done' AND status_code = 200",
    },
    seed: async (db) => {
      await sql`INSERT INTO bulk_operation (workspace_id, user_id, action, params, status, total,
          succeeded, started_at, finished_at)
        SELECT 1, id, 'edit', '{"edit": {"summary": "Seeded"}}'::jsonb, 'done', 1, 1, now(), now()
          FROM app_user WHERE email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO bulk_item (operation_id, workspace_id, position, ref, ticket_id,
          outcome, status_code, finished_at)
        SELECT o.id, 1, 0, 'SEED-1', k.id, 'done', 200, now()
          FROM bulk_operation o, ticket k
         WHERE o.action = 'edit' AND k.summary = 'Seed ticket'`.execute(db);
    },
  },
  '0041_comments': {
    tables: {
      ticket_comment:
        "version = 2 AND visible_group_id IS NOT NULL AND body->>'type' = 'doc' AND edited_at IS NOT NULL",
      ticket_comment_version: "version = 1 AND body->'content'->0->>'type' = 'paragraph'",
      ticket_comment_reaction: "emoji = '\u{1F44D}'",
    },
    seed: async (db) => {
      // A comment for the seed group, edited once (its first text kept), with one reaction.
      await sql`INSERT INTO ticket_comment (workspace_id, ticket_id, author_id, body,
          visible_group_id, version, edited_at, edited_by)
        SELECT 1, k.id, u.id,
          '{"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Seed comment, edited"}]}]}',
          g.id, 2, now(), u.id
          FROM ticket k, app_user u, user_group g
         WHERE k.summary = 'Seed ticket' AND u.email = 'seed@example.com'
           AND g.name = 'seed-group'`.execute(db);
      await sql`INSERT INTO ticket_comment_version (comment_id, version, workspace_id, body,
          visible_group_id, written_by, written_at, replaced_by)
        SELECT c.id, 1, 1,
          '{"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Seed comment"}]}]}',
          c.visible_group_id, c.author_id, c.created_at, c.author_id
          FROM ticket_comment c WHERE c.version = 2`.execute(db);
      await sql`INSERT INTO ticket_comment_reaction (comment_id, emoji, user_id, workspace_id)
        SELECT c.id, ${'\u{1F44D}'}, c.author_id, 1 FROM ticket_comment c WHERE c.version = 2`.execute(
        db,
      );
    },
  },
  '0042_workflow_maps': {
    tables: {
      workflow: "name = 'Seed local workflow' AND owner_track_id IS NOT NULL",
      workflow_map: "name = 'Seed map' AND owner_track_id IS NULL AND NOT is_default",
      workflow_map_entry: "map_id IN (SELECT id FROM workflow_map WHERE name = 'Seed map')",
      track:
        "key = 'SEED' AND workflow_map_id IN (SELECT id FROM workflow_map WHERE name = 'Seed map')",
      workflow_migration: "reason = 'track_map' AND status = 'done' AND total = 1 AND migrated = 1",
      workflow_migration_step:
        "ticket_count = 1 AND migration_id IN (SELECT id FROM workflow_migration WHERE reason = 'track_map')",
    },
    seed: async (db) => {
      await sql`INSERT INTO workflow (workspace_id, name, owner_track_id)
        SELECT 1, 'Seed local workflow', id FROM track WHERE key = 'SEEDNEW'`.execute(db);
      await sql`INSERT INTO workflow_version (workspace_id, workflow_id, version, definition)
        SELECT 1, w.id, 1, jsonb_build_object('initialStatusId', s.id,
          'statuses', jsonb_build_array(jsonb_build_object('statusId', s.id)),
          'transitions', '[]'::jsonb)
          FROM workflow w, status s
         WHERE w.name = 'Seed local workflow' AND s.name = 'Seed status'`.execute(db);
      // The seed track's workflow stays its map's default; the seed type uses the default.
      await sql`INSERT INTO workflow_map (workspace_id, name, default_workflow_id)
        SELECT 1, 'Seed map', id FROM workflow WHERE name = 'Seed workflow'`.execute(db);
      await sql`INSERT INTO workflow_map_entry (workspace_id, map_id, ticket_type_id, workflow_id)
        SELECT 1, m.id, ty.id, w.id FROM workflow_map m, ticket_type ty, workflow w
         WHERE m.name = 'Seed map' AND ty.name = 'Seed type' AND w.workspace_id = 1
           AND w.is_default`.execute(db);
      await sql`UPDATE track SET workflow_map_id = (SELECT id FROM workflow_map WHERE name = 'Seed map')
         WHERE key = 'SEED'`.execute(db);
      await sql`INSERT INTO workflow_migration (workspace_id, user_id, reason, map_id, track_id,
          status, total, migrated, change_set, started_at, finished_at)
        SELECT 1, u.id, 'track_map', m.id, t.id, 'done', 1, 1, 990042, now(), now()
          FROM app_user u, workflow_map m, track t
         WHERE u.email = 'seed@example.com' AND m.name = 'Seed map' AND t.key = 'SEED'`.execute(db);
      await sql`INSERT INTO workflow_migration_step (migration_id, workspace_id, track_id,
          ticket_type_id, from_status_id, to_status_id, ticket_count)
        SELECT o.id, 1, o.track_id, ty.id, s.id, s.id, 1
          FROM workflow_migration o, ticket_type ty, status s
         WHERE o.reason = 'track_map' AND ty.name = 'Seed type' AND s.name = 'Seed status'`.execute(
        db,
      );
    },
  },
  // Indexes only: the seeded ticket must come through with its search fields as they were.
  '0043_search_indexes': {
    tables: {
      ticket: "summary = 'Seed ticket' AND deleted_at IS NULL AND requester_id IS NOT NULL",
    },
    seed: async (db) => {
      await sql`UPDATE ticket SET requester_id = (SELECT id FROM app_user WHERE email = 'seed@example.com')
        WHERE summary = 'Seed ticket'`.execute(db);
    },
  },
  '0044_inbox': {
    tables: {
      notification:
        "event = 'mentioned' AND direct AND snoozed_until IS NOT NULL AND channel = 'inbox'",
      inbox_state:
        "version = 3 AND user_id IN (SELECT id FROM app_user WHERE email = 'seed@example.com')",
    },
    seed: async (db) => {
      await sql`INSERT INTO notification (workspace_id, user_id, channel, event, ticket_id,
          domain_event_id, payload, direct, snoozed_until)
        SELECT 1, u.id, 'inbox', 'mentioned', k.id, 990044, '{"mentionedIn": ["comment"]}', true,
               now() + interval '1 day'
          FROM app_user u, ticket k
         WHERE u.email = 'seed@example.com' AND k.summary = 'Seed ticket'`.execute(db);
      await sql`INSERT INTO inbox_state (user_id, workspace_id, version)
        SELECT id, 1, 3 FROM app_user WHERE email = 'seed@example.com'`.execute(db);
    },
  },
  '0045_imports': {
    tables: {
      import_run: "import_source = 'synthetic' AND source_system = 'seed' AND status = 'done'",
      import_record: "entity_kind = 'track' AND source_id = 'seed-track' AND outcome = 'linked'",
      import_external_id: "entity_kind = 'track' AND source_id = 'seed-track'",
    },
    seed: async (db) => {
      // A finished import that linked the seed track.
      await sql`INSERT INTO import_run (workspace_id, user_id, import_source, source_system, source,
          status, started_at, finished_at)
        SELECT 1, id, 'synthetic', 'seed', '{"format": "synthetic"}'::jsonb, 'done', now(), now()
          FROM app_user WHERE email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO import_record (run_id, workspace_id, entity_kind, source_id, outcome,
          target_id, checksum)
        SELECT r.id, 1, 'track', 'seed-track', 'linked', t.id, 'seed'
          FROM import_run r, track t WHERE r.source_system = 'seed' AND t.key = 'SEED'`.execute(db);
      await sql`INSERT INTO import_external_id (workspace_id, import_source, source_system,
          entity_kind, source_id, target_id, checksum, first_run_id, last_run_id)
        SELECT 1, 'synthetic', 'seed', 'track', 'seed-track', t.id, 'seed', r.id, r.id
          FROM import_run r, track t WHERE r.source_system = 'seed' AND t.key = 'SEED'`.execute(db);
    },
  },
  '0046_ticket_visits': {
    tables: {
      ticket_visit:
        "user_id IN (SELECT id FROM app_user WHERE email = 'seed@example.com') AND ticket_id IN (SELECT id FROM ticket WHERE summary = 'Seed ticket')",
    },
    seed: async (db) => {
      await sql`INSERT INTO ticket_visit (workspace_id, user_id, ticket_id)
        SELECT 1, u.id, k.id FROM app_user u, ticket k
         WHERE u.email = 'seed@example.com' AND k.summary = 'Seed ticket'`.execute(db);
    },
  },
  '0047_boards': {
    tables: {
      board: "name = 'Seed board' AND filter_query = 'summary ~ seed'",
      board_admin:
        "board_id IN (SELECT id FROM board WHERE name = 'Seed board') AND user_id IN (SELECT id FROM app_user WHERE email = 'seed@example.com')",
    },
    seed: async (db) => {
      // A board kept by the seed person, with one column and its admin.
      await sql`INSERT INTO board (workspace_id, name, kind, location_user_id, filter_query, columns,
          swimlanes, card_rules)
        SELECT 1, 'Seed board', 'kanban', id, 'summary ~ seed',
               '[{"id": "c1", "name": "New", "statusIds": [], "min": null, "max": null}]'::jsonb,
               '{"mode": "none", "lanes": [], "unassigned": "last", "otherName": "Everything else"}'::jsonb,
               '{"colourBy": "type", "colours": [], "fields": [], "daysInColumn": true}'::jsonb
          FROM app_user WHERE email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO board_admin (workspace_id, board_id, user_id)
        SELECT 1, b.id, u.id FROM board b, app_user u
         WHERE b.name = 'Seed board' AND u.email = 'seed@example.com'`.execute(db);
    },
  },
  '0050_guardrails': {
    tables: { guardrail_limit: "name = 'releases_per_track' AND value = 20000" },
    seed: async (db) => {
      await sql`INSERT INTO guardrail_limit (workspace_id, name, value)
        VALUES (1, 'releases_per_track', 20000)`.execute(db);
    },
  },
  '0051_saved_searches': {
    tables: {
      saved_search: "name = 'Seed saved search' AND query = 'summary ~ seed'",
      saved_search_share: "scope = 'any_user'",
      saved_search_subscription: "schedule = 'weekly' AND weekday = 1",
    },
    seed: async (db) => {
      // A saved search of the seed person, shared with everyone signed in, sent weekly.
      await sql`INSERT INTO saved_search (workspace_id, owner_id, name, query)
        SELECT 1, id, 'Seed saved search', 'summary ~ seed'
          FROM app_user WHERE email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO saved_search_share (workspace_id, saved_search_id, scope)
        SELECT 1, id, 'any_user' FROM saved_search WHERE name = 'Seed saved search'`.execute(db);
      await sql`INSERT INTO saved_search_subscription (workspace_id, saved_search_id, created_by,
          recipient_user_id, schedule, weekday, next_run_at)
        SELECT 1, s.id, s.owner_id, s.owner_id, 'weekly', 1, now()
          FROM saved_search s WHERE s.name = 'Seed saved search'`.execute(db);
    },
  },
  '0052_sprints': {
    tables: {
      sprint: "name = 'Seed sprint' AND state = 'active'",
      sprint_ticket: "open AND ticket_id IN (SELECT id FROM ticket WHERE summary = 'Seed ticket')",
      sprint_change: "kind = 'committed' AND original_estimate = 3600",
    },
    seed: async (db) => {
      // An active sprint on the seed board holding the seed ticket, committed at its start.
      await sql`INSERT INTO sprint (workspace_id, board_id, name, state, sequence, start_at,
          end_at, started_at)
        SELECT 1, id, 'Seed sprint', 'active', 1, '2026-10-01T09:00:00Z', '2026-10-15T09:00:00Z',
          '2026-10-01T09:00:00Z'
          FROM board WHERE name = 'Seed board'`.execute(db);
      await sql`INSERT INTO sprint_ticket (workspace_id, sprint_id, ticket_id)
        SELECT 1, s.id, k.id FROM sprint s, ticket k
         WHERE s.name = 'Seed sprint' AND k.summary = 'Seed ticket'`.execute(db);
      await sql`INSERT INTO sprint_change (workspace_id, sprint_id, ticket_id, kind,
          original_estimate, at)
        SELECT 1, s.id, k.id, 'committed', 3600, '2026-10-01T09:00:00Z' FROM sprint s, ticket k
         WHERE s.name = 'Seed sprint' AND k.summary = 'Seed ticket'`.execute(db);
    },
  },
  '0053_webhooks': {
    tables: {
      webhook: "name = 'Seed webhook' AND format = 'json'",
      webhook_delivery: "state = 'failed' AND last_status = 503",
    },
    seed: async (db) => {
      // A webhook of the seed person for created tickets, with one failed delivery.
      await sql`INSERT INTO webhook (workspace_id, name, url, events, owner_id)
        SELECT 1, 'Seed webhook', 'https://hooks.example.com/taskmoor', '{ticket.created}', id
          FROM app_user WHERE email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO webhook_delivery (id, workspace_id, webhook_id, event_id, event_type,
          body, state, attempts, last_status)
        SELECT '00000000-0000-4000-8000-000000000053', 1, id, 1, 'ticket.created', '{}', 'failed',
          6, 503
          FROM webhook WHERE name = 'Seed webhook'`.execute(db);
    },
  },
  '0054_dashboards': {
    tables: {
      dashboard: "name = 'Seed dashboard' AND layout = 'two' AND jsonb_array_length(widgets) = 1",
      dashboard_share: "scope = 'any_user'",
    },
    seed: async (db) => {
      // A dashboard of the seed person with one widget, shared with everyone signed in.
      await sql`INSERT INTO dashboard (workspace_id, owner_id, name, widgets)
        SELECT 1, id, 'Seed dashboard',
          '[{"id":"intro","kind":"introduction","column":0,"title":"","config":{"text":"Hi"}}]'
          FROM app_user WHERE email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO dashboard_share (workspace_id, dashboard_id, scope)
        SELECT 1, id, 'any_user' FROM dashboard WHERE name = 'Seed dashboard'`.execute(db);
    },
  },
  '0055_contract_m0_session': {
    tables: { app_user: "email = 'seed-0055@example.com' AND workspace_id = 1" },
    seed: async (db) => {
      // With the default gone, a user names its workspace.
      await sql`INSERT INTO app_user (workspace_id, email, name)
        VALUES (1, 'seed-0055@example.com', 'Seed 0055')`.execute(db);
    },
  },
  '0056_history_search': {
    tables: {
      ticket_change: "field = 'description' AND length(to_value) = 5000",
    },
    seed: async (db) => {
      // A change to the seed ticket longer than an index entry holds: the history indexes keep
      // its first 200 characters, so writing it still works.
      await sql`INSERT INTO ticket_change (workspace_id, ticket_id, change_set, actor_id, field,
          to_value, at)
        SELECT 1, id, 55, NULL, 'description', repeat('x', 5000), '2026-10-30T09:00:00Z'
          FROM ticket WHERE summary = 'Seed ticket'`.execute(db);
    },
  },
  '0057_full_text_search': {
    tables: {
      ticket:
        "summary = 'Seed search' AND description_words @@ to_tsquery('taskmoor_search', 'freezing')",
      ticket_comment: "body_words @@ to_tsquery('taskmoor_search', '''searchable notes''')",
    },
    seed: async (db) => {
      // Words Postgres keeps with the ticket and its comment: stemmed, a split word whole.
      await sql`INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary,
          description, requester_id, creator_id, rank)
        SELECT 1, t.id, 57, ty.id, 'Seed search',
          '{"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "The form fre"}, {"type": "text", "text": "ezes", "marks": [{"type": "bold"}]}]}]}',
          u.id, u.id, 'a57'
          FROM track t, ticket_type ty, app_user u
         WHERE t.key = 'SEED' AND ty.name = 'Seed type' AND u.email = 'seed@example.com'`.execute(
        db,
      );
      await sql`INSERT INTO ticket_comment (workspace_id, ticket_id, author_id, body)
        SELECT 1, k.id, k.creator_id,
          '{"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Searchable notes"}]}]}'
          FROM ticket k WHERE k.summary = 'Seed search'`.execute(db);
    },
  },
  '0058_info_fields': {
    tables: {
      ticket:
        "summary = 'Seed search' AND first_response_at IS NOT NULL AND last_comment_at >= first_response_at",
    },
    seed: async (db) => {
      // An answer from someone other than the requester: the triggers record the first
      // response; the requester's comment of 0057 was backfilled as the last comment.
      await sql`INSERT INTO ticket_comment (workspace_id, ticket_id, author_id, body, created_at)
        SELECT 1, k.id, u.id,
          '{"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "An answer"}]}]}',
          now() + interval '1 minute'
          FROM ticket k, app_user u
         WHERE k.summary = 'Seed search' AND u.email = 'seed-0055@example.com'`.execute(db);
    },
  },
  '0059_rate_limits': {
    tables: {
      rate_limit_policy: 'token_rate = 80 AND ticket_write_burst = 40',
      api_usage: "client_kind = 'address' AND requests = 3 AND errors = 1",
    },
    seed: async (db) => {
      // Limits an administrator raised, and a minute of usage by an address.
      await sql`INSERT INTO rate_limit_policy (workspace_id, token_rate) VALUES (1, 80)`.execute(
        db,
      );
      await sql`INSERT INTO api_usage (workspace_id, client_kind, client, minute, requests, errors)
        VALUES (1, 'address', '192.0.2.10', '2026-10-30T12:00:00Z', 3, 1)`.execute(db);
    },
  },
  '0060_teams': {
    tables: {
      team: "name = 'Seed team' AND lead_id IS NOT NULL",
      team_member: "team_id IN (SELECT id FROM team WHERE name = 'Seed team')",
      board: "name = 'Seed board' AND team_id IS NOT NULL",
      area: "name = 'Seed area' AND owner_team_id IS NOT NULL",
      field: "name = 'Seed team field' AND type = 'team'",
    },
    seed: async (db) => {
      // A team led by the seed person, who is its member; it has the seed board, owns the
      // seed area, and a Team field exists.
      await sql`INSERT INTO team (workspace_id, name, description, lead_id)
        SELECT 1, 'Seed team', 'Seeds', id FROM app_user WHERE email = 'seed@example.com'`.execute(
        db,
      );
      await sql`INSERT INTO team_member (workspace_id, team_id, user_id)
        SELECT 1, t.id, u.id FROM team t, app_user u
         WHERE t.name = 'Seed team' AND u.email = 'seed@example.com'`.execute(db);
      const team = sql`(SELECT id FROM team WHERE name = 'Seed team')`;
      await sql`UPDATE board SET team_id = ${team} WHERE name = 'Seed board'`.execute(db);
      await sql`UPDATE area SET owner_team_id = ${team} WHERE name = 'Seed area'`.execute(db);
      await sql`INSERT INTO field (workspace_id, name, type) VALUES (1, 'Seed team field', 'team')`.execute(
        db,
      );
    },
  },
  '0061_clone': {
    tables: {
      bulk_operation: "action = 'clone' AND total = 1 AND params->>'descendants' = 'true'",
      bulk_item: "ref = 'SEED-57' AND result_ticket_id IS NOT NULL AND result->>'key' = 'SEED-58'",
    },
    seed: async (db) => {
      // A finished deep clone of the seed search ticket, which made SEED-58.
      await sql`INSERT INTO bulk_operation (workspace_id, user_id, action, params, status, total,
          succeeded, started_at, finished_at)
        SELECT 1, id, 'clone', '{"ticket": 57, "descendants": true}'::jsonb, 'done', 1, 1,
          now(), now()
          FROM app_user WHERE email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO bulk_item (operation_id, workspace_id, position, ref, ticket_id,
          outcome, status_code, finished_at, result_ticket_id, result)
        SELECT o.id, 1, 0, 'SEED-57', k.id, 'done', 201, now(), k.id + 1000,
          '{"key": "SEED-58", "attachments": 0, "links": 1, "webLinks": 0, "left": []}'::jsonb
          FROM bulk_operation o, ticket k
         WHERE o.action = 'clone' AND k.summary = 'Seed search'`.execute(db);
    },
  },
  '0062_allowlists_syslog': {
    tables: {
      ip_allowlist: "enabled AND exempt_group_ids = '{}'",
      ip_allowlist_entry: "range = '2001:db8::/32'::inet AND note = 'Office'",
      audit_syslog: "transport = 'tls' AND last_seq = 0",
      organization_domain: "domain = 'example.com'",
    },
    seed: async (db) => {
      // An office range in IPv6 and a syslog receiver not yet sent to.
      await sql`INSERT INTO ip_allowlist (workspace_id, enabled) VALUES (1, true)`.execute(db);
      await sql`INSERT INTO ip_allowlist_entry (workspace_id, range, note)
        VALUES (1, '2001:db8::/32', 'Office')`.execute(db);
      await sql`INSERT INTO audit_syslog (workspace_id, host, port, transport)
        VALUES (1, 'siem.example.com', 6514, 'tls')`.execute(db);
      await sql`INSERT INTO organization_domain (workspace_id, domain)
        VALUES (1, 'example.com')`.execute(db);
    },
  },
  '0063_board_workflow': {
    tables: {
      board: "name = 'Seed managed board' AND manages_workflow",
    },
    seed: async (db) => {
      // A board that manages its track's workflow.
      await sql`INSERT INTO board (workspace_id, name, kind, location_track_id, filter_query,
          columns, swimlanes, card_rules, manages_workflow)
        SELECT 1, 'Seed managed board', 'kanban', t.id, 'track = SEED',
               '[{"id": "c1", "name": "New", "statusIds": [], "min": null, "max": null}]'::jsonb,
               '{"mode": "none", "lanes": [], "unassigned": "last", "otherName": "Everything else"}'::jsonb,
               '{"colourBy": "type", "colours": [], "fields": [], "daysInColumn": true}'::jsonb,
               true
          FROM track t WHERE t.key = 'SEED'`.execute(db);
    },
  },
  '0064_oauth': {
    tables: {
      user_session: "client_id = 'taskmoor-web' AND token_hash IS NULL AND parent_id IS NOT NULL",
      oauth_code: "code_hash = 'seed-code' AND used_at IS NOT NULL AND family_id IS NOT NULL",
      oauth_token: "token_hash = 'seed-refresh' AND kind = 'refresh' AND used_at IS NULL",
    },
    seed: async (db) => {
      // A frontend's token family under the seed browser session, the code it came from and
      // its current refresh token.
      await sql`INSERT INTO user_session (workspace_id, user_id, token_hash, expires_at,
          client_id, parent_id)
        SELECT s.workspace_id, s.user_id, NULL, s.expires_at, 'taskmoor-web', s.id
          FROM user_session s WHERE s.token_hash = 'seed-hash'`.execute(db);
      await sql`INSERT INTO oauth_code (code_hash, workspace_id, session_id, client_id,
          redirect_uri, code_challenge, expires_at, used_at, family_id)
        SELECT 'seed-code', 1, f.parent_id, 'taskmoor-web', 'https://tracker.example.com/',
               'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', now() + interval '1 minute', now(),
               f.id
          FROM user_session f WHERE f.client_id = 'taskmoor-web'`.execute(db);
      await sql`INSERT INTO oauth_token (token_hash, workspace_id, session_id, kind, expires_at)
        SELECT 'seed-refresh', f.workspace_id, f.id, 'refresh', f.expires_at
          FROM user_session f WHERE f.client_id = 'taskmoor-web'`.execute(db);
    },
  },
  '0065_import_labels': {
    tables: {
      import_record:
        "entity_kind = 'status' AND source_id = 'seed-status' AND label = 'Seed status'",
    },
    seed: async (db) => {
      // A configuration record of an earlier run, with the name the report's mapping shows.
      await sql`INSERT INTO import_record (run_id, workspace_id, entity_kind, source_id, outcome,
          target_id, label)
        SELECT r.run_id, 1, 'status', 'seed-status', 'linked', s.id, 'Seed status'
          FROM import_record r, status s
         WHERE r.entity_kind = 'track' AND r.source_id = 'seed-track'
         ORDER BY s.id LIMIT 1`.execute(db);
    },
  },
  '0066_entity_properties': {
    tables: {
      ticket_property: "key = 'seed.support' AND value->>'level' = '2'",
      track_property: "key = 'seed.track'",
      user_property: "key = 'seed.user'",
      board_property: "key = 'seed.board'",
      sprint_property: "key = 'seed.sprint'",
      property_index: "key = 'seed.support' AND path = 'level' AND type = 'number'",
      p_number: 'value = 2',
    },
    seed: async (db) => {
      // A property on one of each kind of entity, an index on the ticket's and its value.
      await sql`INSERT INTO ticket_property (workspace_id, ticket_id, key, value)
        SELECT workspace_id, id, 'seed.support', '{"level": 2}'::jsonb
          FROM ticket ORDER BY id LIMIT 1`.execute(db);
      await sql`INSERT INTO track_property (workspace_id, track_id, key, value)
        SELECT workspace_id, id, 'seed.track', '"on"'::jsonb FROM track ORDER BY id LIMIT 1`.execute(
        db,
      );
      await sql`INSERT INTO user_property (workspace_id, user_id, key, value)
        SELECT workspace_id, id, 'seed.user', '[1, 2]'::jsonb FROM app_user ORDER BY id LIMIT 1`.execute(
        db,
      );
      await sql`INSERT INTO board_property (workspace_id, board_id, key, value)
        SELECT workspace_id, id, 'seed.board', 'true'::jsonb FROM board ORDER BY id LIMIT 1`.execute(
        db,
      );
      await sql`INSERT INTO sprint_property (workspace_id, sprint_id, key, value)
        SELECT workspace_id, id, 'seed.sprint', 'null'::jsonb FROM sprint ORDER BY id LIMIT 1`.execute(
        db,
      );
      await sql`INSERT INTO property_index (workspace_id, key, path, type)
        VALUES (1, 'seed.support', 'level', 'number')`.execute(db);
      await sql`INSERT INTO p_number (workspace_id, ticket_id, track_id, field_id, value, created_at)
        SELECT t.workspace_id, t.id, t.track_id, i.id, 2, t.created_at
          FROM ticket t, property_index i
         WHERE i.key = 'seed.support'
         ORDER BY t.id LIMIT 1`.execute(db);
    },
  },
  '0067_oauth_clients': {
    tables: {
      oauth_client: "id = 'tmc_seedclient0000000000000' AND name = 'Seed client'",
      oauth_request: "id_hash = 'seed-request' AND scope = 'read write'",
      user_session: "client_id = 'tmc_seedclient0000000000000' AND scope = 'read'",
    },
    seed: async (db) => {
      // A registered client, a request waiting for consent and a read-only family it holds.
      await sql`INSERT INTO oauth_client (id, workspace_id, name, redirect_uris)
        VALUES ('tmc_seedclient0000000000000', 1, 'Seed client',
                ARRAY['http://127.0.0.1:33418/callback'])`.execute(db);
      await sql`INSERT INTO oauth_request (id_hash, workspace_id, client_id, redirect_uri,
          code_challenge, state, scope, expires_at)
        VALUES ('seed-request', 1, 'tmc_seedclient0000000000000',
                'http://127.0.0.1:33418/callback', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
                'seed-state', 'read write', now() + interval '10 minutes')`.execute(db);
      await sql`INSERT INTO user_session (workspace_id, user_id, token_hash, expires_at,
          client_id, parent_id, scope)
        SELECT s.workspace_id, s.user_id, NULL, now() + interval '30 days',
               'tmc_seedclient0000000000000', NULL, 'read'
          FROM user_session s WHERE s.token_hash = 'seed-hash'`.execute(db);
    },
  },
  '0068_frontend_origins': {
    tables: {
      frontend_origin: "origin = 'https://seed-frontend.example.org' AND last_version = '1.4.0'",
    },
    seed: async (db) => {
      // A registered frontend with its OAuth return address, seen at version 1.4.0.
      await sql`INSERT INTO frontend_origin (workspace_id, origin, label, redirect_uris,
          websocket, last_version, last_seen_at, created_by)
        SELECT 1, 'https://seed-frontend.example.org', 'Seed frontend',
               ARRAY['https://seed-frontend.example.org/'], false, '1.4.0', now(), min(id)
          FROM app_user`.execute(db);
    },
  },
  '0071_import_staged': {
    tables: {
      import_staged: "kind = 'ticket' AND source_id = '10001' AND depth = 1",
    },
    seed: async (db) => {
      // A ticket a remote fetch staged for the seed import, below its parent.
      await sql`INSERT INTO import_staged (run_id, workspace_id, kind, source_id, depth, ordinal,
          label, data)
        SELECT id, 1, 'ticket', '10001', 1, 1, 'SEED-2', '{"key": "SEED-2"}'::jsonb
          FROM import_run WHERE source_system = 'seed'`.execute(db);
      await sql`UPDATE import_run SET fetch_state = '{"done": true}'::jsonb
        WHERE source_system = 'seed'`.execute(db);
    },
  },
  '0073_saved_search_import_problem': {
    tables: {
      saved_search: "name = 'Seed imported search' AND import_problem LIKE 'subtasksOf()%'",
    },
    seed: async (db) => {
      // A saved search an import kept with the source's text, flagged with why it cannot run.
      await sql`INSERT INTO saved_search (workspace_id, owner_id, name, query, import_problem)
        SELECT 1, id, 'Seed imported search', 'issueFunction in subtasksOf("project = SEED")',
               'subtasksOf() is not a function Taskmoor has'
          FROM app_user WHERE email = 'seed@example.com'`.execute(db);
    },
  },
  '0074_ai_credentials': {
    tables: {
      ai_setting: 'workspace_id = 1 AND version = 2',
      ai_credential: "slot = 'apiKey' AND last4 = 'seed'",
    },
    seed: async (db) => {
      // AI on with the Anthropic API and a sealed key (the seed's ciphertext opens with nothing).
      await sql`INSERT INTO ai_setting (workspace_id, value, version, environment_imported_at)
        VALUES (1, '{"enabled": true, "provider": {"provider": "anthropic",
          "apiKey": {"secretId": "apiKey"}}}'::jsonb, 2, now())`.execute(db);
      await sql`INSERT INTO ai_credential (workspace_id, slot, kek_id, wrapped_key, ciphertext,
          last4, source)
        VALUES (1, 'apiKey', 'master:seedseedseed', 'v1.seed.seed.seed', 'v1.seed.seed.seed',
                'seed', 'environment')`.execute(db);
    },
  },
  '0075_ai_spend': {
    tables: {
      ai_policy: 'workspace_id = 1 AND content_days = 7',
      ai_price: "provider = 'bedrock' AND model = 'claude-opus-5-5'",
      ai_spend_limit: "scope = 'feature' AND feature = 'summarize' AND amount = 500000",
      ai_call: "feature = 'summarize' AND outcome = 'ok' AND cost_nanos = 3200000",
      ai_usage_day: "feature = 'summarize' AND day = '2026-10-30'",
      ai_spend_counter: "key = 'feature:summarize' AND period = 'day'",
      ai_limit_alert: 'percent = 80 AND used = 400000',
      ai_notice_ack: 'workspace_id = 1',
    },
    seed: async (db) => {
      // A workspace keeping content a week, a Bedrock price, a feature's daily token limit
      // that raised its 80% alert, one call with its daily sums, and a person who read the notice.
      await sql`INSERT INTO ai_policy (workspace_id, content_days, redact_terms, redacted_fields)
        VALUES (1, 7, ARRAY['Heron'], ARRAY['environment'])`.execute(db);
      await sql`INSERT INTO ai_price (workspace_id, provider, model, input_nanos, output_nanos,
          cache_read_nanos, cache_write_nanos)
        VALUES (1, 'bedrock', 'claude-opus-5-5', 4400, 22000, 220, 5500)`.execute(db);
      await sql`INSERT INTO ai_spend_limit (workspace_id, scope, feature, period, metric, amount)
        VALUES (1, 'feature', 'summarize', 'day', 'tokens', 500000)`.execute(db);
      await sql`INSERT INTO ai_call (workspace_id, occurred_at, user_id, feature, provider, model,
          served_model, mode, outcome, input_tokens, output_tokens, cost_nanos, priced, latency_ms)
        SELECT 1, '2026-10-30T10:00:00Z', min(id), 'summarize', 'anthropic', 'claude-opus-5-5',
               'claude-opus-5-5', 'stream', 'ok', 300, 100, 3200000, true, 850
          FROM app_user`.execute(db);
      await sql`INSERT INTO ai_usage_day (workspace_id, day, feature, user_id, provider, model,
          calls, input_tokens, output_tokens, cost_nanos)
        SELECT 1, '2026-10-30', 'summarize', min(id), 'anthropic', 'claude-opus-5-5', 1, 300, 100,
               3200000
          FROM app_user`.execute(db);
      await sql`INSERT INTO ai_spend_counter (workspace_id, period, period_start, key, tokens,
          cost_nanos)
        VALUES (1, 'day', '2026-10-30', 'feature:summarize', 400, 3200000)`.execute(db);
      await sql`INSERT INTO ai_limit_alert (workspace_id, limit_id, period_start, percent, used)
        SELECT 1, id, '2026-10-30', 80, 400000 FROM ai_spend_limit WHERE feature = 'summarize'`.execute(
        db,
      );
      await sql`INSERT INTO ai_notice_ack (workspace_id, user_id)
        SELECT 1, min(id) FROM app_user`.execute(db);
    },
  },
  '0076_import_delta': {
    tables: {
      import_run: "source_system = 'seed' AND name = 'Seed delta' AND delta_from IS NOT NULL",
      import_record: "outcome = 'deleted' AND source_id = 'seed-gone'",
    },
    seed: async (db) => {
      // A delta run from the seed import (cancelled, so the 0045 seed's row stays the only done
      // one) that had found a ticket the source no longer holds.
      await sql`INSERT INTO import_run (workspace_id, import_source, source_system, name, source,
          status, delta_from)
        SELECT 1, import_source, source_system, 'Seed delta', source, 'cancelled', id
          FROM import_run WHERE source_system = 'seed' ORDER BY id LIMIT 1`.execute(db);
      await sql`INSERT INTO import_record (run_id, workspace_id, entity_kind, source_id, outcome,
          target_id)
        SELECT id, 1, 'ticket', 'seed-gone', 'deleted', NULL
          FROM import_run WHERE name = 'Seed delta'`.execute(db);
    },
  },
  '0079_embeddings': {
    tables: {
      ticket_embedding:
        "model = 'local:all-MiniLM-L6-v2' AND cardinality(embedding) = 3 AND source_hash = md5('Seed ticket')",
      comment_embedding: "model = 'local:all-MiniLM-L6-v2' AND embedding = '{0,1,0}'",
    },
    seed: async (db) => {
      // The seed ticket's vector (a short one: the shape, not the model, is what is carried)
      // and its comment's.
      await sql`INSERT INTO ticket_embedding (ticket_id, workspace_id, model, source_hash, embedding)
        SELECT id, 1, 'local:all-MiniLM-L6-v2', md5('Seed ticket'), '{1,0,0}'
          FROM ticket WHERE summary = 'Seed ticket'`.execute(db);
      await sql`INSERT INTO comment_embedding (comment_id, ticket_id, workspace_id, model,
          source_hash, embedding)
        SELECT c.id, c.ticket_id, 1, 'local:all-MiniLM-L6-v2', md5('Seed comment'), '{0,1,0}'
          FROM ticket_comment c WHERE c.version = 2`.execute(db);
    },
  },
  '0080_session_policy': {
    tables: { session_policy: 'workspace_id = 1 AND lifetime_minutes = 720 AND idle_minutes = 30' },
    seed: async (db) => {
      // A workspace on the ASVS level-2 values: 12 hours, 30 minutes idle.
      await sql`INSERT INTO session_policy (workspace_id, lifetime_minutes, idle_minutes)
        VALUES (1, 720, 30)`.execute(db);
    },
  },
  '0081_security_events': {
    tables: {
      domain_event: "type = 'user.password_changed' AND user_agent = 'Seed browser'",
      security_email: "kind = 'password_changed' AND to_address = 'seed@example.com'",
      security_alert_rule: "rule = 'access_refusals' AND threshold = 80",
      security_counter: "rule = 'bulk_exports' AND key = 'user:seed'",
      security_alert: "rule = 'bulk_exports' AND key = 'user:seed' AND count = 5",
    },
    seed: async (db) => {
      // A password change with where it came from, its notice, a tuned rule, a count and the
      // alert it raised.
      await sql`INSERT INTO domain_event (workspace_id, type, subject_type, subject_id, payload,
          ip, user_agent)
        SELECT 1, 'user.password_changed', 'user', id::text,
          '{"via": "self", "endedSessions": 0}', '192.0.2.1', 'Seed browser'
          FROM app_user WHERE email = 'seed@example.com'`.execute(db);
      await sql`INSERT INTO security_email (workspace_id, user_id, kind, domain_event_id,
          to_address, details)
        SELECT 1, u.id, 'password_changed', e.id, u.email, '{"ip": "192.0.2.1"}'
          FROM app_user u, domain_event e
         WHERE u.email = 'seed@example.com' AND e.user_agent = 'Seed browser'`.execute(db);
      await sql`INSERT INTO security_alert_rule (workspace_id, rule, threshold, window_minutes)
        VALUES (1, 'access_refusals', 80, 15)`.execute(db);
      await sql`INSERT INTO security_counter (workspace_id, rule, key, window_start, count)
        VALUES (1, 'bulk_exports', 'user:seed', '2026-11-02T00:00:00Z', 5)`.execute(db);
      await sql`INSERT INTO security_alert (workspace_id, rule, key, window_start, count,
          threshold, window_minutes)
        VALUES (1, 'bulk_exports', 'user:seed', '2026-11-02T00:00:00Z', 5, 5, 60)`.execute(db);
    },
  },
  '0082_storage_quota': {
    tables: {
      attachment_setting:
        'workspace_id = 1 AND workspace_quota = 1099511627776 AND person_quota = 10737418240',
    },
    seed: async (db) => {
      // A workspace capped at 1 TiB, 10 GiB a person, beside its earlier file size limit.
      await sql`UPDATE attachment_setting SET workspace_quota = 1099511627776,
          person_quota = 10737418240 WHERE workspace_id = 1`.execute(db);
    },
  },
  '0083_personal_data': {
    tables: {
      personal_export:
        "workspace_id = 1 AND state = 'ready' AND storage = 'local' AND size = 2048 AND requested_by = user_id",
      app_user: "email = 'erased-seed@erased.invalid' AND erased_at IS NOT NULL",
    },
    seed: async (db) => {
      // An erased person: the placeholder identity stays for attribution.
      await sql`INSERT INTO app_user (workspace_id, email, name, deactivated_at, erased_at)
        VALUES (1, 'erased-seed@erased.invalid', 'Former user', now(), now())`.execute(db);
      // A finished personal data download (ADR-111) of the seed's first person, asked by them.
      await sql`INSERT INTO personal_export (workspace_id, user_id, requested_by, state, storage,
          storage_key, size, sha256, finished_at, expires_at)
        SELECT 1, id, id, 'ready', 'local', 'w1/ab/cd/abcd0000000000000000000000000000', 2048,
               repeat('a', 64), now(), now() + interval '7 days'
          FROM app_user WHERE workspace_id = 1 ORDER BY id LIMIT 1`.execute(db);
    },
  },
  '0084_tutorial_progress': {
    tables: {
      tutorial_progress:
        "workspace_id = 1 AND section = 'boards' AND state = 'active' AND step = 3",
    },
    seed: async (db) => {
      // The seed's first person is partway through a section of the tutorial (ADR-115).
      await sql`INSERT INTO tutorial_progress (workspace_id, user_id, section, state, step)
        SELECT 1, id, 'boards', 'active', 3
          FROM app_user WHERE workspace_id = 1 ORDER BY id LIMIT 1`.execute(db);
    },
  },
  '0088_one_board_per_track': {
    tables: {
      board: "name = 'Seed one-track board' AND location_user_id IS NULL",
    },
    seed: async (db) => {
      // A track with no board gets the seed's only board of that query (ADR-116); made after the
      // migration too, as a track's board, so the rule's own shape is what stays.
      await sql`INSERT INTO board (workspace_id, name, kind, location_track_id, filter_query,
          columns, swimlanes, card_rules)
        SELECT 1, 'Seed one-track board', 'kanban', t.id, 'track = "' || t.key || '"', '[]', '{}', '{}'
          FROM track t
         WHERE t.workspace_id = 1
           AND NOT EXISTS (SELECT 1 FROM board b WHERE b.location_track_id = t.id)
         ORDER BY t.id LIMIT 1`.execute(db);
    },
  },
  '0089_seamless_default_workflow': {
    tables: {
      workflow: 'is_default AND workspace_id = 1',
    },
    seed: async () => {},
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
