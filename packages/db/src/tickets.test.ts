import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from './testing';

/**
 * What the ticket tables guarantee whichever path writes them (M1-008): the API, the importer
 * or direct SQL.
 */
describe('ticket tables (M1-008)', () => {
  const database = useMigratedDatabase();
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    const { db } = database;
    const policy = await db
      .selectFrom('access_policy')
      .select('id')
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    for (const key of ['ONE', 'TWO']) {
      const track = await db
        .insertInto('track')
        .values({ workspace_id: 1, key, name: key, access_policy_id: policy.id })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids[key] = track.id;
    }
    const type = await db
      .selectFrom('ticket_type')
      .select('id')
      .where('name', '=', 'Feature')
      .executeTakeFirstOrThrow();
    ids.type = type.id;
  });

  const insert = (track: string, number: number, rank: string, summary = 'A ticket') =>
    database.db
      .insertInto('ticket')
      .values({
        workspace_id: 1,
        track_id: ids[track] as number,
        number,
        ticket_type_id: ids.type as number,
        summary,
        rank,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

  const history = (ticketId: number) =>
    database.db
      .selectFrom('ticket_key_history as h')
      .innerJoin('track as t', 't.id', 'h.track_id')
      .select(['t.key', 'h.number', 'h.replaced_at'])
      .where('h.ticket_id', '=', ticketId)
      .orderBy('h.id')
      .execute();

  it('[CORE-023] records every track and number a ticket has had', async () => {
    const { id } = await insert('ONE', 1, 'a1');
    expect((await history(id)).map((h) => [h.key, h.number, h.replaced_at === null])).toEqual([
      ['ONE', 1, true],
    ]);
    await database.db
      .updateTable('ticket')
      .set({ track_id: ids.TWO as number, number: 1 })
      .where('id', '=', id)
      .execute();
    // An update that leaves track and number alone adds nothing.
    await database.db
      .updateTable('ticket')
      .set({ summary: 'Renamed' })
      .where('id', '=', id)
      .execute();
    expect((await history(id)).map((h) => [h.key, h.number, h.replaced_at === null])).toEqual([
      ['ONE', 1, false],
      ['TWO', 1, true],
    ]);
  });

  it('[CORE-001] never gives a number in a track to a second ticket, even after a move', async () => {
    // ONE-1 moved away in the test above; its number stays taken.
    await expect(insert('ONE', 1, 'a2')).rejects.toMatchObject({
      code: '23505',
      constraint: 'ticket_key_history_key',
    });
    await insert('ONE', 2, 'a3');
    await expect(insert('ONE', 2, 'a4')).rejects.toMatchObject({
      code: '23505',
      constraint: 'ticket_track_number_key',
    });
  });

  it('[AGL-009] keeps ranks unique per workspace and ordered byte by byte', async () => {
    await expect(insert('TWO', 2, 'a3')).rejects.toMatchObject({
      code: '23505',
      constraint: 'ticket_rank_key',
    });
    await insert('TWO', 2, 'aB');
    await insert('TWO', 3, 'ab');
    const { rows } = await sql<{ rank: string }>`
      SELECT rank FROM ticket WHERE rank IN ('aB', 'ab', 'a3') ORDER BY rank`.execute(database.db);
    // "C" order: digits, then upper case, then lower case, whatever the database's locale.
    expect(rows.map((r) => r.rank)).toEqual(['a3', 'aB', 'ab']);
  });

  it('[CORE-008] refuses an empty or over-long summary and a ticket as its own parent', async () => {
    await expect(insert('TWO', 10, 'a10', '')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('TWO', 11, 'a11', 'x'.repeat(256))).rejects.toMatchObject({
      code: '23514',
    });
    const { id } = await insert('TWO', 12, 'a12');
    await expect(
      database.db.updateTable('ticket').set({ parent_id: id }).where('id', '=', id).execute(),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ticket_parent_self_check' });
  });

  it('reads dates as calendar days, whatever the time zone', async () => {
    const { id } = await insert('TWO', 13, 'a13');
    await database.db
      .updateTable('ticket')
      .set({ start_date: '2026-03-29', due_date: '2026-10-25' })
      .where('id', '=', id)
      .execute();
    const row = await database.db
      .selectFrom('ticket')
      .select(['start_date', 'due_date'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ start_date: '2026-03-29', due_date: '2026-10-25' });
  });
});
