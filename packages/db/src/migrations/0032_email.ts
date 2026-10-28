import { type Kysely, sql } from 'kysely';

/**
 * Email notifications (M1-057; NTF-002, NTF-004).
 *
 * - `email_setting`: per workspace, how long changes to one ticket gather into one email
 *   (default two minutes) and the local hour digests go out (default 08:00).
 * - `user_preference`: whether a person gets email at once, as a daily or weekly digest, or not
 *   at all, and their quiet hours (local hours; email waits until they end).
 * - `email_delivery`: one row per email sent or failed, with the notifications it carried
 *   (`notification.email_delivery_id`).
 * - `email_unsubscribe`: the one-click unsubscribe links in emails, stored as a hash of a
 *   random token: unsubscribing from one event, or from all email.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE email_setting (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      batch_window_seconds integer NOT NULL DEFAULT 120
        CHECK (batch_window_seconds BETWEEN 0 AND 3600),
      digest_hour smallint NOT NULL DEFAULT 8 CHECK (digest_hour BETWEEN 0 AND 23),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`INSERT INTO email_setting (workspace_id) SELECT id FROM workspace`.execute(db);

  await sql`
    ALTER TABLE user_preference
      ADD COLUMN email_delivery text NOT NULL DEFAULT 'instant'
        CHECK (email_delivery IN ('instant', 'daily', 'weekly', 'off')),
      ADD COLUMN quiet_start smallint CHECK (quiet_start BETWEEN 0 AND 23),
      ADD COLUMN quiet_end smallint CHECK (quiet_end BETWEEN 0 AND 23),
      ADD CONSTRAINT user_preference_quiet_check
        CHECK ((quiet_start IS NULL) = (quiet_end IS NULL))`.execute(db);

  await sql`
    CREATE TABLE email_delivery (
      id bigserial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('instant', 'daily', 'weekly')),
      ticket_id integer REFERENCES ticket (id) ON DELETE SET NULL,
      notification_count integer NOT NULL CHECK (notification_count > 0),
      subject text NOT NULL,
      message_id text,
      error text,
      sent_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX email_delivery_user_idx ON email_delivery (user_id, sent_at DESC)`.execute(
    db,
  );
  await sql`
    ALTER TABLE notification
      ADD COLUMN email_delivery_id bigint REFERENCES email_delivery (id) ON DELETE SET NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE email_unsubscribe (
      token_hash bytea PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      event text,
      created_at timestamptz NOT NULL DEFAULT now(),
      used_at timestamptz
    )`.execute(db);
  await sql`CREATE INDEX email_unsubscribe_created_idx ON email_unsubscribe (created_at)`.execute(
    db,
  );
}
