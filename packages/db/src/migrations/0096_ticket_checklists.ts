import { type Kysely, sql } from 'kysely';

/**
 * Checklists on tickets (CORE-033; ADR-120): named lists separate from the description, each with
 * items of plain text in one of four states. They leave with their ticket when the trash purge
 * removes it. An item's position runs within its list; the routes rewrite them on a reorder.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE ticket_checklist (
    id serial PRIMARY KEY,
    workspace_id integer NOT NULL REFERENCES workspace (id),
    ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    position integer NOT NULL,
    created_by integer REFERENCES app_user (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX ticket_checklist_ticket_idx ON ticket_checklist (ticket_id, position)`.execute(
    db,
  );
  await sql`CREATE TABLE ticket_checklist_item (
    id serial PRIMARY KEY,
    workspace_id integer NOT NULL REFERENCES workspace (id),
    checklist_id integer NOT NULL REFERENCES ticket_checklist (id) ON DELETE CASCADE,
    text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000),
    state text NOT NULL DEFAULT 'open'
      CHECK (state IN ('open', 'in_progress', 'done', 'rejected')),
    position integer NOT NULL,
    created_by integer REFERENCES app_user (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX ticket_checklist_item_list_idx ON ticket_checklist_item (checklist_id, position)`.execute(
    db,
  );
  // Whose items a person's data export lists, and the foreign key's lookup when a person goes.
  await sql`CREATE INDEX ticket_checklist_item_creator_idx ON ticket_checklist_item (created_by)
    WHERE created_by IS NOT NULL`.execute(db);
}
