import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword, LOCKOUT } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { appendAudit } from '../audit/chain';
import { type AuditView, CSV_COLUMNS } from '../audit/query';
import { AUDIT_ACTIONS } from '../audit/record';
import { SESSION_COOKIE } from '../auth';
import { EventBus } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';

const PASSWORD = 'ladder violet harbour';

function sessionCookie(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  const found = list.find(
    (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
  );
  return (found ?? '').split(';')[0] ?? '';
}

describe('audit log API (M1-003, IAM-013)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let passwordHash: string;
  const ids: Record<string, number> = {};
  const cookies: Record<string, string> = {};
  let address = 0;

  const call = (options: InjectOptions & { cookie?: string; from?: string }) =>
    app.inject({
      ...options,
      remoteAddress: options.from ?? `198.18.1.${++address}`,
      headers: {
        ...(options.headers ?? {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
    });
  const asAdmin = (options: InjectOptions & { from?: string }) =>
    call({ ...options, cookie: cookies.admin ?? '' });

  async function createUser(email: string, admin = false): Promise<number> {
    const row = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email,
        name: email.split('@')[0] ?? email,
        password_hash: passwordHash,
        is_site_admin: admin,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function signIn(email: string): Promise<string> {
    const res = await call({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return sessionCookie(res);
  }

  /** Runs the worker's part: relay events and deliver them to the subscribers. */
  async function deliverEvents(): Promise<void> {
    const bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    const runner = new JobRunner(database.db, 'audit-test');
    bus.attach(runner);
    while ((await bus.relayOnce()) > 0) {}
    while ((await runner.runOnce()) > 0) {}
  }

  async function search(
    query: string,
  ): Promise<{ records: AuditView[]; nextCursor: string | null }> {
    const res = await asAdmin({ method: 'GET', url: `/api/v1/audit?${query}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    passwordHash = await hashPassword(PASSWORD);
    ids.admin = await createUser('admin@example.com', true);
    ids.member = await createUser('member@example.com');
    ids.target = await createUser('target@example.com');
    cookies.admin = await signIn('admin@example.com');
    cookies.member = await signIn('member@example.com');
  });
  afterAll(async () => {
    await app.close();
  });

  it('[IAM-013] lets only site administrators read the log and set its retention', async () => {
    const routes: InjectOptions[] = [
      { method: 'GET', url: '/api/v1/audit' },
      { method: 'GET', url: '/api/v1/audit/export' },
      { method: 'GET', url: '/api/v1/audit/verify' },
      { method: 'GET', url: '/api/v1/audit/settings' },
      { method: 'PUT', url: '/api/v1/audit/settings', payload: { retentionMonths: 1 } },
    ];
    for (const route of routes) {
      expect((await call(route)).statusCode, `${route.url} anonymous`).toBe(401);
      expect((await call({ ...route, cookie: cookies.member ?? '' })).statusCode).toBe(403);
    }
  });

  it('[IAM-013] records refused sign-ins and the lockout, with the address and without the password', async () => {
    const from = '198.51.100.77';
    for (let i = 0; i < LOCKOUT.freeFailures; i++) {
      const res = await call({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: 'Target@Example.com', password: `secret guess ${i}` },
        from,
      });
      expect(res.statusCode).toBe(401);
    }
    // Locked now: refused without a check, and without a record.
    const locked = await call({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'target@example.com', password: PASSWORD },
      from,
    });
    expect(locked.statusCode).toBe(429);
    // Someone typed the password into the email field.
    await call({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: PASSWORD, password: PASSWORD },
      from,
    });

    const { records } = await search('action=session.');
    const actions = records.map((r) => r.action);
    expect(actions.filter((a) => a === AUDIT_ACTIONS.signInFailed)).toHaveLength(
      LOCKOUT.freeFailures + 1,
    );
    expect(actions.filter((a) => a === AUDIT_ACTIONS.lockedOut)).toHaveLength(1);
    const lockout = records.find((r) => r.action === AUDIT_ACTIONS.lockedOut);
    expect(lockout).toMatchObject({
      actor: null,
      subject: { type: 'user', id: String(ids.target) },
      ip: from,
      details: { email: 'target@example.com', until: expect.any(String) },
    });
    expect(records[0]).toMatchObject({
      action: AUDIT_ACTIONS.signInFailed,
      subject: null,
      details: { emailMalformed: true },
    });
    for (const record of records) expect(record.ip).toBe(from);
    expect(JSON.stringify(records)).not.toMatch(/secret guess|ladder violet/);
  });

  it('[IAM-013] records a refused password check and a rejected password link', async () => {
    const from = '198.51.100.78';
    const wrong = await call({
      method: 'PUT',
      url: '/api/v1/account/password',
      cookie: cookies.member ?? '',
      payload: { currentPassword: 'not it at all', newPassword: 'quiet otter lantern' },
      from,
    });
    expect(wrong.statusCode).toBe(403);
    const link = await call({
      method: 'POST',
      url: '/api/v1/password-links/inspect',
      payload: { token: 'no-such-link' },
      from,
    });
    expect(link.statusCode).toBe(404);
    const [check] = (await search(`action=${AUDIT_ACTIONS.passwordCheckFailed}`)).records;
    expect(check).toMatchObject({
      actor: { id: ids.member, email: 'member@example.com' },
      subject: { type: 'user', id: String(ids.member) },
      ip: from,
    });
    const [rejected] = (await search(`action=${AUDIT_ACTIONS.passwordLinkRejected}`)).records;
    expect(rejected).toMatchObject({ actor: null, subject: null, ip: from, details: {} });
  });

  it('[IAM-013] turns domain events into records with the actor, subject and client address', async () => {
    const created = await asAdmin({
      method: 'POST',
      url: '/api/v1/groups',
      payload: { name: 'Auditors' },
      from: '198.51.100.88',
    });
    expect(created.statusCode).toBeLessThan(300);
    const groupId = created.json().group.id;
    await deliverEvents();
    const { records } = await search('action=group.created');
    const event = await database.db
      .selectFrom('domain_event')
      .select(['id', 'ip'])
      .where('type', '=', 'group.created')
      .executeTakeFirstOrThrow();
    expect(event.ip).toBe('198.51.100.88');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: 'group.created',
      actor: { id: ids.admin, email: 'admin@example.com', name: 'admin' },
      subject: { type: 'group', id: String(groupId) },
      details: { name: 'Auditors' },
      ip: '198.51.100.88',
      sourceEventId: String(event.id),
    });
    // The sign-ins of the setup became records too.
    const signIns = (await search(`action=session.started&actor=${ids.admin}`)).records;
    expect(signIns).toHaveLength(1);
    expect(signIns[0]?.details).toMatchObject({ method: 'password' });
  });

  it('[IAM-013] searches by action, actor, subject and time, newest first, a page at a time', async () => {
    await appendAudit(
      database.db,
      Array.from({ length: 5 }, (_, i) => ({
        workspaceId: 1,
        action: 'test.page',
        actorId: ids.member ?? null,
        subjectType: 'group',
        subjectId: 1000 + i,
      })),
    );
    const seen: number[] = [];
    let cursor: string | null = '';
    let pages = 0;
    while (cursor !== null) {
      const page = await search(`action=test.page&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.records.map((r) => r.seq));
      cursor = page.nextCursor;
      pages++;
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));

    const byActor = await search(`actor=${ids.member}&limit=500`);
    expect(byActor.records.length).toBeGreaterThanOrEqual(5);
    expect(byActor.records.every((r) => r.actor?.id === ids.member)).toBe(true);
    const bySubject = await search('subject=group:1003');
    expect(bySubject.records.map((r) => r.subject)).toEqual([{ type: 'group', id: '1003' }]);
    const byType = await search('subject=group&limit=500');
    expect(byType.records.every((r) => r.subject?.type === 'group')).toBe(true);

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect((await search(`from=${encodeURIComponent(hourAgo)}`)).records.length).toBeGreaterThan(0);
    expect((await search('from=2999-01-01')).records).toEqual([]);
    expect((await search('to=2000-01-01')).records).toEqual([]);
    expect((await search('action=test.p%25')).records).toEqual([]);

    for (const bad of ['from=yesterday', 'subject=Not%20a%20subject', 'limit=0', 'cursor=abc']) {
      expect((await asAdmin({ method: 'GET', url: `/api/v1/audit?${bad}` })).statusCode).toBe(400);
    }
  });

  it('[IAM-013] exports the log as CSV and JSON Lines, streamed, and records each export', async () => {
    const csv = await asAdmin({ method: 'GET', url: '/api/v1/audit/export?format=csv' });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/^attachment; filename="audit-.*\.csv"$/);
    const lines = csv.body.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    const total = await database.db
      .selectFrom('audit_event')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', 1)
      .executeTakeFirstOrThrow();
    // Every record, the export's own record included (it is written before the first line).
    expect(lines.length - 1).toBe(Number(total.n));
    expect(lines[lines.length - 1]).toContain(`,${AUDIT_ACTIONS.exported},`);

    const jsonl = await asAdmin({
      method: 'GET',
      url: '/api/v1/audit/export?format=jsonl&action=session.sign_in_failed',
    });
    expect(jsonl.headers['content-type']).toMatch(/^application\/x-ndjson/);
    const rows = jsonl.body
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditView);
    expect(rows).toHaveLength(LOCKOUT.freeFailures + 1);
    expect(rows.every((r) => r.action === 'session.sign_in_failed')).toBe(true);
    expect(rows.map((r) => r.seq)).toEqual([...rows.map((r) => r.seq)].sort((a, b) => a - b));

    const exports = (await search(`action=${AUDIT_ACTIONS.exported}`)).records;
    expect(exports.map((r) => r.details)).toEqual([
      { format: 'jsonl', filter: { action: 'session.sign_in_failed' } },
      { format: 'csv', filter: {} },
    ]);
    expect(exports[0]?.actor?.id).toBe(ids.admin);
  });

  it('[IAM-013] streams a large export in batches', async () => {
    await appendAudit(
      database.db,
      Array.from({ length: 2500 }, (_, i) => ({
        workspaceId: 1,
        action: 'test.bulk',
        actorId: null,
        details: { n: i },
      })),
    );
    const res = await asAdmin({
      method: 'GET',
      url: '/api/v1/audit/export?format=jsonl&action=test.bulk',
    });
    const rows = res.body.split('\n').filter(Boolean);
    expect(rows).toHaveLength(2500);
    expect(JSON.parse(rows[2499] ?? '{}').details).toEqual({ n: 2499 });
  });

  it('[IAM-013] sets the retention and emits one event per change', async () => {
    expect((await asAdmin({ method: 'GET', url: '/api/v1/audit/settings' })).json()).toEqual({
      retentionMonths: 12,
    });
    const put = (payload: unknown) =>
      asAdmin({
        method: 'PUT',
        url: '/api/v1/audit/settings',
        payload: payload as object,
        from: '198.51.100.99',
      });
    const changed = await put({ retentionMonths: 84 });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ retentionMonths: 84 });
    expect((await put({ retentionMonths: 84 })).statusCode).toBe(200);
    const events = await database.db
      .selectFrom('domain_event')
      .select(['payload', 'actor_id', 'ip'])
      .where('type', '=', 'audit.settings_updated')
      .execute();
    expect(events).toEqual([
      {
        payload: { changes: { retentionMonths: { from: 12, to: 84 } } },
        actor_id: ids.admin,
        ip: '198.51.100.99',
      },
    ]);
    expect((await asAdmin({ method: 'GET', url: '/api/v1/audit/settings' })).json()).toEqual({
      retentionMonths: 84,
    });
    for (const bad of [
      { retentionMonths: -1 },
      { retentionMonths: 1201 },
      { retentionMonths: 1.5 },
      { retentionMonths: '12' },
      { retentionMonths: 12, extra: true },
    ]) {
      expect((await put(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('[IAM-013] verifies the chain, and reports a record altered behind its back', async () => {
    await deliverEvents();
    const ok = await asAdmin({ method: 'GET', url: '/api/v1/audit/verify' });
    expect(ok.json()).toMatchObject({ ok: true, firstBroken: null, checkpoint: { seq: 0 } });
    const head = ok.json().head.seq as number;
    expect(ok.json().checked).toBe(head);

    await database.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await sql`UPDATE audit_event SET ip = '192.0.2.1' WHERE workspace_id = 1 AND seq = 3`.execute(
        trx,
      );
    });
    const broken = await asAdmin({ method: 'GET', url: '/api/v1/audit/verify' });
    expect(broken.json()).toMatchObject({
      ok: false,
      checked: 2,
      firstBroken: { seq: 3, reason: 'hash' },
    });
  });
});
