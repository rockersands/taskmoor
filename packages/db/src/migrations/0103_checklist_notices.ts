import { type Kysely, sql } from 'kysely';

/**
 * Checklist notices (T-196a; NTF-015; ADR-120): a track's administrators may have the followers
 * of its tickets told when a checklist or its items change. The choice is the track's, so it is a
 * column here, off for every track that exists and for every new one until someone turns it on.
 * The notices themselves are ordinary `notification` rows, of the product event
 * `checklist_changed`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE track
      ADD COLUMN notify_checklist_changes boolean NOT NULL DEFAULT false`.execute(db);
}
