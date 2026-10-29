import { type Kysely, sql } from 'kysely';

/**
 * Indexes for running queries (M1-037; QRY-008, QRY-009; ADR-010 "Implementation (M1-037)").
 *
 * The compiler orders every result by the fields asked for and then by the ticket id, in the
 * direction of the last field, and searches only tickets outside the trash. These indexes let
 * the common pages walk an index in that order and stop after one page:
 *
 * - newest first and oldest first, site-wide and within a track (`created DESC`, the default);
 * - recently updated (`updated DESC` and `updated < -90d ... ORDER BY updated ASC`), site-wide
 *   and within a track;
 * - by priority, newest or oldest first: the compiler merges one branch per priority for
 *   `ORDER BY priority` ("value branches"), and each branch walks this index. It replaces the
 *   plain priority index (0018), whose lookups it serves too.
 * - closed recently and due soon, which only tickets with a value need;
 * - the requester (`requester = currentUser()`; the assignee has its index since M1-008);
 * - the words of the summary, of the text in description and environment documents and of
 *   comment bodies, for `~` on those fields and `text ~` (`simple` configuration: words as
 *   written, case-folded, no stemming; full-text search proper is M1-040). The expressions are
 *   the compiler's own (`search/compile.ts`), so the planner matches them.
 *
 * Built inside the upgrade's transaction: no release holds enough tickets for that to matter.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX ticket_created_idx ON ticket (created_at DESC, id DESC)
      WHERE deleted_at IS NULL`.execute(db);
  await sql`
    CREATE INDEX ticket_track_created_idx ON ticket (track_id, created_at DESC, id DESC)
      WHERE deleted_at IS NULL`.execute(db);
  await sql`
    CREATE INDEX ticket_updated_idx ON ticket (updated_at DESC, id DESC)
      WHERE deleted_at IS NULL`.execute(db);
  await sql`
    CREATE INDEX ticket_track_updated_idx ON ticket (track_id, updated_at DESC, id DESC)
      WHERE deleted_at IS NULL`.execute(db);
  await sql`
    CREATE INDEX ticket_priority_created_idx ON ticket (priority_id, created_at DESC, id DESC)
      WHERE priority_id IS NOT NULL`.execute(db);
  await sql`DROP INDEX ticket_priority_idx`.execute(db);
  await sql`
    CREATE INDEX ticket_closed_idx ON ticket (closed_at DESC, id DESC)
      WHERE closed_at IS NOT NULL AND deleted_at IS NULL`.execute(db);
  await sql`
    CREATE INDEX ticket_due_idx ON ticket (due_date, id)
      WHERE due_date IS NOT NULL AND deleted_at IS NULL`.execute(db);
  await sql`
    CREATE INDEX ticket_requester_idx ON ticket (requester_id)
      WHERE requester_id IS NOT NULL`.execute(db);
  await sql`
    CREATE INDEX ticket_summary_words_idx ON ticket
      USING gin (to_tsvector('simple'::regconfig, summary))`.execute(db);
  for (const column of ['description', 'environment']) {
    await sql`
      CREATE INDEX ${sql.raw(`ticket_${column}_words_idx`)} ON ticket USING gin (
        to_tsvector('simple'::regconfig,
          jsonb_path_query_array(${sql.raw(column)}, 'strict $.**.text', '{}', true)))
      WHERE ${sql.raw(column)} IS NOT NULL`.execute(db);
  }
  await sql`
    CREATE INDEX ticket_comment_words_idx ON ticket_comment USING gin (
      to_tsvector('simple'::regconfig, jsonb_path_query_array(body, 'strict $.**.text', '{}', true)))
    WHERE deleted_at IS NULL`.execute(db);
}
