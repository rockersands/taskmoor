import { describe, expect, it } from 'vitest';
import { up } from './migrations/0091_board_kind_decides_backlog';
import { useMigratedDatabase } from './testing';

/** Migration 0091 (ADR-116): existing tracks' backlog and sprints follow their board's kind. */
describe('backlog and sprints follow the board on upgrade', () => {
  const database = useMigratedDatabase();

  const track = async (key: string, on: boolean, kind: 'scrum' | 'kanban' | null) => {
    const { db } = database;
    const policy = await db
      .selectFrom('access_policy')
      .select('id')
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    const { id } = await db
      .insertInto('track')
      .values({
        workspace_id: 1,
        key,
        name: key,
        access_policy_id: policy.id,
        feature_backlog: on,
        feature_sprints: on,
        feature_timeline: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (kind) {
      await db
        .insertInto('board')
        .values({
          workspace_id: 1,
          name: key,
          kind,
          location_track_id: id,
          location_user_id: null,
          filter_query: `track = ${key}`,
          sub_filter_query: null,
          columns: JSON.stringify([]),
          swimlanes: JSON.stringify({ mode: 'none', lanes: [] }),
          card_rules: JSON.stringify({}),
          created_by: null,
        })
        .execute();
    }
    return id;
  };

  const read = (id: number) =>
    database.db
      .selectFrom('track')
      .select(['feature_backlog', 'feature_sprints', 'feature_timeline'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('[CORE-002] turns them off on a Kanban track, on on a Scrum one, and leaves the rest', async () => {
    const kanbanOn = await track('KOH', true, 'kanban');
    const scrumOff = await track('SOF', false, 'scrum');
    const noBoard = await track('NOB', true, null);
    await up(database.db as never);
    expect(await read(kanbanOn)).toEqual({
      feature_backlog: false,
      feature_sprints: false,
      feature_timeline: false,
    });
    expect(await read(scrumOff)).toEqual({
      feature_backlog: true,
      feature_sprints: true,
      feature_timeline: false,
    });
    // No board yet: the first one aligns them when it is made.
    expect(await read(noBoard)).toEqual({
      feature_backlog: true,
      feature_sprints: true,
      feature_timeline: false,
    });
  });
});
