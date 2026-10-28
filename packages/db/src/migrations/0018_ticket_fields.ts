import { type Kysely, sql } from 'kysely';

/**
 * Priorities, close reasons, labels, releases and areas (M1-014; CORE-014 to CORE-017; spec 01a
 * sections 1.3 and 1.6; ADR-009 implementation note).
 *
 * - `priority`: the workspace's ordered list (gapless `sort_order` under a deferred unique
 *   constraint), shipped with Urgent, High, Normal and Low. `priority_set` and
 *   `priority_set_member` choose which a track offers, with a default (CORE-014 (2)); every
 *   workspace gets a default set with all four, and `track.priority_set_id` null means it.
 * - `close_reason`: the ordered list of reasons a ticket is closed for (Completed, Not planned,
 *   Duplicate, Not reproducible). Workflows set it (M1-027); people with "Set close reason" too.
 * - Labels are a `text[]` on the ticket (GIN-indexed for "has label"), with the `label` table as
 *   the workspace's vocabulary for autocomplete (CORE-017), filled as tickets use labels.
 * - `release`: per track, with dates, a manual order, shipped and archived state and optional
 *   approvals (`release_approver`). Tickets point at releases through `ticket_release` with a
 *   role: `target` (Target releases) or `found` (Found in releases).
 * - `area`: per track, with an owner and the rule for a new ticket's assignee (area owner,
 *   track owner or nobody); tickets list theirs in `ticket_area`.
 * - `ticket.priority_id` and `ticket.close_reason_id`; `ticket.closed_at` is set by workflows
 *   (M1-023) when a ticket reaches a closed stage, and marks which tickets a release ships open.
 */
const PRIORITIES = [
  ['Urgent', 'Needs attention now', 'priority-urgent', '#d9534f'],
  ['High', 'Comes before normal work', 'priority-high', '#e0803a'],
  ['Normal', 'Everyday work', 'priority-normal', '#5b8def'],
  ['Low', 'Can wait', 'priority-low', '#8a9bb0'],
] as const;

const CLOSE_REASONS = [
  ['Completed', 'The work is done'],
  ['Not planned', 'The work will not be done'],
  ['Duplicate', 'Another ticket covers it'],
  ['Not reproducible', 'The problem could not be seen again'],
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE priority (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      icon text,
      color text,
      sort_order integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT priority_order_key UNIQUE (workspace_id, sort_order) DEFERRABLE INITIALLY DEFERRED
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX priority_name_idx ON priority (workspace_id, lower(name))`.execute(
    db,
  );

  await sql`
    CREATE TABLE priority_set (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      is_default boolean NOT NULL DEFAULT false,
      default_priority_id integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX priority_set_name_idx ON priority_set (workspace_id, lower(name))`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX priority_set_default_idx ON priority_set (workspace_id) WHERE is_default`.execute(
    db,
  );
  await sql`
    CREATE TABLE priority_set_member (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      priority_set_id integer NOT NULL REFERENCES priority_set (id) ON DELETE CASCADE,
      priority_id integer NOT NULL REFERENCES priority (id),
      PRIMARY KEY (priority_set_id, priority_id)
    )`.execute(db);
  await sql`CREATE INDEX priority_set_member_priority_idx ON priority_set_member (priority_id)`.execute(
    db,
  );
  await sql`
    ALTER TABLE priority_set ADD CONSTRAINT priority_set_default_member_fkey
      FOREIGN KEY (id, default_priority_id)
      REFERENCES priority_set_member (priority_set_id, priority_id) DEFERRABLE INITIALLY DEFERRED`.execute(
    db,
  );
  await sql`ALTER TABLE track ADD COLUMN priority_set_id integer REFERENCES priority_set (id)`.execute(
    db,
  );
  await sql`CREATE INDEX track_priority_set_idx ON track (priority_set_id) WHERE priority_set_id IS NOT NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE close_reason (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      sort_order integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT close_reason_order_key UNIQUE (workspace_id, sort_order)
        DEFERRABLE INITIALLY DEFERRED
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX close_reason_name_idx ON close_reason (workspace_id, lower(name))`.execute(
    db,
  );

  await sql`
    CREATE TABLE label (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, name)
    )`.execute(db);
  await sql`CREATE INDEX label_prefix_idx ON label (workspace_id, lower(name) text_pattern_ops)`.execute(
    db,
  );

  await sql`
    CREATE TABLE release (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      track_id integer NOT NULL REFERENCES track (id),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      start_date date,
      release_date date,
      sort_order integer NOT NULL,
      shipped_at timestamptz,
      archived_at timestamptz,
      require_approvals boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT release_order_key UNIQUE (track_id, sort_order) DEFERRABLE INITIALLY DEFERRED
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX release_name_idx ON release (track_id, lower(name))`.execute(db);
  await sql`
    CREATE TABLE release_approver (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      release_id integer NOT NULL REFERENCES release (id) ON DELETE CASCADE,
      user_id integer NOT NULL REFERENCES app_user (id),
      decision text CHECK (decision IN ('approved', 'declined')),
      comment text NOT NULL DEFAULT '',
      decided_at timestamptz,
      PRIMARY KEY (release_id, user_id),
      CHECK ((decision IS NULL) = (decided_at IS NULL))
    )`.execute(db);

  await sql`
    CREATE TABLE area (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      track_id integer NOT NULL REFERENCES track (id),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      owner_id integer REFERENCES app_user (id),
      default_assignee text NOT NULL DEFAULT 'unassigned'
        CHECK (default_assignee IN ('area_owner', 'track_owner', 'unassigned')),
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX area_name_idx ON area (track_id, lower(name))`.execute(db);
  await sql`CREATE INDEX area_owner_idx ON area (owner_id) WHERE owner_id IS NOT NULL`.execute(db);

  await sql`
    ALTER TABLE ticket
      ADD COLUMN priority_id integer REFERENCES priority (id),
      ADD COLUMN close_reason_id integer REFERENCES close_reason (id),
      ADD COLUMN closed_at timestamptz,
      ADD COLUMN labels text[] NOT NULL DEFAULT '{}'`.execute(db);
  await sql`CREATE INDEX ticket_priority_idx ON ticket (priority_id) WHERE priority_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX ticket_close_reason_idx ON ticket (close_reason_id) WHERE close_reason_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX ticket_labels_idx ON ticket USING gin (labels)`.execute(db);
  await sql`
    CREATE TABLE ticket_release (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      release_id integer NOT NULL REFERENCES release (id),
      role text NOT NULL CHECK (role IN ('target', 'found')),
      PRIMARY KEY (ticket_id, role, release_id)
    )`.execute(db);
  await sql`CREATE INDEX ticket_release_release_idx ON ticket_release (release_id, role)`.execute(
    db,
  );
  await sql`
    CREATE TABLE ticket_area (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      area_id integer NOT NULL REFERENCES area (id),
      PRIMARY KEY (ticket_id, area_id)
    )`.execute(db);
  await sql`CREATE INDEX ticket_area_area_idx ON ticket_area (area_id)`.execute(db);

  const { rows } = await sql<{ id: number }>`SELECT id FROM workspace ORDER BY id`.execute(db);
  for (const { id: ws } of rows) {
    for (const [i, [name, description, icon, color]] of PRIORITIES.entries()) {
      await sql`
        INSERT INTO priority (workspace_id, name, description, icon, color, sort_order)
        VALUES (${ws}, ${name}, ${description}, ${icon}, ${color}, ${i + 1})`.execute(db);
    }
    for (const [i, [name, description]] of CLOSE_REASONS.entries()) {
      await sql`
        INSERT INTO close_reason (workspace_id, name, description, sort_order)
        VALUES (${ws}, ${name}, ${description}, ${i + 1})`.execute(db);
    }
    await sql`
      INSERT INTO priority_set (workspace_id, name, description, is_default)
      VALUES (${ws}, 'Default priority set', 'Every priority', true)`.execute(db);
    await sql`
      INSERT INTO priority_set_member (workspace_id, priority_set_id, priority_id)
      SELECT ${ws}, s.id, p.id FROM priority_set s, priority p
       WHERE s.workspace_id = ${ws} AND p.workspace_id = ${ws}`.execute(db);
    await sql`
      UPDATE priority_set SET default_priority_id =
        (SELECT id FROM priority WHERE workspace_id = ${ws} AND name = 'Normal')
       WHERE workspace_id = ${ws}`.execute(db);
  }
}
