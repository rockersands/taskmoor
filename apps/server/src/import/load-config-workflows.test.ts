import { useMigratedDatabase } from '@taskmoor/db/testing';
import { describe, expect, it } from 'vitest';
import type { LoadContext } from './load';
import { workflows } from './load-config';
import type { Warning, WorkflowCommand } from './model';

/**
 * A backup's workflow that converts to no transitions at all (a source workflow with only its
 * create action): imported with the free moves a new workflow gets (T-246; WF-008 (4); ADR-116).
 */
describe('an imported workflow with no transitions', () => {
  const database = useMigratedDatabase();
  const context = (warnings: Warning[]) =>
    ({
      trx: database.db,
      db: database.db,
      workspaceId: 1,
      remap: { id: (_kind: string, id: string) => id, field: () => undefined },
      refs: { get: () => null, preload: async () => {} },
      warn: (w: Warning) => warnings.push(w),
    }) as unknown as LoadContext;
  const statuses = async () =>
    new Map(
      (
        await database.db
          .selectFrom('status')
          .select(['id', 'name'])
          .where('workspace_id', '=', 1)
          .execute()
      ).map((s) => [s.name, s.id]),
    );
  const load = async (cmd: WorkflowCommand) => {
    const warnings: Warning[] = [];
    const ctx = context(warnings);
    const plan = await workflows.plan(ctx, cmd, null, 'source-1');
    expect(plan.action).toBe('create');
    const id = await workflows.apply(ctx, cmd, plan);
    const version = await database.db
      .selectFrom('workflow as w')
      .innerJoin('workflow_version as v', (j) =>
        j.onRef('v.workflow_id', '=', 'w.id').onRef('v.version', '=', 'w.published_version'),
      )
      .select(['v.version', 'v.definition'])
      .where('w.id', '=', id)
      .executeTakeFirstOrThrow();
    return {
      version: version.version,
      definition: version.definition as unknown as {
        transitions: { name: string; from: unknown; to: number; effects?: unknown }[];
      },
    };
  };

  it('[WF-008] [IMP-004] publishes it with a move into every status, as a new workflow gets them (T-246)', async () => {
    const s = await statuses();
    const ids = [s.get('New'), s.get('Active'), s.get('Closed')] as number[];
    const { version, definition } = await load({
      kind: 'workflow',
      name: 'Only a create action',
      description: '',
      isDefault: false,
      definition: {
        initialStatusId: ids[0] as number,
        statuses: ids.map((statusId) => ({ statusId })),
        transitions: [],
      },
    });
    expect(version).toBe(1);
    expect(definition.transitions.map((t) => [t.name, t.from, t.to])).toEqual([
      ['New', 'any', ids[0]],
      ['Active', 'any', ids[1]],
      ['Closed', 'any', ids[2]],
    ]);
  });

  it('[WF-008] [IMP-004] keeps the transitions of one that has any, as converted (T-246)', async () => {
    const s = await statuses();
    const ids = [s.get('New'), s.get('Active')] as number[];
    const { definition } = await load({
      kind: 'workflow',
      name: 'With its own move',
      description: '',
      isDefault: false,
      definition: {
        initialStatusId: ids[0] as number,
        statuses: ids.map((statusId) => ({ statusId })),
        transitions: [{ id: 11, name: 'Start', from: [ids[0] as number], to: ids[1] as number }],
      },
    });
    expect(definition.transitions.map((t) => [t.name, t.from, t.to])).toEqual([
      ['Start', [ids[0]], ids[1]],
    ]);
  });
});
