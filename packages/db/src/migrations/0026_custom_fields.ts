import { type Kysely, sql } from 'kysely';

/**
 * Custom fields with contexts and options (M1-010; CORE-003, CORE-009, CORE-010; spec 01a
 * sections 1.4 and 1.5; ADR-008).
 *
 * - `field`: a custom field's name, type (fixed at creation, as is `multiple`) and type
 *   settings. Shared fields belong to the workspace; a local-mode track's own fields name it in
 *   `track_id` and leave with it.
 * - `field_context`: where a field applies and what it offers there: its default value and
 *   settings such as the group a user picker chooses from (CORE-009).
 * - `field_context_scope`: the tracks and ticket types a context covers, one row per pair (a
 *   null track is every track, a null type every type). A field has at most one context per
 *   pair, so the context of a ticket is the most specific row that matches it: its track and
 *   type, its track, its type, then the field's global context. Rows leave with their track or
 *   type; a context with none left applies nowhere.
 * - `field_option`: a context's options in order, cascading children under their parent.
 *   Renaming, reordering or disabling keeps the id tickets store (CORE-009 (3)).
 * - `field_label`: each labels field's own vocabulary, for autocomplete.
 * - `ticket.fields`: the values, keyed by field id, in the forms of `fields/types.ts`.
 * - `field_epoch`: moves on every change to the four tables above, so the servers' cached
 *   copies of the field catalogue know when to reload.
 */
const TYPES = [
  'text',
  'paragraph',
  'number',
  'date',
  'datetime',
  'select',
  'cascading-select',
  'user',
  'group',
  'labels',
  'url',
  'read-only-text',
  'release',
  'area',
];
const MULTIPLE = ['select', 'user', 'group', 'release', 'area'];

export async function up(db: Kysely<unknown>): Promise<void> {
  const list = (values: string[]) => sql.join(values.map((v) => sql.lit(v)));
  await sql`
    CREATE TABLE field (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      track_id integer REFERENCES track (id) ON DELETE CASCADE,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      type text NOT NULL CHECK (type IN (${list(TYPES)})),
      multiple boolean NOT NULL DEFAULT false,
      config jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (NOT multiple OR type IN (${list(MULTIPLE)}))
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX field_name_idx ON field (workspace_id, coalesce(track_id, 0), lower(name))`.execute(
    db,
  );
  await sql`CREATE INDEX field_track_idx ON field (track_id) WHERE track_id IS NOT NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE field_context (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      field_id integer NOT NULL REFERENCES field (id) ON DELETE CASCADE,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      default_value jsonb,
      config jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX field_context_name_idx ON field_context (field_id, lower(name))`.execute(
    db,
  );

  await sql`
    CREATE TABLE field_context_scope (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      field_id integer NOT NULL REFERENCES field (id) ON DELETE CASCADE,
      context_id integer NOT NULL REFERENCES field_context (id) ON DELETE CASCADE,
      track_id integer REFERENCES track (id) ON DELETE CASCADE,
      ticket_type_id integer REFERENCES ticket_type (id) ON DELETE CASCADE
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX field_context_scope_idx
      ON field_context_scope (field_id, coalesce(track_id, 0), coalesce(ticket_type_id, 0))`.execute(
    db,
  );
  await sql`CREATE INDEX field_context_scope_context_idx ON field_context_scope (context_id)`.execute(
    db,
  );
  await sql`CREATE INDEX field_context_scope_track_idx ON field_context_scope (track_id)`.execute(
    db,
  );
  await sql`CREATE INDEX field_context_scope_type_idx ON field_context_scope (ticket_type_id)`.execute(
    db,
  );

  await sql`
    CREATE TABLE field_option (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      field_id integer NOT NULL REFERENCES field (id) ON DELETE CASCADE,
      context_id integer NOT NULL REFERENCES field_context (id) ON DELETE CASCADE,
      parent_id integer REFERENCES field_option (id) ON DELETE CASCADE,
      value text NOT NULL,
      sort_order integer NOT NULL,
      disabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX field_option_value_idx
      ON field_option (context_id, coalesce(parent_id, 0), lower(value))`.execute(db);
  await sql`CREATE INDEX field_option_field_idx ON field_option (field_id)`.execute(db);
  await sql`CREATE INDEX field_option_parent_idx ON field_option (parent_id) WHERE parent_id IS NOT NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE field_label (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      field_id integer NOT NULL REFERENCES field (id) ON DELETE CASCADE,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (field_id, name)
    )`.execute(db);

  await sql`ALTER TABLE ticket ADD COLUMN fields jsonb NOT NULL DEFAULT '{}'`.execute(db);

  await sql`
    CREATE TABLE field_epoch (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      epoch bigint NOT NULL DEFAULT 1
    )`.execute(db);
  await sql`INSERT INTO field_epoch (workspace_id) SELECT id FROM workspace`.execute(db);
  // Statement triggers with the changed rows, so a context saved with 20,000 options moves the
  // epoch once, not once per option.
  await sql`
    CREATE FUNCTION field_epoch_bump() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO field_epoch (workspace_id, epoch)
      SELECT DISTINCT workspace_id, 1 FROM changed
      ON CONFLICT (workspace_id) DO UPDATE SET epoch = field_epoch.epoch + 1;
      RETURN NULL;
    END $$`.execute(db);
  for (const table of ['field', 'field_context', 'field_context_scope', 'field_option']) {
    for (const [event, rows] of [
      ['INSERT', 'NEW'],
      ['UPDATE', 'NEW'],
      ['DELETE', 'OLD'],
    ] as const) {
      await sql`
        CREATE TRIGGER ${sql.raw(`${table}_epoch_${event.toLowerCase()}`)}
        AFTER ${sql.raw(event)} ON ${sql.table(table)}
        REFERENCING ${sql.raw(rows)} TABLE AS changed
        FOR EACH STATEMENT EXECUTE FUNCTION field_epoch_bump()`.execute(db);
    }
  }
}
