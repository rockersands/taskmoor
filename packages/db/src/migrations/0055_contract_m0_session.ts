import { type Kysely, sql } from 'kysely';

/**
 * The contract step for M1-001 (M1-121; ADR-022). 0003 expanded: it added `user_session` and
 * copied the M0 `session` table's live rows into it with their tokens hashed, and gave
 * `app_user.workspace_id` a default so the previous release, which wrote users without it, kept
 * working during a rolling upgrade. Nothing has read `session` or relied on that default since,
 * so both go: every user row names its workspace from now on.
 *
 * It lands before any release is published (ADR-022, "Contract step for M1-001"): no published
 * release reads either, and every database reaches this through 0003, whose copy ran first.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE session`.execute(db);
  await sql`ALTER TABLE app_user ALTER COLUMN workspace_id DROP DEFAULT`.execute(db);
}
