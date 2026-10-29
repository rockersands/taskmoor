import { type Kysely, sql } from 'kysely';

/**
 * The in-app inbox and mentions (M1-058; NTF-003, NTF-005; ADR-047).
 *
 * - `notification.snoozed_until`: an inbox item put aside until then; it comes back unread at
 *   that time, at the top. The inbox lists items newest first by
 *   `coalesce(snoozed_until, created_at)`, which `notification_inbox_idx` serves.
 * - `notification.direct`: a direct ask (a mention of the person, or the ticket assigned to
 *   them), shown on the inbox's Priority tab.
 * - `inbox_state`: one row per person whose inbox changed, with a counter bumped in the same
 *   transaction as every change to their inbox items (new, read, unread, snoozed). The realtime
 *   socket reads it to tell open inboxes to refresh, without reading the items themselves.
 *
 * The new columns have constant defaults or none, so adding them does not rewrite the table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE notification
      ADD COLUMN snoozed_until timestamptz,
      ADD COLUMN direct boolean NOT NULL DEFAULT false`.execute(db);
  await sql`
    CREATE INDEX notification_inbox_idx
      ON notification (user_id, (coalesce(snoozed_until, created_at)) DESC, id DESC)
      WHERE channel = 'inbox'`.execute(db);
  await sql`
    CREATE INDEX notification_inbox_unread_idx ON notification (user_id)
      WHERE channel = 'inbox' AND read_at IS NULL`.execute(db);
  await sql`
    CREATE TABLE inbox_state (
      user_id integer PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      version bigint NOT NULL DEFAULT 0,
      changed_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
}
