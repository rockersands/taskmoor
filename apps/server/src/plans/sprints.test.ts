import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { inActiveSprint, sprintDay } from './sprints';

// Made for this run: no password is written in the repository.
const PASSWORD = `sprints-${randomBytes(18).toString('base64url')}`;

/**
 * A plan ticket's sprints (ADR-122 stages 2 and 7): the day it is dated by through its sprint,
 * which the Timeline draws and the auto-scheduler ends an undated blocker on, and whether it is
 * in an active sprint, which a run keeps. Only Scrum boards' sprints count, never a deleted one.
 */
describe('a plan ticket’s sprints (PLN-006, PLN-004)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const t: Record<string, number> = {};
  const boards: Record<'scrum' | 'kanban', number> = { scrum: 0, kanban: 0 };
  let sequence = 0;
  let adminId = 0;

  const sprint = async (
    kind: 'scrum' | 'kanban',
    state: 'future' | 'active' | 'closed',
    days: [string, string] | null,
    deleted = false,
  ) =>
    (
      await database.db
        .insertInto('sprint')
        .values({
          workspace_id: 1,
          board_id: boards[kind],
          name: `Sprint ${++sequence}`,
          sequence,
          state,
          start_at: days ? new Date(days[0]) : null,
          end_at: days ? new Date(days[1]) : null,
          started_at: state === 'future' ? null : new Date(),
          completed_at: state === 'closed' ? new Date() : null,
          deleted_at: deleted ? new Date() : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const member = (sprintId: number, ticket: string, open: boolean) =>
    database.db
      .insertInto('sprint_ticket')
      .values({ workspace_id: 1, sprint_id: sprintId, ticket_id: t[ticket] as number, open })
      .execute();
  const read = async () => {
    const rows = (
      await sql<{ id: number; active: boolean; start: string | null; end: string | null }>`
        SELECT k.id, ${inActiveSprint()} AS active,
               ${sprintDay('start_at')}::text AS start, ${sprintDay('end_at')}::text AS end
          FROM ticket k WHERE k.id = ANY(${Object.values(t)}::int[])`.execute(database.db)
    ).rows;
    const name = new Map(Object.entries(t).map(([k, v]) => [v, k]));
    const seen: Record<string, { active: boolean; start: string | null; end: string | null }> = {};
    for (const r of rows)
      seen[name.get(r.id) ?? ''] = { active: r.active, start: r.start, end: r.end };
    return seen;
  };

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    adminId = (
      await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: 'admin@example.com',
          name: 'admin',
          password_hash: await hashPassword(PASSWORD),
          is_site_admin: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
    });
    const header = session.headers['set-cookie'];
    const cookie =
      (
        (Array.isArray(header) ? header : [header ?? '']).find(
          (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
        ) ?? ''
      ).split(';')[0] ?? '';
    const track = await app.inject({
      method: 'POST',
      url: '/api/v1/tracks',
      headers: { cookie },
      payload: { key: 'SPR', name: 'Sprints', mode: 'shared' },
    });
    expect(track.statusCode, track.body).toBe(201);
    for (const name of [
      'active',
      'future',
      'removed',
      'kanban',
      'none',
      'next',
      'past',
      'deleted',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tickets',
        headers: { cookie },
        payload: { track: 'SPR', summary: name },
      });
      expect(res.statusCode, res.body).toBe(201);
      t[name] = res.json().ticket.id;
    }
    for (const kind of ['scrum', 'kanban'] as const) {
      boards[kind] = (
        await database.db
          .insertInto('board')
          .values({
            workspace_id: 1,
            name: `SPR ${kind}`,
            kind,
            // A person's own boards: a track holds one board at most.
            location_track_id: null,
            location_user_id: adminId,
            filter_query: 'track = SPR',
            sub_filter_query: null,
            columns: JSON.stringify([]),
            swimlanes: JSON.stringify({ kind: 'none' }),
            card_rules: JSON.stringify([]),
            created_by: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    const first = await sprint('scrum', 'closed', ['2027-01-04T00:00:00Z', '2027-01-15T23:30:00Z']);
    const second = await sprint('scrum', 'closed', [
      '2027-01-18T00:00:00Z',
      '2027-01-29T00:00:00Z',
    ]);
    const binned = await sprint(
      'scrum',
      'closed',
      ['2027-02-01T00:00:00Z', '2027-02-12T00:00:00Z'],
      true,
    );
    const active = await sprint('scrum', 'active', [
      '2027-02-15T00:00:00Z',
      '2027-02-26T00:00:00Z',
    ]);
    const future = await sprint('scrum', 'future', [
      '2027-03-01T00:00:00Z',
      '2027-03-12T00:00:00Z',
    ]);
    const kanban = await sprint('kanban', 'active', [
      '2027-02-15T00:00:00Z',
      '2027-02-26T00:00:00Z',
    ]);
    await member(active, 'active', true);
    await member(future, 'future', true);
    // Taken out of the active sprint: its membership is no longer open.
    await member(active, 'removed', false);
    await member(kanban, 'kanban', true);
    // An open sprint wins over a later-numbered one it was in before.
    await member(future, 'next', true);
    await member(binned, 'next', false);
    // Only closed sprints: the latest of them, never a deleted one.
    await member(first, 'past', false);
    await member(second, 'past', false);
    await member(first, 'deleted', false);
    await member(binned, 'deleted', false);
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('[PLN-004] says a ticket is in an active sprint only for an open membership of an active Scrum sprint', async () => {
    const seen = await read();
    expect(
      Object.entries(seen)
        .filter(([, v]) => v.active)
        .map(([k]) => k),
    ).toEqual(['active']);
  });

  it('[PLN-006] [PLN-004] dates a ticket by its open sprint, else its latest, in UTC', async () => {
    const seen = await read();
    expect(seen.active).toMatchObject({ start: '2027-02-15', end: '2027-02-26' });
    expect(seen.future).toMatchObject({ start: '2027-03-01', end: '2027-03-12' });
    expect(seen.next).toMatchObject({ start: '2027-03-01', end: '2027-03-12' });
    expect(seen.removed).toMatchObject({ start: '2027-02-15', end: '2027-02-26' });
    expect(seen.past).toMatchObject({ start: '2027-01-18', end: '2027-01-29' });
    // A deleted sprint dates nothing; 23:30 UTC is still the 15th.
    expect(seen.deleted).toMatchObject({ start: '2027-01-04', end: '2027-01-15' });
    // A Kanban board's sprint, or none at all, dates nothing.
    expect(seen.kanban).toMatchObject({ start: null, end: null });
    expect(seen.none).toMatchObject({ start: null, end: null });
  });
});
