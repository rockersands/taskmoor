import { type Kysely, sql } from 'kysely';

/**
 * The importer framework (M1-086; IMP-009, IMP-010, ADR-048).
 *
 * - `import_run`: one import, asked for by a site administrator: its source (format, system and
 *   the uploaded data or the settings of a configured source), whether it is a dry run, its
 *   state, the checkpoint it resumes from (entity kind and the source's cursor after the last
 *   committed batch), tallies per entity kind, warnings and unsupported kinds as they are found,
 *   and the fidelity report once it finishes.
 * - `import_record`: one row per source record a run handled, with its outcome (created,
 *   updated, unchanged, linked to an existing object, failed or skipped), the target it reached,
 *   a checksum of what was asked and whether the record is in the report's sample. A dry run
 *   resolves references to records it would create through these rows.
 * - `import_external_id`: every imported object keyed by (import source, source system, entity
 *   kind, source id), so a second run updates instead of creating a duplicate (IMP-009 (2)).
 *   No foreign key on the target: an object deleted later keeps its key, and a re-run reports
 *   it instead of creating it again.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE import_run (
      id bigserial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer REFERENCES app_user (id) ON DELETE SET NULL,
      import_source text NOT NULL,
      source_system text NOT NULL,
      name text NOT NULL DEFAULT '',
      source jsonb NOT NULL,
      dry_run boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
      cancel_requested boolean NOT NULL DEFAULT false,
      checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
      tallies jsonb NOT NULL DEFAULT '{}'::jsonb,
      warnings jsonb NOT NULL DEFAULT '{}'::jsonb,
      unsupported jsonb NOT NULL DEFAULT '{}'::jsonb,
      batches integer NOT NULL DEFAULT 0,
      report jsonb,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    )`.execute(db);
  await sql`CREATE INDEX import_run_workspace_idx
    ON import_run (workspace_id, created_at DESC)`.execute(db);
  await sql`
    CREATE TABLE import_record (
      run_id bigint NOT NULL REFERENCES import_run (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      entity_kind text NOT NULL,
      source_id text NOT NULL,
      outcome text NOT NULL
        CHECK (outcome IN ('created', 'updated', 'unchanged', 'linked', 'failed', 'skipped')),
      target_id bigint,
      checksum text,
      sampled boolean NOT NULL DEFAULT false,
      error jsonb,
      PRIMARY KEY (run_id, entity_kind, source_id)
    )`.execute(db);
  await sql`CREATE INDEX import_record_failed_idx
    ON import_record (run_id, entity_kind) WHERE outcome = 'failed'`.execute(db);
  await sql`CREATE INDEX import_record_sampled_idx
    ON import_record (run_id, entity_kind) WHERE sampled`.execute(db);
  await sql`
    CREATE TABLE import_external_id (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      import_source text NOT NULL,
      source_system text NOT NULL,
      entity_kind text NOT NULL,
      source_id text NOT NULL,
      target_id bigint NOT NULL,
      checksum text NOT NULL,
      first_run_id bigint REFERENCES import_run (id) ON DELETE SET NULL,
      last_run_id bigint REFERENCES import_run (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, import_source, source_system, entity_kind, source_id)
    )`.execute(db);
  await sql`CREATE INDEX import_external_id_target_idx
    ON import_external_id (workspace_id, entity_kind, target_id)`.execute(db);
}
