import { type Kysely, sql } from 'kysely';

/**
 * The transition behind a status change (M1-024 to M1-027): ticket history rows a workflow
 * transition wrote carry its id, so guards such as separation of duties ("whoever ran Approve
 * may not run Release") can read who ran which transition. Null for every other change.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE ticket_change ADD COLUMN transition_id integer`.execute(db);
}
