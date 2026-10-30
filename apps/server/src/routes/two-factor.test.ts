import { useMigratedDatabase } from '@taskmoor/db/testing';
import {
  LOCKOUT,
  openSecret,
  passwordHasher,
  pepperFromSecret,
  pepperRing,
  totpCode,
  totpStep,
} from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { SoftAuthenticator } from '../testing/webauthn';

const PASSWORD = 'ladder violet harbour';
const ORIGIN = 'https://tracker.example.com';
const peppers = pepperRing(pepperFromSecret('a pepper for two-factor tests, long enough'));
let address = 0;
const nextAddress = () => `203.0.113.${++address}`;

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

describe('two-factor sign-in (M1-084)', () => {
  const database = useMigratedDatabase();
  const passwords = passwordHasher(peppers);
  let app: FastifyInstance;
  let adminCookie: string;

  const call = (cookie: string | undefined, options: InjectOptions) =>
    app.inject({
      remoteAddress: nextAddress(),
      ...options,
      headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
    });

  async function addUser(email: string, admin = false) {
    const row = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email,
        name: email.split('@')[0] ?? email,
        password_hash: await passwords.hash(PASSWORD),
        is_site_admin: admin,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  const signIn = (email: string, remoteAddress = nextAddress()) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password: PASSWORD },
      remoteAddress,
    });

  /** Signs in a person without a second factor and returns their cookie. */
  async function plainSignIn(email: string) {
    const res = await signIn(email);
    expect(res.json().status).toBe('signed_in');
    return sessionCookie(res);
  }

  /** Enrols TOTP from the account page; returns the secret and the recovery codes. */
  async function enrolTotp(cookie: string) {
    const setup = (
      await call(cookie, { method: 'POST', url: '/api/v1/account/two-factor/totp' })
    ).json();
    const code = totpCode(setup.secret, totpStep(new Date()));
    const confirm = await call(cookie, {
      method: 'POST',
      url: '/api/v1/account/two-factor/totp/confirm',
      payload: { setupToken: setup.setupToken, code },
    });
    expect(confirm.statusCode).toBe(201);
    return {
      secret: setup.secret as string,
      recoveryCodes: confirm.json().recoveryCodes as string[],
    };
  }

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      passwords,
      peppers,
      publicUrl: ORIGIN,
    });
    await addUser('admin@example.com', true);
    adminCookie = await plainSignIn('admin@example.com');
  });
  afterAll(async () => {
    await app.close();
  });

  it('[IAM-001] enrols an authenticator app with recovery codes and stores the secret sealed', async () => {
    const id = await addUser('totp@example.com');
    const cookie = await plainSignIn('totp@example.com');
    const setup = (
      await call(cookie, { method: 'POST', url: '/api/v1/account/two-factor/totp' })
    ).json();
    expect(setup.uri).toMatch(
      /^otpauth:\/\/totp\/Taskmoor%3Atotp%40example\.com\?secret=[A-Z2-7]+/,
    );
    const wrong = await call(cookie, {
      method: 'POST',
      url: '/api/v1/account/two-factor/totp/confirm',
      payload: { setupToken: setup.setupToken, code: '000000' },
    });
    expect(wrong.json()).toEqual({ error: 'invalid_code' });
    // Someone else's setup token does not work for this person.
    const other = await addUser('other@example.com');
    expect(other).toBeGreaterThan(id);
    const confirm = await call(cookie, {
      method: 'POST',
      url: '/api/v1/account/two-factor/totp/confirm',
      payload: { setupToken: setup.setupToken, code: totpCode(setup.secret, totpStep(new Date())) },
    });
    expect(confirm.statusCode).toBe(201);
    expect(confirm.json().recoveryCodes).toHaveLength(10);
    const row = await database.db
      .selectFrom('totp_credential')
      .select('secret_sealed')
      .where('user_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.secret_sealed.startsWith('enc1:')).toBe(true);
    expect(row.secret_sealed).not.toContain(setup.secret);
    expect(openSecret(row.secret_sealed, peppers)).toBe(setup.secret);
    const status = (
      await call(cookie, { method: 'GET', url: '/api/v1/account/two-factor' })
    ).json();
    expect(status).toMatchObject({
      totp: true,
      securityKeys: [],
      recoveryRemaining: 10,
      required: false,
    });
  });

  it('[IAM-001] asks for the second factor after the password, once per code', async () => {
    await addUser('second@example.com');
    const { secret, recoveryCodes } = await enrolTotp(await plainSignIn('second@example.com'));
    const first = await signIn('second@example.com');
    expect(first.json()).toMatchObject({
      status: 'second_factor',
      methods: ['totp', 'recovery_code'],
    });
    expect(sessionCookie(first)).toBe('');
    const challenge = first.json().challenge;

    const bad = await call(undefined, {
      method: 'POST',
      url: '/api/v1/session/second-factor',
      payload: { challenge, method: 'totp', code: '123456' },
    });
    expect(bad.json()).toEqual({ error: 'invalid_second_factor' });
    const audited = await database.db
      .selectFrom('audit_event')
      .select(['action', 'details'])
      .where('action', '=', 'session.sign_in_failed')
      .orderBy('seq', 'desc')
      .executeTakeFirstOrThrow();
    expect(audited.details).toMatchObject({ reason: 'second_factor', email: 'second@example.com' });

    // The current step was used to confirm enrolment; the next step's code signs in.
    const code = totpCode(secret, totpStep(new Date()) + 1);
    const ok = await call(undefined, {
      method: 'POST',
      url: '/api/v1/session/second-factor',
      payload: { challenge, method: 'totp', code },
    });
    expect(ok.json()).toMatchObject({ status: 'signed_in', user: { email: 'second@example.com' } });
    expect(sessionCookie(ok)).not.toBe('');
    const event = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'session.started')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ method: 'totp' });

    // The challenge is spent, and the same code cannot be used again (ASVS 2.8.4).
    const again = await signIn('second@example.com');
    const replay = await call(undefined, {
      method: 'POST',
      url: '/api/v1/session/second-factor',
      payload: { challenge: again.json().challenge, method: 'totp', code },
    });
    expect(replay.statusCode).toBe(401);
    const reuse = await call(undefined, {
      method: 'POST',
      url: '/api/v1/session/second-factor',
      payload: { challenge, method: 'totp', code: totpCode(secret, totpStep(new Date())) },
    });
    expect(reuse.json()).toEqual({ error: 'invalid_challenge' });

    // A recovery code works once.
    const recovery = recoveryCodes[0] as string;
    const viaRecovery = await call(undefined, {
      method: 'POST',
      url: '/api/v1/session/second-factor',
      payload: {
        challenge: again.json().challenge,
        method: 'recovery_code',
        code: recovery.toLowerCase(),
      },
    });
    expect(viaRecovery.json().status).toBe('signed_in');
    const third = await signIn('second@example.com');
    const used = await call(undefined, {
      method: 'POST',
      url: '/api/v1/session/second-factor',
      payload: { challenge: third.json().challenge, method: 'recovery_code', code: recovery },
    });
    expect(used.statusCode).toBe(401);
  });

  it('[IAM-001] counts wrong second factors against the challenge and the account', async () => {
    await addUser('guess@example.com');
    await enrolTotp(await plainSignIn('guess@example.com'));
    const from = nextAddress();
    const challenge = (await signIn('guess@example.com', from)).json().challenge;
    const guess = (code: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/session/second-factor',
        payload: { challenge, method: 'totp', code },
        remoteAddress: from,
      });
    for (let i = 0; i < LOCKOUT.freeFailures - 1; i++) {
      expect((await guess(String(100000 + i))).statusCode).toBe(401);
    }
    // The fifth failure locks the account: the right password no longer opens a challenge.
    expect((await guess('199999')).statusCode).toBe(401);
    expect((await signIn('guess@example.com')).statusCode).toBe(429);
  });

  it('[IAM-001] registers a security key and signs in with it', async () => {
    await addUser('key@example.com');
    const cookie = await plainSignIn('key@example.com');
    const authenticator = new SoftAuthenticator(ORIGIN, 'tracker.example.com');
    const begin = (
      await call(cookie, { method: 'POST', url: '/api/v1/account/two-factor/webauthn/options' })
    ).json();
    expect(begin.options.rp).toEqual({ name: 'Taskmoor', id: 'tracker.example.com' });
    const registered = await call(cookie, {
      method: 'POST',
      url: '/api/v1/account/two-factor/webauthn',
      payload: {
        registrationToken: begin.registrationToken,
        name: 'Desk key',
        response: authenticator.register(begin.options),
      },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().recoveryCodes).toHaveLength(10);

    const first = await signIn('key@example.com');
    expect(first.json()).toMatchObject({
      status: 'second_factor',
      methods: ['webauthn', 'recovery_code'],
    });
    const challenge = first.json().challenge;
    const options = (
      await call(undefined, {
        method: 'POST',
        url: '/api/v1/session/second-factor/webauthn',
        payload: { challenge },
      })
    ).json().options;
    // An assertion for another challenge is refused.
    const stale = await call(undefined, {
      method: 'POST',
      url: '/api/v1/session/second-factor',
      payload: {
        challenge,
        method: 'webauthn',
        response: authenticator.authenticate({ challenge: 'bm9wZQ' }),
      },
    });
    expect(stale.statusCode).toBe(401);
    const ok = await call(undefined, {
      method: 'POST',
      url: '/api/v1/session/second-factor',
      payload: { challenge, method: 'webauthn', response: authenticator.authenticate(options) },
    });
    expect(ok.json().status).toBe('signed_in');
    const key = await database.db
      .selectFrom('webauthn_credential')
      .select(['counter', 'last_used_at'])
      .where('name', '=', 'Desk key')
      .executeTakeFirstOrThrow();
    expect(Number(key.counter)).toBeGreaterThan(0);
    expect(key.last_used_at).not.toBeNull();
  });

  it('[IAM-001] makes sign-in impossible without a second factor when the policy requires one', async () => {
    await addUser('required@example.com');
    const policy = await call(adminCookie, {
      method: 'PUT',
      url: '/api/v1/security/two-factor',
      payload: { required: 'everyone' },
    });
    expect(policy.json()).toEqual({ required: 'everyone', groupIds: [], organizationDomains: [] });
    const first = await signIn('required@example.com');
    expect(first.json()).toMatchObject({ status: 'enrollment_required' });
    expect(sessionCookie(first)).toBe('');
    const challenge = first.json().challenge;
    // Neither another route nor a guessed factor gets past the challenge.
    const skip = await call(undefined, {
      method: 'POST',
      url: '/api/v1/session/second-factor',
      payload: { challenge, method: 'recovery_code', code: 'AAAAA-AAAAA' },
    });
    expect(skip.statusCode).toBe(401);
    const setup = (
      await call(undefined, {
        method: 'POST',
        url: '/api/v1/session/enroll/totp',
        payload: { challenge },
      })
    ).json();
    const done = await call(undefined, {
      method: 'POST',
      url: '/api/v1/session/enroll/totp/confirm',
      payload: {
        challenge,
        setupToken: setup.setupToken,
        code: totpCode(setup.secret, totpStep(new Date())),
      },
    });
    expect(done.json()).toMatchObject({
      status: 'signed_in',
      user: { email: 'required@example.com' },
    });
    expect(done.json().recoveryCodes).toHaveLength(10);
    const cookie = sessionCookie(done);
    // A required last factor cannot be switched off.
    const disable = await call(cookie, {
      method: 'POST',
      url: '/api/v1/account/two-factor/totp/disable',
      payload: { password: PASSWORD },
    });
    expect(disable.json()).toEqual({ error: 'two_factor_required' });
    await call(adminCookie, {
      method: 'PUT',
      url: '/api/v1/security/two-factor',
      payload: { required: 'none' },
    });
  });

  it('[IAM-001] requires a second factor of site administrators and of chosen groups', async () => {
    const id = await addUser('grouped@example.com');
    const group = (
      await call(adminCookie, {
        method: 'POST',
        url: '/api/v1/groups',
        payload: { name: 'Finance' },
      })
    ).json().group.id;
    await call(adminCookie, { method: 'PUT', url: `/api/v1/groups/${group}/members/${id}` });
    await call(adminCookie, {
      method: 'PUT',
      url: '/api/v1/security/two-factor',
      payload: { required: 'site_admins', groupIds: [group] },
    });
    expect((await signIn('grouped@example.com')).json().status).toBe('enrollment_required');
    expect((await signIn('admin@example.com')).json().status).toBe('enrollment_required');
    await addUser('free@example.com');
    expect((await signIn('free@example.com')).json().status).toBe('signed_in');
    await call(adminCookie, {
      method: 'PUT',
      url: '/api/v1/security/two-factor',
      payload: { required: 'none' },
    });
  });

  it('[IAM-004] requires a second factor of external people, those outside the organization’s domains', async () => {
    await addUser('inside@example.com');
    await addUser('guest@partner.test');
    const saved = await call(adminCookie, {
      method: 'PUT',
      url: '/api/v1/security/two-factor',
      payload: { required: 'none', organizationDomains: [' Example.COM ', 'example.com'] },
    });
    expect(saved.json()).toEqual({
      required: 'none',
      groupIds: [],
      organizationDomains: ['example.com'],
    });
    expect((await signIn('inside@example.com')).json().status).toBe('signed_in');
    expect((await signIn('guest@partner.test')).json().status).toBe('enrollment_required');
    // Saving the policy without domains keeps the list; an empty list clears it.
    await call(adminCookie, {
      method: 'PUT',
      url: '/api/v1/security/two-factor',
      payload: { required: 'none' },
    });
    expect((await signIn('guest@partner.test')).json().status).toBe('enrollment_required');
    const cleared = await call(adminCookie, {
      method: 'PUT',
      url: '/api/v1/security/two-factor',
      payload: { required: 'none', organizationDomains: [] },
    });
    expect(cleared.json().organizationDomains).toEqual([]);
    expect((await signIn('guest@partner.test')).json().status).toBe('signed_in');
    const invalid = await call(adminCookie, {
      method: 'PUT',
      url: '/api/v1/security/two-factor',
      payload: { required: 'none', organizationDomains: ['not a domain'] },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('[IAM-001] needs the password to switch a factor off or renew recovery codes', async () => {
    await addUser('careful@example.com');
    const cookie = await plainSignIn('careful@example.com');
    await enrolTotp(cookie);
    const wrong = await call(cookie, {
      method: 'POST',
      url: '/api/v1/account/two-factor/recovery-codes',
      payload: { password: 'not the password' },
    });
    expect(wrong.json()).toEqual({ error: 'wrong_password' });
    const renewed = await call(cookie, {
      method: 'POST',
      url: '/api/v1/account/two-factor/recovery-codes',
      payload: { password: PASSWORD },
    });
    expect(renewed.json().recoveryCodes).toHaveLength(10);
    const off = await call(cookie, {
      method: 'POST',
      url: '/api/v1/account/two-factor/totp/disable',
      payload: { password: PASSWORD },
    });
    expect(off.statusCode).toBe(204);
    const status = (
      await call(cookie, { method: 'GET', url: '/api/v1/account/two-factor' })
    ).json();
    expect(status).toMatchObject({ totp: false, recoveryRemaining: 0 });
    expect((await signIn('careful@example.com')).json().status).toBe('signed_in');
  });

  it('[IAM-001] lets an administrator reset a person who lost every factor', async () => {
    const id = await addUser('lost@example.com');
    await enrolTotp(await plainSignIn('lost@example.com'));
    expect((await signIn('lost@example.com')).json().status).toBe('second_factor');
    const member = await addUser('nosy@example.com');
    const nosy = await plainSignIn('nosy@example.com');
    expect(
      (await call(nosy, { method: 'POST', url: `/api/v1/users/${id}/two-factor/reset` }))
        .statusCode,
    ).toBe(403);
    const reset = await call(adminCookie, {
      method: 'POST',
      url: `/api/v1/users/${id}/two-factor/reset`,
    });
    expect(reset.statusCode).toBe(204);
    expect(member).toBeGreaterThan(0);
    expect((await signIn('lost@example.com')).json().status).toBe('signed_in');
  });

  it('expires a challenge after five minutes', async () => {
    await addUser('slow@example.com');
    const { secret } = await enrolTotp(await plainSignIn('slow@example.com'));
    const challenge = (await signIn('slow@example.com')).json().challenge;
    await database.db
      .updateTable('sign_in_challenge')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();
    const late = await call(undefined, {
      method: 'POST',
      url: '/api/v1/session/second-factor',
      payload: { challenge, method: 'totp', code: totpCode(secret, totpStep(new Date()) + 1) },
    });
    expect(late.json()).toEqual({ error: 'invalid_challenge' });
  });
});
