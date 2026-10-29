import { type Kysely, sql } from 'kysely';

/**
 * Tickets a person opened lately (M1-052; AGL-018 recent, AGL-019 viewed): one row per person
 * and ticket with the last time they opened it, for the home page's Recent list. The route
 * keeps the latest 50 per person. Rows leave with their ticket or person.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ticket_visit (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      visited_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, ticket_id)
    )`.execute(db);
  await sql`CREATE INDEX ticket_visit_recent_idx ON ticket_visit (user_id, visited_at DESC, ticket_id DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX ticket_visit_ticket_idx ON ticket_visit (ticket_id)`.execute(db);
}
