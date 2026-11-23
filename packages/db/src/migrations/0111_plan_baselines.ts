import { type Kysely, sql } from 'kysely';

/**
 * Baselines of Multi-track plans (T-089a; PLN-011; ADR-122 stage 9).
 *
 * - `plan_baseline`: a named, frozen copy of the days of a plan's tickets at one moment, taken
 *   from the tickets as they are (`live`) or from a scenario, whose name is copied so the list can
 *   say where it came from after the scenario is renamed or gone. It goes with its plan.
 * - `plan_baseline_day`: one ticket of the plan as its capturer was shown it: its own start and
 *   due days, or else its sprint's, and which of the two (`dated`, null exactly when it had no
 *   days), and whether it was closed. Never a key, a summary or a roll-up. It goes with its
 *   baseline and with the ticket when the ticket is purged.
 *
 * No rows are written: a plan without baselines works as before.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE plan_baseline (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      plan_id integer NOT NULL REFERENCES plan (id) ON DELETE CASCADE,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
      source text NOT NULL CHECK (source IN ('live', 'scenario')),
      scenario_name text,
      tickets integer NOT NULL DEFAULT 0 CHECK (tickets >= 0),
      created_by integer NOT NULL REFERENCES app_user (id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CHECK ((source = 'scenario') = (scenario_name IS NOT NULL))
    )`.execute(db);
  // Unique so rows can name their baseline and plan together; it also lists a plan's baselines.
  await sql`CREATE UNIQUE INDEX plan_baseline_plan_idx ON plan_baseline (plan_id, id)`.execute(db);
  await sql`CREATE INDEX plan_baseline_creator_idx ON plan_baseline (created_by)`.execute(db);
  await sql`
    CREATE TABLE plan_baseline_day (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      plan_id integer NOT NULL,
      baseline_id integer NOT NULL,
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      start_date date,
      due_date date,
      dated text CHECK (dated IN ('own', 'sprint')),
      closed boolean NOT NULL,
      PRIMARY KEY (baseline_id, ticket_id),
      FOREIGN KEY (plan_id, baseline_id) REFERENCES plan_baseline (plan_id, id) ON DELETE CASCADE,
      CHECK ((dated IS NULL) = (start_date IS NULL AND due_date IS NULL))
    )`.execute(db);
  await sql`CREATE INDEX plan_baseline_day_ticket_idx ON plan_baseline_day (ticket_id)`.execute(db);
}
