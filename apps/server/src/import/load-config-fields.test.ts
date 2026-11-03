import { useMigratedDatabase } from '@taskmoor/db/testing';
import { describe, expect, it } from 'vitest';
import type { LoadContext } from './load';
import { fields } from './load-config';
import type { FieldCommand, Warning } from './model';

/** A backup's field whose name another field holds (the Points of migration 0095). */
describe('an imported field whose name is taken', () => {
  const database = useMigratedDatabase();
  const context = (warnings: Warning[]) =>
    ({
      trx: database.db,
      db: database.db,
      workspaceId: 1,
      remap: new Map(),
      refs: { get: () => null },
      warn: (w: Warning) => warnings.push(w),
    }) as unknown as LoadContext;
  const command = (type: FieldCommand['type']): FieldCommand => ({
    kind: 'field',
    name: 'Points',
    description: 'From the backup',
    type,
    multiple: false,
    config: {},
    track: null,
  });
  const load = async (cmd: FieldCommand, existing: number | null = null) => {
    const warnings: Warning[] = [];
    const ctx = context(warnings);
    const plan = await fields.plan(ctx, cmd, existing, 'source-1');
    const id = await fields.apply(ctx, cmd, plan);
    const row = await database.db
      .selectFrom('field')
      .select(['name', 'type'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { id, row, warnings, action: plan.action };
  };

  it('[IMP-005] links a field of the same kind, as the Points every workspace starts with', async () => {
    const { row, warnings, action } = await load(command('number'));
    expect(action).toBe('link');
    expect(row).toEqual({ name: 'Points', type: 'number' });
    expect(warnings).toEqual([]);
  });

  it('[IMP-005] [IMP-009] brings a field of another kind in under its own name, and says so', async () => {
    const first = await load(command('text'));
    expect(first.action).toBe('create');
    expect(first.row).toEqual({ name: 'Points (imported)', type: 'text' });
    expect(first.warnings).toEqual([{ code: 'field_name_taken', detail: 'Points' }]);

    // Importing again finds the same one, and leaves its name alone.
    const again = await load(command('text'), first.id);
    expect(again.id).toBe(first.id);
    expect(again.row.name).toBe('Points (imported)');
    const fresh = await load(command('text'));
    expect(fresh.action).toBe('link');
    expect(fresh.id).toBe(first.id);
  });
});
