import { type Kysely, sql } from 'kysely';

/**
 * Entity properties (M1-129; API-013; ADR-083): JSON documents that integrations keep on a
 * ticket, track, person, board or sprint under a key of their choosing, and declared property
 * indexes that make one value inside a ticket's property searchable.
 *
 * - One table per kind of entity, so a property goes when its entity is deleted (a purged
 *   ticket, a deleted board) without a sweep. A key is 1 to 255 characters; the value is any
 *   JSON document, at most 32,768 bytes as JSON text (the application checks its size, which
 *   `jsonb` would measure differently).
 * - `property_index` declares a value to index: a ticket property's key, a dot path inside its
 *   document ('' for the whole value) and a type (number, string, text, date, user). Queries
 *   name it as `ticket.property[key].path` (Jira dialect: `issue.property[key].path`) or by its
 *   alias.
 * - The indexed values live in typed side tables shaped like the custom field ones (0027), so
 *   the search compiler reads them the same way: `p_text` (strings and text, one row per array
 *   element), `p_number`, `p_time` (dates as instants) and `p_user`. `field_id` is the index's
 *   id. Rows copy the ticket's track and creation time and exist for tickets outside the trash
 *   only, kept in step with the property in the same transaction.
 */
const KINDS = ['ticket', 'track', 'user', 'board', 'sprint'] as const;
const OWNER: Record<(typeof KINDS)[number], string> = {
  ticket: 'ticket',
  track: 'track',
  user: 'app_user',
  board: 'board',
  sprint: 'sprint',
};
const VALUES = [
  { name: 'p_text', type: 'text' },
  { name: 'p_number', type: 'numeric' },
  { name: 'p_time', type: 'timestamptz' },
  { name: 'p_user', type: 'integer' },
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const kind of KINDS) {
    const table = sql.table(`${kind}_property`);
    const owner = sql.ref(`${kind}_id`);
    await sql`
      CREATE TABLE ${table} (
        workspace_id integer NOT NULL REFERENCES workspace (id),
        ${owner} integer NOT NULL REFERENCES ${sql.table(OWNER[kind])} (id) ON DELETE CASCADE,
        key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
        value jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by integer REFERENCES app_user (id) ON DELETE SET NULL,
        PRIMARY KEY (${owner}, key)
      )`.execute(db);
    await sql`
      CREATE INDEX ${sql.raw(`${kind}_property_key_idx`)} ON ${table} (workspace_id, key)`.execute(
      db,
    );
  }
  await sql`
    CREATE TABLE property_index (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
      path text NOT NULL DEFAULT '' CHECK (char_length(path) <= 255),
      type text NOT NULL CHECK (type IN ('number', 'string', 'text', 'date', 'user')),
      alias text CHECK (alias IS NULL OR char_length(alias) BETWEEN 1 AND 255),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      UNIQUE (workspace_id, key, path)
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX property_index_alias_idx ON property_index (workspace_id, lower(alias))
      WHERE alias IS NOT NULL`.execute(db);
  for (const t of VALUES) {
    const table = sql.table(t.name);
    const index = (suffix: string) => sql.raw(`${t.name}_${suffix}`);
    await sql`
      CREATE TABLE ${table} (
        workspace_id integer NOT NULL REFERENCES workspace (id),
        ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
        track_id integer NOT NULL,
        field_id integer NOT NULL REFERENCES property_index (id) ON DELETE CASCADE,
        value ${sql.raw(t.type)} NOT NULL,
        ${t.name === 'p_text' ? sql`sort_key text COLLATE "C" NOT NULL,` : sql``}
        created_at timestamptz NOT NULL,
        PRIMARY KEY (ticket_id, field_id, value)
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
  }
  await sql`CREATE INDEX p_text_field_sort_idx ON p_text (field_id, sort_key, ticket_id)`.execute(
    db,
  );
  await sql`
    CREATE INDEX p_text_words_idx ON p_text
      USING gin (to_tsvector('taskmoor_search'::regconfig, value))`.execute(db);
}
