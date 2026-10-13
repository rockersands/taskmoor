import { type Kysely, sql } from 'kysely';

/**
 * Identity foundation (M1-001; ADR-006, ADR-019): workspaces and `workspace_id` scoping, user
 * profiles, nested groups, hashed sessions with idle and absolute expiry, sign-in throttles and
 * one-time password links.
 *
 * Expand only (ADR-022): the M0 `session` table stays until a later release, so pods of the
 * previous release keep working during a rolling upgrade; its live rows are copied here with
 * their tokens hashed. `app_user.workspace_id` defaults to the first workspace for the same
 * reason; a later migration drops that default once no older release writes users.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE workspace (
      id serial PRIMARY KEY,
      key text NOT NULL UNIQUE,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`INSERT INTO workspace (key, name) VALUES ('default', 'Default')`.execute(db);

  await sql`
    ALTER TABLE app_user
      ADD COLUMN workspace_id integer NOT NULL DEFAULT 1 REFERENCES workspace (id),
      ADD COLUMN time_zone text,
      ADD COLUMN locale text,
      ADD COLUMN password_changed_at timestamptz,
      ADD COLUMN last_sign_in_at timestamptz,
      ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()`.execute(db);
  // Email is unique within a workspace, ignoring case, rather than across the instance.
  await sql`ALTER TABLE app_user DROP CONSTRAINT app_user_email_key`.execute(db);
  await sql`CREATE UNIQUE INDEX app_user_workspace_email_idx ON app_user (workspace_id, lower(email))`.execute(
    db,
  );

  await sql`
    CREATE TABLE user_group (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX user_group_workspace_name_idx ON user_group (workspace_id, lower(name))`.execute(
    db,
  );
  await sql`
    CREATE TABLE group_member (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      group_id integer NOT NULL REFERENCES user_group (id) ON DELETE CASCADE,
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      added_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, user_id)
    )`.execute(db);
  await sql`CREATE INDEX group_member_user_idx ON group_member (user_id)`.execute(db);
  // A group may contain groups (IAM-008); the application refuses cycles.
  await sql`
    CREATE TABLE group_nesting (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      parent_id integer NOT NULL REFERENCES user_group (id) ON DELETE CASCADE,
      child_id integer NOT NULL REFERENCES user_group (id) ON DELETE CASCADE,
      PRIMARY KEY (parent_id, child_id),
      CHECK (parent_id <> child_id)
    )`.execute(db);
  await sql`CREATE INDEX group_nesting_child_idx ON group_nesting (child_id)`.execute(db);

  // Sessions keep only a hash of the token the browser holds (ADR-019, ADR-032).
  await sql`
    CREATE TABLE user_session (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      ip text,
      user_agent text
    )`.execute(db);
  await sql`CREATE INDEX user_session_user_idx ON user_session (user_id)`.execute(db);
  await sql`CREATE INDEX user_session_expires_idx ON user_session (expires_at)`.execute(db);
  await sql`
    INSERT INTO user_session (workspace_id, user_id, token_hash, created_at, expires_at, last_seen_at)
    SELECT u.workspace_id, s.user_id, encode(sha256(convert_to(s.id, 'UTF8')), 'hex'),
           s.created_at, s.expires_at, s.last_seen_at
      FROM session s JOIN app_user u ON u.id = s.user_id
     WHERE s.expires_at > now()`.execute(db);

  // Failed sign-ins per account and per address, for progressive lockout and rate limits.
  await sql`
    CREATE TABLE sign_in_throttle (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      key text NOT NULL,
      failures integer NOT NULL,
      window_started_at timestamptz NOT NULL DEFAULT now(),
      locked_until timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, key)
    )`.execute(db);

  // One-time links an administrator hands to a person to set a password (activation or reset).
  await sql`
    CREATE TABLE password_link (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      purpose text NOT NULL CHECK (purpose IN ('activate', 'reset')),
      created_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    )`.execute(db);
  await sql`CREATE INDEX password_link_user_idx ON password_link (user_id)`.execute(db);
}
