import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `plan-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.88.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (
      list.find(
        (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
      ) ?? ''
    ).split(';')[0] ?? ''
  );
}

interface BacklogJson {
  track: { id: number; key: string } | null;
  sprints: { id: number; tickets: { key: string }[] }[];
  backlog: {
    tickets: { id: number; key: string; parentId: number | null; releaseIds: number[] }[];
  };
}

/**
 * Planning on the backlog through the API (M1-047; AGL-008, AGL-009): a block of selected
 * tickets ranked together, fifty moved into a sprint in one operation, tickets put under an
 * outcome and added to a release from the panels, and the refusals of the ticket routes passed
 * on per ticket.
 */
describe('backlog planning (M1-047)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const t: Record<string, { id: number; key: string }> = {};
  let board = 0;
  let release = 0;
  let trackId = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const call = async (who: string, options: InjectOptions, code = 200) => {
    const res = await as(who, options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body}`).toBe(code);
    return res.json();
  };
  const post = (who: string, path: string, payload: unknown, code = 200) =>
    call(
      who,
      {
        method: 'POST',
        url: `/api/v1/boards/${board}/${path}`,
        payload: payload as Record<string, unknown>,
      },
      code,
    );
  const backlog = async (): Promise<BacklogJson> =>
    call('alice', { method: 'GET', url: `/api/v1/boards/${board}/backlog?limit=10000` });
  const order = async () => (await backlog()).backlog.tickets.map((x) => x.key.split('-')[1]);

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['carol', false],
    ] as const) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: admin,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      users[name] = { id: row.id, cookie: sessionCookie(res.headers['set-cookie']) };
    }
    trackId = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'BP', name: 'Planning', mode: 'shared' },
        },
        201,
      )
    ).track.id;
    const members = (await database.db.selectFrom('role').select(['id', 'name']).execute()).find(
      (r) => r.name === 'Members',
    )?.id as number;
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: trackId,
        role_id: members,
        user_id: users.alice?.id as number,
      })
      .execute();
    const outcomeType = await database.db
      .selectFrom('ticket_type as y')
      .innerJoin('hierarchy_level as h', 'h.id', 'y.level_id')
      .select('y.id')
      .where('h.kind', '=', 'outcome')
      .where('y.owner_track_id', 'is', null)
      .executeTakeFirstOrThrow();
    t.goal = (
      await call(
        'alice',
        {
          method: 'POST',
          url: '/api/v1/tickets',
          payload: { track: 'BP', summary: 'Goal', ticketTypeId: outcomeType.id },
        },
        201,
      )
    ).ticket;
    for (const n of [1, 2, 3, 4, 5, 6]) {
      t[`t${n}`] = (
        await call(
          'alice',
          {
            method: 'POST',
            url: '/api/v1/tickets',
            payload: { track: 'BP', summary: `plan ${n}` },
          },
          201,
        )
      ).ticket;
    }
    release = (
      await call(
        'admin',
        { method: 'POST', url: `/api/v1/tracks/${trackId}/releases`, payload: { name: '1.0' } },
        201,
      )
    ).release.id;
    board = (
      await call(
        'alice',
        {
          method: 'POST',
          url: '/api/v1/boards',
          payload: {
            name: 'Planning',
            kind: 'scrum',
            trackId,
            source: { query: 'track = BP AND summary ~ plan' },
          },
        },
        201,
      )
    ).board.id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('[AGL-009] ranks a block of selected tickets together, in the order given', async () => {
    expect(await order()).toEqual(['2', '3', '4', '5', '6', '7']);
    // plan 5 and plan 3, in that order, before plan 1.
    const ranked = await post('alice', 'backlog/rank', {
      tickets: [t.t5?.id, t.t3?.id],
      before: t.t1?.id,
    });
    expect(ranked).toMatchObject({ ranked: 2 });
    expect(await order()).toEqual(['6', '4', '2', '3', '5', '7']);
    await post('alice', 'backlog/rank', { tickets: [t.t1?.id, t.t2?.id], position: 'bottom' });
    expect(await order()).toEqual(['6', '4', '5', '7', '2', '3']);
    expect(
      (await post('alice', 'backlog/rank', { tickets: [t.t1?.id], before: t.t1?.id }, 400)).fields,
    ).toEqual({ before: 'selected' });
    expect((await post('alice', 'backlog/rank', { tickets: [t.t1?.id] }, 400)).error).toBe(
      'invalid_fields',
    );
  });

  it('[AGL-008] moves fifty selected tickets into a sprint in one operation', async () => {
    const fifty: number[] = [];
    for (let n = 0; n < 50; n++) {
      fifty.push(
        (
          await call(
            'alice',
            {
              method: 'POST',
              url: '/api/v1/tickets',
              payload: { track: 'BP', summary: `plan bulk ${n}` },
            },
            201,
          )
        ).ticket.id,
      );
    }
    const sprint = (await post('alice', 'sprints', { name: 'Sprint 1' }, 201)).sprint.id;
    const before = await database.db
      .selectFrom('domain_event')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    await call('alice', {
      method: 'POST',
      url: `/api/v1/sprints/${sprint}/tickets`,
      payload: { tickets: fifty },
    });
    const after = await database.db
      .selectFrom('domain_event')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    // One operation: one event for the fifty.
    expect(Number(after.n) - Number(before.n)).toBe(1);
    const view = await backlog();
    expect(view.sprints.find((s) => s.id === sprint)?.tickets).toHaveLength(50);
  });

  it('[AGL-008] puts tickets under an outcome and into a release from the panels', async () => {
    const panels = await call('alice', {
      method: 'GET',
      url: `/api/v1/boards/${board}/backlog/panels`,
    });
    expect(panels.outcomes).toEqual([
      { id: t.goal?.id, key: t.goal?.key, summary: 'Goal', status: 'New', tickets: 0, closed: 0 },
    ]);
    expect(panels.releases).toEqual([
      { id: release, name: '1.0', trackId, releaseDate: null, tickets: 0 },
    ]);
    expect(
      await post('alice', 'backlog/parent', { tickets: [t.t1?.id, t.t2?.id], parent: t.goal?.key }),
    ).toMatchObject({ updated: 2 });
    expect(
      await post('alice', 'backlog/release', { tickets: [t.t1?.id, t.t3?.id], releaseId: release }),
    ).toMatchObject({ updated: 2 });
    // Again: already there, nothing changes, still done.
    expect(
      await post('alice', 'backlog/release', { tickets: [t.t1?.id], releaseId: release }),
    ).toMatchObject({ updated: 1 });
    const tickets = (await backlog()).backlog.tickets;
    const of = (name: string) => tickets.find((x) => x.id === t[name]?.id);
    expect([of('t1')?.parentId, of('t2')?.parentId, of('t3')?.parentId]).toEqual([
      t.goal?.id,
      t.goal?.id,
      null,
    ]);
    expect([of('t1')?.releaseIds, of('t3')?.releaseIds, of('t2')?.releaseIds]).toEqual([
      [release],
      [release],
      [],
    ]);
    const after = await call('alice', {
      method: 'GET',
      url: `/api/v1/boards/${board}/backlog/panels`,
    });
    expect([after.outcomes[0].tickets, after.releases[0].tickets]).toEqual([2, 2]);
    // Taken from the outcome again.
    await post('alice', 'backlog/parent', { tickets: [t.t2?.id], parent: null });
    expect((await backlog()).backlog.tickets.find((x) => x.id === t.t2?.id)?.parentId).toBeNull();
  });

  it('[AGL-008] passes on the ticket routes’ refusals per ticket', async () => {
    // A ticket cannot be its own parent: one refused, one done.
    const mixed = await post('alice', 'backlog/parent', {
      tickets: [t.goal?.id, t.t4?.id],
      parent: t.goal?.id,
    });
    expect(mixed.updated).toBe(1);
    expect(mixed.results.map((r: { ok: boolean }) => r.ok)).toEqual([false, true]);
    // Nothing through: the first refusal answers.
    const refused = await as('alice', {
      method: 'POST',
      url: `/api/v1/boards/${board}/backlog/parent`,
      payload: { tickets: [t.goal?.id], parent: t.goal?.id },
    });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(refused.json().results).toHaveLength(1);
    // Someone who does not see the board.
    await post('carol', 'backlog/rank', { tickets: [t.t1?.id], position: 'top' }, 404);
  });
});
