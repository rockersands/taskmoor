import { type Kysely, sql } from 'kysely';

/**
 * Sprints (M1-044; AGL-007, AGL-010, AGL-011; ADR-054).
 *
 * - `board.sprint_settings`: a Scrum board's estimation statistic (none, the original time
 *   estimate, or a number field such as story points), its time tracking (none, or remaining
 *   estimate and time spent) and whether several sprints may be active at once. JSON the
 *   routes validate (`apps/server/src/sprints/model.ts`).
 * - `sprint`: owned by a board; future, active or closed; `sequence` orders a board's sprints
 *   (future ones are reordered by it). A deleted completed sprint keeps its rows with
 *   `deleted_at` set, so it leaves reports while its tickets keep their history (AGL-010 (3)).
 * - `sprint_ticket`: which tickets are in which sprint. `open` is true while the sprint is
 *   future or active; a ticket is in one open sprint at most (the partial unique index), and
 *   stays in the closed sprints it passed through, so `sprint = <id>` and `openSprints()`
 *   (M1-045) read this table without a schema change.
 * - `sprint_change`: every membership change with its time and author, and what the ticket's
 *   estimate was then (`original_estimate`, `remaining_estimate` in seconds, `points` for the
 *   board's number field): added, removed, committed at start, completed or carried over at
 *   completion. `after_start` marks scope change (AGL-010 (2)). Reports and burndown (M1-062)
 *   are computed from these rows and the ticket change log.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE board ADD COLUMN sprint_settings jsonb NOT NULL
    DEFAULT '{"estimation":{"statistic":"originalEstimate"},"timeTracking":"remainingEstimate","parallelSprints":false}'`.execute(
    db,
  );
  await sql`
    CREATE TABLE sprint (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      board_id integer NOT NULL REFERENCES board (id) ON DELETE CASCADE,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
      goal text NOT NULL DEFAULT '' CHECK (char_length(goal) <= 10000),
      state text NOT NULL DEFAULT 'future' CHECK (state IN ('future', 'active', 'closed')),
      sequence integer NOT NULL,
      start_at timestamptz,
      end_at timestamptz,
      started_at timestamptz,
      completed_at timestamptz,
      started_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      completed_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      created_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CHECK (end_at IS NULL OR start_at IS NULL OR end_at > start_at),
      CHECK (state = 'future' OR started_at IS NOT NULL),
      CHECK (state <> 'closed' OR completed_at IS NOT NULL),
      CHECK (deleted_at IS NULL OR state = 'closed')
    )`.execute(db);
  await sql`CREATE INDEX sprint_board_idx ON sprint (board_id, sequence) WHERE deleted_at IS NULL`.execute(
    db,
  );
  await sql`CREATE INDEX sprint_open_idx ON sprint (workspace_id, state) WHERE state <> 'closed'`.execute(
    db,
  );
  await sql`
    CREATE TABLE sprint_ticket (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      sprint_id integer NOT NULL REFERENCES sprint (id) ON DELETE CASCADE,
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      open boolean NOT NULL DEFAULT true,
      added_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (sprint_id, ticket_id)
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX sprint_ticket_open_idx ON sprint_ticket (ticket_id) WHERE open`.execute(
    db,
  );
  await sql`CREATE INDEX sprint_ticket_ticket_idx ON sprint_ticket (ticket_id)`.execute(db);
  await sql`
    CREATE TABLE sprint_change (
      id bigserial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      sprint_id integer NOT NULL REFERENCES sprint (id) ON DELETE CASCADE,
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      kind text NOT NULL
        CHECK (kind IN ('added', 'removed', 'committed', 'completed', 'carried_over')),
      after_start boolean NOT NULL DEFAULT false,
      at timestamptz NOT NULL DEFAULT now(),
      actor_id integer REFERENCES app_user (id) ON DELETE SET NULL,
      original_estimate integer,
      remaining_estimate integer,
      points numeric,
      to_sprint_id integer REFERENCES sprint (id) ON DELETE SET NULL
    )`.execute(db);
  await sql`CREATE INDEX sprint_change_sprint_idx ON sprint_change (sprint_id, at, id)`.execute(db);
  await sql`CREATE INDEX sprint_change_ticket_idx ON sprint_change (ticket_id)`.execute(db);
}
