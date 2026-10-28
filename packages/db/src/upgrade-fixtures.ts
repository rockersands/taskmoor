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
      track: "key = 'SEED' AND workflow_id IS NOT NULL",
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
      await sql`UPDATE track SET workflow_id = ${workflow} WHERE key = 'SEED'`.execute(db);
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
