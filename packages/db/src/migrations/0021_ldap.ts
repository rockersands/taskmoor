import { type Kysely, sql } from 'kysely';

/**
 * LDAP and Active Directory (M1-082; IAM-005, ADR-019).
 *
 * - `ldap_directory`: a directory Taskmoor reads people and groups from and signs them in
 *   against. Connection (URL, StartTLS, trusted CA certificates), the service account it binds
 *   as (the password sealed under the pepper, as identity provider client secrets are), where
 *   and what to search, which attributes mean what, read-only or read-write, its precedence
 *   among several directories (`position`, lowest first), the schedule, and the incremental
 *   sync's cursor (Active Directory: the domain controller's USN; others: modifyTimestamp).
 * - `ldap_user`: an account a directory manages, with the entry's stable identifier (objectGUID,
 *   entryUUID), DN and user name. `deactivated_by_sync` remembers that the sync, not an
 *   administrator, deactivated the account, so only those come back when the entry does.
 *   `removed_at` is set when the entry left the directory (or its filter); the account stays,
 *   deactivated, with everything it did.
 * - `ldap_group`: a group a directory manages; its members and nested groups follow the
 *   directory.
 * - `ldap_sync_run`: queued, running and finished syncs with their counts and warnings. One run
 *   per directory runs at a time and one waits (partial unique indexes); a running run's
 *   heartbeat tells a dead worker's run from a live one.
 * - The authorization epoch (ADR-012, migration 0004) moves once per statement on
 *   `group_member`, `group_nesting` and `user_group` instead of once per row: a sync writes
 *   thousands of memberships at a time, and bumping one row thousands of times in a transaction
 *   grows its version chain, so each bump took longer than the last (a 100,000-person sync
 *   spent most of its time there). Any change still moves the epoch, which is all the
 *   authorizer's cache compares.
 *
 * Expand only (ADR-022): new tables, and triggers that do what the old ones did. The previous
 * release ignores the tables; accounts a directory created have no password there, so they
 * cannot sign in with one until the upgrade finishes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ldap_directory (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('active_directory', 'openldap', 'generic')),
      url text NOT NULL,
      start_tls boolean NOT NULL DEFAULT false,
      ca_certificates text[] NOT NULL DEFAULT '{}',
      bind_dn text NOT NULL,
      bind_password_sealed text NOT NULL,
      base_dn text NOT NULL,
      user_base_dn text,
      user_filter text NOT NULL,
      group_base_dn text,
      group_filter text NOT NULL,
      attribute_map jsonb NOT NULL DEFAULT '{}',
      mode text NOT NULL DEFAULT 'read_only' CHECK (mode IN ('read_only', 'read_write')),
      position integer NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      sync_interval_minutes integer NOT NULL DEFAULT 60
        CHECK (sync_interval_minutes BETWEEN 5 AND 1440),
      full_sync_hours integer NOT NULL DEFAULT 24 CHECK (full_sync_hours BETWEEN 1 AND 720),
      next_sync_at timestamptz,
      last_full_sync_at timestamptz,
      sync_cursor jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX ldap_directory_workspace_name_idx ON ldap_directory (workspace_id, lower(name))`.execute(
    db,
  );
  await sql`CREATE INDEX ldap_directory_next_sync_idx ON ldap_directory (next_sync_at) WHERE enabled`.execute(
    db,
  );

  await sql`
    CREATE TABLE ldap_user (
      user_id integer PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      directory_id integer NOT NULL REFERENCES ldap_directory (id) ON DELETE CASCADE,
      external_id text NOT NULL,
      dn text NOT NULL,
      username text NOT NULL,
      disabled boolean NOT NULL DEFAULT false,
      deactivated_by_sync boolean NOT NULL DEFAULT false,
      removed_at timestamptz,
      synced_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (directory_id, external_id)
    )`.execute(db);
  await sql`CREATE INDEX ldap_user_directory_dn_idx ON ldap_user (directory_id, lower(dn))`.execute(
    db,
  );

  await sql`
    CREATE TABLE ldap_group (
      group_id integer PRIMARY KEY REFERENCES user_group (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      directory_id integer NOT NULL REFERENCES ldap_directory (id) ON DELETE CASCADE,
      external_id text NOT NULL,
      dn text NOT NULL,
      synced_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (directory_id, external_id)
    )`.execute(db);
  await sql`CREATE INDEX ldap_group_directory_dn_idx ON ldap_group (directory_id, lower(dn))`.execute(
    db,
  );

  await sql`
    CREATE TABLE ldap_sync_run (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      directory_id integer NOT NULL REFERENCES ldap_directory (id) ON DELETE CASCADE,
      mode text NOT NULL CHECK (mode IN ('full', 'incremental')),
      trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
      requested_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      confirm_removals boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
      worker text,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      heartbeat_at timestamptz,
      finished_at timestamptz,
      stats jsonb NOT NULL DEFAULT '{}',
      warnings jsonb NOT NULL DEFAULT '[]',
      error text
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX ldap_sync_run_running_idx ON ldap_sync_run (directory_id) WHERE status = 'running'`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX ldap_sync_run_queued_idx ON ldap_sync_run (directory_id) WHERE status = 'queued'`.execute(
    db,
  );
  await sql`CREATE INDEX ldap_sync_run_directory_idx ON ldap_sync_run (directory_id, id DESC)`.execute(
    db,
  );

  await sql`
    CREATE FUNCTION authz_epoch_bump_statement() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO authz_epoch (workspace_id, epoch)
      SELECT DISTINCT workspace_id, 1 FROM changed
      ON CONFLICT (workspace_id) DO UPDATE SET epoch = authz_epoch.epoch + 1;
      RETURN NULL;
    END $$`.execute(db);
  for (const table of ['group_member', 'group_nesting', 'user_group']) {
    await sql`DROP TRIGGER ${sql.raw(`${table}_authz_epoch`)} ON ${sql.table(table)}`.execute(db);
    // A trigger with a transition table serves one kind of statement.
    for (const [event, rows] of [
      ['INSERT', 'NEW'],
      ['UPDATE', 'NEW'],
      ['DELETE', 'OLD'],
    ] as const) {
      await sql`
        CREATE TRIGGER ${sql.raw(`${table}_authz_epoch_${event.toLowerCase()}`)}
        AFTER ${sql.raw(event)} ON ${sql.table(table)}
        REFERENCING ${sql.raw(rows)} TABLE AS changed
        FOR EACH STATEMENT EXECUTE FUNCTION authz_epoch_bump_statement()`.execute(db);
    }
  }
}
