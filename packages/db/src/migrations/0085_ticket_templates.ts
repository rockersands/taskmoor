import { type Kysely, sql } from 'kysely';

/**
 * Ticket templates (CORE-029, CORE-030; ADR-113): named starting points for new tickets.
 *
 * - `track_id` null is a template for every track; otherwise it belongs to that track and goes
 *   with it.
 * - `ticket_type_ids` limits it to some ticket types; empty is every type.
 * - `purpose` says what it is for. `summary` is a pattern (`{date}`, `{track}`, `{user}`); `description` the description outline, a
 *   document as tickets store theirs; `defaults` the values it gives (priority, labels,
 *   assignee, areas, releases, due and start date offsets in days, custom fields by id);
 *   `subtickets` the subtickets made with it, each a summary and an optional type.
 * - The name is unique in its track, or among the templates for every track, ignoring case.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE ticket_template (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id integer NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
    track_id integer REFERENCES track (id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
    purpose text NOT NULL DEFAULT '' CHECK (char_length(purpose) <= 2000),
    ticket_type_ids integer[] NOT NULL DEFAULT '{}',
    summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 255),
    description jsonb,
    defaults jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(defaults) = 'object'),
    subtickets jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(subtickets) = 'array'),
    created_by integer REFERENCES app_user (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX ticket_template_name_idx
    ON ticket_template (workspace_id, track_id, lower(name)) NULLS NOT DISTINCT`.execute(db);
  await sql`CREATE INDEX ticket_template_track_idx ON ticket_template (track_id)`.execute(db);
}
