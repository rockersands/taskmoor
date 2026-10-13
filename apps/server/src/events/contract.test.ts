import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword, totpCode, totpStep } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { issueSetupToken } from '../setup';
import { FakeIdp } from '../testing/fake-idp';
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
const REDIRECT_MUTATIONS = ['GET /api/v1/auth/oidc/:id/start', 'GET /api/v1/auth/oidc/callback'];
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

  const idp = new FakeIdp('taskmoor', 'contract client secret');

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
      route: 'DELETE /api/v1/track-categories/:id',
      expect: 'track_category.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/track-categories/${state.category}` }),
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
