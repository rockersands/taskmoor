import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `dash-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.85.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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
 * Dashboards through the API (M1-064; RPT-004): widgets checked per kind, private until shared,
 * shared like saved searches, the administrators' default seen by everyone signed in, and
 * changed by their owner only.
 */
describe('dashboards (M1-064)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};

  const as = (who: string | null, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: who ? (users[who]?.cookie ?? '') : '' },
    });
  const call = async (who: string | null, options: InjectOptions, code = 200) => {
    const res = await as(who, options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body}`).toBe(code);
    return res.statusCode === 204 ? null : res.json();
  };
  const make = (who: string, payload: Record<string, unknown>, code = 201) =>
    call(who, { method: 'POST', url: '/api/v1/dashboards', payload }, code);
  const patch = (who: string, id: number, payload: Record<string, unknown>, code = 200) =>
    call(who, { method: 'PATCH', url: `/api/v1/dashboards/${id}`, payload }, code);
  const read = (who: string | null, id: number, code = 200) =>
    call(who, { method: 'GET', url: `/api/v1/dashboards/${id}` }, code);
  const names = async (who: string, filter = 'visible') =>
    (await call(who, { method: 'GET', url: `/api/v1/dashboards?filter=${filter}` })).dashboards
      .map((d: { name: string }) => d.name)
      .sort();

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
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
  });
  afterAll(async () => {
    await app.close();
  });

  it('[RPT-004] checks each widget by its kind and fills in its defaults', async () => {
    const made = (
      await make('alice', {
        name: 'Team',
        layout: 'two',
        widgets: [
          { kind: 'introduction', config: { text: 'Welcome' } },
          { id: 'mine', kind: 'assigned-to-me', column: 1 },
          // The third column of a two-column layout is its second.
          { kind: 'created-vs-closed', column: 2, config: { query: 'track = ABC', days: 90 } },
        ],
      })
    ).dashboard;
    expect(made.owner.id).toBe(users.alice?.id);
    expect(made.editable).toBe(true);
    expect(made.widgets).toMatchObject([
      { kind: 'introduction', column: 0, title: '', config: { text: 'Welcome' } },
      { id: 'mine', kind: 'assigned-to-me', column: 1, config: { limit: 10 } },
      {
        kind: 'created-vs-closed',
        column: 1,
        config: { query: 'track = ABC', days: 90, period: 'day', cumulative: false },
      },
    ]);
    expect(made.widgets[0].id).toMatch(/^w-[0-9a-f]{8}$/);
    const fields = async (widgets: unknown[]) =>
      (await make('alice', { name: 'Bad', widgets }, 400)).fields;
    expect(await fields([{ kind: 'pie', config: { field: 'status; drop' } }])).toHaveProperty(
      'widgets.0.config.field',
    );
    expect(
      await fields([
        { kind: 'quick-links', config: { links: [{ label: 'x', url: 'javascript:alert(1)' }] } },
      ]),
    ).toEqual({ 'widgets.0.config.links.0.url': 'unsafe_url' });
    expect(await fields([{ kind: 'sprint-health', config: {} }])).toHaveProperty(
      'widgets.0.config.boardId',
    );
    expect(
      await fields([
        { id: 'a', kind: 'introduction' },
        { id: 'a', kind: 'introduction' },
      ]),
    ).toEqual({ widgets: 'duplicate_id' });
    expect(
      (await make('alice', { name: 'Bad', widgets: [{ kind: 'nope' }] }, 400)).fields,
    ).toHaveProperty('widgets.0.kind');
    // A smaller layout moves widgets to its last column.
    const one = (await patch('alice', made.id, { layout: 'one' })).dashboard;
    expect(one.widgets.map((w: { column: number }) => w.column)).toEqual([0, 0, 0]);
  });

  it('[RPT-004] is private until shared, and only its owner changes it', async () => {
    const id = (await make('alice', { name: 'Private' })).dashboard.id;
    await read('bob', id, 404);
    await read(null, id, 404);
    await patch('alice', id, { shares: [{ scope: 'user', userId: users.bob?.id }] });
    const seen = (await read('bob', id)).dashboard;
    expect([seen.name, seen.editable]).toEqual(['Private', false]);
    expect((await patch('bob', id, { name: 'Mine now' }, 403)).permission).toBe('edit_dashboard');
    await read('carol', id, 404);
    // Public: anyone, signed in or not, reads it.
    await patch('alice', id, { shares: [{ scope: 'public' }] });
    expect((await read(null, id)).dashboard.name).toBe('Private');
    expect(await names('bob', 'mine')).toEqual([]);
    expect(await names('alice', 'mine')).toEqual(['Private', 'Team']);
    // A stale version is refused.
    const version = (await read('alice', id)).dashboard.version;
    expect((await patch('alice', id, { name: 'Old', version: version - 1 }, 409)).error).toBe(
      'version_conflict',
    );
    // Only site administrators give it away.
    expect((await patch('alice', id, { ownerId: users.bob?.id }, 403)).permission).toBe(
      'site_admin',
    );
    const given = (await patch('admin', id, { ownerId: users.bob?.id })).dashboard;
    expect(given.owner.id).toBe(users.bob?.id);
    await call('bob', { method: 'DELETE', url: `/api/v1/dashboards/${id}` }, 204);
    await read('bob', id, 404);
  });

  it('[RPT-004] the administrators’ default is everyone’s, and stays while it is', async () => {
    const id = (await make('admin', { name: 'Home', widgets: [{ kind: 'assigned-to-me' }] }))
      .dashboard.id;
    await call('carol', { method: 'GET', url: '/api/v1/dashboards/default' }, 404);
    expect(
      (
        await call(
          'alice',
          { method: 'PUT', url: '/api/v1/dashboards/default', payload: { dashboardId: id } },
          403,
        )
      ).permission,
    ).toBe('configuration_admin');
    await call('admin', {
      method: 'PUT',
      url: '/api/v1/dashboards/default',
      payload: { dashboardId: id },
    });
    // Carol has no share of it, and sees it.
    const home = (await call('carol', { method: 'GET', url: '/api/v1/dashboards/default' }))
      .dashboard;
    expect([home.name, home.isDefault, home.editable]).toEqual(['Home', true, false]);
    expect(await names('carol')).toEqual(['Home']);
    expect(
      (await call('admin', { method: 'DELETE', url: `/api/v1/dashboards/${id}` }, 409)).error,
    ).toBe('is_default');
    await call('admin', {
      method: 'PUT',
      url: '/api/v1/dashboards/default',
      payload: { dashboardId: null },
    });
    await read('carol', id, 404);
  });

  it('[RPT-004] copies a dashboard the person sees as their own, without its shares', async () => {
    const source = (
      await make('alice', {
        name: 'Shared',
        layout: 'three',
        widgets: [{ kind: 'introduction', column: 2, config: { text: 'Hi' } }],
        shares: [{ scope: 'any_user' }],
      })
    ).dashboard;
    const copy = (
      await call(
        'bob',
        { method: 'POST', url: `/api/v1/dashboards/${source.id}/copy`, payload: {} },
        201,
      )
    ).dashboard;
    expect(copy).toMatchObject({
      name: 'Shared (copy)',
      layout: 'three',
      owner: { id: users.bob?.id },
      shares: [],
      editable: true,
    });
    expect(copy.widgets).toEqual(source.widgets);
    const hidden = (await make('alice', { name: 'Hidden' })).dashboard.id;
    await call(
      'bob',
      { method: 'POST', url: `/api/v1/dashboards/${hidden}/copy`, payload: {} },
      404,
    );
  });
});
