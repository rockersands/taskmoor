import { createDatabase, testPgAdminUrl } from '@taskmoor/testkit/pg';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createDb } from './client';
import { migrateTo, migrateToLatest } from './migrate';

describe('migration 0011 with existing tracks (M1-007)', () => {
  it('[CORE-003] gives shared tracks the default type set of their type and local tracks their own copy', async () => {
    const database = await createDatabase(testPgAdminUrl());
    const db = createDb({ connectionString: database.url, maxConnections: 2 });
    try {
      await migrateTo(db, '0010_identity_providers');
      await sql`
        INSERT INTO track (workspace_id, key, name, type, mode, access_policy_id)
        SELECT 1, t.key, t.key, t.type, t.mode, p.id
          FROM access_policy p,
               (VALUES ('SHR', 'software', 'shared'), ('BIZ', 'business', 'shared'),
                       ('LOC', 'software', 'local'), ('IDEA', 'discovery', 'local')) AS t (key, type, mode)
         WHERE p.is_default`.execute(db);
      await migrateToLatest(db);

      const sets = await db
        .selectFrom('type_set as s')
        .leftJoin('track as o', 'o.id', 's.owner_track_id')
        .leftJoin('ticket_type as d', 'd.id', 's.default_type_id')
        .select((eb) => [
          's.id',
          's.name',
          'o.key as owner',
          'd.name as preselected',
          eb
            .selectFrom('type_set_member as m')
            .innerJoin('ticket_type as t', 't.id', 'm.ticket_type_id')
            .select(sql<string>`string_agg(t.name, ', ' ORDER BY m.sort_order)`.as('types'))
            .whereRef('m.type_set_id', '=', 's.id')
            .as('types'),
        ])
        .orderBy('s.id')
        .execute();
      expect(sets.map(({ id: _, ...set }) => set)).toEqual([
        {
          name: 'Software type set',
          owner: null,
          preselected: 'Feature',
          types: 'Outcome, Feature, Bug, Chore, Subticket',
        },
        {
          name: 'Business type set',
          owner: null,
          preselected: 'To-do',
          types: 'Outcome, To-do, Subticket',
        },
        { name: 'Discovery type set', owner: null, preselected: 'Idea', types: 'Idea' },
        {
          name: 'LOC local type set',
          owner: 'LOC',
          preselected: 'Feature',
          types: 'Outcome, Feature, Bug, Chore, Subticket',
        },
        { name: 'IDEA local type set', owner: 'IDEA', preselected: 'Idea', types: 'Idea' },
      ]);
      const setOf = Object.fromEntries(sets.map((s) => [s.name, s.id]));
      const tracks = await db
        .selectFrom('track')
        .select(['key', 'type_set_id'])
        .orderBy('key')
        .execute();
      expect(tracks).toEqual([
        { key: 'BIZ', type_set_id: setOf['Business type set'] },
        { key: 'IDEA', type_set_id: setOf['IDEA local type set'] },
        { key: 'LOC', type_set_id: setOf['LOC local type set'] },
        { key: 'SHR', type_set_id: setOf['Software type set'] },
      ]);
    } finally {
      await db.destroy();
      await database.drop();
    }
  });
});
