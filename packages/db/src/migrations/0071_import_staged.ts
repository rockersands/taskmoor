import { type Kysely, sql } from 'kysely';

/**
 * The staging area of imports that read a remote server (M1-095; IMP-002, IMP-009; ADR-094).
 * The Cloud REST importer fetches the source's records over its API into `import_staged`, a
 * page at a time, and keeps where it got to in `import_run.fetch_state`, committed with the
 * page; a worker that dies, or a source that keeps refusing, resumes from there. The run's
 * extract stage then reads the staged records in a stable order (`depth`, then `ordinal`:
 * parents before their children), as it reads a backup's staged files. The rows go with their
 * run.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE import_run ADD COLUMN fetch_state jsonb NOT NULL DEFAULT '{}'::jsonb`.execute(
    db,
  );
  await sql`
    CREATE TABLE import_staged (
      run_id bigint NOT NULL REFERENCES import_run (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      kind text NOT NULL,
      source_id text NOT NULL,
      depth integer NOT NULL DEFAULT 0,
      ordinal bigint NOT NULL,
      label text,
      data jsonb NOT NULL,
      PRIMARY KEY (run_id, kind, source_id)
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX import_staged_order_idx
    ON import_staged (run_id, kind, depth, ordinal)`.execute(db);
}
