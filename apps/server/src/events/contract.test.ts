import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { issueSetupToken } from '../setup';
import { EVENT_TYPES, type EventType } from './catalogue';

/**
 * M1-005 done-when: every mutation path emits exactly one event, and each event type has a
 * contract test. Every mutating route (POST, PUT, PATCH, DELETE) needs a scenario here or an
 * exemption with a reason; a new route without one fails this file. Each scenario performs a
 * successful call and must leave exactly one new event of its type whose payload matches the
 * catalogue.
 */
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];
const EXEMPT: Record<string, string> = {
  'POST /api/v1/password-check': 'reads only: checks a candidate password, stores nothing',
  'POST /api/v1/password-links/inspect': 'reads only: shows who a link is for',
};
const PASSWORD = 'ladder violet harbour';

function sessionCookie(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (
      list.find(
        (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
      ) ?? ''
    ).split(';')[0] ?? ''
  );
}

interface Scenario {
  route: string;
  expect: EventType;
  /** Setup the call needs; its events are not counted. */
  prepare?: () => Promise<void>;
  run: () => Promise<LightMyRequestResponse>;
}

describe('every mutation emits exactly one event (M1-005)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const state: Record<string, number | string> = {};
  let address = 0;
  const call = (cookie: string | undefined, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: `198.18.0.${++address}`,
      headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
    });
  const admin = (options: InjectOptions) => call(String(state.admin), options);

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
  });
  afterAll(async () => {
    await app.close();
  });

  const scenarios: Scenario[] = [
    {
      route: 'POST /api/v1/setup',
      expect: 'setup.completed',
      run: async () => {
        const token = (await issueSetupToken(database.db)) as string;
        const res = await call(undefined, {
          method: 'POST',
          url: '/api/v1/setup',
          payload: {
            token,
            instanceName: 'Events',
            admin: { name: 'Ada', email: 'ada@example.com', password: PASSWORD },
          },
        });
        state.admin = sessionCookie(res);
        state.adminId = res.json().user.id;
        // A second person and a track for the scenarios below, written directly.
        const bo = await database.db
          .insertInto('app_user')
          .values({
            workspace_id: 1,
            email: 'bo@example.com',
            name: 'Bo',
            password_hash: await hashPassword(PASSWORD),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        state.bo = bo.id;
        const policy = await database.db
          .selectFrom('access_policy')
          .select('id')
          .where('name', '=', 'Default access policy')
          .executeTakeFirstOrThrow();
        const track = await database.db
          .insertInto('track')
          .values({ workspace_id: 1, key: 'EVT', name: 'Events', access_policy_id: policy.id })
          .returning('id')
          .executeTakeFirstOrThrow();
        state.track = track.id;
        const role = await database.db
          .selectFrom('role')
          .select('id')
          .where('name', '=', 'Members')
          .executeTakeFirstOrThrow();
        state.role = role.id;
        return res;
      },
    },
    {
      route: 'POST /api/v1/session',
      expect: 'session.started',
      run: async () => {
        const res = await call(undefined, {
          method: 'POST',
          url: '/api/v1/session',
          payload: { email: 'bo@example.com', password: PASSWORD },
        });
        state.bo1 = sessionCookie(res);
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/account',
      expect: 'user.updated',
      run: () =>
        call(String(state.bo1), {
          method: 'PATCH',
          url: '/api/v1/account',
          payload: { name: 'Bo B.' },
        }),
    },
    {
      route: 'DELETE /api/v1/sessions/:id',
      expect: 'session.revoked',
      prepare: async () => {
        await call(undefined, {
          method: 'POST',
          url: '/api/v1/session',
          payload: { email: 'bo@example.com', password: PASSWORD },
        });
      },
      run: async () => {
        const list = await call(String(state.bo1), { method: 'GET', url: '/api/v1/sessions' });
        const other = (list.json().sessions as { id: number; current: boolean }[]).find(
          (s) => !s.current,
        );
        return call(String(state.bo1), { method: 'DELETE', url: `/api/v1/sessions/${other?.id}` });
      },
    },
    {
      route: 'DELETE /api/v1/sessions/others',
      expect: 'session.revoked',
      prepare: async () => {
        await call(undefined, {
          method: 'POST',
          url: '/api/v1/session',
          payload: { email: 'bo@example.com', password: PASSWORD },
        });
      },
      run: () => call(String(state.bo1), { method: 'DELETE', url: '/api/v1/sessions/others' }),
    },
    {
      route: 'PUT /api/v1/account/password',
      expect: 'user.password_changed',
      run: () =>
        call(String(state.bo1), {
          method: 'PUT',
          url: '/api/v1/account/password',
          payload: { currentPassword: PASSWORD, newPassword: 'quiet otter lantern' },
        }),
    },
    {
      route: 'DELETE /api/v1/session',
      expect: 'session.ended',
      run: () => call(String(state.bo1), { method: 'DELETE', url: '/api/v1/session' }),
    },
    {
      route: 'POST /api/v1/users',
      expect: 'user.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/users',
          payload: { email: 'cy@example.com', name: 'Cy' },
        });
        state.cy = res.json().user.id;
        state.cyLink =
          new URL((res.json().activationLink as string).replace('/#/', '/')).searchParams.get(
            'token',
          ) ?? '';
        return res;
      },
    },
    {
      route: 'POST /api/v1/password-links/redeem',
      expect: 'user.password_changed',
      run: () =>
        call(undefined, {
          method: 'POST',
          url: '/api/v1/password-links/redeem',
          payload: { token: state.cyLink, password: 'another otter lantern' },
        }),
    },
    {
      route: 'PATCH /api/v1/users/:id',
      expect: 'user.updated',
      run: () =>
        admin({ method: 'PATCH', url: `/api/v1/users/${state.cy}`, payload: { name: 'Cyrus' } }),
    },
    {
      route: 'POST /api/v1/users/:id/password-link',
      expect: 'user.password_link_created',
      run: () => admin({ method: 'POST', url: `/api/v1/users/${state.cy}/password-link` }),
    },
    {
      route: 'DELETE /api/v1/users/:id/sessions',
      expect: 'session.revoked',
      run: () => admin({ method: 'DELETE', url: `/api/v1/users/${state.cy}/sessions` }),
    },
    {
      route: 'POST /api/v1/users/:id/deactivate',
      expect: 'user.deactivated',
      run: () => admin({ method: 'POST', url: `/api/v1/users/${state.cy}/deactivate` }),
    },
    {
      route: 'POST /api/v1/users/:id/reactivate',
      expect: 'user.reactivated',
      run: () => admin({ method: 'POST', url: `/api/v1/users/${state.cy}/reactivate` }),
    },
    {
      route: 'POST /api/v1/groups',
      expect: 'group.created',
      run: async () => {
        const parent = await admin({
          method: 'POST',
          url: '/api/v1/groups',
          payload: { name: 'Parent' },
        });
        state.parent = parent.json().group.id;
        return parent;
      },
    },
    {
      route: 'PATCH /api/v1/groups/:id',
      expect: 'group.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/groups/${state.parent}`,
          payload: { description: 'Everyone' },
        }),
    },
    {
      route: 'PUT /api/v1/groups/:id/members/:userId',
      expect: 'group.member_added',
      run: () =>
        admin({ method: 'PUT', url: `/api/v1/groups/${state.parent}/members/${state.bo}` }),
    },
    {
      route: 'DELETE /api/v1/groups/:id/members/:userId',
      expect: 'group.member_removed',
      run: () =>
        admin({ method: 'DELETE', url: `/api/v1/groups/${state.parent}/members/${state.bo}` }),
    },
    {
      route: 'PUT /api/v1/groups/:id/children/:childId',
      expect: 'group.nested',
      run: async () => {
        const child = await database.db
          .insertInto('user_group')
          .values({ workspace_id: 1, name: 'Child' })
          .returning('id')
          .executeTakeFirstOrThrow();
        state.child = child.id;
        return admin({
          method: 'PUT',
          url: `/api/v1/groups/${state.parent}/children/${state.child}`,
        });
      },
    },
    {
      route: 'DELETE /api/v1/groups/:id/children/:childId',
      expect: 'group.unnested',
      run: () =>
        admin({ method: 'DELETE', url: `/api/v1/groups/${state.parent}/children/${state.child}` }),
    },
    {
      route: 'DELETE /api/v1/groups/:id',
      expect: 'group.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/groups/${state.child}` }),
    },
    {
      route: 'POST /api/v1/roles',
      expect: 'role.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/roles',
          payload: { name: 'Auditors' },
        });
        state.auditors = res.json().role.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/roles/:id',
      expect: 'role.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/roles/${state.auditors}`,
          payload: { description: 'Read the logs' },
        }),
    },
    {
      route: 'DELETE /api/v1/roles/:id',
      expect: 'role.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/roles/${state.auditors}` }),
    },
    {
      route: 'POST /api/v1/access-policies',
      expect: 'access_policy.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/access-policies',
          payload: { name: 'Strict' },
        });
        state.policy = res.json().policy.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/access-policies/:id',
      expect: 'access_policy.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/access-policies/${state.policy}`,
          payload: { name: 'Stricter' },
        }),
    },
    {
      route: 'POST /api/v1/access-policies/:id/grants',
      expect: 'access_grant.added',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: `/api/v1/access-policies/${state.policy}/grants`,
          payload: { permission: 'browse_track', grantee: 'any_user' },
        });
        state.grant = res.json().grant.id;
        return res;
      },
    },
    {
      route: 'DELETE /api/v1/access-policies/:id/grants/:grantId',
      expect: 'access_grant.removed',
      run: () =>
        admin({
          method: 'DELETE',
          url: `/api/v1/access-policies/${state.policy}/grants/${state.grant}`,
        }),
    },
    {
      route: 'DELETE /api/v1/access-policies/:id',
      expect: 'access_policy.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/access-policies/${state.policy}` }),
    },
    {
      route: 'POST /api/v1/global-grants',
      expect: 'global_grant.added',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/global-grants',
          payload: { permission: 'bulk_change', grantee: 'user', userId: state.bo },
        });
        state.globalGrant = res.json().grant.id;
        return res;
      },
    },
    {
      route: 'DELETE /api/v1/global-grants/:id',
      expect: 'global_grant.removed',
      run: () => admin({ method: 'DELETE', url: `/api/v1/global-grants/${state.globalGrant}` }),
    },
    {
      route: 'PUT /api/v1/tracks/:id/roles/:roleId/users/:actorId',
      expect: 'track_role.actor_added',
      run: () =>
        admin({
          method: 'PUT',
          url: `/api/v1/tracks/${state.track}/roles/${state.role}/users/${state.bo}`,
        }),
    },
    {
      route: 'DELETE /api/v1/tracks/:id/roles/:roleId/users/:actorId',
      expect: 'track_role.actor_removed',
      run: () =>
        admin({
          method: 'DELETE',
          url: `/api/v1/tracks/${state.track}/roles/${state.role}/users/${state.bo}`,
        }),
    },
    {
      route: 'PUT /api/v1/tracks/:id/roles/:roleId/groups/:actorId',
      expect: 'track_role.actor_added',
      run: () =>
        admin({
          method: 'PUT',
          url: `/api/v1/tracks/${state.track}/roles/${state.role}/groups/${state.parent}`,
        }),
    },
    {
      route: 'DELETE /api/v1/tracks/:id/roles/:roleId/groups/:actorId',
      expect: 'track_role.actor_removed',
      run: () =>
        admin({
          method: 'DELETE',
          url: `/api/v1/tracks/${state.track}/roles/${state.role}/groups/${state.parent}`,
        }),
    },
  ];

  it('covers every mutating route with a scenario or a stated exemption', () => {
    const mutating = app.routeTable.filter((r) => MUTATING.includes(r.split(' ')[0] ?? ''));
    const covered = new Set([...scenarios.map((s) => s.route), ...Object.keys(EXEMPT)]);
    expect(
      mutating.filter((r) => !covered.has(r)),
      'routes without a scenario',
    ).toEqual([]);
    expect(
      [...covered].filter((r) => !mutating.includes(r)),
      'scenarios for missing routes',
    ).toEqual([]);
  });

  it('[AUT-010] emits exactly one valid event per successful mutation', async () => {
    const produced = new Set<EventType>();
    for (const scenario of scenarios) {
      await scenario.prepare?.();
      const before = await database.db
        .selectFrom('domain_event')
        .select((eb) => eb.fn.max('id').as('max'))
        .executeTakeFirstOrThrow();
      const from = Number(before.max ?? 0);
      const res = await scenario.run();
      expect(res.statusCode, `${scenario.route}: ${res.body}`).toBeLessThan(300);
      const events = await database.db
        .selectFrom('domain_event')
        .select(['type', 'payload', 'subject_type'])
        .where('id', '>', String(from))
        .orderBy('id')
        .execute();
      expect(
        events.length,
        `${scenario.route} emitted ${events.map((e) => e.type).join(', ')}`,
      ).toBe(1);
      const [event] = events;
      expect(event?.type, scenario.route).toBe(scenario.expect);
      const spec = EVENT_TYPES[scenario.expect];
      expect(event?.subject_type).toBe(spec.subject);
      expect(() => spec.payload.parse(event?.payload)).not.toThrow();
      // No secret ever travels in an event.
      expect(JSON.stringify(event?.payload)).not.toMatch(/password_hash|argon2|token|\$scrypt/i);
      produced.add(scenario.expect);
    }
    const missing = (Object.keys(EVENT_TYPES) as EventType[]).filter((t) => !produced.has(t));
    expect(missing, 'event types no route produces').toEqual([]);
  });
});
