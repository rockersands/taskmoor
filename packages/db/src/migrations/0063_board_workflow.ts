import { type Kysely, sql } from 'kysely';

/**
 * Board-managed workflows (M1-126; WF-010; ADR-079): a board of a local-mode track whose
 * columns are its track's statuses. At most one board manages a track's workflow.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE board ADD COLUMN manages_workflow boolean NOT NULL DEFAULT false`.execute(
    db,
  );
  await sql`
    CREATE UNIQUE INDEX board_manages_workflow_idx ON board (location_track_id)
      WHERE manages_workflow`.execute(db);
}
