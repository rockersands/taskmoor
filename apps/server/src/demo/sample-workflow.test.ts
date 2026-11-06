import { useMigratedDatabase } from '@taskmoor/db/testing';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { releaseSampleWorkflow } from './sample-workflow';

/** The repair for a demo seeded before its sample tracks moved freely (WF-008). */
describe('a demo seeded with the strict sample workflow', () => {
  const database = useMigratedDatabase();

  /** A map whose workflow holds the seeded statuses and any `more`, with one strict step. */
  async function strictMap(name: string, workflowName: string, more: number[] = []) {
    const db = database.db;
    const { rows } = await sql<{ id: number }>`
      SELECT id FROM status WHERE workspace_id = 1 AND name IN ('New', 'Active', 'In Review', 'Closed')
       ORDER BY sort_order`.execute(db);
    const ids = [...rows.map((r) => r.id), ...more];
    const workflow = await sql<{ id: number }>`
      INSERT INTO workflow (workspace_id, name) VALUES (1, ${workflowName}) RETURNING id`.execute(
      db,
    );
    const workflowId = workflow.rows[0]?.id as number;
    await sql`
      INSERT INTO workflow_version (workspace_id, workflow_id, version, definition, published_at)
      VALUES (1, ${workflowId}, 1, ${JSON.stringify({
        initialStatusId: ids[0],
        statuses: ids.map((statusId) => ({ statusId })),
        transitions: [{ id: 1, name: 'Start', from: [ids[0]], to: ids[1] }],
      })}, now())`.execute(db);
    await sql`
      INSERT INTO workflow_version_status (workspace_id, workflow_id, version, status_id)
      SELECT 1, ${workflowId}, 1, unnest(${ids}::int[])`.execute(db);
    const map = await sql<{ id: number }>`
      INSERT INTO workflow_map (workspace_id, name, default_workflow_id)
      VALUES (1, ${name}, ${workflowId}) RETURNING id`.execute(db);
    return { workflowId, mapId: map.rows[0]?.id as number };
  }

  async function trackOn(key: string, mapId: number | null) {
    const { rows } = await sql<{ id: number }>`
      INSERT INTO track (workspace_id, key, name, mode, workflow_map_id, access_policy_id)
      SELECT 1, ${key}, ${key}, 'shared', ${mapId}::int, min(id) FROM access_policy
      RETURNING id`.execute(database.db);
    return rows[0]?.id as number;
  }

  const mapOf = async (trackId: number) =>
    (
      await database.db
        .selectFrom('track')
        .select('workflow_map_id')
        .where('id', '=', trackId)
        .executeTakeFirstOrThrow()
    ).workflow_map_id;

  it('[WF-008] puts only the sample tracks back on the default map, and only once', async () => {
    const sample = await strictMap('Eval map', 'Eval workflow');
    const own = await strictMap('Our map', 'Our workflow');
    const sampleTrack = await trackOn('SMPL', sample.mapId);
    const ownTrack = await trackOn('OWNT', own.mapId);

    expect(await releaseSampleWorkflow(database.db)).toBe(1);
    expect(await mapOf(sampleTrack)).toBeNull();
    expect(await mapOf(ownTrack)).toBe(own.mapId);
    expect(await releaseSampleWorkflow(database.db)).toBe(0);

    // Once someone published a version of it on purpose, it is theirs.
    await sql`UPDATE track SET workflow_map_id = ${sample.mapId} WHERE id = ${sampleTrack}`.execute(
      database.db,
    );
    await sql`
      INSERT INTO workflow_version (workspace_id, workflow_id, version, definition, published_at)
      SELECT workspace_id, workflow_id, 2, definition, now() FROM workflow_version
       WHERE workflow_id = ${sample.workflowId} AND version = 1`.execute(database.db);
    await sql`UPDATE workflow SET published_version = 2 WHERE id = ${sample.workflowId}`.execute(
      database.db,
    );
    expect(await releaseSampleWorkflow(database.db)).toBe(0);
    expect(await mapOf(sampleTrack)).toBe(sample.mapId);
  });

  it('[WF-008] keeps a sample workflow holding a status the default workflow lacks', async () => {
    // Someone added a status of their own to the sample workflow: its tickets may be in it, and
    // the default workflow has no place for them.
    const own = await sql<{ id: number }>`
      INSERT INTO status (workspace_id, name, stage, sort_order)
      VALUES (1, 'Waiting on legal', 'active', 90) RETURNING id`.execute(database.db);
    const extra = own.rows[0]?.id as number;
    // The first test's sample is still here under the same names: set it aside.
    await sql`UPDATE workflow_map SET name = 'Eval map (earlier)' WHERE name = 'Eval map'`.execute(
      database.db,
    );
    await sql`UPDATE workflow SET name = 'Eval workflow (earlier)' WHERE name = 'Eval workflow'`.execute(
      database.db,
    );
    const sample = await strictMap('Eval map', 'Eval workflow', [extra]);
    const track = await trackOn('SMPX', sample.mapId);
    expect(await releaseSampleWorkflow(database.db)).toBe(0);
    expect(await mapOf(track)).toBe(sample.mapId);

    // The same sample with only the default's statuses goes back to the default map.
    await sql`DELETE FROM workflow_version_status
               WHERE workflow_id = ${sample.workflowId} AND status_id = ${extra}`.execute(
      database.db,
    );
    expect(await releaseSampleWorkflow(database.db)).toBe(1);
    expect(await mapOf(track)).toBeNull();
  });
});
