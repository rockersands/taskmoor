import { beforeAll, describe, expect, it } from 'vitest';
import { up } from './migrations/0093_board_card_defaults';
import { useMigratedDatabase } from './testing';

/** Migration 0093 (AGL-006): a board on the old default cards takes the new one; others stay. */
describe('board cards on upgrade', () => {
  const database = useMigratedDatabase();
  let policy = 0;
  let tracks = 0;

  beforeAll(async () => {
    policy = (
      await database.db
        .selectFrom('access_policy')
        .select('id')
        .where('is_default', '=', true)
        .executeTakeFirstOrThrow()
    ).id;
  });

  /** A board on a track of its own: a track has one board. */
  const board = async (name: string, cardRules: unknown) => {
    const { db } = database;
    const key = `CARD${++tracks}`;
    const track = await db
      .insertInto('track')
      .values({ workspace_id: 1, key, name: key, access_policy_id: policy })
      .returning('id')
      .executeTakeFirstOrThrow();
    const { id } = await db
      .insertInto('board')
      .values({
        workspace_id: 1,
        name,
        kind: 'kanban',
        location_track_id: track.id,
        location_user_id: null,
        filter_query: `track = ${key}`,
        sub_filter_query: null,
        columns: JSON.stringify([]),
        swimlanes: JSON.stringify({ mode: 'none', lanes: [] }),
        card_rules: JSON.stringify(cardRules),
        created_by: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return id;
  };

  const rules = async (id: number) =>
    (
      await database.db
        .selectFrom('board')
        .select('card_rules')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).card_rules;

  const OLD = {
    colourBy: 'type',
    colours: [],
    fields: ['assignee', 'priority'],
    daysInColumn: true,
  };

  it('[AGL-006] gives a board on the old default the new one, with nothing else moved', async () => {
    const id = await board('Untouched', OLD);
    const before = await database.db
      .selectFrom('board')
      .select(['version', 'updated_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    await up(database.db as never);
    expect(await rules(id)).toEqual({
      colourBy: 'none',
      colours: [],
      fields: ['priority', 'assignee', 'points'],
      daysInColumn: false,
    });
    expect(
      await database.db
        .selectFrom('board')
        .select(['version', 'updated_at'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
  });

  it('[AGL-006] keeps a colour or days setting someone changed, and updates the fields', async () => {
    const colour = await board('Coloured', { ...OLD, colourBy: 'priority' });
    const days = await board('No days', { ...OLD, daysInColumn: false });
    await up(database.db as never);
    expect(await rules(colour)).toEqual({
      ...OLD,
      colourBy: 'priority',
      fields: ['priority', 'assignee', 'points'],
    });
    expect(await rules(days)).toEqual({
      ...OLD,
      daysInColumn: false,
      fields: ['priority', 'assignee', 'points'],
    });
  });

  it('[AGL-006] leaves fields someone chose as they are', async () => {
    const chosen = [
      { ...OLD, fields: ['assignee', 'labels'] },
      { ...OLD, fields: ['priority', 'assignee'] },
      { ...OLD, fields: [] },
    ];
    const ids = await Promise.all(chosen.map((rule, i) => board(`Chosen ${i}`, rule)));
    await up(database.db as never);
    expect(await Promise.all(ids.map(rules))).toEqual(chosen);
  });
});
