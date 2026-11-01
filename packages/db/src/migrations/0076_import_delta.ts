import { type Kysely, sql } from 'kysely';

/**
 * Delta runs of an import (M1-096; IMP-009 (3); ADR-102). A run can start from an earlier run of
 * the same source (`import_run.delta_from`): a Cloud REST run then fetches only the tickets
 * updated since that run's fetch began, a Data Center run reads a later backup, and either one
 * looks for what the source no longer holds. Such records get a row with the new outcome
 * `deleted`: the target keeps the object, and the report lists it for the administrator.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE import_run
    ADD COLUMN delta_from bigint REFERENCES import_run (id) ON DELETE SET NULL`.execute(db);
  await sql`ALTER TABLE import_record DROP CONSTRAINT import_record_outcome_check`.execute(db);
  await sql`ALTER TABLE import_record ADD CONSTRAINT import_record_outcome_check
    CHECK (outcome IN ('created', 'updated', 'unchanged', 'linked', 'failed', 'skipped',
                       'deleted'))`.execute(db);
}
