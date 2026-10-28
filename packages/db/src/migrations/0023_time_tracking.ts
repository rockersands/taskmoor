import { type Kysely, sql } from 'kysely';

/**
 * Time tracking (M1-019; TIM-001; spec 03 section 3).
 *
 * - `time_tracking_setting`: the workspace's working hours per day and days per week (decimals
 *   allowed; they turn "1w 2d" into hours), the display format and default unit, whether
 *   transition comments go into the time entry description, and a switch for the feature.
 * - `ticket.original_estimate`, `ticket.remaining_estimate` (null: none) and
 *   `ticket.time_spent`, all in seconds; time spent is the sum of the ticket's time entries,
 *   kept in the same transaction as every change to them.
 * - `time_entry`: who worked, from when, for how long (seconds), a description, and an
 *   optional visibility to one role in the track or one group. Entries leave with their
 *   ticket. Accounts, billing and work categories arrive in M2 (TIM-004).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE time_tracking_setting (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      enabled boolean NOT NULL DEFAULT true,
      hours_per_day numeric(4, 2) NOT NULL DEFAULT 8
        CHECK (hours_per_day > 0 AND hours_per_day <= 24),
      days_per_week numeric(3, 2) NOT NULL DEFAULT 5
        CHECK (days_per_week > 0 AND days_per_week <= 7),
      display_format text NOT NULL DEFAULT 'pretty'
        CHECK (display_format IN ('pretty', 'days', 'hours')),
      default_unit text NOT NULL DEFAULT 'minute'
        CHECK (default_unit IN ('week', 'day', 'hour', 'minute')),
      copy_transition_comments boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`INSERT INTO time_tracking_setting (workspace_id) SELECT id FROM workspace`.execute(db);

  await sql`
    ALTER TABLE ticket
      ADD COLUMN original_estimate integer CHECK (original_estimate >= 0),
      ADD COLUMN remaining_estimate integer CHECK (remaining_estimate >= 0),
      ADD COLUMN time_spent integer NOT NULL DEFAULT 0 CHECK (time_spent >= 0)`.execute(db);

  await sql`
    CREATE TABLE time_entry (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      author_id integer NOT NULL REFERENCES app_user (id),
      started_at timestamptz NOT NULL,
      duration integer NOT NULL CHECK (duration > 0),
      description text NOT NULL DEFAULT '',
      visible_role_id integer REFERENCES role (id),
      visible_group_id integer REFERENCES user_group (id),
      created_by integer REFERENCES app_user (id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (visible_role_id IS NULL OR visible_group_id IS NULL)
    )`.execute(db);
  await sql`CREATE INDEX time_entry_ticket_idx ON time_entry (ticket_id, started_at, id)`.execute(
    db,
  );
  await sql`CREATE INDEX time_entry_author_idx ON time_entry (author_id, started_at)`.execute(db);
}
