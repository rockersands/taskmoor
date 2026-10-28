import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword, totpCode, totpStep } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { issueSetupToken } from '../setup';
import { FakeIdp } from '../testing/fake-idp';
import { FakeSamlIdp } from '../testing/fake-saml-idp';
import { SoftAuthenticator } from '../testing/webauthn';
import { EVENT_TYPES, type EventType } from './catalogue';

/**
 * M1-005 done-when: every mutation path emits exactly one event, and each event type has a
 * contract test. Every mutating route (POST, PUT, PATCH, DELETE) needs a scenario here or an
 * exemption with a reason; a new route without one fails this file. Each scenario performs a
 * successful call and must leave exactly one new event of its type whose payload matches the
 * catalogue.
 */
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];
/** GET routes that change state because a browser arrives at them by redirect. */
const REDIRECT_MUTATIONS = [
  'GET /api/v1/auth/oidc/:id/start',
  'GET /api/v1/auth/oidc/callback',
  'GET /api/v1/auth/saml/:id/start',
  'GET /api/v1/auth/saml/continue',
];
const EXEMPT: Record<string, string> = {
  'POST /api/v1/password-check': 'reads only: checks a candidate password, stores nothing',
  'POST /api/v1/password-links/inspect': 'reads only: shows who a link is for',
  'POST /api/v1/account/two-factor/totp': 'reads only: proposes a secret, stored at confirmation',
  'POST /api/v1/account/two-factor/webauthn/options': 'reads only: registration options',
  'POST /api/v1/session/enroll/totp': 'reads only: proposes a secret, stored at confirmation',
  'POST /api/v1/session/second-factor/webauthn':
    'transient sign-in state: the WebAuthn challenge of a sign-in in progress',
  'POST /api/v1/auth/discover': 'reads only: which sign-in methods a domain uses',
  'GET /api/v1/auth/oidc/:id/start':
    'transient sign-in state: the state, nonce and verifier of a single sign-on in progress',
  'GET /api/v1/auth/saml/:id/start':
    'transient sign-in state: the request ID of a SAML sign-in in progress, bound to the browser',
  'POST /api/v1/auth/saml/:id/acs':
    'transient sign-in state: a verified SAML response waiting for its browser, and its assertion ID; the sign-in itself is GET /api/v1/auth/saml/continue',
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
  /** A redirect answers success for browser flows; everything else answers 2xx. */
  status?: number;
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
  /** A SCIM call with the provisioning token (ADR-038). */
  const scim = (
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    payload?: object,
  ): Promise<LightMyRequestResponse> => {
    const options: InjectOptions = {
      method,
      url: `/api/v1/scim/v2${path}`,
      remoteAddress: `198.18.0.${++address}`,
      headers: { authorization: `Bearer ${state.scim}` },
    };
    if (payload) {
      options.headers = { ...options.headers, 'content-type': 'application/scim+json' };
      options.payload = JSON.stringify(payload);
    }
    return app.inject(options);
  };

  const idp = new FakeIdp('taskmoor', 'contract client secret');
  const samlIdp = new FakeSamlIdp();

  beforeAll(async () => {
    await idp.start();
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
  });
  afterAll(async () => {
    await app.close();
    await idp.stop();
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
    {
      route: 'POST /api/v1/account/tokens',
      expect: 'token.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/account/tokens',
          payload: { name: 'Contract script', scopes: ['read'], expiresInDays: 30 },
        });
        state.personal = res.json().apiToken.id;
        return res;
      },
    },
    {
      route: 'POST /api/v1/account/tokens/:id/rotate',
      expect: 'token.rotated',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: `/api/v1/account/tokens/${state.personal}/rotate`,
          payload: { overlapHours: 1 },
        });
        state.personalNext = res.json().apiToken.id;
        return res;
      },
    },
    {
      route: 'DELETE /api/v1/account/tokens/:id',
      expect: 'token.revoked',
      run: () => admin({ method: 'DELETE', url: `/api/v1/account/tokens/${state.personalNext}` }),
    },
    {
      route: 'POST /api/v1/service-accounts',
      expect: 'service_account.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/service-accounts',
          payload: { name: 'Contract robot', description: 'Deploys' },
        });
        state.robot = res.json().serviceAccount.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/service-accounts/:id',
      expect: 'service_account.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/service-accounts/${state.robot}`,
          payload: { description: 'Deploys and reports' },
        }),
    },
    {
      route: 'POST /api/v1/service-accounts/:id/tokens',
      expect: 'token.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: `/api/v1/service-accounts/${state.robot}/tokens`,
          payload: { name: 'Deploy key', scopes: ['read', 'write'], expiresInDays: 90 },
        });
        state.robotKey = res.json().apiToken.id;
        return res;
      },
    },
    {
      route: 'POST /api/v1/service-accounts/:id/tokens/:tokenId/rotate',
      expect: 'token.rotated',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: `/api/v1/service-accounts/${state.robot}/tokens/${state.robotKey}/rotate`,
          payload: { overlapHours: 48 },
        });
        state.robotKeyNext = res.json().apiToken.id;
        return res;
      },
    },
    {
      route: 'DELETE /api/v1/admin/tokens/:id',
      expect: 'token.revoked',
      run: () => admin({ method: 'DELETE', url: `/api/v1/admin/tokens/${state.robotKeyNext}` }),
    },
    {
      route: 'POST /api/v1/admin/tokens/revoke',
      expect: 'token.bulk_revoked',
      // The rotated key still works during its overlap; revoking the robot's tokens ends it.
      run: () =>
        admin({
          method: 'POST',
          url: '/api/v1/admin/tokens/revoke',
          payload: { ownerId: state.robot },
        }),
    },
    {
      route: 'PUT /api/v1/admin/token-policy',
      expect: 'token_policy.updated',
      run: () =>
        admin({
          method: 'PUT',
          url: '/api/v1/admin/token-policy',
          payload: { maxLifetimeDays: 730 },
        }),
    },
    {
      route: 'POST /api/v1/service-accounts/:id/deactivate',
      expect: 'service_account.deactivated',
      run: () =>
        admin({ method: 'POST', url: `/api/v1/service-accounts/${state.robot}/deactivate` }),
    },
    {
      route: 'POST /api/v1/service-accounts/:id/reactivate',
      expect: 'service_account.reactivated',
      run: () =>
        admin({ method: 'POST', url: `/api/v1/service-accounts/${state.robot}/reactivate` }),
    },
    {
      route: 'POST /api/v1/track-categories',
      expect: 'track_category.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/track-categories',
          payload: { name: 'Product' },
        });
        state.category = res.json().category.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/track-categories/:id',
      expect: 'track_category.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/track-categories/${state.category}`,
          payload: { description: 'What we sell' },
        }),
    },
    {
      route: 'POST /api/v1/tracks',
      expect: 'track.created',
      run: async () => {
        // A local-mode track also copies a policy and adds its creator as an administrator:
        // still one event.
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'loc', name: 'Local', mode: 'local', categoryId: state.category },
        });
        state.newTrack = res.json().track?.id;
        return res;
      },
      prepare: async () => {
        const res = await call(undefined, {
          method: 'POST',
          url: '/api/v1/session',
          payload: { email: 'bo@example.com', password: 'quiet otter lantern' },
        });
        state.bo1b = sessionCookie(res);
      },
    },
    {
      route: 'PATCH /api/v1/tracks/:id',
      expect: 'track.updated',
      run: () =>
        call(String(state.bo1b), {
          method: 'PATCH',
          url: `/api/v1/tracks/${state.newTrack}`,
          payload: { key: 'LOC2', features: { sprints: false } },
        }),
    },
    {
      route: 'POST /api/v1/tracks/:id/archive',
      expect: 'track.archived',
      run: () => admin({ method: 'POST', url: `/api/v1/tracks/${state.newTrack}/archive` }),
    },
    {
      route: 'POST /api/v1/tracks/:id/restore',
      expect: 'track.restored',
      run: () => admin({ method: 'POST', url: `/api/v1/tracks/${state.newTrack}/restore` }),
    },
    {
      route: 'POST /api/v1/tickets',
      expect: 'ticket.created',
      run: async () => {
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: '/api/v1/tickets',
          payload: { track: state.newTrack, summary: 'First ticket' },
        });
        state.ticket = res.json().ticket?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/tickets/:id',
      expect: 'ticket.updated',
      run: () =>
        call(String(state.bo1b), {
          method: 'PATCH',
          url: `/api/v1/tickets/${state.ticket}`,
          payload: { summary: 'First ticket, renamed', dueDate: '2026-12-01' },
        }),
    },
    {
      route: 'PUT /api/v1/tickets/:id/rank',
      expect: 'ticket.ranked',
      prepare: async () => {
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: '/api/v1/tickets',
          payload: { track: state.newTrack, summary: 'Second ticket' },
        });
        state.secondTicket = res.json().ticket.id;
      },
      run: () =>
        call(String(state.bo1b), {
          method: 'PUT',
          url: `/api/v1/tickets/${state.ticket}/rank`,
          payload: { after: state.secondTicket },
        }),
    },
    {
      route: 'POST /api/v1/tickets/:id/move',
      expect: 'ticket.moved',
      prepare: async () => {
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'MOV', name: 'Moves', mode: 'local' },
        });
        state.moveTrack = res.json().track.id;
      },
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/tickets/${state.ticket}/move`,
          payload: { track: 'MOV' },
        }),
    },
    {
      route: 'DELETE /api/v1/tickets/:id',
      expect: 'ticket.deleted',
      run: () =>
        call(String(state.bo1b), { method: 'DELETE', url: `/api/v1/tickets/${state.ticket}` }),
    },
    {
      route: 'POST /api/v1/tickets/:id/restore',
      expect: 'ticket.restored',
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/tickets/${state.ticket}/restore`,
        }),
    },
    {
      route: 'POST /api/v1/priorities',
      expect: 'priority.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/priorities',
          payload: { name: 'Blocker', icon: 'priority-blocker' },
        });
        state.priority = res.json().priority?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/priorities/:id',
      expect: 'priority.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/priorities/${state.priority}`,
          payload: { color: '#aa0000' },
        }),
    },
    {
      route: 'PUT /api/v1/priorities/order',
      expect: 'priority.reordered',
      run: async () => {
        const list = await admin({ method: 'GET', url: '/api/v1/priorities' });
        const ids = list.json().priorities.map((p: { id: number }) => p.id);
        return admin({
          method: 'PUT',
          url: '/api/v1/priorities/order',
          payload: { priorityIds: ids.reverse() },
        });
      },
    },
    {
      route: 'POST /api/v1/priority-sets',
      expect: 'priority_set.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/priority-sets',
          payload: {
            name: 'Blockers only',
            priorityIds: [state.priority],
            defaultPriorityId: state.priority,
          },
        });
        state.prioritySet = res.json().prioritySet?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/priority-sets/:id',
      expect: 'priority_set.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/priority-sets/${state.prioritySet}`,
          payload: { description: 'For incidents' },
        }),
    },
    {
      route: 'DELETE /api/v1/priority-sets/:id',
      expect: 'priority_set.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/priority-sets/${state.prioritySet}` }),
    },
    {
      route: 'DELETE /api/v1/priorities/:id',
      expect: 'priority.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/priorities/${state.priority}` }),
    },
    {
      route: 'POST /api/v1/close-reasons',
      expect: 'close_reason.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/close-reasons',
          payload: { name: 'Obsolete' },
        });
        state.closeReason = res.json().closeReason?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/close-reasons/:id',
      expect: 'close_reason.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/close-reasons/${state.closeReason}`,
          payload: { description: 'Nobody needs it any more' },
        }),
    },
    {
      route: 'PUT /api/v1/close-reasons/order',
      expect: 'close_reason.reordered',
      run: async () => {
        const list = await admin({ method: 'GET', url: '/api/v1/close-reasons' });
        const ids = list.json().closeReasons.map((r: { id: number }) => r.id);
        return admin({
          method: 'PUT',
          url: '/api/v1/close-reasons/order',
          payload: { closeReasonIds: ids.reverse() },
        });
      },
    },
    {
      route: 'DELETE /api/v1/close-reasons/:id',
      expect: 'close_reason.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/close-reasons/${state.closeReason}` }),
    },
    {
      route: 'POST /api/v1/labels/merge',
      expect: 'label.merged',
      // A ticket with the label: the merge rewrites it, still one event.
      prepare: async () => {
        await call(String(state.bo1b), {
          method: 'PATCH',
          url: `/api/v1/tickets/${state.ticket}`,
          payload: { labels: ['front-end'] },
        });
      },
      run: () =>
        admin({
          method: 'POST',
          url: '/api/v1/labels/merge',
          payload: { labels: ['front-end'], into: 'frontend' },
        }),
    },
    {
      route: 'POST /api/v1/tracks/:id/releases',
      expect: 'release.created',
      run: async () => {
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/tracks/${state.moveTrack}/releases`,
          payload: { name: '1.0', releaseDate: '2026-12-01' },
        });
        state.release = res.json().release?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/releases/:id',
      expect: 'release.updated',
      run: () =>
        call(String(state.bo1b), {
          method: 'PATCH',
          url: `/api/v1/releases/${state.release}`,
          payload: { description: 'The first one' },
        }),
    },
    {
      route: 'PUT /api/v1/tracks/:id/releases/order',
      expect: 'release.reordered',
      prepare: async () => {
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/tracks/${state.moveTrack}/releases`,
          payload: { name: '2.0' },
        });
        state.release2 = res.json().release.id;
      },
      run: () =>
        call(String(state.bo1b), {
          method: 'PUT',
          url: `/api/v1/tracks/${state.moveTrack}/releases/order`,
          payload: { releaseIds: [state.release2, state.release] },
        }),
    },
    {
      route: 'PUT /api/v1/releases/:id/approvers',
      expect: 'release.approvers_set',
      run: () =>
        call(String(state.bo1b), {
          method: 'PUT',
          url: `/api/v1/releases/${state.release}/approvers`,
          payload: { userIds: [state.bo] },
        }),
    },
    {
      route: 'POST /api/v1/releases/:id/approval',
      expect: 'release.approval_decided',
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/releases/${state.release}/approval`,
          payload: { decision: 'approved' },
        }),
    },
    {
      route: 'POST /api/v1/releases/:id/ship',
      expect: 'release.shipped',
      // An open ticket moves to the next release: still one event.
      prepare: async () => {
        await call(String(state.bo1b), {
          method: 'PATCH',
          url: `/api/v1/tickets/${state.ticket}`,
          payload: { targetReleaseIds: [state.release] },
        });
      },
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/releases/${state.release}/ship`,
          payload: { moveOpenTo: state.release2 },
        }),
    },
    {
      route: 'POST /api/v1/releases/:id/unship',
      expect: 'release.unshipped',
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/releases/${state.release}/unship`,
        }),
    },
    {
      route: 'POST /api/v1/releases/:id/archive',
      expect: 'release.archived',
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/releases/${state.release}/archive`,
        }),
    },
    {
      route: 'POST /api/v1/releases/:id/restore',
      expect: 'release.restored',
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/releases/${state.release}/restore`,
        }),
    },
    {
      route: 'POST /api/v1/releases/:id/merge',
      expect: 'release.merged',
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/releases/${state.release}/merge`,
          payload: { into: state.release2 },
        }),
    },
    {
      route: 'DELETE /api/v1/releases/:id',
      expect: 'release.deleted',
      run: () =>
        call(String(state.bo1b), {
          method: 'DELETE',
          url: `/api/v1/releases/${state.release2}?removeFromTickets=true`,
        }),
    },
    {
      route: 'POST /api/v1/tracks/:id/areas',
      expect: 'area.created',
      run: async () => {
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/tracks/${state.moveTrack}/areas`,
          payload: { name: 'API', ownerId: state.bo, defaultAssignee: 'area_owner' },
        });
        state.area = res.json().area?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/areas/:id',
      expect: 'area.updated',
      run: () =>
        call(String(state.bo1b), {
          method: 'PATCH',
          url: `/api/v1/areas/${state.area}`,
          payload: { description: 'The public interface' },
        }),
    },
    {
      route: 'POST /api/v1/areas/:id/archive',
      expect: 'area.archived',
      run: () =>
        call(String(state.bo1b), { method: 'POST', url: `/api/v1/areas/${state.area}/archive` }),
    },
    {
      route: 'POST /api/v1/areas/:id/restore',
      expect: 'area.restored',
      run: () =>
        call(String(state.bo1b), { method: 'POST', url: `/api/v1/areas/${state.area}/restore` }),
    },
    {
      route: 'DELETE /api/v1/areas/:id',
      expect: 'area.deleted',
      prepare: async () => {
        await call(String(state.bo1b), {
          method: 'PATCH',
          url: `/api/v1/tickets/${state.ticket}`,
          payload: { areaIds: [state.area] },
        });
      },
      run: () =>
        call(String(state.bo1b), {
          method: 'DELETE',
          url: `/api/v1/areas/${state.area}?removeFromTickets=true`,
        }),
    },
    {
      route: 'POST /api/v1/link-types',
      expect: 'link_type.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/link-types',
          payload: { name: 'Causes', outward: 'causes', inward: 'is caused by' },
        });
        state.linkType = res.json().linkType?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/link-types/:id',
      expect: 'link_type.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/link-types/${state.linkType}`,
          payload: { inward: 'is the result of' },
        }),
    },
    {
      route: 'POST /api/v1/tickets/:id/links',
      expect: 'ticket.linked',
      run: async () => {
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/tickets/${state.ticket}/links`,
          payload: { linkTypeId: state.linkType, ticket: state.secondTicket },
        });
        state.link = res.json().link?.id;
        return res;
      },
    },
    {
      route: 'DELETE /api/v1/tickets/:id/links/:linkId',
      expect: 'ticket.unlinked',
      run: () =>
        call(String(state.bo1b), {
          method: 'DELETE',
          url: `/api/v1/tickets/${state.ticket}/links/${state.link}`,
        }),
    },
    {
      route: 'DELETE /api/v1/link-types/:id',
      expect: 'link_type.deleted',
      // A link of the type moves to the replacement: still one event.
      prepare: async () => {
        await call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/tickets/${state.ticket}/links`,
          payload: { linkTypeId: state.linkType, ticket: state.secondTicket },
        });
        const types = await admin({ method: 'GET', url: '/api/v1/link-types' });
        state.relates = types
          .json()
          .linkTypes.find((t: { name: string }) => t.name === 'Relates').id;
      },
      run: () =>
        admin({
          method: 'DELETE',
          url: `/api/v1/link-types/${state.linkType}?replacementId=${state.relates}`,
        }),
    },
    {
      route: 'POST /api/v1/tickets/:id/web-links',
      expect: 'ticket.web_link_added',
      run: async () => {
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/tickets/${state.ticket}/web-links`,
          payload: { url: 'https://example.com/pr/1', title: 'Pull request 1', globalId: 'pr-1' },
        });
        state.webLink = res.json().webLink?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/tickets/:id/web-links/:linkId',
      expect: 'ticket.web_link_updated',
      run: () =>
        call(String(state.bo1b), {
          method: 'PATCH',
          url: `/api/v1/tickets/${state.ticket}/web-links/${state.webLink}`,
          payload: { title: 'Pull request 1 (merged)' },
        }),
    },
    {
      route: 'DELETE /api/v1/tickets/:id/web-links/:linkId',
      expect: 'ticket.web_link_removed',
      run: () =>
        call(String(state.bo1b), {
          method: 'DELETE',
          url: `/api/v1/tickets/${state.ticket}/web-links/${state.webLink}`,
        }),
    },
    {
      // Bo follows the ticket already: creating and editing it did that.
      route: 'DELETE /api/v1/tickets/:id/followers/:userId',
      expect: 'ticket.unfollowed',
      run: () =>
        call(String(state.bo1b), {
          method: 'DELETE',
          url: `/api/v1/tickets/${state.ticket}/followers/me`,
        }),
    },
    {
      route: 'PUT /api/v1/tickets/:id/followers/:userId',
      expect: 'ticket.followed',
      run: () =>
        call(String(state.bo1b), {
          method: 'PUT',
          url: `/api/v1/tickets/${state.ticket}/followers/${state.bo}`,
        }),
    },
    {
      route: 'PUT /api/v1/tickets/:id/votes',
      expect: 'ticket.voted',
      run: () =>
        call(String(state.bo1b), { method: 'PUT', url: `/api/v1/tickets/${state.ticket}/votes` }),
    },
    {
      route: 'DELETE /api/v1/tickets/:id/votes',
      expect: 'ticket.unvoted',
      run: () =>
        call(String(state.bo1b), {
          method: 'DELETE',
          url: `/api/v1/tickets/${state.ticket}/votes`,
        }),
    },
    {
      route: 'PATCH /api/v1/account/preferences',
      expect: 'user.preferences_updated',
      run: () =>
        call(String(state.bo1b), {
          method: 'PATCH',
          url: '/api/v1/account/preferences',
          payload: { autoFollow: false },
        }),
    },
    {
      route: 'PUT /api/v1/link-policy',
      expect: 'link_policy.updated',
      run: () => admin({ method: 'PUT', url: '/api/v1/link-policy', payload: { enabled: false } }),
    },
    {
      route: 'DELETE /api/v1/track-categories/:id',
      expect: 'track_category.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/track-categories/${state.category}` }),
    },
    {
      route: 'POST /api/v1/hierarchy-levels',
      expect: 'hierarchy_level.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/hierarchy-levels',
          payload: { name: 'Objective' },
        });
        state.level = res.json().level?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/hierarchy-levels/:id',
      expect: 'hierarchy_level.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/hierarchy-levels/${state.level}`,
          payload: { description: 'What a year of work aims at' },
        }),
    },
    {
      route: 'POST /api/v1/ticket-types',
      expect: 'ticket_type.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/ticket-types',
          payload: { name: 'Objective', levelId: state.level, icon: 'target' },
        });
        state.ticketType = res.json().ticketType?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/ticket-types/:id',
      expect: 'ticket_type.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/ticket-types/${state.ticketType}`,
          payload: { color: '#336699' },
        }),
    },
    {
      route: 'POST /api/v1/type-sets',
      expect: 'type_set.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/type-sets',
          payload: {
            name: 'Planning type set',
            ticketTypeIds: [state.ticketType],
            defaultTypeId: state.ticketType,
          },
        });
        state.typeSet = res.json().typeSet?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/type-sets/:id',
      expect: 'type_set.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/type-sets/${state.typeSet}`,
          payload: { description: 'Objectives only' },
        }),
    },
    {
      route: 'DELETE /api/v1/type-sets/:id',
      expect: 'type_set.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/type-sets/${state.typeSet}` }),
    },
    {
      route: 'DELETE /api/v1/ticket-types/:id',
      expect: 'ticket_type.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/ticket-types/${state.ticketType}` }),
    },
    {
      route: 'DELETE /api/v1/hierarchy-levels/:id',
      expect: 'hierarchy_level.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/hierarchy-levels/${state.level}` }),
    },
    {
      route: 'POST /api/v1/account/two-factor/totp/confirm',
      expect: 'user.two_factor_enabled',
      prepare: async () => {
        await database.db
          .insertInto('app_user')
          .values({
            workspace_id: 1,
            email: 'dee@example.com',
            name: 'Dee',
            password_hash: await hashPassword(PASSWORD),
          })
          .execute();
        state.dee = sessionCookie(
          await call(undefined, {
            method: 'POST',
            url: '/api/v1/session',
            payload: { email: 'dee@example.com', password: PASSWORD },
          }),
        );
        const setup = (
          await call(String(state.dee), { method: 'POST', url: '/api/v1/account/two-factor/totp' })
        ).json();
        state.deeSecret = setup.secret;
        state.deeSetup = setup.setupToken;
      },
      run: () =>
        call(String(state.dee), {
          method: 'POST',
          url: '/api/v1/account/two-factor/totp/confirm',
          payload: {
            setupToken: state.deeSetup,
            code: totpCode(String(state.deeSecret), totpStep(new Date())),
          },
        }),
    },
    {
      route: 'POST /api/v1/session/second-factor',
      expect: 'session.started',
      prepare: async () => {
        const res = await call(undefined, {
          method: 'POST',
          url: '/api/v1/session',
          payload: { email: 'dee@example.com', password: PASSWORD },
        });
        state.deeChallenge = res.json().challenge;
      },
      run: () =>
        call(undefined, {
          method: 'POST',
          url: '/api/v1/session/second-factor',
          payload: {
            challenge: state.deeChallenge,
            method: 'totp',
            code: totpCode(String(state.deeSecret), totpStep(new Date()) + 1),
          },
        }),
    },
    {
      route: 'POST /api/v1/account/two-factor/recovery-codes',
      expect: 'user.recovery_codes_regenerated',
      run: () =>
        call(String(state.dee), {
          method: 'POST',
          url: '/api/v1/account/two-factor/recovery-codes',
          payload: { password: PASSWORD },
        }),
    },
    {
      route: 'POST /api/v1/account/two-factor/webauthn',
      expect: 'user.two_factor_enabled',
      prepare: async () => {
        const begin = (
          await call(String(state.dee), {
            method: 'POST',
            url: '/api/v1/account/two-factor/webauthn/options',
          })
        ).json();
        state.deeRegistration = begin.registrationToken;
        state.deeKey = JSON.stringify(
          new SoftAuthenticator('http://localhost:8080', 'localhost').register(begin.options),
        );
      },
      run: async () => {
        const res = await call(String(state.dee), {
          method: 'POST',
          url: '/api/v1/account/two-factor/webauthn',
          payload: {
            registrationToken: state.deeRegistration,
            name: 'Key',
            response: JSON.parse(String(state.deeKey)),
          },
        });
        state.deeKeyId = res.json().securityKey.id;
        return res;
      },
    },
    {
      route: 'POST /api/v1/account/two-factor/webauthn/:id/remove',
      expect: 'user.two_factor_disabled',
      run: () =>
        call(String(state.dee), {
          method: 'POST',
          url: `/api/v1/account/two-factor/webauthn/${state.deeKeyId}/remove`,
          payload: { password: PASSWORD },
        }),
    },
    {
      route: 'POST /api/v1/account/two-factor/totp/disable',
      expect: 'user.two_factor_disabled',
      run: () =>
        call(String(state.dee), {
          method: 'POST',
          url: '/api/v1/account/two-factor/totp/disable',
          payload: { password: PASSWORD },
        }),
    },
    {
      route: 'POST /api/v1/users/:id/two-factor/reset',
      expect: 'user.two_factor_reset',
      run: () => admin({ method: 'POST', url: `/api/v1/users/${state.bo}/two-factor/reset` }),
    },
    {
      route: 'PUT /api/v1/security/two-factor',
      expect: 'two_factor_policy.updated',
      run: () =>
        admin({
          method: 'PUT',
          url: '/api/v1/security/two-factor',
          payload: { required: 'everyone' },
        }),
    },
    {
      route: 'POST /api/v1/session/enroll/totp/confirm',
      expect: 'user.two_factor_enabled',
      prepare: async () => {
        await database.db
          .insertInto('app_user')
          .values({
            workspace_id: 1,
            email: 'eve@example.com',
            name: 'Eve',
            password_hash: await hashPassword(PASSWORD),
          })
          .execute();
        const res = await call(undefined, {
          method: 'POST',
          url: '/api/v1/session',
          payload: { email: 'eve@example.com', password: PASSWORD },
        });
        state.eveChallenge = res.json().challenge;
        const setup = (
          await call(undefined, {
            method: 'POST',
            url: '/api/v1/session/enroll/totp',
            payload: { challenge: state.eveChallenge },
          })
        ).json();
        state.eveSecret = setup.secret;
        state.eveSetup = setup.setupToken;
      },
      run: () =>
        call(undefined, {
          method: 'POST',
          url: '/api/v1/session/enroll/totp/confirm',
          payload: {
            challenge: state.eveChallenge,
            setupToken: state.eveSetup,
            code: totpCode(String(state.eveSecret), totpStep(new Date())),
          },
        }),
    },
    {
      route: 'POST /api/v1/identity-providers',
      expect: 'identity_provider.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/identity-providers',
          payload: {
            name: 'Contract IdP',
            issuer: idp.issuer,
            clientId: 'taskmoor',
            clientSecret: 'contract client secret',
            domains: ['sso.example'],
            groupClaim: 'groups',
          },
        });
        state.idp = res.json().provider?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/identity-providers/:id',
      expect: 'identity_provider.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/identity-providers/${state.idp}`,
          payload: { groupMap: [{ claimValue: 'eng', groupId: state.parent }] },
        }),
    },
    {
      route: 'GET /api/v1/auth/oidc/callback',
      expect: 'sso.signed_in',
      status: 302,
      prepare: async () => {
        idp.person = { sub: 'fay', email: 'fay@sso.example', name: 'Fay', groups: ['eng'] };
        const start = await call(undefined, {
          method: 'GET',
          url: `/api/v1/auth/oidc/${state.idp}/start`,
        });
        const header = start.headers['set-cookie'];
        state.ssoBrowser = String(Array.isArray(header) ? header[0] : header).split(';')[0] ?? '';
        const authorize = await fetch(String(start.headers.location), { redirect: 'manual' });
        const back = new URL(authorize.headers.get('location') ?? '');
        state.ssoCallback = `${back.pathname}${back.search}`;
      },
      run: async () => {
        const res = await call(undefined, {
          method: 'GET',
          url: String(state.ssoCallback),
          headers: { cookie: String(state.ssoBrowser) },
        });
        expect(String(res.headers.location)).not.toContain('sso_error');
        return res;
      },
    },
    {
      route: 'GET /api/v1/auth/saml/continue',
      expect: 'sso.signed_in',
      status: 302,
      // A SAML provider, a sign-in started, answered and posted back; then the browser
      // collects it.
      prepare: async () => {
        const created = await admin({
          method: 'POST',
          url: '/api/v1/identity-providers',
          payload: {
            protocol: 'saml',
            name: 'Contract SAML',
            metadataXml: samlIdp.metadata(),
            domains: ['saml.example'],
          },
        });
        const provider = created.json().provider;
        const start = await call(undefined, {
          method: 'GET',
          url: `/api/v1/auth/saml/${provider.id}/start`,
        });
        const header = start.headers['set-cookie'];
        state.samlBrowser = String(Array.isArray(header) ? header[0] : header).split(';')[0] ?? '';
        const request = samlIdp.readRequest(String(start.headers.location));
        const acs = await call(undefined, {
          method: 'POST',
          url: `/api/v1/auth/saml/${provider.id}/acs`,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: new URLSearchParams({
            SAMLResponse: samlIdp.post({
              person: { nameId: 'gil@saml.example' },
              acsUrl: provider.serviceProvider.acsUrl,
              audience: provider.serviceProvider.spEntityId,
              inResponseTo: request.id,
            }),
          }).toString(),
        });
        const next = new URL(String(acs.headers.location));
        state.samlContinue = `${next.pathname}${next.search}`;
      },
      run: async () => {
        const res = await call(undefined, {
          method: 'GET',
          url: String(state.samlContinue),
          headers: { cookie: String(state.samlBrowser) },
        });
        expect(String(res.headers.location)).not.toContain('sso_error');
        return res;
      },
    },
    {
      route: 'DELETE /api/v1/identity-providers/:id',
      expect: 'identity_provider.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/identity-providers/${state.idp}` }),
    },
    {
      route: 'PUT /api/v1/audit/settings',
      expect: 'audit.settings_updated',
      run: () =>
        admin({ method: 'PUT', url: '/api/v1/audit/settings', payload: { retentionMonths: 84 } }),
    },
    {
      route: 'POST /api/v1/scim/v2/Users',
      expect: 'scim.user_created',
      // A provisioning service account with a scim token; its own events are not counted.
      prepare: async () => {
        const account = await admin({
          method: 'POST',
          url: '/api/v1/service-accounts',
          payload: { name: 'Contract provisioning', description: 'SCIM' },
        });
        const issued = await admin({
          method: 'POST',
          url: `/api/v1/service-accounts/${account.json().serviceAccount.id}/tokens`,
          payload: { name: 'Provisioning', scopes: ['scim'], expiresInDays: 30 },
        });
        state.scim = issued.json().token;
      },
      run: async () => {
        const res = await scim('POST', '/Users', {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'grace@example.com',
          name: { givenName: 'Grace', familyName: 'Hopper' },
          emails: [{ value: 'grace@example.com', type: 'work', primary: true }],
        });
        state.scimUser = res.json().id;
        return res;
      },
    },
    {
      route: 'PUT /api/v1/scim/v2/Users/:id',
      expect: 'scim.user_updated',
      run: () =>
        scim('PUT', `/Users/${state.scimUser}`, {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'grace@example.com',
          name: { givenName: 'Grace', familyName: 'Hopper' },
          title: 'Rear admiral',
        }),
    },
    {
      route: 'PATCH /api/v1/scim/v2/Users/:id',
      expect: 'scim.user_updated',
      run: () =>
        scim('PATCH', `/Users/${state.scimUser}`, {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        }),
    },
    {
      route: 'POST /api/v1/scim/v2/Groups',
      expect: 'scim.group_created',
      run: async () => {
        const res = await scim('POST', '/Groups', {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
          displayName: 'Compilers',
          members: [{ value: String(state.scimUser) }],
        });
        state.scimGroup = res.json().id;
        return res;
      },
    },
    {
      route: 'PUT /api/v1/scim/v2/Groups/:id',
      expect: 'scim.group_updated',
      run: () =>
        scim('PUT', `/Groups/${state.scimGroup}`, {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
          displayName: 'Compiler team',
          members: [{ value: String(state.scimUser) }],
        }),
    },
    {
      route: 'PATCH /api/v1/scim/v2/Groups/:id',
      expect: 'scim.group_updated',
      run: () =>
        scim('PATCH', `/Groups/${state.scimGroup}`, {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'remove', path: `members[value eq "${state.scimUser}"]` }],
        }),
    },
    {
      route: 'DELETE /api/v1/scim/v2/Groups/:id',
      expect: 'scim.group_deleted',
      run: () => scim('DELETE', `/Groups/${state.scimGroup}`),
    },
    {
      route: 'DELETE /api/v1/scim/v2/Users/:id',
      expect: 'scim.user_removed',
      run: () => scim('DELETE', `/Users/${state.scimUser}`),
    },
  ];

  it('covers every mutating route with a scenario or a stated exemption', () => {
    const mutating = app.routeTable.filter(
      (r) => MUTATING.includes(r.split(' ')[0] ?? '') || REDIRECT_MUTATIONS.includes(r),
    );
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
      if (scenario.status) expect(res.statusCode, scenario.route).toBe(scenario.status);
      else expect(res.statusCode, `${scenario.route}: ${res.body}`).toBeLessThan(300);
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
