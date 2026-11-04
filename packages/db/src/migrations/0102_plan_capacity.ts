import { type Kysely, sql } from 'kysely';

/**
 * Teams and capacity in Multi-track plans (T-089b; PLN-005, PLN-009; ADR-122 stage 3).
 *
 * - `plan` gains its capacity settings: the unit work and capacity are counted in (`points`, from
 *   the workspace's Points field, or `hours`, from the original estimate) and its periods: every
 *   `period_weeks` weeks from `period_anchor` (any day; periods repeat from it both ways), or each
 *   calendar month. Existing plans get two-week periods from Monday 2024-01-01, in points.
 * - `plan_team`: the site teams (ADR-076) a plan plans with, in the order chosen. A team gives no
 *   access, and leaves the plan when it is deleted.
 * - `plan_capacity`: how much a team or a person can take on in a period, in the plan's unit.
 *   `period_start` null is every period; a row for one period's first day replaces it there (a
 *   holiday, say, with a note). One row per plan, subject and period. A person's capacity is the
 *   plan's, whichever of its teams they are in; it goes with the team or the account.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE plan
      ADD COLUMN capacity_unit text NOT NULL DEFAULT 'points'
        CHECK (capacity_unit IN ('points', 'hours')),
      ADD COLUMN period_kind text NOT NULL DEFAULT 'weeks' CHECK (period_kind IN ('weeks', 'month')),
      ADD COLUMN period_weeks smallint NOT NULL DEFAULT 2 CHECK (period_weeks BETWEEN 1 AND 6),
      ADD COLUMN period_anchor date NOT NULL DEFAULT DATE '2024-01-01'`.execute(db);
  await sql`
    CREATE TABLE plan_team (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      plan_id integer NOT NULL REFERENCES plan (id) ON DELETE CASCADE,
      team_id integer NOT NULL REFERENCES team (id) ON DELETE CASCADE,
      position integer NOT NULL CHECK (position >= 0),
      PRIMARY KEY (plan_id, team_id)
    )`.execute(db);
  await sql`CREATE INDEX plan_team_team_idx ON plan_team (team_id)`.execute(db);
  await sql`
    CREATE TABLE plan_capacity (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      plan_id integer NOT NULL REFERENCES plan (id) ON DELETE CASCADE,
      team_id integer REFERENCES team (id) ON DELETE CASCADE,
      user_id integer REFERENCES app_user (id) ON DELETE CASCADE,
      period_start date,
      amount numeric(8, 2) NOT NULL CHECK (amount >= 0 AND amount <= 100000),
      note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
      CHECK ((team_id IS NULL) <> (user_id IS NULL))
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX plan_capacity_team_key
      ON plan_capacity (plan_id, team_id, COALESCE(period_start, DATE '0001-01-01'))
      WHERE team_id IS NOT NULL`.execute(db);
  await sql`
    CREATE UNIQUE INDEX plan_capacity_user_key
      ON plan_capacity (plan_id, user_id, COALESCE(period_start, DATE '0001-01-01'))
      WHERE user_id IS NOT NULL`.execute(db);
  await sql`CREATE INDEX plan_capacity_team_idx ON plan_capacity (team_id) WHERE team_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX plan_capacity_user_idx ON plan_capacity (user_id) WHERE user_id IS NOT NULL`.execute(
    db,
  );
}
