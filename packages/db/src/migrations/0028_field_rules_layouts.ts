import { type Kysely, sql } from 'kysely';

/**
 * Field rule sets and layout sets (M1-012; CORE-008, CORE-013; spec 01a section 1.5).
 *
 * - `field_rule_set` and `field_rule`: per ticket type (null: every type) and field, whether
 *   it is required or hidden and its help text. Fields are named as the query language names
 *   them (`dueDate`, `cf[12]`). A rule for the ticket's type wins over the set's rule for every
 *   type; a field without a rule is optional and shown.
 * - `layout_set` and `layout`: per ticket type (null: every type) and operation (create, edit,
 *   view), the tabs and sections a form shows and in what order (`definition`, checked by
 *   `apps/server/src/fields/layouts.ts`). Transition layouts stay with their transitions.
 * - Each workspace has one default set of each; `track.field_rule_set_id` and
 *   `track.layout_set_id` choose another (null: the default). A local-mode track's own sets name
 *   it in `track_id` and leave with it.
 * - Changes move `field_epoch`, so the servers' cached field catalogues reload.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const kind of ['field_rule_set', 'layout_set'] as const) {
    const table = sql.table(kind);
    await sql`
      CREATE TABLE ${table} (
        id serial PRIMARY KEY,
        workspace_id integer NOT NULL REFERENCES workspace (id),
        track_id integer REFERENCES track (id) ON DELETE CASCADE,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        is_default boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (NOT is_default OR track_id IS NULL)
      )`.execute(db);
    await sql`
      CREATE UNIQUE INDEX ${sql.raw(`${kind}_name_idx`)}
        ON ${table} (workspace_id, coalesce(track_id, 0), lower(name))`.execute(db);
    await sql`
      CREATE UNIQUE INDEX ${sql.raw(`${kind}_default_idx`)} ON ${table} (workspace_id)
        WHERE is_default`.execute(db);
  }

  await sql`
    CREATE TABLE field_rule (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      rule_set_id integer NOT NULL REFERENCES field_rule_set (id) ON DELETE CASCADE,
      ticket_type_id integer REFERENCES ticket_type (id) ON DELETE CASCADE,
      field text NOT NULL,
      required boolean NOT NULL DEFAULT false,
      hidden boolean NOT NULL DEFAULT false,
      description text,
      CHECK (NOT (required AND hidden))
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX field_rule_idx
      ON field_rule (rule_set_id, coalesce(ticket_type_id, 0), field)`.execute(db);

  await sql`
    CREATE TABLE layout (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      layout_set_id integer NOT NULL REFERENCES layout_set (id) ON DELETE CASCADE,
      ticket_type_id integer REFERENCES ticket_type (id) ON DELETE CASCADE,
      operation text NOT NULL CHECK (operation IN ('create', 'edit', 'view')),
      definition jsonb NOT NULL
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX layout_idx
      ON layout (layout_set_id, coalesce(ticket_type_id, 0), operation)`.execute(db);

  await sql`
    ALTER TABLE track
      ADD COLUMN field_rule_set_id integer REFERENCES field_rule_set (id),
      ADD COLUMN layout_set_id integer REFERENCES layout_set (id)`.execute(db);
  await sql`CREATE INDEX track_field_rule_set_idx ON track (field_rule_set_id)`.execute(db);
  await sql`CREATE INDEX track_layout_set_idx ON track (layout_set_id)`.execute(db);

  await sql`
    INSERT INTO field_rule_set (workspace_id, name, description, is_default)
    SELECT id, 'Default field rules', 'Every field optional and shown, the summary required.', true
      FROM workspace`.execute(db);
  await sql`
    INSERT INTO layout_set (workspace_id, name, description, is_default)
    SELECT id, 'Default layouts', 'Every field that applies, in one tab.', true
      FROM workspace`.execute(db);

  for (const table of ['field_rule_set', 'field_rule', 'layout_set', 'layout']) {
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
