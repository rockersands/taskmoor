import { type Kysely, sql } from 'kysely';

/**
 * Program boards and dependency options in Multi-track plans (T-089d; PLN-008, PLN-013; ADR-122
 * stage 5).
 *
 * - `program_board`: a plan's work laid out by team and period. Rows are the plan's teams, read
 *   from each ticket's value in the board's Team field (a shared `team` field, set to null when the
 *   field is deleted); columns are `periods` of the plan's own periods from the one holding
 *   `from_day`. It stores no cards: a card is a ticket, and where it stands is its Team value and
 *   its due day. No limit per plan (PLN-008); it goes with its plan.
 * - `plan_dependency_type`: link types a plan counts as dependencies beside blocking links, the
 *   source finishing first (PLN-013); it goes with the plan or the link type.
 * - `plan.flag_same_sprint`: whether the plan marks dependencies whose two tickets are in the same
 *   sprint now.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE program_board (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      plan_id integer NOT NULL REFERENCES plan (id) ON DELETE CASCADE,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
      team_field_id integer REFERENCES field (id) ON DELETE SET NULL,
      from_day date NOT NULL,
      periods smallint NOT NULL DEFAULT 6 CHECK (periods BETWEEN 1 AND 12),
      archived_at timestamptz,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX program_board_plan_idx ON program_board (plan_id, id)`.execute(db);
  await sql`CREATE INDEX program_board_field_idx ON program_board (team_field_id)
    WHERE team_field_id IS NOT NULL`.execute(db);
  await sql`
    CREATE TABLE plan_dependency_type (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      plan_id integer NOT NULL REFERENCES plan (id) ON DELETE CASCADE,
      link_type_id integer NOT NULL REFERENCES link_type (id) ON DELETE CASCADE,
      PRIMARY KEY (plan_id, link_type_id)
    )`.execute(db);
  await sql`CREATE INDEX plan_dependency_type_link_idx ON plan_dependency_type (link_type_id)`.execute(
    db,
  );
  await sql`ALTER TABLE plan ADD COLUMN flag_same_sprint boolean NOT NULL DEFAULT false`.execute(db);
}
