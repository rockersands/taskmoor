import { describe, expect, it } from 'vitest';
import { up } from './migrations/0095_points_field';
import { useMigratedDatabase } from './testing';

/** Migration 0095: a Points field per workspace, and the boards that estimate with it. */
describe('the Points field on upgrade', () => {
  const database = useMigratedDatabase();

  const workspace = async (key: string) => {
    const { db } = database;
    const { id } = await db
      .insertInto('workspace')
      .values({ key, name: key })
      .returning('id')
      .executeTakeFirstOrThrow();
    const policy = await db
      .insertInto('access_policy')
      .values({ workspace_id: id, name: `${key} policy` })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id, policy: policy.id };
  };

  const board = async (
    ws: { id: number; policy: number },
    key: string,
    sprintSettings?: unknown,
    mode: 'shared' | 'local' = 'shared',
  ) => {
    const { db } = database;
    const track = await db
      .insertInto('track')
      .values({ workspace_id: ws.id, key, name: key, access_policy_id: ws.policy, mode })
      .returning('id')
      .executeTakeFirstOrThrow();
    const made = await db
      .insertInto('board')
      .values({
        workspace_id: ws.id,
        name: key,
        kind: 'kanban',
        location_track_id: track.id,
        location_user_id: null,
        filter_query: `track = ${key}`,
        sub_filter_query: null,
        columns: JSON.stringify([]),
        swimlanes: JSON.stringify({ mode: 'none', lanes: [] }),
        card_rules: JSON.stringify({}),
        ...(sprintSettings === undefined
          ? {}
          : { sprint_settings: JSON.stringify(sprintSettings) }),
        created_by: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id: made.id, track: track.id };
  };

  const settingsOf = async (id: number) =>
    (
      await database.db
        .selectFrom('board')
        .select('sprint_settings')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).sprint_settings as Record<string, unknown>;

  const fieldsOf = (id: number) =>
    database.db
      .selectFrom('field')
      .select(['id', 'name', 'type', 'track_id'])
      .where('workspace_id', '=', id)
      .orderBy('id')
      .execute();

  const addField = async (ws: number, name: string, type = 'number', trackId?: number) =>
    (
      await database.db
        .insertInto('field')
        .values({ workspace_id: ws, name, type: type as never, track_id: trackId ?? null })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

  const defaults = { timeTracking: 'remainingEstimate', parallelSprints: false };
  const timeDefault = { estimation: { statistic: 'originalEstimate' }, ...defaults };

  it('[AGL-007] a new install has the field, over every track and type', async () => {
    const [field] = await fieldsOf(1);
    expect(field).toMatchObject({ name: 'Points', type: 'number', track_id: null });
    const scope = await database.db
      .selectFrom('field_context_scope')
      .select(['track_id', 'ticket_type_id'])
      .where('field_id', '=', field?.id as number)
      .execute();
    expect(scope).toEqual([{ track_id: null, ticket_type_id: null }]);
  });

  it('[AGL-007] makes the field where there is none and points the default boards at it', async () => {
    const ws = await workspace('plain');
    const untouched = await board(ws, 'PLAIN');
    const withSettings = await board(ws, 'SET', {
      estimation: { statistic: 'originalEstimate' },
      timeTracking: 'none',
      parallelSprints: true,
    });
    await up(database.db as never);
    const fields = await fieldsOf(ws.id);
    expect(fields.map((f) => f.name)).toEqual(['Points']);
    const fieldId = fields[0]?.id as number;
    expect(await settingsOf(untouched.id)).toMatchObject({
      ...defaults,
      estimation: { statistic: 'field', fieldId },
    });
    expect(await settingsOf(withSettings.id)).toEqual({
      estimation: { statistic: 'field', fieldId },
      timeTracking: 'none',
      parallelSprints: true,
    });
  });

  it("[AGL-007] uses an administrator's own field and makes no second one", async () => {
    for (const [key, name] of [
      ['STORY', 'Story points'],
      ['PUNTOS', ' puntos '],
    ] as const) {
      const ws = await workspace(key.toLowerCase());
      const own = await addField(ws.id, name);
      await addField(ws.id, 'Value');
      const made = await board(ws, key);
      await up(database.db as never);
      expect((await fieldsOf(ws.id)).map((f) => f.name)).toEqual([name, 'Value']);
      expect((await settingsOf(made.id)).estimation).toEqual({ statistic: 'field', fieldId: own });
    }
  });

  it('[AGL-007] takes the oldest when there are several', async () => {
    const ws = await workspace('several');
    const oldest = await addField(ws.id, 'Story points');
    await addField(ws.id, 'Points');
    const made = await board(ws, 'SEV');
    await up(database.db as never);
    expect((await settingsOf(made.id)).estimation).toEqual({ statistic: 'field', fieldId: oldest });
  });

  it('[AGL-007] leaves a board that chose something, or that estimates in time', async () => {
    const { db } = database;
    const policy = await db
      .selectFrom('access_policy')
      .select('id')
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    const ws = { id: 1, policy: policy.id };
    const other = await addField(1, 'Value');
    const named = { estimation: { statistic: 'field', fieldId: other }, ...defaults };
    const counting = { estimation: { statistic: 'ticketCount' }, ...defaults };
    const namesField = await board(ws, 'NAMED', named);
    const countsTickets = await board(ws, 'COUNT', counting);
    const inTime = await board(ws, 'TIME', timeDefault);
    const sized = await board(ws, 'SIZE', timeDefault);
    const type = await db
      .selectFrom('ticket_type')
      .select('id')
      .where('workspace_id', '=', 1)
      .executeTakeFirstOrThrow();
    const common = {
      workspace_id: 1,
      number: 1,
      ticket_type_id: type.id,
      summary: 'A ticket',
    };
    await db
      .insertInto('ticket')
      .values([
        { ...common, rank: '00000001', track_id: inTime.track, original_estimate: 3600 },
        { ...common, rank: '00000002', track_id: sized.track },
      ])
      .execute();
    await up(db as never);
    expect(await settingsOf(namesField.id)).toEqual(named);
    expect(await settingsOf(countsTickets.id)).toEqual(counting);
    expect(await settingsOf(inTime.id)).toEqual(timeDefault);
    expect((await settingsOf(sized.id)).estimation).toEqual({
      statistic: 'field',
      fieldId: (await fieldsOf(1))[0]?.id,
    });
  });

  it("[AGL-007] a local-mode track's board uses its track's own field", async () => {
    const ws = await workspace('local');
    const made = await board(ws, 'LOC', undefined, 'local');
    const local = await addField(ws.id, 'Points', 'number', made.track);
    const shared = await board(ws, 'SHA');
    await up(database.db as never);
    expect((await settingsOf(made.id)).estimation).toEqual({ statistic: 'field', fieldId: local });
    const sharedField = (await fieldsOf(ws.id)).find((f) => f.track_id === null);
    expect(sharedField?.name).toBe('Points');
    expect((await settingsOf(shared.id)).estimation).toEqual({
      statistic: 'field',
      fieldId: sharedField?.id,
    });
  });

  it('[AGL-007] a shared field of another type holding the name is left alone', async () => {
    const ws = await workspace('text');
    const taken = await addField(ws.id, 'Points', 'text');
    const made = await board(ws, 'TXT', timeDefault);
    await up(database.db as never);
    expect((await fieldsOf(ws.id)).map((f) => f.id)).toEqual([taken]);
    expect(await settingsOf(made.id)).toEqual(timeDefault);
  });

  it('[AGL-007] runs twice without a second field', async () => {
    const before = await fieldsOf(1);
    await up(database.db as never);
    expect(await fieldsOf(1)).toEqual(before);
  });
});
