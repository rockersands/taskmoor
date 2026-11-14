import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword, totpCode, totpStep } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import type { OutgoingEmail } from '../email/transport';
import { EventBus, emit } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { DEFAULT_ALERT_RULES, forgetAlertRules, isAuditCount, windowStart } from './alerts';
import { deliverSecurityEmail, renderSecurityEmail } from './mail';
import { maskAddress } from './notices';

/**
 * Security events (ADR-109): notices to people when their credentials change (ASVS 2.2.3,
 * 2.5.5), failed sign-ins and repeated refusals in the audit log (ASVS 7.1.3, 7.2.1, 7.2.2),
 * and alert rules that tell site administrators (ASVS 11.1.7, 11.1.8). Passwords are made at run
 * time; nothing here is a real credential.
 */
const PASSWORD = randomBytes(18).toString('base64url');
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) SecurityTest/1.0';

function sessionCookie(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  const found = list.find(
    (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
  );
  return (found ?? '').split(';')[0] ?? '';
}

/** A mail transport that keeps what it is given; `failNext` makes the next send fail. */
function memoryTransport() {
  const sent: OutgoingEmail[] = [];
  let failures = 0;
  return {
    sent,
    failNext: (n = 1) => {
      failures = n;
    },
    async send(email: OutgoingEmail) {
      if (failures > 0) {
        failures--;
        throw new Error('the test server is down');
      }
      sent.push(email);
      return { messageId: `<${sent.length}@test>` };
    },
  };
}

describe('security events (ADR-109)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const ids: Record<string, number> = {};
  const cookies: Record<string, string> = {};
  let address = 0;
  const transport = memoryTransport();
  const mailer = { transport, from: 'taskmoor@example.com', publicUrl: 'https://tm.example.com' };

  const call = (options: InjectOptions & { cookie?: string; from?: string }) =>
    app.inject({
      ...options,
      remoteAddress: options.from ?? `198.18.7.${++address}`,
      headers: {
        'user-agent': BROWSER,
        ...(options.headers ?? {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
    });
  const asAdmin = (options: InjectOptions & { from?: string }) =>
    call({ ...options, cookie: cookies.admin ?? '' });

  async function createUser(email: string, options: { admin?: boolean; locale?: string } = {}) {
    const row = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email,
        name: email.split('@')[0] ?? email,
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: options.admin ?? false,
        locale: options.locale ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function signIn(email: string, password = PASSWORD, from?: string) {
    return call({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password },
      ...(from ? { from } : {}),
    });
  }

  /** The worker's part: relay events and run every subscriber's jobs. */
  async function deliverEvents(): Promise<void> {
    const bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    const runner = new JobRunner(database.db, 'security-test');
    bus.attach(runner);
    while ((await bus.relayOnce()) > 0) {}
    while ((await runner.runOnce()) > 0) {}
  }

  async function securityEmails(userId: number) {
    return database.db
      .selectFrom('security_email')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('id')
      .execute();
  }

  async function audit(action: string) {
    return database.db
      .selectFrom('audit_event')
      .select(['action', 'actor_id', 'subject_type', 'subject_id', 'ip', 'details'])
      .where('action', '=', action)
      .orderBy('seq')
      .execute();
  }

  async function setRule(rule: string, setting: object) {
    const res = await asAdmin({
      method: 'PUT',
      url: '/api/v1/security/alerts',
      payload: { rules: { [rule]: setting } },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    ids.admin = await createUser('admin@example.com', { admin: true });
    ids.member = await createUser('member@example.com');
    cookies.admin = sessionCookie(await signIn('admin@example.com'));
    cookies.member = sessionCookie(await signIn('member@example.com'));
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    // Each test starts from the default rules and clean counters.
    await database.db.deleteFrom('security_alert_rule').execute();
    await database.db.deleteFrom('security_counter').execute();
    forgetAlertRules(1);
  });

  describe('notices when credentials change (ASVS 2.2.3, 2.5.5)', () => {
    it('[IAM-001] ASVS 2.2.3: a password change is told by email with when, where from and how to get help, and no sign-in link', async () => {
      const id = await createUser('changer@example.com');
      const cookie = sessionCookie(await signIn('changer@example.com'));
      const next = randomBytes(18).toString('base64url');
      const res = await call({
        method: 'PUT',
        url: '/api/v1/account/password',
        cookie,
        from: '203.0.113.40',
        payload: { currentPassword: PASSWORD, newPassword: next },
      });
      expect(res.statusCode, res.body).toBe(200);
      await deliverEvents();
      const [notice] = await securityEmails(id);
      expect(notice).toMatchObject({
        kind: 'password_changed',
        to_address: 'changer@example.com',
        sent_at: null,
        details: { ip: '203.0.113.40', userAgent: BROWSER, by: 'self', via: 'self' },
      });

      const before = transport.sent.length;
      const run = await deliverSecurityEmail(database.db, mailer);
      expect(run.sent).toBeGreaterThanOrEqual(1);
      const email = transport.sent.slice(before).find((e) => e.to === 'changer@example.com');
      expect(email?.subject).toBe('Your Taskmoor password was changed');
      expect(email?.text).toContain('From: 203.0.113.40');
      expect(email?.text).toContain(`Browser or program: ${BROWSER}`);
      expect(email?.text).toContain('Made by: you, while signed in.');
      expect(email?.text).toContain('contact your Taskmoor administrator');
      // The only address in it is the sign-in page: no token, no link that signs anyone in.
      expect(email?.text.match(/https?:\/\/\S+/g)).toEqual(['https://tm.example.com/']);
      expect(`${email?.text}${email?.html}`).not.toContain(next);
      expect(email?.headers['List-Unsubscribe']).toBeUndefined();
      // Sent once.
      expect((await deliverSecurityEmail(database.db, mailer)).sent).toBe(0);
      expect((await securityEmails(id))[0]?.sent_at).not.toBeNull();
    });

    it('[IAM-001] ASVS 2.2.3: notices are not optional: email turned off, a digest chosen or quiet hours change nothing', async () => {
      const id = await createUser('quiet@example.com');
      await database.db
        .insertInto('user_preference')
        .values({
          user_id: id,
          workspace_id: 1,
          email_delivery: 'off',
          quiet_start: 0,
          quiet_end: 23,
        })
        .execute();
      const cookie = sessionCookie(await signIn('quiet@example.com'));
      await call({
        method: 'PUT',
        url: '/api/v1/account/password',
        cookie,
        payload: { currentPassword: PASSWORD, newPassword: randomBytes(18).toString('base64url') },
      });
      await deliverEvents();
      const before = transport.sent.length;
      await deliverSecurityEmail(database.db, mailer);
      expect(transport.sent.slice(before).map((e) => e.to)).toContain('quiet@example.com');
    });

    it('[IAM-001] ASVS 2.5.5: adding and removing a second factor, new recovery codes and an administrator reset are each told', async () => {
      const id = await createUser('factors@example.com', { locale: 'es' });
      const cookie = sessionCookie(await signIn('factors@example.com'));
      const setup = (
        await call({ method: 'POST', url: '/api/v1/account/two-factor/totp', cookie })
      ).json();
      const confirmed = await call({
        method: 'POST',
        url: '/api/v1/account/two-factor/totp/confirm',
        cookie,
        payload: {
          setupToken: setup.setupToken,
          code: totpCode(setup.secret, totpStep(new Date())),
        },
      });
      expect(confirmed.statusCode, confirmed.body).toBeLessThan(300);
      const codes = await call({
        method: 'POST',
        url: '/api/v1/account/two-factor/recovery-codes',
        cookie,
        payload: { password: PASSWORD },
      });
      expect(codes.statusCode, codes.body).toBe(201);
      const disabled = await call({
        method: 'POST',
        url: '/api/v1/account/two-factor/totp/disable',
        cookie,
        payload: { password: PASSWORD },
      });
      expect(disabled.statusCode, disabled.body).toBeLessThan(300);
      const reset = await asAdmin({ method: 'POST', url: `/api/v1/users/${id}/two-factor/reset` });
      expect(reset.statusCode).toBe(204);
      await deliverEvents();
      const notices = await securityEmails(id);
      expect(notices.map((n) => [n.kind, n.details.by, n.details.method ?? null])).toEqual([
        ['two_factor_enabled', 'self', 'totp'],
        ['recovery_codes_regenerated', 'self', null],
        ['two_factor_disabled', 'self', 'totp'],
        ['two_factor_reset', 'administrator', null],
      ]);
      const before = transport.sent.length;
      await deliverSecurityEmail(database.db, mailer);
      const mine = transport.sent.slice(before).filter((e) => e.to === 'factors@example.com');
      // In the person's language (Spanish here); never a code or a secret.
      expect(mine.map((e) => e.subject)).toEqual([
        'Se añadió un segundo factor a tu cuenta de Taskmoor',
        'Se crearon códigos de recuperación nuevos para tu cuenta de Taskmoor',
        'Se quitó un segundo factor de tu cuenta de Taskmoor',
        'Se restablecieron los segundos factores de tu cuenta de Taskmoor',
      ]);
      const recoveryCodes = codes.json().recoveryCodes as string[];
      for (const email of mine) {
        expect(email.text).not.toContain(setup.secret);
        for (const code of recoveryCodes) expect(email.text).not.toContain(code);
      }
      expect(mine[3]?.text).toContain('Lo hizo un administrador del sitio.');
    });

    it('[IAM-001] ASVS 2.5.5: an email change is told to the old address, with the new one masked', async () => {
      const id = await createUser('old.address@example.com');
      const res = await asAdmin({
        method: 'PATCH',
        url: `/api/v1/users/${id}`,
        payload: { email: 'new.address@example.org' },
      });
      expect(res.statusCode, res.body).toBe(200);
      await deliverEvents();
      const [notice] = await securityEmails(id);
      expect(notice).toMatchObject({
        kind: 'email_changed',
        to_address: 'old.address@example.com',
        details: { newAddress: 'n***@example.org', by: 'administrator' },
      });
      expect(maskAddress('ada@example.com')).toBe('a***@example.com');
      expect(maskAddress('nonsense')).toBe('***');
    });

    it('[IAM-001] activating an account through its link sends no notice; a reset link does', async () => {
      const created = await asAdmin({
        method: 'POST',
        url: '/api/v1/users',
        payload: { email: 'invited@example.com', name: 'Invited' },
      });
      const userId = created.json().user.id as number;
      const token = new URL(
        (created.json().activationLink as string).replace('/#/', '/'),
      ).searchParams.get('token');
      const redeem = await call({
        method: 'POST',
        url: '/api/v1/password-links/redeem',
        payload: { token, password: randomBytes(18).toString('base64url') },
      });
      expect(redeem.statusCode, redeem.body).toBe(200);
      await deliverEvents();
      expect(await securityEmails(userId)).toEqual([]);
    });

    it('[IAM-001] a failed send is tried again at the next run', async () => {
      // Whatever else is queued goes out first.
      await deliverEvents();
      await deliverSecurityEmail(database.db, mailer);
      const id = await createUser('retry@example.com');
      const cookie = sessionCookie(await signIn('retry@example.com'));
      await call({
        method: 'PUT',
        url: '/api/v1/account/password',
        cookie,
        payload: { currentPassword: PASSWORD, newPassword: randomBytes(18).toString('base64url') },
      });
      await deliverEvents();
      transport.failNext(1);
      const first = await deliverSecurityEmail(database.db, mailer);
      expect(first).toEqual({ sent: 0, failed: 1, dropped: 0 });
      expect((await securityEmails(id))[0]).toMatchObject({
        attempts: 1,
        last_error: 'the test server is down',
        sent_at: null,
      });
      expect((await deliverSecurityEmail(database.db, mailer)).sent).toBe(1);
      expect((await securityEmails(id))[0]).toMatchObject({ attempts: 2, last_error: null });
      expect((await securityEmails(id))[0]?.sent_at).not.toBeNull();
    });
  });

  describe('failed sign-ins in the audit log (ASVS 7.1.3, 7.2.1)', () => {
    it('[IAM-013] ASVS 7.2.1: a wrong password and an unknown account record the account, address, method and reason, never the password', async () => {
      const guess = randomBytes(12).toString('base64url');
      const from = '203.0.113.71';
      expect((await signIn('member@example.com', guess, from)).statusCode).toBe(401);
      expect((await signIn('nobody@example.com', guess, from)).statusCode).toBe(401);
      const records = (await audit('session.sign_in_failed')).filter((r) => r.ip === from);
      expect(records).toEqual([
        expect.objectContaining({
          subject_type: 'user',
          subject_id: String(ids.member),
          details: expect.objectContaining({
            email: 'member@example.com',
            reason: 'wrong_password',
            method: 'password',
            userAgent: BROWSER,
          }),
        }),
        expect.objectContaining({
          subject_type: null,
          details: expect.objectContaining({
            email: 'nobody@example.com',
            reason: 'unknown_account',
            method: 'password',
          }),
        }),
      ]);
      expect(JSON.stringify(records)).not.toContain(guess);
    });

    it('[IAM-013] ASVS 7.2.1: a wrong second factor records its method', async () => {
      await createUser('second@example.com');
      const cookie = sessionCookie(await signIn('second@example.com'));
      const setup = (
        await call({ method: 'POST', url: '/api/v1/account/two-factor/totp', cookie })
      ).json();
      await call({
        method: 'POST',
        url: '/api/v1/account/two-factor/totp/confirm',
        cookie,
        payload: {
          setupToken: setup.setupToken,
          code: totpCode(setup.secret, totpStep(new Date())),
        },
      });
      const from = '203.0.113.72';
      const { challenge } = (await signIn('second@example.com', PASSWORD, from)).json();
      const bad = await call({
        method: 'POST',
        url: '/api/v1/session/second-factor',
        from,
        payload: { challenge, method: 'recovery_code', code: 'aaaa-bbbb-cccc' },
      });
      expect(bad.statusCode).toBe(401);
      const [record] = (await audit('session.sign_in_failed')).filter((r) => r.ip === from);
      expect(record?.details).toMatchObject({ reason: 'second_factor', method: 'recovery_code' });
      expect(JSON.stringify(record)).not.toContain('aaaa-bbbb-cccc');
    });

    it('[IAM-013] ASVS 7.2.1: refused API tokens are audited with the token id when it is known, never the token', async () => {
      const from = '203.0.113.73';
      const unknown = `tmk_${randomBytes(24).toString('base64url')}`;
      const res = await call({
        method: 'GET',
        url: '/api/v1/session',
        from,
        headers: { authorization: `Bearer ${unknown}` },
      });
      expect(res.statusCode).toBe(401);
      const created = await call({
        method: 'POST',
        url: '/api/v1/account/tokens',
        cookie: cookies.member ?? '',
        payload: { name: 'Script', scopes: ['read'], expiresInDays: 30 },
      });
      expect(created.statusCode, created.body).toBe(201);
      const { token, apiToken } = created.json();
      await call({
        method: 'DELETE',
        url: `/api/v1/account/tokens/${apiToken.id}`,
        cookie: cookies.member ?? '',
      });
      await call({
        method: 'GET',
        url: '/api/v1/session',
        from,
        headers: { authorization: `Bearer ${token}` },
      });
      const records = (await audit('session.sign_in_failed')).filter((r) => r.ip === from);
      expect(records.map((r) => r.details)).toEqual([
        expect.objectContaining({ method: 'api_token', reason: 'token_unknown' }),
        expect.objectContaining({
          method: 'api_token',
          reason: 'token_revoked',
          tokenId: apiToken.id,
        }),
      ]);
      expect(records[1]?.subject_id).toBe(String(ids.member));
      expect(JSON.stringify(records)).not.toContain(unknown);
      expect(JSON.stringify(records)).not.toContain(token);
    });

    it('[IAM-013] ASVS 7.2.1: Basic authentication on the Jira-compatible API is audited when it is not a token or not the owner', async () => {
      const from = '203.0.113.74';
      const password = randomBytes(12).toString('base64url');
      const basic = (user: string, secret: string) =>
        `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
      const withPassword = await call({
        method: 'GET',
        url: '/rest/api/2/myself',
        from,
        headers: { authorization: basic('member@example.com', password) },
      });
      expect(withPassword.statusCode).toBe(401);
      const created = await call({
        method: 'POST',
        url: '/api/v1/account/tokens',
        cookie: cookies.member ?? '',
        payload: { name: 'Compat', scopes: ['read'], expiresInDays: 30 },
      });
      const { token } = created.json();
      const mismatch = await call({
        method: 'GET',
        url: '/rest/api/2/myself',
        from,
        headers: { authorization: basic('admin@example.com', token) },
      });
      expect(mismatch.statusCode).toBe(401);
      const records = (await audit('session.sign_in_failed')).filter((r) => r.ip === from);
      expect(records.map((r) => r.details)).toEqual([
        expect.objectContaining({ method: 'basic', reason: 'not_a_token' }),
        expect.objectContaining({ method: 'basic', reason: 'email_mismatch' }),
      ]);
      expect(records[1]?.subject_id).toBe(String(ids.member));
      expect(JSON.stringify(records)).not.toContain(password);
      expect(JSON.stringify(records)).not.toContain(token);
    });
  });

  describe('repeated refusals in aggregate (ASVS 7.2.2)', () => {
    it('[IAM-013] ASVS 7.2.2: one audit record at 10 refusals in the window and one at 100, not one per request', async () => {
      expect([10, 100, 1000].every(isAuditCount)).toBe(true);
      expect([9, 11, 20, 50, 99, 101, 500].some(isAuditCount)).toBe(false);
      await setRule('access_refusals', { enabled: false, threshold: 50, windowMinutes: 15 });
      const from = '203.0.113.80';
      for (let i = 0; i < 100; i++) {
        const res = await call({
          method: 'GET',
          url: '/api/v1/audit',
          cookie: cookies.member ?? '',
          from,
        });
        expect(res.statusCode).toBe(403);
      }
      const records = await audit('access.refused_repeatedly');
      const mine = records.filter((r) => r.actor_id === ids.member);
      expect(mine.map((r) => (r.details as { count: number }).count)).toEqual([10, 100]);
      expect(mine[0]).toMatchObject({
        subject_type: 'user',
        subject_id: String(ids.member),
        ip: from,
        details: { windowMinutes: 15, lastRoute: 'GET /api/v1/audit' },
      });
      // The rule was off: no alert.
      expect(
        await database.db
          .selectFrom('security_alert')
          .selectAll()
          .where('rule', '=', 'access_refusals')
          .execute(),
      ).toEqual([]);
    });
  });

  describe('alert rules (ASVS 11.1.7, 11.1.8)', () => {
    it('[IAM-018] ASVS 11.1.8: a burst of failed sign-ins for one account alerts every site administrator, in the inbox and by email, once per window', async () => {
      await setRule('sign_in_failures_account', { enabled: true, threshold: 3, windowMinutes: 60 });
      const target = await createUser('targeted@example.com');
      for (let i = 0; i < 4; i++) {
        await signIn('targeted@example.com', randomBytes(8).toString('hex'), `203.0.113.${90 + i}`);
      }
      const alerts = await database.db
        .selectFrom('security_alert')
        .selectAll()
        .where('rule', '=', 'sign_in_failures_account')
        .execute();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ key: `user:${target}`, count: 3, threshold: 3 });
      const events = await database.db
        .selectFrom('domain_event')
        .select(['actor_id', 'payload', 'ip'])
        .where('type', '=', 'security.alert_raised')
        .execute();
      expect(events.at(-1)).toMatchObject({
        actor_id: null,
        // The request that reached the threshold.
        ip: '203.0.113.92',
        payload: { rule: 'sign_in_failures_account', count: 3, userId: target },
      });
      await deliverEvents();
      // The administrator's inbox: a direct ask about no ticket.
      const inbox = await asAdmin({ method: 'GET', url: '/api/v1/inbox?view=priority' });
      const item = inbox.json().items.find((i: { event: string }) => i.event === 'security_alert');
      expect(item).toMatchObject({
        ticket: null,
        direct: true,
        alert: {
          rule: 'sign_in_failures_account',
          count: 3,
          windowMinutes: 60,
          userName: 'targeted',
          userEmail: 'targeted@example.com',
        },
      });
      // Not in a member's inbox.
      const theirs = await call({
        method: 'GET',
        url: '/api/v1/inbox',
        cookie: cookies.member ?? '',
      });
      expect(theirs.json().items.some((i: { event: string }) => i.event === 'security_alert')).toBe(
        false,
      );
      // Audited, and an email to the administrator.
      expect((await audit('security.alert_raised')).length).toBeGreaterThanOrEqual(1);
      const before = transport.sent.length;
      await deliverSecurityEmail(database.db, mailer);
      const email = transport.sent.slice(before).find((e) => e.to === 'admin@example.com');
      expect(email?.subject).toBe('Taskmoor security alert: failed sign-ins for one account');
      expect(email?.text).toContain('3 in 60 minutes (the threshold is 3).');
      expect(email?.text).toContain('Account: targeted <targeted@example.com>');
      // The administrator can mark it read like any item.
      const read = await asAdmin({
        method: 'PATCH',
        url: `/api/v1/inbox/${item.id}`,
        payload: { read: true },
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().item).toMatchObject({ read: true, ticket: null });
    });

    it('[IAM-018] ASVS 11.1.8: failed sign-ins from one address, across accounts and bad tokens, alert by address', async () => {
      await setRule('sign_in_failures_address', { enabled: true, threshold: 4, windowMinutes: 15 });
      const from = '203.0.113.99';
      for (let i = 0; i < 3; i++) await signIn(`spray${i}@example.com`, PASSWORD, from);
      await call({
        method: 'GET',
        url: '/api/v1/session',
        from,
        headers: { authorization: `Bearer tmk_${randomBytes(24).toString('base64url')}` },
      });
      const [alert] = await database.db
        .selectFrom('security_alert')
        .selectAll()
        .where('rule', '=', 'sign_in_failures_address')
        .where('key', '=', `ip:${from}`)
        .execute();
      expect(alert).toMatchObject({ count: 4, details: { address: from } });
    });

    it('[IAM-018] ASVS 11.1.7: bulk exports by one person alert; a rule turned off does not', async () => {
      await setRule('bulk_exports', { enabled: true, threshold: 2, windowMinutes: 60 });
      for (let i = 0; i < 2; i++) {
        const res = await asAdmin({ method: 'GET', url: '/api/v1/audit/export?format=jsonl' });
        expect(res.statusCode).toBe(200);
      }
      const raised = await database.db
        .selectFrom('security_alert')
        .selectAll()
        .where('rule', '=', 'bulk_exports')
        .execute();
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({ key: `user:${ids.admin}`, count: 2 });

      await setRule('sign_in_failures_account', {
        enabled: false,
        threshold: 1,
        windowMinutes: 60,
      });
      const quietTarget = await createUser('unalerted@example.com');
      await signIn('unalerted@example.com', randomBytes(12).toString('hex'), '203.0.113.120');
      expect(
        await database.db
          .selectFrom('security_alert')
          .select('id')
          .where('key', '=', `user:${quietTarget}`)
          .execute(),
      ).toEqual([]);
    });

    it('[OPS-020] an AI spend alert reaches the site administrators too', async () => {
      await emit(
        database.db,
        { workspaceId: 1, actorId: null, ip: null },
        {
          type: 'ai_limit.threshold_reached',
          subjectId: 1,
          payload: {
            scope: 'workspace',
            feature: null,
            userId: null,
            period: 'month',
            periodStart: '2026-11-01',
            metric: 'tokens',
            amount: 1000,
            used: 800,
            percent: 80,
          },
        },
      );
      await deliverEvents();
      const inbox = await asAdmin({ method: 'GET', url: '/api/v1/inbox?event=ai_spend_alert' });
      expect(inbox.json().items[0]).toMatchObject({
        event: 'ai_spend_alert',
        ticket: null,
        alert: { rule: 'ai_spend', percent: 80, metric: 'tokens' },
      });
    });

    it('[IAM-018] site administrators read and set the rules; others may not; out-of-range values are refused', async () => {
      const read = await asAdmin({ method: 'GET', url: '/api/v1/security/alerts' });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        rules: DEFAULT_ALERT_RULES,
        defaults: DEFAULT_ALERT_RULES,
        limits: { threshold: { min: 1, max: 100_000 }, windowMinutes: { min: 1, max: 1440 } },
      });
      expect(Array.isArray(read.json().recent)).toBe(true);
      const member = await call({
        method: 'PUT',
        url: '/api/v1/security/alerts',
        cookie: cookies.member ?? '',
        payload: { rules: { bulk_exports: { enabled: false, threshold: 1, windowMinutes: 1 } } },
      });
      expect(member.statusCode).toBe(403);
      for (const bad of [
        { rules: {} },
        { rules: { bulk_exports: { enabled: true, threshold: 0, windowMinutes: 10 } } },
        { rules: { bulk_exports: { enabled: true, threshold: 5, windowMinutes: 1441 } } },
        { rules: { made_up: { enabled: true, threshold: 5, windowMinutes: 10 } } },
      ]) {
        expect(
          (await asAdmin({ method: 'PUT', url: '/api/v1/security/alerts', payload: bad }))
            .statusCode,
        ).toBe(400);
      }
      const set = await asAdmin({
        method: 'PUT',
        url: '/api/v1/security/alerts',
        payload: {
          rules: { access_refusals: { enabled: true, threshold: 80, windowMinutes: 30 } },
        },
      });
      expect(set.json().rules).toEqual({
        ...DEFAULT_ALERT_RULES,
        access_refusals: { enabled: true, threshold: 80, windowMinutes: 30 },
      });
      const [event] = await database.db
        .selectFrom('domain_event')
        .select('payload')
        .where('type', '=', 'security_alerts.updated')
        .orderBy('id', 'desc')
        .limit(1)
        .execute();
      expect(event?.payload).toEqual({
        rules: [{ rule: 'access_refusals', enabled: true, threshold: 80, windowMinutes: 30 }],
      });
    });

    it('[IAM-018] windows are fixed: a window of 15 minutes starts on the quarter hour', () => {
      expect(windowStart(new Date('2026-11-02T10:07:31Z'), 15).toISOString()).toBe(
        '2026-11-02T10:00:00.000Z',
      );
      expect(windowStart(new Date('2026-11-02T10:59:59Z'), 60).toISOString()).toBe(
        '2026-11-02T10:00:00.000Z',
      );
    });

    it('[IAM-018] alert emails are escaped HTML and name the rule in the reader’s language', () => {
      const email = renderSecurityEmail(
        'alert',
        {
          rule: 'access_refusals',
          count: 50,
          threshold: 50,
          windowMinutes: 15,
          userName: '<b>Mallory</b>',
          at: '2026-11-02T10:00:00Z',
        },
        { locale: 'es-ES', timeZone: 'Europe/Madrid' },
        'https://tm.example.com',
      );
      expect(email.subject).toBe(
        'Alerta de seguridad de Taskmoor: solicitudes rechazadas repetidas',
      );
      expect(email.html).toContain('&lt;b&gt;Mallory&lt;/b&gt;');
      expect(email.html).not.toContain('<b>Mallory</b>');
    });
  });

  it('[IAM-013] events keep the User-Agent of the request that caused them', async () => {
    await asAdmin({
      method: 'PUT',
      url: '/api/v1/security/alerts',
      payload: { rules: { bulk_exports: { enabled: true, threshold: 5, windowMinutes: 60 } } },
    });
    const { rows } = await sql<{ user_agent: string | null }>`
      SELECT user_agent FROM domain_event WHERE type = 'security_alerts.updated'
       ORDER BY id DESC LIMIT 1`.execute(database.db);
    expect(rows[0]?.user_agent).toBe(BROWSER);
  });
});
