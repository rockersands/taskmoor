import { type Kysely, sql } from 'kysely';

/**
 * Custom field values for filtering, sorting and counting (M1-011; ADR-008, ADR-010): one typed
 * side table per kind of value, kept in step with `ticket.fields` by the application in the
 * same transaction (`apps/server/src/fields/storage.ts`).
 *
 * - `v_text` (short text, read-only text, URLs, labels one row each, the first 255 characters of
 *   a paragraph's text), `v_number`, `v_date` (dates), `v_time` (date-times), `v_user` (people)
 *   and `v_option` (options, groups, releases and areas; a cascade is two rows).
 * - Every row copies its ticket's track and creation time, which never change together with a
 *   value, so a track-scoped, newest-first page is served by one side index without touching
 *   the ticket table (ADR-008). Rows exist for tickets outside the trash only.
 * - `v_text.sort_key` is the case-folded text the application orders by (ADR-009, M1-010), in
 *   the C collation, so the database orders text as the application does.
 * - Indexes follow the spike: by field and value newest first, the same within a track, and by
 *   field newest first for ranges. Extended statistics on (field, value) and a statistics
 *   target of 5,000 keep the planner's estimates per field (ADR-008).
 * - No release holds custom values before this one, so nothing is copied here; a development
 *   database that has some fills its rows with `node cli.mjs field-values --repair`.
 */
const TABLES = [
  { name: 'v_text', type: 'text', multiple: true },
  { name: 'v_number', type: 'numeric', multiple: false },
  { name: 'v_date', type: 'date', multiple: false },
  { name: 'v_time', type: 'timestamptz', multiple: false },
  { name: 'v_user', type: 'integer', multiple: true },
  { name: 'v_option', type: 'integer', multiple: true },
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const t of TABLES) {
    const table = sql.table(t.name);
    const index = (suffix: string) => sql.raw(`${t.name}_${suffix}`);
    await sql`
      CREATE TABLE ${table} (
        workspace_id integer NOT NULL REFERENCES workspace (id),
        ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
        track_id integer NOT NULL,
        field_id integer NOT NULL REFERENCES field (id) ON DELETE CASCADE,
        value ${sql.raw(t.type)} NOT NULL,
        ${t.name === 'v_text' ? sql`sort_key text COLLATE "C" NOT NULL,` : sql``}
        created_at timestamptz NOT NULL,
        PRIMARY KEY (ticket_id, field_id${t.multiple ? sql`, value` : sql``})
      )`.execute(db);
    await sql`
      CREATE INDEX ${index('field_value_idx')} ON ${table} (field_id, value, created_at DESC)
        INCLUDE (ticket_id)`.execute(db);
    await sql`
      CREATE INDEX ${index('track_field_value_idx')}
        ON ${table} (track_id, field_id, value, created_at DESC) INCLUDE (ticket_id)`.execute(db);
    await sql`
      CREATE INDEX ${index('field_created_idx')} ON ${table} (field_id, created_at DESC)
        INCLUDE (value, ticket_id)`.execute(db);
    if (t.name === 'v_text') {
      await sql`
        CREATE INDEX v_text_field_sort_idx ON v_text (field_id, sort_key, ticket_id)`.execute(db);
    }
    await sql`
      CREATE STATISTICS ${index('field_value_stats')} (dependencies, ndistinct, mcv)
        ON field_id, value FROM ${table}`.execute(db);
    await sql`ALTER TABLE ${table} ALTER COLUMN field_id SET STATISTICS 5000`.execute(db);
    await sql`ALTER TABLE ${table} ALTER COLUMN value SET STATISTICS 5000`.execute(db);
  }
}
