import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';

/**
 * A demo seeded before the sample data moved freely (WF-008) keeps its tracks on "Eval map", whose
 * workflow refuses most moves, and a restart skips the seed. Those tracks go back to the default
 * map. The default workflow holds the same statuses and a ticket stores no workflow (ADR-045), so
 * no ticket moves. A track someone else put on another map stays, and so does "Eval workflow" once
 * somebody published a version of it on purpose, or when it holds a status the default lacks.
 * Answers how many tracks changed.
 */
export async function releaseSampleWorkflow(db: Kysely<Database>): Promise<number> {
  const { rows } = await sql<{ id: number }>`
    WITH sample AS (
      SELECT m.id AS map_id, w.id AS workflow_id, w.workspace_id
        FROM workflow_map m
        JOIN workflow w ON w.id = m.default_workflow_id
       WHERE m.name = 'Eval map' AND w.name = 'Eval workflow' AND w.published_version = 1
    ), fits AS (
      SELECT s.map_id
        FROM sample s
       WHERE NOT EXISTS (
         SELECT 1
           FROM workflow_version_status mine
          WHERE mine.workflow_id = s.workflow_id
            AND mine.version = 1
            AND mine.status_id NOT IN (
              SELECT d.status_id
                FROM workflow w
                JOIN workflow_version_status d
                  ON d.workflow_id = w.id AND d.version = w.published_version
               WHERE w.workspace_id = s.workspace_id AND w.is_default
            )
       )
    )
    UPDATE track SET workflow_map_id = NULL, updated_at = now()
     WHERE workflow_map_id IN (SELECT map_id FROM fits)
    RETURNING id`.execute(db);
  return rows.length;
}
