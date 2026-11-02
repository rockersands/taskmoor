import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { passwordHasher, pepperFromSecret, pepperRing } from '@taskmoor/iam';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { runSync } from '../ldap/sync';
import { FakeLdap } from '../testing/fake-ldap';
import { selfSignedCertificate } from '../testing/x509';

/**
 * LDAP and Active Directory over HTTP (M1-082; IAM-005): administration, the connection test,
 * runs asked for by administrators, sign-in by binding as the person, and what read-only and
 * read-write directories let Taskmoor change. Every password is made per run.
 */
const secret = () => `pw-${randomBytes(12).toString('base64url')}`;

let address = 0;
const nextAddress = () => `100.70.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

describe('directories over HTTP (M1-082)', () => {
  const database = useMigratedDatabase();
  const peppers = pepperRing(pepperFromSecret(randomBytes(32)));
  let app: FastifyInstance;
  let adminCookie = '';
  let memberCookie = '';
  const adminPassword = secret();
  const memberPassword = secret();
  const ldap = new FakeLdap({ flavour: 'openldap' });
  const people: Record<string, { dn: string; password: string }> = {};

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    cookie = adminCookie,
  ) =>
    app.inject({
      method,
      url,
      remoteAddress: nextAddress(),
      headers: cookie ? { cookie } : {},
      ...(payload ? { payload } : {}),
    });
  const signIn = (email: string, password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/session',
      remoteAddress: nextAddress(),
      payload: { email, password },
    });
  const body = (name: string, server: FakeLdap = ldap) => ({
    name,
    kind: server.flavour,
    url: server.url,
    bindDn: server.bindDn,
    bindPassword: server.bindPassword,
    baseDn: server.baseDn,
  });
  const syncNow = async (directoryId: number, mode: 'full' | 'incremental' = 'incremental') => {
    const res = await call('POST', `/api/v1/directories/${directoryId}/sync`, { mode });
    expect(res.statusCode, res.body).toBe(202);
    // The worker's part, run here.
    const result = await runSync(database.db, res.json().run.id, { peppers });
    expect(result.status, result.error ?? '').toBe('succeeded');
    return result;
  };
  const accountId = async (email: string) =>
    (
      await database.db
        .selectFrom('app_user')
        .select('id')
        .where(sql<string>`lower(email)`, '=', email)
        .executeTakeFirstOrThrow()
    ).id;
  const groupId = async (name: string) =>
    (
      await database.db
        .selectFrom('user_group')
        .select('id')
        .where('name', '=', name)
        .executeTakeFirstOrThrow()
    ).id;

  beforeAll(async () => {
    await ldap.start();
    for (const name of ['ada', 'ben', 'cleo']) {
      const password = secret();
      people[name] = {
        dn: ldap.addUser({ username: name, displayName: name.toUpperCase(), password }),
        password,
      };
    }
    ldap.addGroup({ cn: 'Readers', members: [people.ada?.dn as string] });
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      peppers,
      publicUrl: 'https://tracker.example',
    });
    const hasher = passwordHasher(peppers);
    for (const [email, password, admin] of [
      ['admin@local.test', adminPassword, true],
      ['member@local.test', memberPassword, false],
    ] as const) {
      await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email,
          name: email,
          password_hash: await hasher.hash(password),
          is_site_admin: admin,
        })
        .execute();
    }
    adminCookie = sessionCookie(await signIn('admin@local.test', adminPassword));
    memberCookie = sessionCookie(await signIn('member@local.test', memberPassword));
    expect(adminCookie).not.toBe('');
  });
  afterAll(async () => {
    await app.close();
    await ldap.stop();
  });

  it('[IAM-005] site administrators manage directories; the bind password is sealed and never returned', async () => {
    expect((await call('GET', '/api/v1/directories', undefined, '')).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/directories', undefined, memberCookie)).statusCode).toBe(
      403,
    );
    const created = await call('POST', '/api/v1/directories', body('Corp LDAP'));
    expect(created.statusCode, created.body).toBe(201);
    const directory = created.json().directory;
    expect(directory).toMatchObject({
      name: 'Corp LDAP',
      kind: 'openldap',
      mode: 'read_only',
      enabled: true,
      position: 1,
      hasBindPassword: true,
      userFilter: '(objectClass=inetOrgPerson)',
      attributes: { id: 'entryUUID', username: 'uid', member: 'member' },
    });
    expect(created.body).not.toContain(ldap.bindPassword);
    const row = await database.db
      .selectFrom('ldap_directory')
      .select(['bind_password_sealed', 'next_sync_at'])
      .where('id', '=', directory.id)
      .executeTakeFirstOrThrow();
    expect(row.bind_password_sealed).toMatch(/^enc1:/);
    expect(row.bind_password_sealed).not.toContain(ldap.bindPassword);
    // The worker's first run starts at its next look.
    expect(row.next_sync_at).not.toBeNull();
    const listed = await call('GET', '/api/v1/directories');
    expect(listed.body).not.toContain(ldap.bindPassword);
    expect(listed.json().presets.active_directory.attributes.id).toBe('objectGUID');

    // Passwords never cross the network in clear outside loopback.
    const plain = await call('POST', '/api/v1/directories', {
      ...body('Plain'),
      url: 'ldap://ldap.example.com',
    });
    expect(plain.statusCode).toBe(400);
    expect(plain.json().error).toBe('insecure_transport');
    for (const [url, startTls] of [
      ['ldaps://ldap.example.com', false],
      ['ldap://ldap.example.com:389', true],
    ] as const) {
      const ok = await call('POST', '/api/v1/directories', {
        ...body(`Secure ${url}`),
        url,
        startTls,
        enabled: false,
      });
      expect(ok.statusCode, ok.body).toBe(201);
      await call('DELETE', `/api/v1/directories/${ok.json().directory.id}`);
    }
    const badFilter = await call('POST', '/api/v1/directories', {
      ...body('Bad filter'),
      userFilter: '(&(objectClass=user)',
    });
    expect(badFilter.statusCode).toBe(400);
    const badCa = await call('POST', '/api/v1/directories', {
      ...body('Bad CA'),
      caCertificates: ['not a certificate'],
    });
    expect(badCa.json().error).toBe('invalid_certificate');
    expect((await call('POST', '/api/v1/directories', body('corp ldap'))).statusCode).toBe(409);

    // An edit sends what changed; leaving the password out keeps it. Changing what is read
    // makes the next run a full one.
    await database.db
      .updateTable('ldap_directory')
      .set({ sync_cursor: JSON.stringify({ kind: 'timestamp', value: '20260101000000Z' }) })
      .where('id', '=', directory.id)
      .execute();
    const edited = await call('PATCH', `/api/v1/directories/${directory.id}`, {
      userFilter: '(&(objectClass=inetOrgPerson)(mail=*))',
      syncIntervalMinutes: 15,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().directory).toMatchObject({
      syncIntervalMinutes: 15,
      hasBindPassword: true,
    });
    const after = await database.db
      .selectFrom('ldap_directory')
      .select(['sync_cursor', 'bind_password_sealed'])
      .where('id', '=', directory.id)
      .executeTakeFirstOrThrow();
    expect(after.sync_cursor).toBeNull();
    expect(after.bind_password_sealed).toBe(row.bind_password_sealed);
    const event = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'directory.updated')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ bindPasswordChanged: false });
    expect(JSON.stringify(event.payload)).not.toContain(ldap.bindPassword);
  });

  it('[IAM-005] tests settings without saving them', async () => {
    const ok = await call('POST', '/api/v1/directories/test', body('Trial'));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      ok: true,
      users: { count: 3, more: false },
      groups: { count: 1 },
    });
    expect(ok.json().users.sample[0]).toMatchObject({
      email: expect.stringMatching(/@example\.com$/),
    });
    const wrong = await call('POST', '/api/v1/directories/test', {
      ...body('Trial'),
      bindPassword: secret(),
    });
    expect(wrong.json()).toEqual({ ok: false, error: 'bind_refused' });
    // With a saved directory, its own password is used when none is sent.
    const [saved] = (await call('GET', '/api/v1/directories')).json().directories;
    const reuse = await call('POST', '/api/v1/directories/test', { id: saved.id });
    expect(reuse.json().ok).toBe(true);
    const down = new FakeLdap({ flavour: 'openldap' });
    await down.start();
    down.down = true;
    const unreachable = await call('POST', '/api/v1/directories/test', body('Down', down));
    await down.stop();
    expect(unreachable.json()).toMatchObject({ ok: false, error: 'unreachable' });
    expect(await database.db.selectFrom('ldap_directory').select('id').execute()).toHaveLength(1);
  });

  it('[IAM-005] an administrator asks for a sync; the worker runs it and the history shows it', async () => {
    const [directory] = (await call('GET', '/api/v1/directories')).json().directories;
    await database.db
      .updateTable('ldap_directory')
      .set({ user_filter: '(objectClass=inetOrgPerson)' })
      .where('id', '=', directory.id)
      .execute();
    const first = await call('POST', `/api/v1/directories/${directory.id}/sync`, { mode: 'full' });
    expect(first.statusCode).toBe(202);
    expect(first.json().run).toMatchObject({ status: 'queued', mode: 'full', trigger: 'manual' });
    // A second request while one waits joins it.
    const second = await call('POST', `/api/v1/directories/${directory.id}/sync`, {});
    expect(second.json().run.id).toBe(first.json().run.id);
    const requested = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'directory.sync_requested')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(requested.payload).toMatchObject({ coalesced: true });
    const result = await runSync(database.db, first.json().run.id, { peppers });
    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(result.stats).toMatchObject({ usersCreated: 3, groupsCreated: 1 });
    const runs = await call('GET', `/api/v1/directories/${directory.id}/runs`);
    expect(runs.json().runs[0]).toMatchObject({
      status: 'succeeded',
      stats: { usersCreated: 3 },
      requestedBy: expect.any(Number),
    });
    const listed = (await call('GET', '/api/v1/directories')).json().directories[0];
    expect(listed).toMatchObject({ accounts: 3, groups: 1, lastRun: { status: 'succeeded' } });
    const user = await call('GET', `/api/v1/users/${await accountId('ada@example.com')}`);
    expect(user.json().directory).toMatchObject({ id: directory.id, dn: people.ada?.dn });
  });

  it('[IAM-005] people sign in with their directory password, checked by binding as them', async () => {
    const ada = people.ada as { dn: string; password: string };
    const ok = await signIn('ada@example.com', ada.password);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe('signed_in');
    const started = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'session.started')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(started.payload).toMatchObject({ method: 'password', directoryId: expect.any(Number) });
    const wrong = await signIn('ada@example.com', secret());
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe('invalid_credentials');
    // The directory decides: a new password there works at once, the old one no longer.
    const changed = secret();
    ldap.setPassword(ada.dn, changed);
    expect((await signIn('ada@example.com', ada.password)).statusCode).toBe(401);
    expect((await signIn('ada@example.com', changed)).statusCode).toBe(200);
    ada.password = changed;

    // An unreachable directory decides nothing: no failure counted, the same answer, a reason
    // in the audit log.
    const [directory] = (await call('GET', '/api/v1/directories')).json().directories;
    await database.db
      .updateTable('ldap_directory')
      .set({ url: 'ldap://127.0.0.1:1' })
      .where('id', '=', directory.id)
      .execute();
    const unavailable = await signIn('ben@example.com', people.ben?.password as string);
    expect(unavailable.statusCode).toBe(401);
    const counted = await database.db
      .selectFrom('sign_in_throttle')
      .select('failures')
      .where('key', 'like', '%ben@example.com%')
      .executeTakeFirst();
    expect(counted?.failures ?? 0).toBe(0);
    const audit = await database.db
      .selectFrom('audit_event')
      .select('details')
      .where('action', '=', 'session.sign_in_failed')
      .orderBy('seq', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ reason: 'directory_unavailable', method: 'directory' });
    await database.db
      .updateTable('ldap_directory')
      .set({ url: ldap.url })
      .where('id', '=', directory.id)
      .execute();
  });

  it('[IAM-005] read-only directories own their people’s passwords, names and group members', async () => {
    const ada = people.ada as { dn: string; password: string };
    const cookie = sessionCookie(await signIn('ada@example.com', ada.password));
    const password = await call(
      'PUT',
      '/api/v1/account/password',
      { currentPassword: ada.password, newPassword: secret() },
      cookie,
    );
    expect(password.statusCode).toBe(409);
    const ownName = await call('PATCH', '/api/v1/account', { name: 'Ada Self' }, cookie);
    expect(ownName.statusCode).toBe(409);
    const ownZone = await call('PATCH', '/api/v1/account', { timeZone: 'Europe/Oslo' }, cookie);
    expect(ownZone.statusCode).toBe(200);
    expect(password.json()).toMatchObject({
      error: 'directory_managed',
      directory: { name: 'Corp LDAP' },
    });
    const adaId = await accountId('ada@example.com');
    expect((await call('PATCH', `/api/v1/users/${adaId}`, { name: 'Other' })).statusCode).toBe(409);
    expect((await call('PATCH', `/api/v1/users/${adaId}`, { breakGlass: true })).statusCode).toBe(
      409,
    );
    // Taskmoor's own settings stay Taskmoor's.
    expect(
      (await call('PATCH', `/api/v1/users/${adaId}`, { timeZone: 'Europe/Madrid' })).statusCode,
    ).toBe(200);
    expect((await call('POST', `/api/v1/users/${adaId}/password-link`)).statusCode).toBe(409);
    const readers = await groupId('Readers');
    const benId = await accountId('ben@example.com');
    expect((await call('PUT', `/api/v1/groups/${readers}/members/${benId}`)).statusCode).toBe(409);
    expect((await call('DELETE', `/api/v1/groups/${readers}/members/${adaId}`)).statusCode).toBe(
      409,
    );
    expect((await call('PATCH', `/api/v1/groups/${readers}`, { name: 'Writers' })).statusCode).toBe(
      409,
    );
    expect(
      (await call('PATCH', `/api/v1/groups/${readers}`, { description: 'From LDAP' })).statusCode,
    ).toBe(200);
    expect((await call('DELETE', `/api/v1/groups/${readers}`)).statusCode).toBe(409);
    const group = await call('GET', `/api/v1/groups/${readers}`);
    expect(group.json().directory).toMatchObject({ name: 'Corp LDAP', mode: 'read_only' });
  });

  it('[IAM-005] read-write directories take password, name and membership changes', async () => {
    const [directory] = (await call('GET', '/api/v1/directories')).json().directories;
    await call('PATCH', `/api/v1/directories/${directory.id}`, { mode: 'read_write' });
    const ben = people.ben as { dn: string; password: string };
    const cookie = sessionCookie(await signIn('ben@example.com', ben.password));
    const next = secret();
    const wrongCurrent = await call(
      'PUT',
      '/api/v1/account/password',
      { currentPassword: secret(), newPassword: next },
      cookie,
    );
    expect(wrongCurrent.statusCode).toBe(403);
    const changed = await call(
      'PUT',
      '/api/v1/account/password',
      { currentPassword: ben.password, newPassword: next },
      cookie,
    );
    expect(changed.statusCode, changed.body).toBe(200);
    expect(ldap.passwordOf(ben.dn)).toBe(next);
    expect((await signIn('ben@example.com', next)).statusCode).toBe(200);
    ben.password = next;

    const own = await call('PATCH', '/api/v1/account', { name: 'Ben Self' }, cookie);
    expect(own.statusCode, own.body).toBe(200);
    expect(ldap.entry(ben.dn)?.attributes.get('displayname')?.values[0]?.toString()).toBe(
      'Ben Self',
    );
    const benId = await accountId('ben@example.com');
    const renamed = await call('PATCH', `/api/v1/users/${benId}`, { name: 'Benedict' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(ldap.entry(ben.dn)?.attributes.get('displayname')?.values[0]?.toString()).toBe(
      'Benedict',
    );

    const readers = await groupId('Readers');
    const memberValues = () =>
      (
        ldap.entry(`cn=Readers,ou=groups,${ldap.baseDn}`)?.attributes.get('member')?.values ?? []
      ).map((v) => v.toString());
    expect((await call('PUT', `/api/v1/groups/${readers}/members/${benId}`)).statusCode).toBe(204);
    expect(memberValues()).toContain(ben.dn);
    // Someone the directory does not manage cannot join its group.
    const local = await accountId('member@local.test');
    const refused = await call('PUT', `/api/v1/groups/${readers}/members/${local}`);
    expect(refused.json().error).toBe('not_in_directory');
    expect((await call('DELETE', `/api/v1/groups/${readers}/members/${benId}`)).statusCode).toBe(
      204,
    );
    expect(memberValues()).not.toContain(ben.dn);

    // Nesting the directory's groups is written there too; a loop is refused before that.
    const editorsDn = ldap.addGroup({ cn: 'Editors' });
    await syncNow(directory.id);
    const editors = await groupId('Editors');
    expect((await call('PUT', `/api/v1/groups/${readers}/children/${editors}`)).statusCode).toBe(
      204,
    );
    expect(memberValues()).toContain(editorsDn);
    const loop = await call('PUT', `/api/v1/groups/${editors}/children/${readers}`);
    expect(loop.json().error).toBe('nesting_cycle');
    expect(
      (ldap.entry(editorsDn)?.attributes.get('member')?.values ?? []).map((v) => v.toString()),
    ).toEqual([]);
    expect((await call('DELETE', `/api/v1/groups/${readers}/children/${editors}`)).statusCode).toBe(
      204,
    );
    expect(memberValues()).not.toContain(editorsDn);

    // The next run agrees with what was written: nothing to change.
    const result = await syncNow(directory.id, 'full');
    expect(result.stats.usersUpdated ?? 0).toBe(0);
    expect(result.stats.membershipsAdded ?? 0).toBe(0);
    expect(result.stats.nestingsAdded ?? 0).toBe(0);
  });

  it('[IAM-005] changes Active Directory passwords over TLS with the CA an administrator trusts', async () => {
    const cert = selfSignedCertificate('localhost');
    const ad = new FakeLdap({
      flavour: 'active_directory',
      transport: 'ldaps',
      host: 'localhost',
      baseDn: 'DC=corp,DC=test',
      tls: { key: cert.privateKeyPem, cert: cert.certificate },
    });
    await ad.start();
    try {
      const password = secret();
      const dn = ad.addUser({ username: 'dana', mail: 'dana@corp.test', password });
      const untrusted = await call('POST', '/api/v1/directories/test', body('AD', ad));
      expect(untrusted.json()).toMatchObject({ ok: false, error: 'tls_failed' });
      const created = await call('POST', '/api/v1/directories', {
        ...body('Corp AD', ad),
        caCertificates: [cert.certificate],
        mode: 'read_write',
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().directory.caCertificates[0].subject).toContain('localhost');
      await syncNow(created.json().directory.id);
      const cookie = sessionCookie(await signIn('dana@corp.test', password));
      expect(cookie).not.toBe('');
      const next = secret();
      const changed = await call(
        'PUT',
        '/api/v1/account/password',
        { currentPassword: password, newPassword: next },
        cookie,
      );
      expect(changed.statusCode, changed.body).toBe(200);
      expect(ad.passwordOf(dn)).toBe(next);
      // Deleting the directory deactivates its accounts and ends their sessions.
      const removed = await call('DELETE', `/api/v1/directories/${created.json().directory.id}`);
      expect(removed.statusCode).toBe(204);
      const dana = await database.db
        .selectFrom('app_user')
        .select(['id', 'deactivated_at'])
        .where('email', '=', 'dana@corp.test')
        .executeTakeFirstOrThrow();
      expect(dana.deactivated_at).not.toBeNull();
      const sessions = await database.db
        .selectFrom('user_session')
        .select('id')
        .where('user_id', '=', dana.id)
        .execute();
      expect(sessions).toEqual([]);
    } finally {
      await ad.stop();
    }
  });

  it('[IAM-005] orders directories by precedence and keeps the last administrator when deleting', async () => {
    const extra = await call('POST', '/api/v1/directories', {
      ...body('Backup LDAP'),
      enabled: false,
    });
    const ids = (await call('GET', '/api/v1/directories'))
      .json()
      .directories.map((d: { id: number }) => d.id);
    expect((await call('PUT', '/api/v1/directories/order', { ids: [ids[0]] })).statusCode).toBe(
      400,
    );
    const reordered = await call('PUT', '/api/v1/directories/order', { ids: [...ids].reverse() });
    expect(reordered.statusCode).toBe(204);
    const after = (await call('GET', '/api/v1/directories')).json().directories;
    expect(after.map((d: { id: number }) => d.id)).toEqual([...ids].reverse());
    expect(after[0].position).toBe(1);

    // The directory now manages the only active site administrator: it cannot go.
    const [main] = after.filter((d: { name: string }) => d.name === 'Corp LDAP');
    const cleo = await accountId('cleo@example.com');
    await database.db
      .updateTable('app_user')
      .set({ is_site_admin: true })
      .where('id', '=', cleo)
      .execute();
    await database.db
      .updateTable('app_user')
      .set({ deactivated_at: new Date() })
      .where('email', '=', 'admin@local.test')
      .execute();
    const blocked = await call(
      'DELETE',
      `/api/v1/directories/${main.id}`,
      undefined,
      sessionCookie(await signIn('cleo@example.com', people.cleo?.password as string)),
    );
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('last_admin');
    expect(extra.statusCode).toBe(201);
  });
});
