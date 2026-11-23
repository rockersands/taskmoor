import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { defaultWorkspaceId } from '../workspace';
import { statusGateFor } from './locks';
import { defaultWorkflowId, loadDefinition } from './store';

/**
 * One process can serve several databases (the e2e API server runs a backend per site), and each
 * database numbers its workflows and versions from the start, so the same id and version mean
 * different workflows there. A status lock is read from the database it is asked of.
 */
describe('status locks, one process serving two databases (WF-007)', () => {
  const plain = useMigratedDatabase();
  const locked = useMigratedDatabase();
  const nobody = { roleIds: new Set<number>(), groupIds: new Set<number>() };

  /** The seeded default workflow's published version: the same id and version in both. */
  async function seeded(db: Kysely<Database>) {
    const workspaceId = await defaultWorkspaceId(db);
    const id = await defaultWorkflowId(db, workspaceId);
    const { published_version: version } = await db
      .selectFrom('workflow')
      .select('published_version')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { workspaceId, id, version, definition: await loadDefinition(db, id, version) };
  }

  it('[WF-007] reads each database’s own workflow, though both have the same id and version', async () => {
    const a = await seeded(plain.db);
    const b = await seeded(locked.db);
    expect([b.id, b.version]).toEqual([a.id, a.version]);
    // In the second database only, the initial status lets just one group attach files.
    const initial = b.definition.initialStatusId;
    await locked.db
      .updateTable('workflow_version')
      .set({
        definition: JSON.stringify({
          ...b.definition,
          statusPermissions: { [String(initial)]: { attach: [{ group: '42' }] } },
        }),
      })
      .where('workflow_id', '=', b.id)
      .where('version', '=', b.version)
      .execute();

    // The first database is read first; its workflow has no lock (no track: the default map).
    const first = await statusGateFor(plain.db, a.workspaceId, 0, 0, nobody);
    expect(first.check(initial, 'attach')).toBeNull();
    const second = await statusGateFor(locked.db, b.workspaceId, 0, 0, nobody);
    expect(second.check(initial, 'attach')).toEqual([{ type: 'group', id: 42 }]);
    // And the first still reads its own.
    expect(
      (await statusGateFor(plain.db, a.workspaceId, 0, 0, nobody)).check(initial, 'attach'),
    ).toBeNull();
  });
});
