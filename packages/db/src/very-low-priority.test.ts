import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { up } from './migrations/0092_very_low_priority';
import { useMigratedDatabase } from './testing';

/** Migration 0092 (CORE-014): Very low at the bottom, and every ticket with a priority. */
describe('Very low and no empty priority on upgrade', () => {
  const database = useMigratedDatabase();
  const ids: { policy: number; type: number } = { policy: 0, type: 0 };
  let number = 0;

  beforeAll(async () => {
    const { db } = database;
    const policy = await db
      .selectFrom('access_policy')
      .select('id')
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    ids.policy = policy.id;
    const type = await db
      .selectFrom('ticket_type')
      .select('id')
      .where('name', '=', 'Feature')
      .executeTakeFirstOrThrow();
    ids.type = type.id;
  });

  const list = async () =>
    (
      await database.db
        .selectFrom('priority')
        .select('name')
        .where('workspace_id', '=', 1)
        .orderBy('sort_order')
        .execute()
    ).map((p) => p.name);

  const idOf = async (name: string) =>
    (
      await database.db
        .selectFrom('priority')
        .select('id')
        .where('name', '=', name)
        .executeTakeFirstOrThrow()
    ).id;

  const defaultSet = () =>
    database.db
      .selectFrom('priority_set')
      .select(['id', 'default_priority_id'])
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();

  const members = async (setId: number) =>
    (
      await database.db
        .selectFrom('priority_set_member')
        .select('priority_id')
        .where('priority_set_id', '=', setId)
        .execute()
    ).map((m) => m.priority_id);

  const track = async (key: string, setId: number | null = null) =>
    (
      await database.db
        .insertInto('track')
        .values({
          workspace_id: 1,
          key,
          name: key,
          access_policy_id: ids.policy,
          priority_set_id: setId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

  const ticket = async (trackId: number, priorityId: number | null = null) =>
    (
      await database.db
        .insertInto('ticket')
        .values({
          workspace_id: 1,
          track_id: trackId,
          number: ++number,
          ticket_type_id: ids.type,
          summary: 'A ticket',
          rank: String(number).padStart(8, '0'),
          priority_id: priorityId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

  const priorityOf = async (id: number) =>
    (
      await database.db
        .selectFrom('ticket')
        .select('priority_id')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).priority_id;

  it('[CORE-014] adds Very low at the bottom of the seeded list and the default set', async () => {
    expect(await list()).toEqual(['Urgent', 'High', 'Normal', 'Low', 'Very low']);
    const set = await defaultSet();
    expect(await members(set.id)).toContain(await idOf('Very low'));
    // The default stays what the set said.
    expect(set.default_priority_id).toBe(await idOf('Normal'));
  });

  it('[CORE-014] fills tickets with the track’s default, leaving no history, event or version', async () => {
    const { db } = database;
    const own = await db
      .insertInto('priority_set')
      .values({ workspace_id: 1, name: 'Ours' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const urgent = await idOf('Urgent');
    const high = await idOf('High');
    const low = await idOf('Low');
    await db
      .insertInto('priority_set_member')
      .values(
        [urgent, high, low].map((p) => ({
          workspace_id: 1,
          priority_set_id: own.id,
          priority_id: p,
        })),
      )
      .execute();
    const usual = await track('USUAL');
    const ours = await track('OURS', own.id);

    const plain = await ticket(usual);
    const middle = await ticket(ours);
    const chosen = await ticket(usual, low);
    const imported = await ticket(usual);
    await db
      .insertInto('import_external_id')
      .values({
        workspace_id: 1,
        import_source: 'seed',
        source_system: 'seed',
        entity_kind: 'ticket',
        source_id: 'SRC-1',
        target_id: String(imported),
        checksum: 'x',
      })
      .execute();

    const before = await db
      .selectFrom('ticket')
      .select(['version', 'updated_at'])
      .where('id', '=', plain)
      .executeTakeFirstOrThrow();
    const count = async (table: 'ticket_change' | 'domain_event') =>
      Number(
        (await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(db))
          .rows[0]?.n,
      );
    const changes = await count('ticket_change');
    const events = await count('domain_event');

    await up(db as never);

    expect(await priorityOf(plain)).toBe(await idOf('Normal'));
    // A set with no default gives the middle of what it offers.
    expect(await priorityOf(middle)).toBe(high);
    expect(await priorityOf(chosen)).toBe(low);
    // What an import left stays: its source said nothing.
    expect(await priorityOf(imported)).toBeNull();
    expect(await count('ticket_change')).toBe(changes);
    expect(await count('domain_event')).toBe(events);
    const after = await db
      .selectFrom('ticket')
      .select(['version', 'updated_at'])
      .where('id', '=', plain)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
  });

  it('[M1-014] leaves a list an administrator changed as it is', async () => {
    const { db } = database;
    const veryLow = await idOf('Very low');
    await db.deleteFrom('priority_set_member').where('priority_id', '=', veryLow).execute();
    await db.deleteFrom('priority').where('id', '=', veryLow).execute();
    await db.updateTable('priority').set({ name: 'Someday' }).where('name', '=', 'Low').execute();

    await up(db as never);

    expect(await list()).toEqual(['Urgent', 'High', 'Normal', 'Someday']);
  });

  it('[M1-014] adds it to the list but not to a default set someone narrowed', async () => {
    const { db } = database;
    await db.updateTable('priority').set({ name: 'Low' }).where('name', '=', 'Someday').execute();
    const set = await defaultSet();
    await db
      .deleteFrom('priority_set_member')
      .where('priority_set_id', '=', set.id)
      .where('priority_id', '=', await idOf('Low'))
      .execute();

    await up(db as never);

    expect(await list()).toEqual(['Urgent', 'High', 'Normal', 'Low', 'Very low']);
    expect(await members(set.id)).not.toContain(await idOf('Very low'));
  });
});
