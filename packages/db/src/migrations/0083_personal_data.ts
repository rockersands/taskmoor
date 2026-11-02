import { type Kysely, sql } from 'kysely';

/**
 * A person's own data (ASVS 8.3.2, IAM-008 (2); ADR-111):
 *
 * - `app_user.erased_at`: when a site administrator erased the person. The row stays, so every
 *   reference to it (tickets, comments, history, the audit log) keeps pointing somewhere; its
 *   name and email are then a placeholder and everything personal about it is gone.
 * - `personal_export`: a download of one person's data, made by a background job into the
 *   attachment store as a ZIP and kept for a week. `user_id` is whose data it is,
 *   `requested_by` who asked (the person, or a site administrator).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE app_user ADD COLUMN erased_at timestamptz`.execute(db);
  await sql`CREATE TABLE personal_export (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id integer NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    requested_by integer REFERENCES app_user (id) ON DELETE SET NULL,
    state text NOT NULL DEFAULT 'queued'
      CHECK (state IN ('queued', 'running', 'ready', 'failed', 'expired')),
    storage text CHECK (storage IN ('local', 's3')),
    storage_key text,
    size bigint,
    sha256 text,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    expires_at timestamptz,
    CHECK ((state = 'ready') = (storage_key IS NOT NULL))
  )`.execute(db);
  await sql`CREATE INDEX personal_export_user_idx
    ON personal_export (workspace_id, user_id, created_at DESC)`.execute(db);
  await sql`CREATE INDEX personal_export_expiry_idx
    ON personal_export (expires_at) WHERE state = 'ready'`.execute(db);
}
