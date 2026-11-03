import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { expectWithinBudget } from '@taskmoor/testkit/budget';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `outcomes-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.79.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

interface Outcome {
  id: number;
  key: string;
  summary: string;
  type: string;
  status: { name: string; stage: string };
  startDate: string | null;
  dueDate: string | null;
  progress: { total: number; closed: number };
}
interface Page {
  track: { id: number; key: string; name: string };
  outcomeTypes: string[];
  outcomes: Outcome[];
  next: string | null;
}

/**
 * A track's Outcomes section through the API (AGL-024): the outcomes of one track with their
 * progress, open first and in rank order, a page at a time, as far as the person may see, and the
 * same on a Kanban track as on a Scrum one.
 */
describe('track outcomes (AGL-024)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const ids: Record<string, number> = {};
  const tracks: Record<string, number> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: cookies[who] ?? '' },
    });
  const outcomes = async (who: string, track: string, query = '') => {
    const res = await as(who, { method: 'GET', url: `/api/v1/tracks/${track}/outcomes${query}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Page;
  };
  /** The type of the track at a level: -1 subticket, 0 standard, 1 outcome. */
  const typeAt = async (track: string, rank: number) => {
    const types = (
      await as('admin', { method: 'GET', url: `/api/v1/tracks/${track}/ticket-types` })
    ).json().ticketTypes as { id: number; level: { rank: number } }[];
    return types.find((t) => t.level.rank === rank)?.id as number;
  };
  const create = async (body: Record<string, unknown>) => {
    const res = await as('admin', { method: 'POST', url: '/api/v1/tickets', payload: body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as { id: number; key: string };
  };
  const outcome = async (track: string, summary: string, extra: Record<string, unknown> = {}) =>
    create({ track, summary, ticketTypeId: await typeAt(track, 1), ...extra });
  const close = async (id: number) => {
    const offered = (
      await as('admin', { method: 'GET', url: `/api/v1/tickets/${id}/transitions` })
    ).json().transitions as { id: number; to: { stage: string } }[];
    const res = await as('admin', {
      method: 'POST',
      url: `/api/v1/tickets/${id}/transitions`,
      payload: { transitionId: offered.find((o) => o.to.stage === 'closed')?.id },
    });
    expect(res.statusCode, res.body).toBe(200);
  };
  const newTrack = async (key: string) => {
    const res = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key, name: `Track ${key}`, mode: 'shared' },
    });
    expect(res.statusCode, res.body).toBe(201);
    tracks[key] = res.json().track.id;
    const role = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: tracks[key] as number,
        role_id: role.id,
        user_id: ids.alice as number,
      })
      .execute();
  };

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['nobody', false],
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
      ids[name] = row.id;
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      const header = res.headers['set-cookie'];
      const list = Array.isArray(header) ? header : header ? [header] : [];
      cookies[name] =
        (list.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '').split(';')[0] ?? '';
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('[AGL-024] lists each outcome with its status, dates and children closed of all', async () => {
    await newTrack('OUT');
    const first = await outcome('OUT', 'Launch the beta', {
      startDate: '2026-11-02',
      dueDate: '2026-12-18',
    });
    const second = await outcome('OUT', 'Faster search');
    const done = await outcome('OUT', 'Old goal');
    await close(done.id);
    // A standard ticket is not an outcome.
    await create({ track: 'OUT', summary: 'Just a ticket' });
    const standard = await typeAt('OUT', 0);
    const a = await create({
      track: 'OUT',
      summary: 'A',
      ticketTypeId: standard,
      parent: first.key,
    });
    await create({ track: 'OUT', summary: 'B', ticketTypeId: standard, parent: first.key });
    await create({ track: 'OUT', summary: 'C', ticketTypeId: standard, parent: first.key });
    await close(a.id);

    const page = await outcomes('alice', 'out');
    expect(page.track).toMatchObject({ id: tracks.OUT, key: 'OUT' });
    expect(page.outcomeTypes).toEqual(['Outcome']);
    expect(page.next).toBeNull();
    // Open first, in rank order (creation order here), then closed.
    expect(page.outcomes).toEqual([
      {
        id: first.id,
        key: first.key,
        summary: 'Launch the beta',
        type: 'Outcome',
        status: { name: 'New', stage: 'new' },
        startDate: '2026-11-02',
        dueDate: '2026-12-18',
        progress: { total: 3, closed: 1 },
      },
      expect.objectContaining({
        key: second.key,
        startDate: null,
        dueDate: null,
        progress: { total: 0, closed: 0 },
      }),
      expect.objectContaining({
        key: done.key,
        status: expect.objectContaining({ stage: 'closed' }),
      }),
    ]);

    // Ranked to the top, the second leads the open ones; the closed one stays last.
    const top = await as('admin', {
      method: 'PUT',
      url: `/api/v1/tickets/${second.id}/rank`,
      payload: { position: 'top' },
    });
    expect(top.statusCode, top.body).toBe(200);
    expect((await outcomes('alice', 'OUT')).outcomes.map((o) => o.key)).toEqual([
      second.key,
      first.key,
      done.key,
    ]);
  });

  it('[AGL-024] counts only the tickets the person may see, and lists only such outcomes', async () => {
    await newTrack('HID');
    const policy = await as('admin', {
      method: 'POST',
      url: '/api/v1/visibility-policies',
      payload: {
        name: 'Outcome secrets',
        levels: [{ name: 'Admin only', members: [{ grantee: 'user', userId: ids.admin }] }],
      },
    });
    expect(policy.statusCode, policy.body).toBe(201);
    const level = policy.json().visibilityPolicy.levels[0].id as number;
    const used = await as('admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${tracks.HID}`,
      payload: { visibilityPolicyId: policy.json().visibilityPolicy.id },
    });
    expect(used.statusCode, used.body).toBe(200);
    const hide = async (id: number) => {
      const res = await as('admin', {
        method: 'PATCH',
        url: `/api/v1/tickets/${id}`,
        payload: { visibilityLevelId: level },
      });
      expect(res.statusCode, res.body).toBe(200);
    };

    const goal = await outcome('HID', 'Visible goal');
    const standard = await typeAt('HID', 0);
    const shown = await create({
      track: 'HID',
      summary: 'Shown',
      ticketTypeId: standard,
      parent: goal.key,
    });
    const hidden = await create({
      track: 'HID',
      summary: 'Hidden',
      ticketTypeId: standard,
      parent: goal.key,
    });
    await close(hidden.id);
    await hide(hidden.id);
    const secret = await outcome('HID', 'Secret goal');
    await hide(secret.id);

    // The administrator sees both children and both outcomes.
    expect((await outcomes('admin', 'HID')).outcomes).toEqual([
      expect.objectContaining({ key: goal.key, progress: { total: 2, closed: 1 } }),
      expect.objectContaining({ key: secret.key }),
    ]);
    // Alice sees neither the hidden child, closed or not, nor the hidden outcome.
    expect((await outcomes('alice', 'HID')).outcomes).toEqual([
      expect.objectContaining({ key: goal.key, progress: { total: 1, closed: 0 } }),
    ]);
    await close(shown.id);
    expect((await outcomes('alice', 'HID')).outcomes).toEqual([
      expect.objectContaining({ key: goal.key, progress: { total: 1, closed: 1 } }),
    ]);
  });

  it('[AGL-024] leaves the trash out, and counts children in other tracks', async () => {
    await newTrack('TRS');
    await newTrack('ELS');
    const goal = await outcome('TRS', 'Goal with trash');
    const standard = await typeAt('TRS', 0);
    const gone = await create({
      track: 'TRS',
      summary: 'Gone',
      ticketTypeId: standard,
      parent: goal.key,
    });
    await create({
      track: 'ELS',
      summary: 'Elsewhere',
      ticketTypeId: await typeAt('ELS', 0),
      parent: goal.key,
    });
    const trashed = await outcome('TRS', 'Trashed goal');
    for (const id of [gone.id, trashed.id]) {
      const res = await as('admin', { method: 'DELETE', url: `/api/v1/tickets/${id}` });
      expect(res.statusCode, res.body).toBe(204);
    }
    expect((await outcomes('alice', 'TRS')).outcomes).toEqual([
      expect.objectContaining({ key: goal.key, progress: { total: 1, closed: 0 } }),
    ]);
    // Another track's outcomes stay there.
    expect((await outcomes('alice', 'ELS')).outcomes).toEqual([]);
  });

  it('[AGL-024] lists outcomes on a Kanban track as on a Scrum one', async () => {
    await newTrack('KAN');
    const board = await as('admin', {
      method: 'POST',
      url: '/api/v1/boards',
      payload: {
        name: 'Flow',
        kind: 'kanban',
        trackId: tracks.KAN,
        source: { query: 'track = KAN' },
      },
    });
    expect(board.statusCode, board.body).toBe(201);
    const read = await as('alice', { method: 'GET', url: '/api/v1/tracks/KAN' });
    expect(read.json().track.sections).toEqual({ backlog: false, sprints: false });
    const goal = await outcome('KAN', 'Kanban goal');
    expect((await outcomes('alice', 'KAN')).outcomes.map((o) => o.key)).toEqual([goal.key]);
  });

  it('[AGL-024] pages past 100 outcomes, each once, with an opaque cursor', async () => {
    await newTrack('PAG');
    const type = await typeAt('PAG', 1);
    const closedStatus = await database.db
      .selectFrom('status')
      .select('id')
      .where('stage', '=', 'closed')
      .orderBy('id')
      .executeTakeFirstOrThrow();
    const openStatus = await database.db
      .selectFrom('status')
      .select('id')
      .where('name', '=', 'New')
      .executeTakeFirstOrThrow();
    // 150 outcomes, every third closed, ranked by number.
    await sql`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                          creator_id, rank)
      SELECT 1, ${tracks.PAG}::int, g, ${type}::int,
             CASE WHEN g % 3 = 0 THEN ${closedStatus.id}::int ELSE ${openStatus.id}::int END,
             'Outcome ' || g, ${ids.admin}::int, 'ypag' || lpad(g::text, 6, '0')
        FROM generate_series(1, 150) g`.execute(database.db);
    await sql`UPDATE ticket_counter SET last_number = 150 WHERE track_id = ${tracks.PAG}`.execute(
      database.db,
    );

    const one = await outcomes('alice', 'PAG');
    expect(one.outcomes).toHaveLength(100);
    expect(one.next).toEqual(expect.any(String));
    const two = await outcomes('alice', 'PAG', `?cursor=${one.next}`);
    expect(two.outcomes).toHaveLength(50);
    expect(two.next).toBeNull();
    const keys = [...one.outcomes, ...two.outcomes].map((o) => o.key);
    const open = Array.from({ length: 150 }, (_, i) => i + 1).filter((n) => n % 3 !== 0);
    const closed = Array.from({ length: 150 }, (_, i) => i + 1).filter((n) => n % 3 === 0);
    expect(keys).toEqual([...open, ...closed].map((n) => `PAG-${n}`));

    const small = await outcomes('alice', 'PAG', '?limit=10');
    expect(small.outcomes.map((o) => o.key)).toEqual(keys.slice(0, 10));
    const bad = await as('alice', { method: 'GET', url: '/api/v1/tracks/PAG/outcomes?cursor=x' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'invalid_cursor' });
    const big = await as('alice', { method: 'GET', url: '/api/v1/tracks/PAG/outcomes?limit=101' });
    expect(big.statusCode).toBe(400);
  });

  it('[AGL-024] answers as if there were no track to someone who may not see it', async () => {
    await newTrack('SHH');
    await outcome('SHH', 'Not for everyone');
    const hidden = await as('nobody', { method: 'GET', url: '/api/v1/tracks/SHH/outcomes' });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: 'not_found' });
    const missing = await as('alice', { method: 'GET', url: '/api/v1/tracks/NOPE/outcomes' });
    expect(missing.statusCode).toBe(404);
    const stranger = await app.inject({
      method: 'GET',
      url: '/api/v1/tracks/SHH/outcomes',
      remoteAddress: nextAddress(),
    });
    expect(stranger.statusCode).toBe(401);
  });

  it('[AGL-024] reads each page quickly on a track of 1,000 outcomes and 100,000 tickets', async () => {
    await newTrack('BIG');
    const outcomeType = await typeAt('BIG', 1);
    const standardType = await typeAt('BIG', 0);
    const status = async (stage: 'new' | 'closed') =>
      (
        await database.db
          .selectFrom('status')
          .select('id')
          .where('stage', '=', stage)
          .orderBy('id')
          .executeTakeFirstOrThrow()
      ).id;
    // 1,000 outcomes, then 99,000 tickets under them, 99 each, 25 of each outcome's closed.
    await sql`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                          creator_id, rank)
      SELECT 1, ${tracks.BIG}::int, g, ${outcomeType}::int, ${await status('new')}::int,
             'Outcome ' || g, ${ids.admin}::int, 'ybig' || lpad(g::text, 6, '0')
        FROM generate_series(1, 1000) g`.execute(database.db);
    await sql`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, parent_id,
                          summary, creator_id, rank)
      SELECT 1, ${tracks.BIG}::int, 1000 + g, ${standardType}::int,
             CASE WHEN ((g - 1) / 1000) % 4 = 0 THEN ${await status('closed')}::int
                  ELSE ${await status('new')}::int END,
             o.id, 'Work ' || g, ${ids.admin}::int, 'ybiw' || lpad(g::text, 6, '0')
        FROM generate_series(1, 99000) g
        JOIN ticket o ON o.track_id = ${tracks.BIG}::int AND o.number = 1 + (g - 1) % 1000`.execute(
      database.db,
    );
    await sql`UPDATE ticket_counter SET last_number = 100000 WHERE track_id = ${tracks.BIG}`.execute(
      database.db,
    );
    await sql`ANALYZE ticket`.execute(database.db);

    let cursor: string | null = null;
    const times: number[] = [];
    let seen = 0;
    let page = 0;
    do {
      const started = performance.now();
      const read: Page = await outcomes('alice', 'BIG', cursor ? `?cursor=${cursor}` : '');
      times.push(performance.now() - started);
      for (const o of read.outcomes) expect(o.progress).toEqual({ total: 99, closed: 25 });
      if (page === 0) expect(read.outcomes[0]?.key).toBe('BIG-1');
      seen += read.outcomes.length;
      cursor = read.next;
      page++;
    } while (cursor);
    expect(seen).toBe(1000);
    expect(page).toBe(10);
    times.sort((x, y) => x - y);
    expectWithinBudget(
      times[Math.floor(times.length / 2)] as number,
      100,
      'outcomes page, 1,000 outcomes and 100,000 tickets, median (ms)',
    );
  }, 120_000);
});
