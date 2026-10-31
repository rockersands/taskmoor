import { type Kysely, sql } from 'kysely';

/**
 * Saved searches an import could not translate (M1-094; IMP-004; ADR-096): the reason, in
 * words, why the query that came from another tracker does not run here (an app's function, a
 * field or person the source does not have). The saved search keeps the source's text so its
 * owner can see what it was and fix it; saving a new query clears the reason. Null for every
 * other saved search.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE saved_search ADD COLUMN import_problem text`.execute(db);
}
