import { useMigratedDatabase } from '@taskmoor/db/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { FieldCatalogs } from '../fields/catalog';
import { type LoadContext, PENDING } from './load';
import { boards } from './load-agile';
import type { BoardCommand, Warning } from './model';

/** One board per track, inside it (ADR-116): what an import writes on a track's first board. */
describe('an imported board stays inside its track', () => {
  const database = useMigratedDatabase();
  const track: Record<string, number> = {};
  let catalog: unknown;
  const command = (name: string, query: string | null): BoardCommand => ({
    kind: 'board',
    name,
    description: '',
    boardKind: 'kanban',
    track: { kind: 'track', id: '1' },
    query,
    columns: [],
  });
  const context = (trackId: number, warnings: Warning[], dryRun = false) =>
    ({
      trx: database.db,
      db: database.db,
      workspaceId: 1,
      catalog,
      system: 'test',
      importSource: 'test',
      dryRun,
      refs: { get: () => trackId },
      warn: (w: Warning) => warnings.push(w),
    }) as unknown as LoadContext;

  /** Runs the loader for a new board of the track and reads what it wrote. */
  const load = async (key: string, query: string | null) => {
    const warnings: Warning[] = [];
    const ctx = context(track[key] as number, warnings);
    const cmd = command(`Board of ${key}`, query);
    const plan = await boards.plan(ctx, cmd, null, key);
    const id = await boards.apply(ctx, cmd, plan);
    const row = await database.db
      .selectFrom('board')
      .select(['filter_query', 'location_track_id'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { id, cmd, warnings, row };
  };

  beforeAll(async () => {
    catalog = await new FieldCatalogs(database.db).get(1);
    const policy = await database.db
      .selectFrom('access_policy')
      .select('id')
      .orderBy('id')
      .executeTakeFirstOrThrow();
    for (const key of ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE']) {
      const row = await database.db
        .insertInto('track')
        .values({ workspace_id: 1, key, name: key, access_policy_id: policy.id })
        .returning('id')
        .executeTakeFirstOrThrow();
      track[key] = row.id;
    }
  });

  it('[AGL-001] [IMP-004] narrows a query across tracks to its track and reports what was lost', async () => {
    const { warnings, row } = await load('ONE', 'track IN (ONE, TWO)');
    expect(row).toEqual({ filter_query: 'track = "ONE"', location_track_id: track.ONE });
    expect(warnings).toEqual([
      { code: 'board_query_narrowed_to_track', detail: 'Board of ONE: track IN (ONE, TWO)' },
    ]);
  });

  it('[AGL-001] [IMP-004] narrows a query that shows another track, or no one track', async () => {
    const other = await load('TWO', 'track = ONE');
    expect(other.row.filter_query).toBe('track = "TWO"');
    expect(other.warnings.map((w) => w.code)).toEqual(['board_query_narrowed_to_track']);
    const anywhere = await load('THREE', 'track = THREE OR priority IS EMPTY');
    expect(anywhere.row.filter_query).toBe('track = "THREE"');
    expect(anywhere.warnings.map((w) => w.code)).toEqual(['board_query_narrowed_to_track']);
  });

  it('[AGL-001] [IMP-004] keeps a query already confined to the track, as written', async () => {
    const { warnings, row } = await load('FOUR', 'track = four AND assignee IS EMPTY');
    expect(row.filter_query).toBe('track = four AND assignee IS EMPTY');
    expect(warnings).toEqual([]);
  });

  it('[AGL-001] [IMP-004] [IMP-009] narrows on a later run, and a dry run warns before it writes', async () => {
    const warnings: Warning[] = [];
    const first = await load('FIVE', 'track = FIVE');
    // A later run writes the query from a board given in full.
    const across = { ...command(first.cmd.name, 'track IN (FIVE, ONE)'), boardFilters: [] };
    const ctx = context(track.FIVE as number, warnings);
    const plan = await boards.plan(ctx, across, first.id, 'FIVE');
    expect(plan.action).toBe('update');
    await boards.apply(ctx, across, plan);
    const row = await database.db
      .selectFrom('board')
      .select('filter_query')
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow();
    expect(row.filter_query).toBe('track = "FIVE"');
    expect(warnings.map((w) => w.code)).toEqual(['board_query_narrowed_to_track']);

    // A track the same batch would make has no key yet to compare with.
    const dry: Warning[] = [];
    const planned = await boards.plan(
      context(PENDING, dry, true),
      command('Planned', 'track IN (A, B)'),
      null,
      'planned',
    );
    expect(planned.action).toBe('create');
    expect(dry).toEqual([
      { code: 'board_query_narrowed_to_track', detail: 'Planned: track IN (A, B)' },
    ]);
  });
});
