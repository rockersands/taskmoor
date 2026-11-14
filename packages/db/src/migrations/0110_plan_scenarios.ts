import { type Kysely, sql } from 'kysely';

/**
 * Draft changes and scenarios in Multi-track plans (T-089e; PLN-002, PLN-003; ADR-122 stage 6).
 *
 * - `plan_scenario`: a named set of draft changes to a plan's tickets; it goes with its plan.
 *   At most one per plan is `main`, the only one applied from (a partial unique index).
 *   `applying_since` holds the scenario while an apply runs; one older than ten minutes is stale.
 * - `plan_draft`: one field of one ticket in one scenario: its start day, its due day or its value
 *   in a shared Team field (`cf:<id>`, with `team_field_id` set exactly then). It keeps the value
 *   the field had when first drafted (`old_value`) and the new one (`new_value`, null clears),
 *   both JSON scalars, who changed it last, its origin (a person, or the auto-scheduler later) and
 *   its last refusal. It goes with its scenario, with the ticket when the ticket is purged, and
 *   with its Team field.
 *
 * No rows are written: a plan without scenarios works as before.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE plan_scenario (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      plan_id integer NOT NULL REFERENCES plan (id) ON DELETE CASCADE,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
      main boolean NOT NULL DEFAULT false,
      created_by integer NOT NULL REFERENCES app_user (id),
      applying_since timestamptz,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  // Unique so drafts can name their scenario and plan together; it also lists a plan's scenarios.
  await sql`CREATE UNIQUE INDEX plan_scenario_plan_idx ON plan_scenario (plan_id, id)`.execute(db);
  await sql`CREATE UNIQUE INDEX plan_scenario_main_idx ON plan_scenario (plan_id)
    WHERE main`.execute(db);
  await sql`CREATE INDEX plan_scenario_creator_idx ON plan_scenario (created_by)`.execute(db);
  await sql`
    CREATE TABLE plan_draft (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      plan_id integer NOT NULL,
      scenario_id integer NOT NULL,
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      field text NOT NULL CHECK (field IN ('startDate', 'dueDate') OR field ~ '^cf:[1-9][0-9]*$'),
      team_field_id integer REFERENCES field (id) ON DELETE CASCADE,
      old_value jsonb,
      new_value jsonb,
      origin text NOT NULL DEFAULT 'person' CHECK (origin IN ('person', 'scheduler')),
      updated_by integer NOT NULL REFERENCES app_user (id),
      updated_at timestamptz NOT NULL DEFAULT now(),
      refusal jsonb,
      refused_at timestamptz,
      PRIMARY KEY (scenario_id, ticket_id, field),
      FOREIGN KEY (plan_id, scenario_id) REFERENCES plan_scenario (plan_id, id) ON DELETE CASCADE,
      CHECK ((field LIKE 'cf:%') = (team_field_id IS NOT NULL)),
      CHECK (team_field_id IS NULL OR field = 'cf:' || team_field_id),
      CHECK (old_value IS NULL OR jsonb_typeof(old_value) IN ('string', 'number', 'null')),
      CHECK (new_value IS NULL OR jsonb_typeof(new_value) IN ('string', 'number', 'null'))
    )`.execute(db);
  await sql`CREATE INDEX plan_draft_ticket_idx ON plan_draft (ticket_id)`.execute(db);
  await sql`CREATE INDEX plan_draft_updater_idx ON plan_draft (updated_by)`.execute(db);
  await sql`CREATE INDEX plan_draft_field_idx ON plan_draft (team_field_id)
    WHERE team_field_id IS NOT NULL`.execute(db);
}
