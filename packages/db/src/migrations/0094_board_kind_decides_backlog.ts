import { type Kysely, sql } from 'kysely';

/**
 * A track's backlog and sprints toggles follow its board's kind from now on (the user's decision,
 * ADR-116): on for a Scrum board, off for a Kanban one. Until now nothing read them and a change of
 * kind did not touch them, so a Blank track with a Kanban board still had them on, and a Kanban
 * template later changed to Scrum still had them off. Data only: nothing else about a track moves.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE track t
               SET feature_backlog = (b.kind = 'scrum'), feature_sprints = (b.kind = 'scrum')
              FROM board b
             WHERE b.location_track_id = t.id
               AND (t.feature_backlog <> (b.kind = 'scrum')
                 OR t.feature_sprints <> (b.kind = 'scrum'))`.execute(db);
}
