import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `statistics-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.88.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

const PEOPLE = ['admin', 'owner', 'manager', 'member', 'outsider'] as const;
type Person = (typeof PEOPLE)[number];

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

const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);

/**
 * What one track's Statistics and Summary read (ADR-116; RPT-002, RPT-005, RPT-006). STA has three
 * open tickets everyone in it sees and one only its managers see; OTH has two tickets its members
 * see, and `member` is not one of them, so nothing here may show them more than a search would.
 */
describe('a track’s statistics and its customized summary', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  let trackId = 0;

  const as = (who: Person | null, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: who ? users[who].cookie : '' },
    });
  const call = async (who: Person, options: InjectOptions, code = 200) => {
    const res = await as(who, options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body}`).toBe(code);
    return code === 204 ? null : res.json();
  };
  const statistic = (who: Person, kind: string, query = '') =>
    call(who, { method: 'GET', url: `/api/v1/tracks/STA/statistics/${kind}${query}` });
  const layout = (who: Person) =>
    call(who, { method: 'GET', url: '/api/v1/tracks/STA/summary-layout' });
  const save = (who: Person, payload: Record<string, unknown>, code = 200) =>
    call(who, { method: 'PUT', url: '/api/v1/tracks/STA/summary-layout', payload }, code);
  const reset = (who: Person, code = 204) =>
    call(who, { method: 'DELETE', url: '/api/v1/tracks/STA/summary-layout' }, code);
  const widget = (who: Person, id: string) =>
    call(who, { method: 'GET', url: `/api/v1/tracks/STA/summary-layout/widgets/${id}` });
  const keysOf = (data: { tickets: { key: string }[] }) =>
    data.tickets.map((t) => t.key.split('-')[0]);

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const name of PEOPLE) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: name === 'admin',
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
    const roles = await database.db.selectFrom('role').select(['id', 'name']).execute();
    const role = (name: string) => roles.find((r) => r.name === name)?.id as number;
    const makeTrack = async (key: string) =>
      (
        await call(
          'admin',
          { method: 'POST', url: '/api/v1/tracks', payload: { key, name: key, mode: 'shared' } },
          201,
        )
      ).track.id as number;
    trackId = await makeTrack('STA');
    const other = await makeTrack('OTH');
    const join = (track: number, name: string, who: Person) =>
      database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: track,
          role_id: role(name),
          user_id: users[who].id,
        })
        .execute();
    await join(trackId, 'Members', 'owner');
    await join(trackId, 'Members', 'member');
    await join(trackId, 'Members', 'manager');
    await join(trackId, 'Administrators', 'manager');
    await join(other, 'Members', 'manager');
    await database.db
      .updateTable('track')
      .set({ owner_id: users.owner.id })
      .where('id', '=', trackId)
      .execute();
    const policy = await call(
      'admin',
      {
        method: 'POST',
        url: '/api/v1/visibility-policies',
        payload: {
          name: 'Managers only',
          levels: [{ name: 'Managers', members: [{ grantee: 'user', userId: users.manager.id }] }],
        },
      },
      201,
    );
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${trackId}`,
      payload: { visibilityPolicyId: policy.visibilityPolicy.id },
    });
    const ticket = async (track: string, summary: string, assignee: Person) =>
      (
        await call(
          'manager',
          {
            method: 'POST',
            url: '/api/v1/tickets',
            payload: { track, summary, assigneeId: users[assignee].id },
          },
          201,
        )
      ).ticket.id as number;
    await ticket('STA', 'One', 'member');
    await ticket('STA', 'Two', 'manager');
    await ticket('STA', 'Three', 'manager');
    const secret = await ticket('STA', 'Secret', 'manager');
    await call('manager', {
      method: 'PATCH',
      url: `/api/v1/tickets/${secret}`,
      payload: { visibilityLevelId: policy.visibilityPolicy.levels[0].id },
    });
    await ticket('OTH', 'Elsewhere one', 'manager');
    await ticket('OTH', 'Elsewhere two', 'manager');
  });
  afterAll(async () => {
    await app.close();
  });

  it('[RPT-002] created vs closed counts the track as the viewer sees it, never another track', async () => {
    const seen = async (who: Person) =>
      sum((await statistic(who, 'created-vs-closed', '?days=30&period=week')).data.created);
    expect(await seen('member')).toBe(3);
    expect(await seen('manager')).toBe(4);
    // A site administrator is not on the ticket's level either: the same as a search.
    expect(await seen('admin')).toBe(3);
    const running = (await statistic('member', 'created-vs-closed', '?cumulative=true')).data;
    expect(running.cumulative).toBe(true);
    expect(running.created.at(-1)).toBe(3);
  });

  it('[RPT-005] two-dimensional statistics group the track by any two fields, as the viewer sees it', async () => {
    const seen = async (who: Person) =>
      (await statistic(who, 'two-dimensional', '?x=status&y=assignee')).data;
    expect((await seen('member')).total).toBe(3);
    const manager = await seen('manager');
    expect(manager.total).toBe(4);
    expect(manager.fields).toEqual({ x: 'status', y: 'assignee' });
    const bad = await statistic('member', 'two-dimensional', '?x=status&y=nothing');
    expect(bad.data).toEqual({ unavailable: 'field' });
  });

  it('[RPT-002] reads each general report, and only for those who see the track', async () => {
    for (const kind of ['recently-created', 'average-age', 'time-to-close']) {
      expect((await statistic('member', kind)).data, kind).toBeTruthy();
    }
    const counted = await statistic('member', 'ticket-statistics', '?field=status');
    expect(counted.data.total).toBe(3);
    const url = '/api/v1/tracks/STA/statistics/created-vs-closed';
    expect((await as('outsider', { method: 'GET', url })).statusCode).toBe(404);
    expect((await as(null, { method: 'GET', url })).statusCode).toBe(401);
    const missing = { method: 'GET', url: '/api/v1/tracks/NOPE/statistics/created-vs-closed' };
    expect((await as('member', missing as InjectOptions)).statusCode).toBe(404);
    // Not a report of this page, and a query cannot be given.
    const other = { method: 'GET', url: '/api/v1/tracks/STA/statistics/assigned-to-me' };
    expect((await as('member', other as InjectOptions)).statusCode).toBe(404);
    const widened = await as('member', { method: 'GET', url: `${url}?query=track%20%3D%20OTH` });
    expect(widened.statusCode).toBe(400);
    expect(widened.json().error).toBe('invalid_fields');
    const tooLong = await as('member', { method: 'GET', url: `${url}?days=5000` });
    expect(tooLong.statusCode).toBe(400);
  });

  it('[RPT-006] has no customized summary until someone makes one, and says who may', async () => {
    const offered = async (who: Person) => (await layout(who)).mayCustomize;
    expect((await layout('member')).custom).toBeNull();
    expect((await layout('member')).track).toEqual({ id: trackId, key: 'STA', name: 'STA' });
    expect(await offered('member')).toBe(false);
    expect(await offered('owner')).toBe(true);
    expect(await offered('manager')).toBe(true);
    expect(await offered('admin')).toBe(true);
    const url = '/api/v1/tracks/STA/summary-layout';
    expect((await as('outsider', { method: 'GET', url })).statusCode).toBe(404);
    expect((await as(null, { method: 'GET', url })).statusCode).toBe(401);
  });

  it('[RPT-006] only the track’s owner and administrators change it, and the server says no to others', async () => {
    const payload = { layout: 'one', widgets: [{ kind: 'track-summary' }] };
    expect((await save('member', payload, 403)).permission).toBe('administer_track');
    await save('outsider', payload, 404);
    await reset('member', 403);
    await reset('outsider', 404);
    const made = (await save('owner', payload)).custom;
    expect(made.version).toBe(1);
    expect(made.widgets.map((w: { kind: string }) => w.kind)).toEqual(['track-summary']);
    // Saved with the version read; anything else is someone else's change.
    expect(
      (await save('manager', { layout: 'two', widgets: made.widgets, version: 7 }, 409)).version,
    ).toBe(1);
    expect((await save('manager', payload, 409)).version).toBe(1);
    const again = (await save('manager', { ...payload, widgets: made.widgets, version: 1 })).custom;
    expect(again.version).toBe(1);
    const changed = (await save('manager', { layout: 'two', widgets: made.widgets, version: 1 }))
      .custom;
    expect(changed).toMatchObject({ layout: 'two', version: 2 });
    // Everyone who sees the track reads it.
    expect((await layout('member')).custom).toMatchObject({ layout: 'two', version: 2 });
    await reset('manager');
    expect((await layout('member')).custom).toBeNull();
    await reset('manager');
    // Someone went back to the default while a draft was open.
    await save('owner', { ...payload, version: 2 }, 409);
  });

  it('[RPT-006] [RPT-004] a widget reads as the viewer: an empty query means the track', async () => {
    const saved = (
      await save('manager', {
        layout: 'two',
        widgets: [
          { kind: 'search-results', config: { query: '', limit: 50 } },
          { kind: 'search-results', column: 1, config: { query: 'track = OTH', limit: 50 } },
          { kind: 'assigned-to-me', column: 1, config: { limit: 50 } },
          { kind: 'created-vs-closed', config: {} },
          { kind: 'introduction', config: { text: 'Hello' } },
          { kind: 'track-summary' },
        ],
      })
    ).custom;
    const id = (i: number) => saved.widgets[i].id as string;
    // Empty: the track, for each as they see it, and not every ticket.
    expect(keysOf((await widget('member', id(0))).data)).toEqual(['STA', 'STA', 'STA']);
    expect(keysOf((await widget('manager', id(0))).data)).toEqual(['STA', 'STA', 'STA', 'STA']);
    // A query that names another track shows it only to those who see that track.
    expect((await widget('member', id(1))).data.tickets).toEqual([]);
    expect(keysOf((await widget('manager', id(1))).data)).toEqual(['OTH', 'OTH']);
    // The viewer's own list stays inside the track.
    expect(keysOf((await widget('manager', id(2))).data)).toEqual(['STA', 'STA', 'STA']);
    expect(keysOf((await widget('member', id(2))).data)).toEqual(['STA']);
    expect(sum((await widget('member', id(3))).data.created)).toBe(3);
    expect(sum((await widget('manager', id(3))).data.created)).toBe(4);
    // What needs no read answers nothing to read.
    expect((await widget('member', id(4))).data).toBeNull();
    expect((await widget('member', id(5))).data).toBeNull();
    // Those who do not see the track reach none of it.
    const url = `/api/v1/tracks/STA/summary-layout/widgets/${id(0)}`;
    expect((await as('outsider', { method: 'GET', url })).statusCode).toBe(404);
    const missing = '/api/v1/tracks/STA/summary-layout/widgets/nothing-here';
    expect((await as('member', { method: 'GET', url: missing })).statusCode).toBe(404);
    await reset('manager');
  });

  it('[RPT-006] [RPT-004] stays out of dashboards: not listed, and its widget not on one', async () => {
    await save('owner', { layout: 'one', widgets: [{ kind: 'track-summary' }] });
    for (const who of ['owner', 'admin'] as const) {
      for (const filter of ['visible', 'mine']) {
        const list = await call(who, { method: 'GET', url: `/api/v1/dashboards?filter=${filter}` });
        expect(list.dashboards).toEqual([]);
      }
    }
    const refused = await call(
      'owner',
      {
        method: 'POST',
        url: '/api/v1/dashboards',
        payload: { name: 'Mine', widgets: [{ kind: 'track-summary' }] },
      },
      400,
    );
    expect(refused.fields).toEqual({ 'widgets.0.kind': 'track_only' });
    await reset('owner');
  });

  it('[RPT-006] checks each widget on save, like a dashboard’s', async () => {
    const bad = await save(
      'owner',
      { layout: 'one', widgets: [{ kind: 'search-results', config: { limit: 900 } }] },
      400,
    );
    expect(Object.keys(bad.fields)).toEqual(['widgets.0.config.limit']);
    await save('owner', { layout: 'six', widgets: [] }, 400);
  });

  it('[RPT-006] leaves an archived track’s summary as it is, and goes with a removed track', async () => {
    await save('owner', { layout: 'one', widgets: [{ kind: 'track-summary' }] });
    await call('admin', { method: 'POST', url: `/api/v1/tracks/${trackId}/archive` });
    expect((await layout('owner')).mayCustomize).toBe(false);
    await save('owner', { layout: 'one', widgets: [], version: 1 }, 403);
    await call('admin', { method: 'POST', url: `/api/v1/tracks/${trackId}/restore` });
    expect((await layout('owner')).mayCustomize).toBe(true);
    await database.db.deleteFrom('ticket').where('track_id', '=', trackId).execute();
    await database.db.deleteFrom('board').where('location_track_id', '=', trackId).execute();
    await database.db.deleteFrom('track_role_actor').where('track_id', '=', trackId).execute();
    await database.db.deleteFrom('track').where('id', '=', trackId).execute();
    const left = await database.db.selectFrom('track_summary_layout').select('track_id').execute();
    expect(left).toEqual([]);
  });
});
