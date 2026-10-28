import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { passwordHasher, pepperFromSecret, pepperRing } from '@taskmoor/iam';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Attribute, Change, Client } from 'ldapts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { effectiveGroupIds } from '../directory';
import { runSync } from './sync';

/**
 * Directory sync against a real OpenLDAP (M1-082 done-when). Runs only when
 * TASKMOOR_OPENLDAP_URL names the server `bash tools/ldap/openldap-test.sh` starts (in Docker,
 * or with `--local`, this machine's slapd), loaded with TASKMOOR_OPENLDAP_PEOPLE people in
 * groups nested four levels deep by tools/ldap/generate-ldif.mjs. The passwords come from that
 * script's environment, made per run.
 */
const URL = process.env.TASKMOOR_OPENLDAP_URL;
const PEOPLE = Number(process.env.TASKMOOR_OPENLDAP_PEOPLE ?? 10_000);
const BASE = 'dc=example,dc=com';
const TWO_MINUTES = 120_000;

let address = 0;
const nextAddress = () => `100.72.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

describe.skipIf(!URL)('directory sync against OpenLDAP (M1-082)', () => {
  const database = useMigratedDatabase();
  const peppers = pepperRing(pepperFromSecret(randomBytes(32)));
  const ca = URL ? readFileSync(process.env.TASKMOOR_OPENLDAP_CA as string, 'utf8') : '';
  const userPassword = process.env.TASKMOOR_OPENLDAP_USER_PASSWORD as string;
  let app: FastifyInstance;
  let adminCookie = '';
  let directoryId = 0;
  const directoryAdmin = new Client({ url: URL ?? 'ldap://localhost', timeout: 60_000 });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    url: string,
    payload?: object,
    cookie = adminCookie,
  ) =>
    app.inject({
      method,
      url,
      remoteAddress: nextAddress(),
      headers: { cookie },
      ...(payload ? { payload } : {}),
    });
  const signIn = (email: string, password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/session',
      remoteAddress: nextAddress(),
      payload: { email, password },
    });
  const sync = async (mode: 'full' | 'incremental') => {
    const res = await call('POST', `/api/v1/directories/${directoryId}/sync`, { mode });
    expect(res.statusCode, res.body).toBe(202);
    const started = performance.now();
    const result = await runSync(database.db, res.json().run.id, { peppers });
    const ms = Math.round(performance.now() - started);
    expect(result.status, result.error ?? '').toBe('succeeded');
    const run = (await call('GET', `/api/v1/directories/${directoryId}/runs?limit=1`)).json()
      .runs[0];
    return { ...result, ms, mode: run.mode as string };
  };
  const account = (email: string) =>
    database.db
      .selectFrom('app_user')
      .select(['id', 'name', 'deactivated_at'])
      .where('email', '=', email)
      .executeTakeFirst();

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'], peppers });
    const adminPassword = `pw-${randomBytes(12).toString('base64url')}`;
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@local.test',
        name: 'Admin',
        password_hash: await passwordHasher(peppers).hash(adminPassword),
        is_site_admin: true,
      })
      .execute();
    adminCookie = sessionCookie(await signIn('admin@local.test', adminPassword));
    await directoryAdmin.startTLS({ ca: [ca], servername: 'localhost' });
    await directoryAdmin.bind(
      `cn=admin,${BASE}`,
      process.env.TASKMOOR_OPENLDAP_ROOT_PASSWORD as string,
    );
  });
  afterAll(async () => {
    await directoryAdmin.unbind().catch(() => undefined);
    await app?.close();
  });

  it(
    '[IAM-005] syncs 10,000 people in groups nested four levels deep in under two minutes, over StartTLS',
    async () => {
      const settings = {
        name: 'OpenLDAP',
        kind: 'openldap',
        url: URL,
        startTls: true,
        caCertificates: [ca],
        bindDn: `cn=sync,${BASE}`,
        bindPassword: process.env.TASKMOOR_OPENLDAP_BIND_PASSWORD,
        baseDn: BASE,
        userBaseDn: `ou=people,${BASE}`,
        groupBaseDn: `ou=groups,${BASE}`,
        groupFilter: '(objectClass=groupOfNames)',
      };
      const tried = await call('POST', '/api/v1/directories/test', settings);
      expect(tried.json(), tried.body).toMatchObject({
        ok: true,
        users: { count: 1000, more: true },
      });
      const created = await call('POST', '/api/v1/directories', settings);
      expect(created.statusCode, created.body).toBe(201);
      directoryId = created.json().directory.id;

      const full = await sync('full');
      const groups = full.stats.groupsCreated ?? 0;
      expect(full.stats.usersCreated).toBe(PEOPLE);
      expect(groups).toBeGreaterThan(PEOPLE / 5);
      expect(full.ms).toBeLessThan(TWO_MINUTES);

      const first = await account('p0@openldap.test');
      const effective = await effectiveGroupIds(database.db, 1, first?.id as number);
      const names = await database.db
        .selectFrom('user_group')
        .select('name')
        .where('id', 'in', effective)
        .orderBy('name')
        .execute();
      expect(names.map((n) => n.name)).toEqual(['department-0', 'division-0', 'group-0', 'team-0']);

      const idle = await sync('incremental');
      expect(idle.mode).toBe('incremental');
      expect(idle.ms).toBeLessThan(TWO_MINUTES);
      console.warn(
        JSON.stringify({
          openldap: {
            people: PEOPLE,
            groups,
            fullMs: full.ms,
            fullReadMs: full.stats.readMs,
            fullApplyMs: full.stats.applyMs,
            idleIncrementalMs: idle.ms,
          },
        }),
      );
    },
    6 * TWO_MINUTES,
  );

  it('[IAM-005] signs people in by binding as them, and takes their password change when read-write', async () => {
    const signedIn = await signIn('p1@openldap.test', userPassword);
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    expect((await signIn('p1@openldap.test', `${userPassword}x`)).statusCode).toBe(401);
    const patched = await call('PATCH', `/api/v1/directories/${directoryId}`, {
      mode: 'read_write',
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const next = `pw-${randomBytes(12).toString('base64url')}`;
    const changed = await call(
      'PUT',
      '/api/v1/account/password',
      { currentPassword: userPassword, newPassword: next },
      sessionCookie(signedIn),
    );
    expect(changed.statusCode, changed.body).toBe(200);
    // OpenLDAP hashed and stored it: binding with it works there and here.
    const check = new Client({ url: URL as string });
    await check.startTLS({ ca: [ca], servername: 'localhost' });
    await check.bind(`uid=p1,ou=people,${BASE}`, next);
    await check.unbind();
    expect((await signIn('p1@openldap.test', next)).statusCode).toBe(200);
  });

  it(
    '[IAM-005] an incremental run takes a locked account, renames, new members and deleted entries',
    async () => {
      const dn = (uid: string) => `uid=${uid},ou=people,${BASE}`;
      const replace = (type: string, values: string[]) =>
        new Change({ operation: 'replace', modification: new Attribute({ type, values }) });
      // The password policy overlay's administrative lock: the account is disabled.
      await directoryAdmin.modify(dn('p2'), replace('pwdAccountLockedTime', ['000001010000Z']));
      await directoryAdmin.modify(dn('p5'), replace('displayName', ['Renamed Five']));
      await directoryAdmin.modify(
        `cn=team-1,ou=groups,${BASE}`,
        new Change({
          operation: 'add',
          modification: new Attribute({ type: 'member', values: [dn('p3')] }),
        }),
      );
      await directoryAdmin.del(dn('p4'));
      const run = await sync('incremental');
      expect(run.mode).toBe('incremental');
      expect(run.ms).toBeLessThan(TWO_MINUTES);
      expect((await account('p2@openldap.test'))?.deactivated_at).not.toBeNull();
      expect((await account('p4@openldap.test'))?.deactivated_at).not.toBeNull();
      expect((await account('p5@openldap.test'))?.name).toBe('Renamed Five');
      const team = await database.db
        .selectFrom('group_member as m')
        .innerJoin('user_group as g', 'g.id', 'm.group_id')
        .innerJoin('app_user as a', 'a.id', 'm.user_id')
        .select('a.email')
        .where('g.name', '=', 'team-1')
        .execute();
      expect(team.map((r) => r.email)).toContain('p3@openldap.test');
      console.warn(JSON.stringify({ openldap: { busyIncrementalMs: run.ms, stats: run.stats } }));
    },
    6 * TWO_MINUTES,
  );
});
