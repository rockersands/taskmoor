import { type Kysely, sql } from 'kysely';

/**
 * A track's customized Summary (ADR-116; RPT-006): its layout and widgets, at most one per track.
 * No row means the track shows the default summary, and removing the row goes back to it. It is a
 * table of its own rather than a dashboard: a dashboard has an owner and shares, while this belongs
 * to the track, changed by its owner and administrators and read by whoever may see the track.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE track_summary_layout (
    track_id integer PRIMARY KEY REFERENCES track (id) ON DELETE CASCADE,
    workspace_id integer NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
    layout text NOT NULL DEFAULT 'one'
      CHECK (layout IN ('one', 'two', 'two-wide-left', 'two-wide-right', 'three')),
    widgets jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(widgets) = 'array'),
    version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
}
