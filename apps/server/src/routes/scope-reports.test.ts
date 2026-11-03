import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `scope-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.84.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

/**
 * Release and outcome reports through the API (M1-062; RPT-001): a Scrum board in points runs
 * two sprints over a release that gains a ticket after the first starts and an outcome with
 * tickets in two tracks under it; only the tickets the viewer may see count, and a release in a
 * track they do not browse is not found.
 */
describe('release and outcome reports (M1-062)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const status: Record<string, number> = {};
  const t: Record<string, { id: number; key: string }> = {};
  const releases: Record<string, number> = {};
  let points = 0;
  let board = 0;
  let kanban = 0;

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
  const post = (url: string, payload: unknown = {}, code = 200) =>
    call('alice', { method: 'POST', url, payload: payload as Record<string, unknown> }, code);
  const get = (who: string, path: string, code = 200) =>
    call(who, { method: 'GET', url: `/api/v1/boards/${board}/reports/${path}` }, code);
  const sprintRows = (report: {
    sprints: { name: string; start: number; completed: number; added: number; end: number }[];
  }) => report.sprints.map((s) => [s.name, s.start, s.completed, s.added, s.end]);
  async function close(name: string) {
    await database.db
      .updateTable('ticket')
      .set({ status_id: status.Closed as number })
      .where('id', '=', t[name]?.id as number)
      .execute();
    // Through the history too, as every write does: the reports read the events.
    await database.db
      .insertInto('ticket_change')
      .values({
        workspace_id: 1,
        ticket_id: t[name]?.id as number,
        change_set: '999999',
        field: 'status',
        from_value: String(status.New),
        to_value: String(status.Closed),
        from_display: 'New',
        to_display: 'Closed',
      })
      .execute();
  }
  async function under(name: string, parent: string) {
    const id = t[name]?.id as number;
    const to = t[parent]?.id as number;
    await database.db.updateTable('ticket').set({ parent_id: to }).where('id', '=', id).execute();
    await database.db
      .insertInto('ticket_change')
      .values({
        workspace_id: 1,
        ticket_id: id,
        change_set: '999998',
        field: 'parent',
        from_value: null,
        to_value: String(to),
        from_display: null,
        to_display: t[parent]?.key ?? null,
      })
      .execute();
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
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
    const members = (await database.db.selectFrom('role').select(['id', 'name']).execute()).find(
      (r) => r.name === 'Members',
    )?.id as number;
    // Bob sees RA only; alice sees both.
    for (const [key, who] of [
      ['RA', ['alice', 'bob']],
      ['RB', ['alice']],
    ] as const) {
      const res = await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key, name: `Releases ${key}`, mode: 'shared' },
        },
        201,
      );
      tracks[key] = res.track.id;
      for (const w of who) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: tracks[key] as number,
            role_id: members,
            user_id: users[w]?.id as number,
          })
          .execute();
      }
      const release = await call(
        'admin',
        { method: 'POST', url: `/api/v1/tracks/${tracks[key]}/releases`, payload: { name: key } },
        201,
      );
      releases[key] = release.release.id;
    }
    for (const s of await database.db.selectFrom('status').select(['id', 'name']).execute()) {
      status[s.name] = s.id;
    }
    points = (
      await call(
        'admin',
        { method: 'POST', url: '/api/v1/fields', payload: { name: 'Points', type: 'number' } },
        201,
      )
    ).field.id;
    const columns = [
      { id: 'todo', name: 'To do', statusIds: [status.New] },
      { id: 'doing', name: 'Doing', statusIds: [status.Active, status['In Review']] },
      { id: 'done', name: 'Done', statusIds: [status.Closed] },
    ];
    board = (
      await post(
        '/api/v1/boards',
        {
          name: 'Releases',
          kind: 'scrum',
          trackId: tracks.RA,
          source: { query: 'track = RA AND summary ~ rel' },
          columns,
          sprintSettings: {
            estimation: { statistic: 'field', fieldId: points },
            timeTracking: 'none',
            parallelSprints: false,
          },
        },
        201,
      )
    ).board.id;
    kanban = (
      await post(
        '/api/v1/boards',
        { name: 'Flow', kind: 'kanban', trackId: tracks.RB, source: { query: 'track = RB' } },
        201,
      )
    ).board.id;
    for (const [name, track, pts, release] of [
      ['outcome', 'RA', 0, null],
      ['a', 'RA', 5, 'RA'],
      ['b', 'RA', 3, 'RA'],
      ['c', 'RB', 8, null],
      ['d', 'RA', 2, null],
    ] as const) {
      t[name] = (
        await post(
          '/api/v1/tickets',
          {
            track,
            summary: `rel ${name}`,
            fields: { [points]: pts },
            ...(release ? { targetReleaseIds: [releases[release]] } : {}),
          },
          201,
        )
      ).ticket;
    }
    await under('a', 'outcome');
    await under('d', 'outcome');
    await under('c', 'outcome');
    const one = (await post(`/api/v1/boards/${board}/sprints`, { name: 'One' }, 201)).sprint.id;
    await post(`/api/v1/sprints/${one}/tickets`, { tickets: [t.a?.key, t.b?.key] });
    await post(`/api/v1/sprints/${one}/start`, { endAt: '2030-01-15T09:00:00Z' });
    await close('a');
    // d joins the release while the first sprint runs.
    await call('alice', {
      method: 'PATCH',
      url: `/api/v1/tickets/${t.d?.id}`,
      payload: { targetReleaseIds: [releases.RA] },
    });
    const two = (await post(`/api/v1/boards/${board}/sprints`, { name: 'Two' }, 201)).sprint.id;
    await post(`/api/v1/sprints/${one}/complete`, { moveTo: { type: 'sprint', sprintId: two } });
    await post(`/api/v1/sprints/${two}/start`, { endAt: '2030-02-15T09:00:00Z' });
    await close('b');
  });
  afterAll(async () => {
    await app.close();
  });

  it('[RPT-001] the release burndown follows the release across the board’s sprints', async () => {
    const report = await get('alice', `release-burndown?release=${releases.RA}`);
    expect(report.release.name).toBe('RA');
    // One: a and b (5 + 3); a done, d joins. Two: b and d; b done.
    expect(sprintRows(report)).toEqual([
      ['One', 8, 5, 2, 5],
      ['Two', 5, 3, 0, 2],
    ]);
    expect(report.now).toEqual({ scope: 10, completed: 8, remaining: 2 });
    expect([report.velocity, report.forecast]).toEqual([5, 1]);
    // Bob does not browse RB: its release is not found for him.
    await get('bob', `release-burndown?release=${releases.RB}`, 404);
    expect(sprintRows(await get('alice', `release-burndown?release=${releases.RB}`))).toEqual([
      ['One', 0, 0, 0, 0],
      ['Two', 0, 0, 0, 0],
    ]);
  });

  it('[RPT-001] the outcome burndown follows the tickets under the outcome', async () => {
    const report = await get('alice', `outcome-burndown?outcome=${t.outcome?.key}`);
    expect(report.outcome).toMatchObject({ key: t.outcome?.key, summary: 'rel outcome' });
    // a, c and d under it (5 + 8 + 2); a done in One.
    expect(sprintRows(report)).toEqual([
      ['One', 15, 5, 0, 10],
      ['Two', 10, 0, 0, 10],
    ]);
    expect([report.velocity, report.forecast]).toEqual([5, 2]);
    // Bob does not see c in RB; by id as well as by key.
    const bob = await get('bob', `outcome-burndown?outcome=${t.outcome?.id}`);
    expect(sprintRows(bob)).toEqual([
      ['One', 7, 5, 0, 2],
      ['Two', 2, 0, 0, 2],
    ]);
    expect(bob.now).toEqual({ scope: 7, completed: 5, remaining: 2 });
    await get('alice', 'outcome-burndown?outcome=RA-999', 404);
  });

  it('[RPT-001] the release report shows scope and completed work by day', async () => {
    const report = await get('alice', `release-report?release=${releases.RA}&timeZone=UTC`);
    expect(report.timeZone).toBe('UTC');
    // Everything happened today: one day, and no pace yet for a forecast.
    expect(report.days).toHaveLength(1);
    expect(report.days[0]).toMatchObject({ scope: 10, completed: 8 });
    expect([report.pace, report.forecast]).toEqual([0, null]);
  });

  it('[RPT-001] refuses a kanban board, a missing release and an unknown one', async () => {
    const kanbanReport = await as('alice', {
      method: 'GET',
      url: `/api/v1/boards/${kanban}/reports/release-burndown?release=${releases.RA}`,
    });
    expect([kanbanReport.statusCode, kanbanReport.json().error]).toEqual([409, 'not_scrum']);
    expect((await get('alice', 'release-burndown', 400)).fields).toHaveProperty('release');
    await get('alice', 'release-report?release=999999', 404);
  });
});
