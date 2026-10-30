import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword, totpCode, totpStep } from '@taskmoor/iam';
import { LocalStore } from '@taskmoor/storage';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { processAttachment } from '../attachments/jobs';
import { type AttachmentStores, storesOf } from '../attachments/stores';
import { SESSION_COOKIE } from '../auth';
import { unsubscribeHash } from '../email/deliver';
import { FieldCatalogs } from '../fields/catalog';
import { IMPORT_FORMATS } from '../import/jobs';
import { runImport } from '../import/run';
import { queueRun, runSync } from '../ldap/sync';
import { issueSetupToken } from '../setup';
import { FakeIdp } from '../testing/fake-idp';
import { FakeLdap } from '../testing/fake-ldap';
import { FakeSamlIdp } from '../testing/fake-saml-idp';
import { multipartFile } from '../testing/multipart';
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
  'POST /api/v1/directories/test':
    'reads only: tries directory settings (connect, bind, read a first page), stores nothing',
  'POST /api/v1/workflow-maps/:id/impact':
    'reads only: what a change of a workflow map would do to tickets, stores nothing',
  'POST /api/v1/search': 'reads only: runs a query too long for a URL (M1-037)',
  'PUT /api/v1/me/recent-tickets/:id':
    'personal history: the tickets a person opened, for their own Recent list (M1-052)',
};
/**
 * Event types no route emits: a background job's own changes (M1-082 directory syncs). The
 * last test below runs the job and checks each of them like a route scenario.
 */
const JOB_EVENTS: readonly EventType[] = [
  'directory.synced',
  'directory.user_created',
  'directory.user_updated',
  'directory.user_removed',
  'directory.group_created',
  'directory.group_updated',
  'directory.group_deleted',
];
/** The attachment worker's own event (M1-016): checked by its own test below. */
const SCAN_JOB_EVENTS: readonly EventType[] = ['attachment.quarantined'];
/** The end of an import (M1-086), emitted by its job: checked by its own test below. */
const IMPORT_JOB_EVENTS: readonly EventType[] = ['import_run.finished'];
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
  const ldap = new FakeLdap({ flavour: 'openldap' });
  const directoryBody = (name: string) => ({
    name,
    kind: 'openldap',
    url: ldap.url,
    bindDn: ldap.bindDn,
    bindPassword: ldap.bindPassword,
    baseDn: ldap.baseDn,
  });

  const files = mkdtempSync(join(tmpdir(), 'taskmoor-contract-'));
  let attachments: AttachmentStores;

  beforeAll(async () => {
    await idp.start();
    await ldap.start();
    attachments = storesOf(await LocalStore.open(files));
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'], attachments });
  });
  afterAll(async () => {
    await app.close();
    await idp.stop();
    await ldap.stop();
    rmSync(files, { recursive: true, force: true });
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
      route: 'POST /api/v1/bulk-operations',
      expect: 'bulk_operation.created',
      // The changes run later in a job, each as its own ticket event.
      run: async () => {
        const res = await call(String(state.admin), {
          method: 'POST',
          url: '/api/v1/bulk-operations',
          payload: { action: 'edit', tickets: [state.ticket], edit: { summary: 'Bulk' } },
        });
        state.bulk = res.json().bulkOperation?.id;
        return res;
      },
    },
    {
      route: 'POST /api/v1/bulk-operations/:id/cancel',
      expect: 'bulk_operation.cancelled',
      run: () =>
        call(String(state.admin), {
          method: 'POST',
          url: `/api/v1/bulk-operations/${state.bulk}/cancel`,
        }),
    },
    {
      route: 'POST /api/v1/admin/imports',
      expect: 'import_run.created',
      // The import runs later in a job; its end is `import_run.finished` (tested below).
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/admin/imports',
          payload: {
            dryRun: true,
            source: { format: 'synthetic', generate: { seed: 1, prefix: 'CT', tickets: 2 } },
          },
        });
        state.importRun = res.json().importRun?.id;
        return res;
      },
    },
    {
      route: 'POST /api/v1/admin/imports/:id/cancel',
      expect: 'import_run.cancelled',
      run: () => admin({ method: 'POST', url: `/api/v1/admin/imports/${state.importRun}/cancel` }),
    },
    {
      route: 'POST /api/v1/tickets/:id/purge',
      expect: 'ticket.purged',
      prepare: async () => {
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: '/api/v1/tickets',
          payload: { track: state.newTrack, summary: 'Short-lived' },
        });
        state.doomedTicket = res.json().ticket.id;
        await call(String(state.bo1b), {
          method: 'DELETE',
          url: `/api/v1/tickets/${state.doomedTicket}`,
        });
      },
      run: () => admin({ method: 'POST', url: `/api/v1/tickets/${state.doomedTicket}/purge` }),
    },
    {
      route: 'DELETE /api/v1/tracks/:id',
      expect: 'track.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/tracks/${state.moveTrack}` }),
    },
    {
      route: 'POST /api/v1/tracks/:id/undelete',
      expect: 'track.undeleted',
      run: () => admin({ method: 'POST', url: `/api/v1/tracks/${state.moveTrack}/undelete` }),
    },
    {
      route: 'POST /api/v1/tracks/:id/purge',
      expect: 'track.purged',
      prepare: async () => {
        // A local-mode track with a ticket: its policy, type set and types go with it.
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'GONE', name: 'Gone', mode: 'local' },
        });
        state.goneTrack = res.json().track.id;
        await call(String(state.bo1b), {
          method: 'POST',
          url: '/api/v1/tickets',
          payload: { track: 'GONE', summary: 'Goes with its track' },
        });
        await admin({ method: 'DELETE', url: `/api/v1/tracks/${state.goneTrack}` });
      },
      run: () => admin({ method: 'POST', url: `/api/v1/tracks/${state.goneTrack}/purge` }),
    },
    {
      route: 'PUT /api/v1/admin/guardrails/:name',
      expect: 'guardrail.changed',
      run: () =>
        admin({
          method: 'PUT',
          url: '/api/v1/admin/guardrails/areas_per_track',
          payload: { limit: 9000 },
        }),
    },
    {
      route: 'PUT /api/v1/admin/trash-policy',
      expect: 'trash_policy.updated',
      run: () =>
        admin({ method: 'PUT', url: '/api/v1/admin/trash-policy', payload: { retentionDays: 14 } }),
    },
    {
      route: 'PUT /api/v1/admin/backups/schedule',
      expect: 'backup_schedule.updated',
      run: () =>
        admin({
          method: 'PUT',
          url: '/api/v1/admin/backups/schedule',
          payload: { time: '03:15', keep: 7 },
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
      route: 'POST /api/v1/fields',
      expect: 'field.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/fields',
          payload: {
            name: 'Severity',
            type: 'select',
            context: { options: [{ value: 'S1' }, { value: 'S2', default: true }] },
          },
        });
        const field = res.json().field;
        state.field = field?.id;
        state.fieldContext = field?.contexts[0]?.id;
        state.fieldOptions = (field?.contexts[0]?.options ?? [])
          .map((o: { id: number }) => o.id)
          .join(',');
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/fields/:id',
      expect: 'field.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/fields/${state.field}`,
          payload: { description: 'How bad it is' },
        }),
    },
    {
      route: 'POST /api/v1/fields/:id/contexts',
      expect: 'field_context.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: `/api/v1/fields/${state.field}/contexts`,
          payload: { name: 'One track', trackIds: [state.track], options: [{ value: 'X' }] },
        });
        state.fieldContext2 = res.json().field?.contexts[1]?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/fields/:id/contexts/:contextId',
      expect: 'field_context.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/fields/${state.field}/contexts/${state.fieldContext2}`,
          payload: { name: 'Track context' },
        }),
    },
    {
      route: 'POST /api/v1/fields/:id/contexts/:contextId/options',
      expect: 'field_option.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: `/api/v1/fields/${state.field}/contexts/${state.fieldContext}/options`,
          payload: { value: 'S3' },
        });
        const options = res.json().field?.contexts[0]?.options ?? [];
        state.fieldOption = options[options.length - 1]?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/fields/:id/contexts/:contextId/options/:optionId',
      expect: 'field_option.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/fields/${state.field}/contexts/${state.fieldContext}/options/${state.fieldOption}`,
          payload: { value: 'S3 (minor)', disabled: true },
        }),
    },
    {
      route: 'PUT /api/v1/fields/:id/contexts/:contextId/options/order',
      expect: 'field_option.reordered',
      run: () =>
        admin({
          method: 'PUT',
          url: `/api/v1/fields/${state.field}/contexts/${state.fieldContext}/options/order`,
          payload: {
            optionIds: [
              Number(state.fieldOption),
              ...String(state.fieldOptions).split(',').map(Number),
            ],
          },
        }),
    },
    {
      route: 'DELETE /api/v1/fields/:id/contexts/:contextId/options/:optionId',
      expect: 'field_option.deleted',
      run: () =>
        admin({
          method: 'DELETE',
          url: `/api/v1/fields/${state.field}/contexts/${state.fieldContext}/options/${state.fieldOption}`,
        }),
    },
    {
      route: 'DELETE /api/v1/fields/:id/contexts/:contextId',
      expect: 'field_context.deleted',
      run: () =>
        admin({
          method: 'DELETE',
          url: `/api/v1/fields/${state.field}/contexts/${state.fieldContext2}`,
        }),
    },
    {
      route: 'DELETE /api/v1/fields/:id',
      expect: 'field.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/fields/${state.field}` }),
    },
    {
      route: 'POST /api/v1/field-rule-sets',
      expect: 'field_rule_set.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/field-rule-sets',
          payload: {
            name: 'Contract field_rule_set',
            rules: [{ field: 'dueDate', required: true }],
          },
        });
        state.ruleSet = res.json().fieldRuleSet?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/field-rule-sets/:id',
      expect: 'field_rule_set.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/field-rule-sets/${state.ruleSet}`,
          payload: { description: 'Changed' },
        }),
    },
    {
      route: 'DELETE /api/v1/field-rule-sets/:id',
      expect: 'field_rule_set.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/field-rule-sets/${state.ruleSet}` }),
    },
    {
      route: 'POST /api/v1/layout-sets',
      expect: 'layout_set.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/layout-sets',
          payload: {
            name: 'Contract layout_set',
            layouts: [
              {
                operation: 'view',
                definition: { tabs: [{ name: 'Main', sections: [{ fields: ['summary'] }] }] },
              },
            ],
          },
        });
        state.layoutSet = res.json().layoutSet?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/layout-sets/:id',
      expect: 'layout_set.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/layout-sets/${state.layoutSet}`,
          payload: { description: 'Changed' },
        }),
    },
    {
      route: 'DELETE /api/v1/layout-sets/:id',
      expect: 'layout_set.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/layout-sets/${state.layoutSet}` }),
    },
    {
      route: 'POST /api/v1/visibility-policies',
      expect: 'visibility_policy.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/visibility-policies',
          payload: {
            name: 'Contract visibility_policy',
            levels: [{ name: 'Internal', members: [{ grantee: 'any_user' }] }],
            defaultLevel: 'Internal',
          },
        });
        state.visibilityPolicy = res.json().visibilityPolicy?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/visibility-policies/:id',
      expect: 'visibility_policy.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/visibility-policies/${state.visibilityPolicy}`,
          payload: { description: 'Changed' },
        }),
    },
    {
      route: 'POST /api/v1/visibility-policies/:id/levels',
      expect: 'visibility_level.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: `/api/v1/visibility-policies/${state.visibilityPolicy}/levels`,
          payload: { name: 'Contract level' },
        });
        const levels = res.json().visibilityPolicy?.levels as { id: number; name: string }[];
        state.visibilityLevel = levels?.find((l) => l.name === 'Contract level')?.id ?? 0;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/visibility-policies/:id/levels/:levelId',
      expect: 'visibility_level.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/visibility-policies/${state.visibilityPolicy}/levels/${state.visibilityLevel}`,
          payload: { description: 'Changed', position: 0 },
        }),
    },
    {
      route: 'POST /api/v1/visibility-policies/:id/levels/:levelId/members',
      expect: 'visibility_level.member_added',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: `/api/v1/visibility-policies/${state.visibilityPolicy}/levels/${state.visibilityLevel}/members`,
          payload: { grantee: 'requester' },
        });
        const levels = res.json().visibilityPolicy?.levels as {
          id: number;
          members: { id: number; grantee: string }[];
        }[];
        state.visibilityMember =
          levels
            ?.find((l) => l.id === state.visibilityLevel)
            ?.members.find((m) => m.grantee === 'requester')?.id ?? 0;
        return res;
      },
    },
    {
      route: 'DELETE /api/v1/visibility-policies/:id/levels/:levelId/members/:memberId',
      expect: 'visibility_level.member_removed',
      run: () =>
        admin({
          method: 'DELETE',
          url: `/api/v1/visibility-policies/${state.visibilityPolicy}/levels/${state.visibilityLevel}/members/${state.visibilityMember}`,
        }),
    },
    {
      route: 'DELETE /api/v1/visibility-policies/:id/levels/:levelId',
      expect: 'visibility_level.deleted',
      run: () =>
        admin({
          method: 'DELETE',
          url: `/api/v1/visibility-policies/${state.visibilityPolicy}/levels/${state.visibilityLevel}`,
        }),
    },
    {
      route: 'DELETE /api/v1/visibility-policies/:id',
      expect: 'visibility_policy.deleted',
      run: () =>
        admin({ method: 'DELETE', url: `/api/v1/visibility-policies/${state.visibilityPolicy}` }),
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
      route: 'PATCH /api/v1/account/notification-preferences',
      expect: 'user.preferences_updated',
      run: () =>
        call(String(state.bo1b), {
          method: 'PATCH',
          url: '/api/v1/account/notification-preferences',
          payload: { ownChanges: true, events: { ticket_updated: { email: false } } },
        }),
    },
    {
      route: 'PUT /api/v1/admin/email-settings',
      expect: 'email_settings.updated',
      run: () =>
        admin({
          method: 'PUT',
          url: '/api/v1/admin/email-settings',
          payload: { batchWindowSeconds: 300, digestHour: 7 },
        }),
    },
    {
      route: 'POST /api/v1/unsubscribe',
      expect: 'user.preferences_updated',
      prepare: async () => {
        const person = await database.db
          .selectFrom('app_user')
          .select('id')
          .orderBy('id')
          .executeTakeFirstOrThrow();
        await database.db
          .insertInto('email_unsubscribe')
          .values({
            token_hash: unsubscribeHash('contract-unsubscribe-token'),
            workspace_id: 1,
            user_id: person.id,
            event: 'ticket_moved',
          })
          .execute();
      },
      run: () =>
        call('', {
          method: 'POST',
          url: '/api/v1/unsubscribe?token=contract-unsubscribe-token',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'List-Unsubscribe=One-Click',
        }),
    },
    {
      route: 'POST /api/v1/notification-policies',
      expect: 'notification_policy.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/notification-policies',
          payload: {
            name: 'Contract notification_policy',
            rules: [{ event: 'ticket_created', recipient: 'track_owner' }],
          },
        });
        state.notificationPolicy = res.json().notificationPolicy?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/notification-policies/:id',
      expect: 'notification_policy.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/notification-policies/${state.notificationPolicy}`,
          payload: { rules: [{ event: 'custom:Escalated', recipient: 'assignee' }] },
        }),
    },
    {
      route: 'DELETE /api/v1/notification-policies/:id',
      expect: 'notification_policy.deleted',
      run: () =>
        admin({
          method: 'DELETE',
          url: `/api/v1/notification-policies/${state.notificationPolicy}`,
        }),
    },
    {
      route: 'PUT /api/v1/link-policy',
      expect: 'link_policy.updated',
      run: () => admin({ method: 'PUT', url: '/api/v1/link-policy', payload: { enabled: false } }),
    },
    {
      route: 'PATCH /api/v1/time-tracking',
      expect: 'time_tracking.settings_updated',
      run: () =>
        admin({ method: 'PATCH', url: '/api/v1/time-tracking', payload: { hoursPerDay: 7.5 } }),
    },
    {
      route: 'POST /api/v1/tickets/:id/time-entries',
      expect: 'time_entry.created',
      // The ticket's time spent and remaining estimate change too: still one event.
      run: async () => {
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/tickets/${state.ticket}/time-entries`,
          payload: { duration: '1h 30m', description: 'Investigation' },
        });
        state.timeEntry = res.json().timeEntry?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/tickets/:id/time-entries/:entryId',
      expect: 'time_entry.updated',
      run: () =>
        call(String(state.bo1b), {
          method: 'PATCH',
          url: `/api/v1/tickets/${state.ticket}/time-entries/${state.timeEntry}`,
          payload: { duration: '2h' },
        }),
    },
    {
      route: 'DELETE /api/v1/tickets/:id/time-entries/:entryId',
      expect: 'time_entry.deleted',
      run: () =>
        call(String(state.bo1b), {
          method: 'DELETE',
          url: `/api/v1/tickets/${state.ticket}/time-entries/${state.timeEntry}`,
        }),
    },
    {
      route: 'POST /api/v1/tickets/:id/comments',
      expect: 'comment.created',
      // A history row, the ticket's updated time and a follow too: still one event.
      run: async () => {
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/tickets/${state.ticket}/comments?format=markdown`,
          payload: { body: 'Reproduced on **staging**' },
        });
        state.comment = res.json().comment?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/tickets/:id/comments/:commentId',
      expect: 'comment.updated',
      run: () =>
        call(String(state.bo1b), {
          method: 'PATCH',
          url: `/api/v1/tickets/${state.ticket}/comments/${state.comment}?format=markdown`,
          payload: { body: 'Reproduced on staging and production' },
        }),
    },
    {
      route: 'PUT /api/v1/tickets/:id/comments/:commentId/reactions/:emoji',
      expect: 'comment.reacted',
      run: () =>
        call(String(state.bo1b), {
          method: 'PUT',
          url: `/api/v1/tickets/${state.ticket}/comments/${state.comment}/reactions/${encodeURIComponent('👍')}`,
        }),
    },
    {
      route: 'DELETE /api/v1/tickets/:id/comments/:commentId/reactions/:emoji',
      expect: 'comment.unreacted',
      run: () =>
        call(String(state.bo1b), {
          method: 'DELETE',
          url: `/api/v1/tickets/${state.ticket}/comments/${state.comment}/reactions/${encodeURIComponent('👍')}`,
        }),
    },
    {
      route: 'DELETE /api/v1/tickets/:id/comments/:commentId',
      expect: 'comment.deleted',
      run: () =>
        call(String(state.bo1b), {
          method: 'DELETE',
          url: `/api/v1/tickets/${state.ticket}/comments/${state.comment}`,
        }),
    },
    {
      route: 'PATCH /api/v1/inbox/:id',
      expect: 'inbox.item_updated',
      // An inbox item of Bo's, as the notification subscriber would write it (M1-058); its
      // email is marked read with it and the inbox counter moves: still one event.
      prepare: async () => {
        const bo = await database.db
          .selectFrom('app_user')
          .select('id')
          .where('email', '=', 'bo@example.com')
          .executeTakeFirstOrThrow();
        const rows = await database.db
          .insertInto('notification')
          .values(
            (['inbox', 'email'] as const).map((channel) => ({
              workspace_id: 1,
              user_id: bo.id,
              channel,
              event: 'ticket_updated',
              ticket_id: Number(state.ticket),
              domain_event_id: '990058',
              payload: JSON.stringify({ key: 'x', summary: 'x', type: 'ticket.updated' }),
            })),
          )
          .returning(['id', 'channel'])
          .execute();
        state.inboxItem = String(rows.find((r) => r.channel === 'inbox')?.id);
      },
      run: () =>
        call(String(state.bo1b), {
          method: 'PATCH',
          url: `/api/v1/inbox/${state.inboxItem}`,
          payload: { snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() },
        }),
    },
    {
      route: 'POST /api/v1/inbox/read',
      expect: 'inbox.marked_read',
      prepare: async () => {
        await database.db
          .updateTable('notification')
          .set({ snoozed_until: null, read_at: null })
          .where('id', '=', String(state.inboxItem))
          .execute();
      },
      run: () =>
        call(String(state.bo1b), { method: 'POST', url: '/api/v1/inbox/read', payload: {} }),
    },
    {
      route: 'POST /api/v1/tickets/:id/attachments',
      expect: 'attachment.created',
      // A new ticket version and a history row too: still one event.
      run: async () => {
        const upload = multipartFile('notes.txt', 'text/plain', 'Investigation notes');
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/tickets/${state.ticket}/attachments`,
          ...upload,
        });
        state.attachment = res.json().attachment?.id;
        return res;
      },
    },
    {
      route: 'DELETE /api/v1/tickets/:id/attachments/:attachmentId',
      expect: 'attachment.deleted',
      run: () =>
        call(String(state.bo1b), {
          method: 'DELETE',
          url: `/api/v1/tickets/${state.ticket}/attachments/${state.attachment}`,
        }),
    },
    {
      route: 'PUT /api/v1/admin/attachment-settings',
      expect: 'attachment_settings.updated',
      run: () =>
        admin({
          method: 'PUT',
          url: '/api/v1/admin/attachment-settings',
          payload: { maxFileSize: 3 * 1024 ** 3 },
        }),
    },
    {
      route: 'POST /api/v1/statuses',
      expect: 'status.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/statuses',
          payload: { name: 'QA', stage: 'active' },
        });
        state.status = res.json().status?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/statuses/:id',
      expect: 'status.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/statuses/${state.status}`,
          payload: { description: 'Being tested' },
        }),
    },
    {
      route: 'PUT /api/v1/statuses/order',
      expect: 'status.reordered',
      run: async () => {
        const list = await admin({ method: 'GET', url: '/api/v1/statuses' });
        const ids = list.json().statuses.map((x: { id: number }) => x.id);
        return admin({
          method: 'PUT',
          url: '/api/v1/statuses/order',
          payload: { statusIds: ids.reverse() },
        });
      },
    },
    {
      route: 'POST /api/v1/workflows',
      expect: 'workflow.created',
      prepare: async () => {
        const list = await admin({ method: 'GET', url: '/api/v1/statuses' });
        const byName = (n: string) =>
          list.json().statuses.find((x: { name: string }) => x.name === n).id as number;
        state.statusNew = byName('New');
        state.statusClosed = byName('Closed');
      },
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/workflows',
          payload: {
            name: 'Testing workflow',
            definition: {
              initialStatusId: state.statusNew,
              statuses: [
                { statusId: state.statusNew },
                { statusId: state.status },
                { statusId: state.statusClosed },
              ],
              transitions: [
                { id: 1, name: 'Test', from: [state.statusNew], to: state.status },
                { id: 2, name: 'Done', from: 'any', to: state.statusClosed },
              ],
            },
          },
        });
        state.workflow = res.json().workflow?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/workflows/:id',
      expect: 'workflow.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/workflows/${state.workflow}`,
          payload: { description: 'For QA' },
        }),
    },
    {
      route: 'PUT /api/v1/workflows/:id/draft',
      expect: 'workflow.draft_saved',
      run: () =>
        admin({
          method: 'PUT',
          url: `/api/v1/workflows/${state.workflow}/draft`,
          payload: {
            definition: {
              initialStatusId: state.statusNew,
              statuses: [{ statusId: state.statusNew }, { statusId: state.statusClosed }],
              transitions: [{ id: 2, name: 'Done', from: 'any', to: state.statusClosed }],
            },
          },
        }),
    },
    {
      route: 'DELETE /api/v1/workflows/:id/draft',
      expect: 'workflow.draft_discarded',
      run: () => admin({ method: 'DELETE', url: `/api/v1/workflows/${state.workflow}/draft` }),
    },
    {
      route: 'POST /api/v1/workflows/:id/versions/:version/restore',
      expect: 'workflow.draft_saved',
      run: () =>
        admin({ method: 'POST', url: `/api/v1/workflows/${state.workflow}/versions/1/restore` }),
    },
    {
      route: 'POST /api/v1/workflows/:id/publish',
      expect: 'workflow.published',
      run: () =>
        admin({ method: 'POST', url: `/api/v1/workflows/${state.workflow}/publish`, payload: {} }),
    },
    {
      route: 'POST /api/v1/workflow-maps',
      expect: 'workflow_map.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/workflow-maps',
          payload: { name: 'Testing map', defaultWorkflowId: state.workflow },
        });
        state.workflowMap = res.json().workflowMap?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/workflow-maps/:id',
      expect: 'workflow_map.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/workflow-maps/${state.workflowMap}`,
          payload: { description: 'For QA' },
        }),
    },
    {
      route: 'DELETE /api/v1/workflow-maps/:id',
      expect: 'workflow_map.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/workflow-maps/${state.workflowMap}` }),
    },
    {
      route: 'POST /api/v1/tickets/:id/transitions',
      expect: 'ticket.transitioned',
      // Closing with a close reason on the layout: status, close reason and Closed stamp
      // change, one event.
      prepare: async () => {
        const reasons = await admin({ method: 'GET', url: '/api/v1/close-reasons' });
        state.completed = reasons
          .json()
          .closeReasons.find((r: { name: string }) => r.name === 'Completed').id;
      },
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/tickets/${state.ticket}/transitions`,
          payload: { transitionId: 4, fields: { 'close-reason': state.completed } },
        }),
    },
    {
      route: 'POST /api/v1/tickets/:id/trigger',
      expect: 'ticket.transitioned',
      // An external event runs the Reopen transition it triggers, which clears the reason.
      prepare: async () => {
        const workflows = await admin({ method: 'GET', url: '/api/v1/workflows' });
        const fallback = workflows.json().workflows.find((w: { isDefault: boolean }) => w.isDefault)
          .id as number;
        const current = await admin({ method: 'GET', url: `/api/v1/workflows/${fallback}` });
        const definition = current.json().workflow.published.definition;
        definition.transitions = definition.transitions.map((t: { id: number }) =>
          t.id === 5 ? { ...t, triggers: [{ event: 'dev.reopened' }] } : t,
        );
        await admin({
          method: 'PUT',
          url: `/api/v1/workflows/${fallback}/draft`,
          payload: { definition },
        });
        await admin({ method: 'POST', url: `/api/v1/workflows/${fallback}/publish`, payload: {} });
      },
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/tickets/${state.ticket}/trigger`,
          payload: { event: 'dev.reopened' },
        }),
    },
    // Boards (M1-043): a board in the ticket's track over its tickets, changed, a card moved along the
    // one transition into the Active column (the ticket route's own event), and removed.
    {
      route: 'POST /api/v1/boards',
      expect: 'board.created',
      run: async () => {
        const ticket = await admin({ method: 'GET', url: `/api/v1/tickets/${state.ticket}` });
        const track = ticket.json().ticket.track as { id: number; key: string };
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: '/api/v1/boards',
          payload: {
            name: 'Team board',
            kind: 'kanban',
            trackId: track.id,
            source: { query: `track = ${track.key}` },
          },
        });
        state.board = res.json().board?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/boards/:id',
      expect: 'board.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/boards/${state.board}`,
          payload: { name: 'Team board (kanban)' },
        }),
    },
    {
      route: 'POST /api/v1/boards/:id/moves',
      expect: 'ticket.transitioned',
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/boards/${state.board}/moves`,
          payload: { ticket: state.ticket, columnId: 'c2' },
        }),
    },
    // Sprints (M1-044): on a Scrum board over the ticket's track, two future sprints, one reordered,
    // the ticket added, removed and added again, started, completed to the backlog and deleted.
    {
      route: 'POST /api/v1/boards/:id/sprints',
      expect: 'sprint.created',
      prepare: async () => {
        const ticket = await admin({ method: 'GET', url: `/api/v1/tickets/${state.ticket}` });
        const track = ticket.json().ticket.track as { id: number; key: string };
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: '/api/v1/boards',
          payload: {
            name: 'Scrum board',
            kind: 'scrum',
            trackId: track.id,
            source: { query: `track = ${track.key}` },
          },
        });
        state.scrumBoard = res.json().board?.id;
        const other = await call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/boards/${state.scrumBoard}/sprints`,
          payload: { name: 'Other sprint' },
        });
        state.otherSprint = other.json().sprint?.id;
      },
      run: async () => {
        const res = await call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/boards/${state.scrumBoard}/sprints`,
          payload: { name: 'Contract sprint' },
        });
        state.sprint = res.json().sprint?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/sprints/:id',
      expect: 'sprint.updated',
      run: () =>
        call(String(state.bo1b), {
          method: 'PATCH',
          url: `/api/v1/sprints/${state.sprint}`,
          payload: { goal: 'Prove the contract' },
        }),
    },
    {
      route: 'POST /api/v1/sprints/:id/rank',
      expect: 'sprint.reordered',
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/sprints/${state.sprint}/rank`,
          payload: { before: state.otherSprint },
        }),
    },
    {
      route: 'POST /api/v1/sprints/:id/tickets',
      expect: 'sprint.tickets_added',
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/sprints/${state.sprint}/tickets`,
          payload: { tickets: [state.ticket] },
        }),
    },
    // Backlog planning (M1-047): each ticket goes through the ticket routes, one event each.
    {
      route: 'POST /api/v1/boards/:id/backlog/rank',
      expect: 'ticket.ranked',
      prepare: async () => {
        const ticket = await admin({ method: 'GET', url: `/api/v1/tickets/${state.ticket}` });
        const track = ticket.json().ticket.track as { key: string };
        const anchor = await admin({
          method: 'POST',
          url: '/api/v1/tickets',
          payload: { track: track.key, summary: 'Contract rank anchor' },
        });
        state.rankAnchor = anchor.json().ticket?.id;
      },
      run: () =>
        admin({
          method: 'POST',
          url: `/api/v1/boards/${state.scrumBoard}/backlog/rank`,
          payload: { tickets: [state.ticket], after: state.rankAnchor },
        }),
    },
    {
      route: 'POST /api/v1/boards/:id/backlog/parent',
      expect: 'ticket.updated',
      prepare: async () => {
        const ticket = await admin({ method: 'GET', url: `/api/v1/tickets/${state.ticket}` });
        const track = ticket.json().ticket.track as { id: number; key: string };
        const outcomeType = await database.db
          .selectFrom('ticket_type as y')
          .innerJoin('hierarchy_level as h', 'h.id', 'y.level_id')
          .select('y.id')
          .where('h.kind', '=', 'outcome')
          .where('y.owner_track_id', 'is', null)
          .executeTakeFirstOrThrow();
        const outcome = await admin({
          method: 'POST',
          url: '/api/v1/tickets',
          payload: { track: track.key, summary: 'Contract outcome', ticketTypeId: outcomeType.id },
        });
        state.outcome = outcome.json().ticket?.id;
        const release = await admin({
          method: 'POST',
          url: `/api/v1/tracks/${track.id}/releases`,
          payload: { name: 'Planning release' },
        });
        state.planningRelease = release.json().release?.id;
      },
      run: () =>
        admin({
          method: 'POST',
          url: `/api/v1/boards/${state.scrumBoard}/backlog/parent`,
          payload: { tickets: [state.ticket], parent: state.outcome },
        }),
    },
    {
      route: 'POST /api/v1/boards/:id/backlog/release',
      expect: 'ticket.updated',
      run: () =>
        admin({
          method: 'POST',
          url: `/api/v1/boards/${state.scrumBoard}/backlog/release`,
          payload: { tickets: [state.ticket], releaseId: state.planningRelease },
        }),
    },
    {
      route: 'POST /api/v1/sprints/:id/tickets/remove',
      expect: 'sprint.tickets_removed',
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/sprints/${state.sprint}/tickets/remove`,
          payload: { tickets: [state.ticket] },
        }),
    },
    {
      route: 'POST /api/v1/sprints/:id/start',
      expect: 'sprint.started',
      prepare: async () => {
        await call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/sprints/${state.sprint}/tickets`,
          payload: { tickets: [state.ticket] },
        });
      },
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/sprints/${state.sprint}/start`,
          payload: { endAt: '2030-01-15T09:00:00Z' },
        }),
    },
    {
      route: 'POST /api/v1/sprints/:id/complete',
      expect: 'sprint.completed',
      run: () =>
        call(String(state.bo1b), {
          method: 'POST',
          url: `/api/v1/sprints/${state.sprint}/complete`,
          payload: { moveTo: { type: 'backlog' } },
        }),
    },
    {
      route: 'DELETE /api/v1/sprints/:id',
      expect: 'sprint.deleted',
      run: () =>
        call(String(state.bo1b), { method: 'DELETE', url: `/api/v1/sprints/${state.sprint}` }),
    },
    {
      route: 'DELETE /api/v1/boards/:id',
      expect: 'board.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/boards/${state.board}` }),
    },
    // Saved searches (M1-063): saved, shared, starred, subscribed to and removed.
    {
      route: 'POST /api/v1/saved-searches',
      expect: 'saved_search.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/saved-searches',
          payload: { name: 'Contract search', query: 'summary ~ contract' },
        });
        state.savedSearch = res.json().savedSearch?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/saved-searches/:id',
      expect: 'saved_search.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/saved-searches/${state.savedSearch}`,
          payload: { shares: [{ scope: 'any_user' }] },
        }),
    },
    {
      route: 'PUT /api/v1/saved-searches/:id/star',
      expect: 'saved_search.starred',
      run: () => admin({ method: 'PUT', url: `/api/v1/saved-searches/${state.savedSearch}/star` }),
    },
    {
      route: 'DELETE /api/v1/saved-searches/:id/star',
      expect: 'saved_search.unstarred',
      run: () =>
        admin({ method: 'DELETE', url: `/api/v1/saved-searches/${state.savedSearch}/star` }),
    },
    {
      route: 'POST /api/v1/saved-searches/:id/subscriptions',
      expect: 'saved_search.subscribed',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: `/api/v1/saved-searches/${state.savedSearch}/subscriptions`,
          payload: { schedule: 'daily', hour: 9 },
        });
        state.subscription = res.json().subscription?.id;
        return res;
      },
    },
    {
      route: 'DELETE /api/v1/saved-searches/:id/subscriptions/:subscriptionId',
      expect: 'saved_search.unsubscribed',
      run: () =>
        admin({
          method: 'DELETE',
          url: `/api/v1/saved-searches/${state.savedSearch}/subscriptions/${state.subscription}`,
        }),
    },
    {
      route: 'DELETE /api/v1/saved-searches/:id',
      expect: 'saved_search.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/saved-searches/${state.savedSearch}` }),
    },
    // Dashboards (M1-064): made, changed, copied, made the default and removed.
    {
      route: 'POST /api/v1/dashboards',
      expect: 'dashboard.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/dashboards',
          payload: {
            name: 'Contract dashboard',
            widgets: [{ kind: 'introduction', config: { text: 'Hello' } }],
          },
        });
        state.dashboard = res.json().dashboard?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/dashboards/:id',
      expect: 'dashboard.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/dashboards/${state.dashboard}`,
          payload: { layout: 'three', shares: [{ scope: 'any_user' }] },
        }),
    },
    {
      route: 'POST /api/v1/dashboards/:id/copy',
      expect: 'dashboard.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: `/api/v1/dashboards/${state.dashboard}/copy`,
          payload: {},
        });
        state.dashboardCopy = res.json().dashboard?.id;
        return res;
      },
    },
    {
      route: 'PUT /api/v1/dashboards/default',
      expect: 'dashboard.default_set',
      run: () =>
        admin({
          method: 'PUT',
          url: '/api/v1/dashboards/default',
          payload: { dashboardId: state.dashboardCopy },
        }),
    },
    {
      route: 'DELETE /api/v1/dashboards/:id',
      expect: 'dashboard.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/dashboards/${state.dashboard}` }),
    },
    {
      route: 'DELETE /api/v1/workflows/:id',
      expect: 'workflow.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/workflows/${state.workflow}` }),
    },
    {
      route: 'DELETE /api/v1/statuses/:id',
      expect: 'status.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/statuses/${state.status}` }),
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
      route: 'POST /api/v1/webhooks',
      expect: 'webhook.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/webhooks',
          payload: {
            name: 'Contract webhook',
            url: 'https://hooks.example.com/contract',
            events: ['ticket.*'],
            secret: 'a contract signing secret',
          },
        });
        state.webhook = res.json().webhook?.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/webhooks/:id',
      expect: 'webhook.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/webhooks/${state.webhook}`,
          payload: { events: ['ticket.created', 'comment.created'] },
        }),
    },
    {
      route: 'POST /api/v1/webhooks/:id/deliveries/replay',
      expect: 'webhook.delivery_replayed',
      run: async () => {
        // A delivery that failed, to send again.
        await database.db
          .insertInto('webhook_delivery')
          .values({
            id: '00000000-0000-4000-8000-00000000c0de',
            workspace_id: 1,
            webhook_id: Number(state.webhook),
            event_id: 1,
            event_type: 'ticket.created',
            body: '{}',
            state: 'failed',
          })
          .execute();
        return admin({
          method: 'POST',
          url: `/api/v1/webhooks/${state.webhook}/deliveries/replay`,
          payload: { failed: true },
        });
      },
    },
    {
      route: 'DELETE /api/v1/webhooks/:id',
      expect: 'webhook.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/webhooks/${state.webhook}` }),
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
    {
      route: 'POST /api/v1/directories',
      expect: 'directory.created',
      run: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/directories',
          payload: directoryBody('Contract directory'),
        });
        state.directory = res.json().directory.id;
        return res;
      },
    },
    {
      route: 'PATCH /api/v1/directories/:id',
      expect: 'directory.updated',
      run: () =>
        admin({
          method: 'PATCH',
          url: `/api/v1/directories/${state.directory}`,
          payload: { syncIntervalMinutes: 30, bindPassword: ldap.bindPassword },
        }),
    },
    {
      route: 'POST /api/v1/directories/:id/sync',
      expect: 'directory.sync_requested',
      run: () =>
        admin({
          method: 'POST',
          url: `/api/v1/directories/${state.directory}/sync`,
          payload: { mode: 'full' },
        }),
    },
    {
      route: 'PUT /api/v1/directories/order',
      expect: 'directory.reordered',
      prepare: async () => {
        const res = await admin({
          method: 'POST',
          url: '/api/v1/directories',
          payload: directoryBody('Second directory'),
        });
        state.directory2 = res.json().directory.id;
      },
      run: () =>
        admin({
          method: 'PUT',
          url: '/api/v1/directories/order',
          payload: { ids: [state.directory2, state.directory] },
        }),
    },
    {
      route: 'DELETE /api/v1/directories/:id',
      expect: 'directory.deleted',
      run: () => admin({ method: 'DELETE', url: `/api/v1/directories/${state.directory2}` }),
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

  // Every mutating route in one run, a few hundred requests: more than the default timeout.
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
    const missing = (Object.keys(EVENT_TYPES) as EventType[]).filter(
      (t) =>
        !produced.has(t) &&
        !JOB_EVENTS.includes(t) &&
        !SCAN_JOB_EVENTS.includes(t) &&
        !IMPORT_JOB_EVENTS.includes(t),
    );
    expect(missing, 'event types no route produces').toEqual([]);
  }, 120_000);

  it('[IAM-005] a directory sync emits one valid event per change it makes, with no actor', async () => {
    const people = [1, 2].map((n) =>
      ldap.addUser({ username: `job${n}`, mail: `job${n}@example.com` }),
    );
    const team = ldap.addGroup({ cn: 'Job team', members: [people[0] as string] });
    const temporary = ldap.addGroup({ cn: 'Job temporary', members: [people[1] as string] });
    const created = await admin({
      method: 'POST',
      url: '/api/v1/directories',
      payload: directoryBody('Job directory'),
    });
    const directoryId = created.json().directory.id as number;
    const before = await database.db
      .selectFrom('domain_event')
      .select((eb) => eb.fn.max('id').as('max'))
      .executeTakeFirstOrThrow();
    const run = async (mode: 'full' | 'incremental') => {
      const queued = await queueRun(database.db, {
        workspaceId: 1,
        directoryId,
        mode,
        trigger: 'schedule',
        requestedBy: null,
        confirmRemovals: false,
      });
      const result = await runSync(database.db, queued.id);
      expect(result.status, result.error ?? '').toBe('succeeded');
    };
    await run('full');
    ldap.modify(people[0] as string, { displayName: ['Job One'] });
    ldap.addMember(team, people[1] as string);
    await run('incremental');
    ldap.remove(people[1] as string);
    ldap.remove(temporary);
    await run('incremental');

    const events = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload', 'subject_type', 'actor_id'])
      .where('id', '>', String(before.max ?? 0))
      .orderBy('id')
      .execute();
    for (const event of events) {
      const spec = EVENT_TYPES[event.type as EventType];
      expect(JOB_EVENTS, event.type).toContain(event.type);
      expect(event.subject_type).toBe(spec.subject);
      expect(() => spec.payload.parse(event.payload)).not.toThrow();
      expect(event.actor_id).toBeNull();
      const text = JSON.stringify(event.payload);
      expect(text).not.toMatch(/password_hash|argon2|token|\$scrypt/i);
      expect(text).not.toContain(ldap.bindPassword);
    }
    expect([...new Set(events.map((e) => e.type))].sort()).toEqual([...JOB_EVENTS].sort());
  });

  it('[CORE-021] a scan that finds malware emits one valid event, with no actor', async () => {
    const upload = multipartFile(
      'setup.exe',
      'application/octet-stream',
      'pretend this is malware',
    );
    const res = await call(String(state.bo1b), {
      method: 'POST',
      url: `/api/v1/tickets/${state.ticket}/attachments`,
      ...upload,
    });
    expect(res.statusCode, res.body).toBe(201);
    const attachmentId = res.json().attachment.id as number;
    // As if a scanner had been configured when it arrived.
    await database.db
      .updateTable('attachment')
      .set({ scan_state: 'pending', scanned_at: null })
      .where('id', '=', attachmentId)
      .execute();
    const before = await database.db
      .selectFrom('domain_event')
      .select((eb) => eb.fn.max('id').as('max'))
      .executeTakeFirstOrThrow();
    await processAttachment(
      database.db,
      {
        ...attachments,
        scanner: {
          name: 'test',
          scan: async () => ({ result: 'infected', signature: 'Test.Sig' }),
        },
      },
      attachmentId,
    );
    const events = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload', 'subject_type', 'actor_id'])
      .where('id', '>', String(before.max ?? 0))
      .execute();
    expect(events.map((e) => e.type)).toEqual(SCAN_JOB_EVENTS);
    const [event] = events;
    const spec = EVENT_TYPES['attachment.quarantined'];
    expect(event?.subject_type).toBe(spec.subject);
    expect(() => spec.payload.parse(event?.payload)).not.toThrow();
    expect(event?.actor_id).toBeNull();
  });

  it('[IMP-009] an import emits one valid event when it ends, with no actor', async () => {
    const res = await admin({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: { source: { format: 'synthetic', generate: { seed: 2, prefix: 'CJ', tickets: 3 } } },
    });
    expect(res.statusCode, res.body).toBe(202);
    const runId = String(res.json().importRun.id);
    const before = await database.db
      .selectFrom('domain_event')
      .select((eb) => eb.fn.max('id').as('max'))
      .executeTakeFirstOrThrow();
    await runImport(
      { db: database.db, catalogs: new FieldCatalogs(database.db), formats: IMPORT_FORMATS },
      runId,
      { until: Number.POSITIVE_INFINITY },
    );
    const events = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload', 'subject_type', 'actor_id'])
      .where('id', '>', String(before.max ?? 0))
      .execute();
    expect(events.map((e) => e.type)).toEqual(IMPORT_JOB_EVENTS);
    const [event] = events;
    const spec = EVENT_TYPES['import_run.finished'];
    expect(event?.subject_type).toBe(spec.subject);
    expect(() => spec.payload.parse(event?.payload)).not.toThrow();
    expect(event?.actor_id).toBeNull();
  });
});
