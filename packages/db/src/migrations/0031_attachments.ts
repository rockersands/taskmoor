import { type Kysely, sql } from 'kysely';

/**
 * Attachments (M1-016; CORE-021, CORE-022, CORE-025 (3); ADR-040).
 *
 * - `attachment_setting`: the workspace's maximum file size in bytes (1 GiB by default, no
 *   upper bound; there is no storage quota).
 * - `attachment`: a file on a ticket. `name` is the file name as given, cleaned for display and
 *   nothing else; the bytes live in a store (`storage`: local disk or an S3-compatible bucket)
 *   under `storage_key`, a random key never derived from the name. The type the uploader
 *   declared and the type the first bytes show are both kept; size and SHA-256 are measured
 *   while the file streams in. `scan_state` is the antivirus verdict (only `clean` files are
 *   served); `thumbnail_state` and `thumbnail_key` the preview of an image. Attachments leave
 *   with their ticket (the trash purge), never before.
 * - `storage_cleanup`: stored objects to delete. A trigger adds the keys of every attachment
 *   row that goes, whatever deletes it (a person, the purge of a ticket or a track), in that
 *   transaction; the cleanup removes the objects after commit and then the rows, so deleting
 *   twice is harmless and nothing is lost when a store is briefly down. Uploads register their
 *   key here before writing (`reason` 'upload', due a day later) and take it out in the
 *   transaction that creates the attachment, so a process that dies mid-upload leaves nothing
 *   behind for long.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE attachment_setting (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      max_file_size bigint NOT NULL DEFAULT 1073741824 CHECK (max_file_size >= 1),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`INSERT INTO attachment_setting (workspace_id) SELECT id FROM workspace`.execute(db);

  await sql`
    CREATE TABLE attachment (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
      declared_type text NOT NULL CHECK (char_length(declared_type) BETWEEN 1 AND 255),
      sniffed_type text CHECK (char_length(sniffed_type) BETWEEN 1 AND 255),
      size bigint NOT NULL CHECK (size >= 0),
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      storage text NOT NULL CHECK (storage IN ('local', 's3')),
      storage_key text NOT NULL,
      scan_state text NOT NULL DEFAULT 'pending'
        CHECK (scan_state IN ('pending', 'clean', 'infected', 'failed')),
      scan_detail text CHECK (char_length(scan_detail) <= 500),
      scanned_at timestamptz,
      thumbnail_state text NOT NULL DEFAULT 'none'
        CHECK (thumbnail_state IN ('none', 'pending', 'ready', 'failed')),
      thumbnail_key text,
      width integer CHECK (width > 0),
      height integer CHECK (height > 0),
      author_id integer REFERENCES app_user (id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT attachment_thumbnail_check
        CHECK ((thumbnail_state = 'ready') = (thumbnail_key IS NOT NULL)),
      CONSTRAINT attachment_scanned_check
        CHECK ((scan_state = 'pending') = (scanned_at IS NULL))
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX attachment_storage_key_idx ON attachment (storage, storage_key)`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX attachment_thumbnail_key_idx ON attachment (storage, thumbnail_key)`.execute(
    db,
  );
  await sql`CREATE INDEX attachment_ticket_idx ON attachment (ticket_id, id)`.execute(db);
  await sql`CREATE INDEX attachment_pending_idx ON attachment (id) WHERE scan_state = 'pending' OR thumbnail_state = 'pending'`.execute(
    db,
  );

  await sql`
    CREATE TABLE storage_cleanup (
      id bigserial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      storage text NOT NULL CHECK (storage IN ('local', 's3')),
      storage_key text NOT NULL,
      reason text NOT NULL CHECK (reason IN ('upload', 'deleted')),
      not_before timestamptz NOT NULL DEFAULT now(),
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT storage_cleanup_key_unique UNIQUE (storage, storage_key)
    )`.execute(db);
  await sql`CREATE INDEX storage_cleanup_due_idx ON storage_cleanup (not_before)`.execute(db);

  // One statement-level trigger, so the purge of a track with thousands of attachments adds its
  // keys in one insert per cascading delete.
  await sql`
    CREATE FUNCTION attachment_storage_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO storage_cleanup (workspace_id, storage, storage_key, reason)
      SELECT workspace_id, storage, storage_key, 'deleted' FROM gone
      UNION ALL
      SELECT workspace_id, storage, thumbnail_key, 'deleted' FROM gone
       WHERE thumbnail_key IS NOT NULL
      ON CONFLICT (storage, storage_key)
        DO UPDATE SET reason = 'deleted', not_before = least(storage_cleanup.not_before, now());
      RETURN NULL;
    END $$`.execute(db);
  await sql`
    CREATE TRIGGER attachment_storage_cleanup
    AFTER DELETE ON attachment
    REFERENCING OLD TABLE AS gone
    FOR EACH STATEMENT EXECUTE FUNCTION attachment_storage_cleanup()`.execute(db);
}
