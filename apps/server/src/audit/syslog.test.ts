import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer, type Server } from 'node:net';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { appendAudit } from './chain';
import type { AuditView } from './query';
import { forwardAudit, sendSyslog, syslogMessage } from './syslog';

// Made for this run: no password is written in the repository.
const PASSWORD = `syslog-${randomBytes(18).toString('base64url')}`;

/** A syslog receiver over TCP: splits the octet-counted frames back into messages. */
async function tcpReceiver(): Promise<{ port: number; messages: string[]; server: Server }> {
  const messages: string[] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const space = buffer.indexOf(0x20);
        if (space < 0) return;
        const length = Number(buffer.subarray(0, space).toString());
        if (buffer.length < space + 1 + length) return;
        messages.push(buffer.subarray(space + 1, space + 1 + length).toString());
        buffer = buffer.subarray(space + 1 + length);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { port: typeof address === 'object' && address ? address.port : 0, messages, server };
}

const record = (seq: number, action: string): AuditView => ({
  seq,
  occurredAt: '2026-10-30T12:00:00.000Z',
  recordedAt: '2026-10-30T12:00:00.000Z',
  actor: null,
  action,
  subject: null,
  details: { note: 'ünïcode and "quotes"' },
  ip: '203.0.113.5',
  sourceEventId: null,
  prevHash: 'a',
  hash: 'b',
});

describe('syslog messages (M1-085)', () => {
  it('[IAM-013] writes RFC 5424 with the record as JSON', () => {
    const message = syslogMessage(record(7, 'user.signed_in'), 'tracker.example.com');
    expect(message).toMatch(
      /^<109>1 2026-10-30T12:00:00\.000Z tracker\.example\.com taskmoor - user\.signed_in - \{/,
    );
    expect(JSON.parse(message.slice(message.indexOf(' - {') + 3))).toMatchObject({
      seq: 7,
      action: 'user.signed_in',
    });
    // Header fields keep to printable ASCII without spaces.
    expect(syslogMessage(record(1, 'a bé'), 'host name')).toContain(' hostname taskmoor - ab - ');
  });

  it('[IAM-013] frames messages by length over TCP, whatever their size', async () => {
    const receiver = await tcpReceiver();
    const big = 'x'.repeat(100_000);
    await sendSyslog({ host: '127.0.0.1', port: receiver.port, transport: 'tcp' }, [
      'first',
      `second with spaces ${big}`,
      'ünïcode',
    ]);
    await expect.poll(() => receiver.messages.length).toBe(3);
    expect(receiver.messages).toEqual(['first', `second with spaces ${big}`, 'ünïcode']);
    receiver.server.close();
  });

  it('[IAM-013] sends one datagram per message over UDP', async () => {
    const got: string[] = [];
    const socket = createSocket('udp4');
    socket.on('message', (m) => got.push(m.toString()));
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    await sendSyslog({ host: '127.0.0.1', port: socket.address().port, transport: 'udp' }, [
      'one',
      'two',
    ]);
    await expect.poll(() => got.length).toBe(2);
    expect(got.sort()).toEqual(['one', 'two']);
    socket.close();
  });

  it('[IAM-013] rejects when nothing listens', async () => {
    const receiver = await tcpReceiver();
    const port = receiver.port;
    await new Promise((r) => receiver.server.close(r));
    await expect(
      sendSyslog({ host: '127.0.0.1', port, transport: 'tcp' }, ['x']),
    ).rejects.toThrow();
  });
});

/**
 * Forwarding through the server (M1-085): a site administrator names a receiver, new audit
 * records reach it in order, a receiver that was down gets what it missed, and the settings
 * are audited.
 */
describe('audit records forwarded to syslog (M1-085)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  let receiver: Awaited<ReturnType<typeof tcpReceiver>>;

  const admin = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      remoteAddress: '203.0.113.1',
      headers: { cookie },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const add = (action: string) =>
    appendAudit(database.db, [{ workspaceId: 1, action, actorId: null, details: {} }]);

  beforeAll(async () => {
    receiver = await tcpReceiver();
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'Admin',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .execute();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
      remoteAddress: '203.0.113.1',
    });
    cookie =
      [res.headers['set-cookie']]
        .flat()
        .find((c) => c?.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
        ?.split(';')[0] ?? '';
  });
  afterAll(async () => {
    receiver.server.close();
    await app?.close();
  });

  it('[IAM-013] sends new audit records to the receiver, in order, and only once', async () => {
    await add('test.before_the_sink');
    const saved = await admin('PUT', '/api/v1/audit/syslog', {
      enabled: true,
      host: '127.0.0.1',
      port: receiver.port,
      transport: 'tcp',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await add('test.one');
    await add('test.two');
    const run = await forwardAudit(database.db, 1, 'tracker.example.com');
    expect(run).toMatchObject({ error: null });
    await expect.poll(() => receiver.messages.length).toBeGreaterThanOrEqual(2);
    const actions = receiver.messages.map((m) => m.split(' ')[5]);
    // The records from before the receiver was named stay in the file export.
    expect(actions).not.toContain('test.before_the_sink');
    expect(actions.indexOf('test.one')).toBeLessThan(actions.indexOf('test.two'));
    const count = receiver.messages.length;
    expect(await forwardAudit(database.db, 1, 'tracker.example.com')).toEqual({
      sent: 0,
      error: null,
    });
    expect(receiver.messages).toHaveLength(count);
  });

  it('[IAM-013] keeps its place while the receiver is down and catches up after', async () => {
    const before = receiver.messages.length;
    await add('test.while_down');
    const failed = await forwardAudit(database.db, 1, 'tracker.example.com', async () => {
      throw new Error('connection refused');
    });
    expect(failed).toEqual({ sent: 0, error: 'connection refused' });
    const status = await admin('GET', '/api/v1/audit/syslog');
    expect(status.json().syslog.lastError).toBe('connection refused');
    await forwardAudit(database.db, 1, 'tracker.example.com');
    await expect.poll(() => receiver.messages.length).toBeGreaterThan(before);
    expect(receiver.messages.slice(before).map((m) => m.split(' ')[5])).toContain(
      'test.while_down',
    );
    expect((await admin('GET', '/api/v1/audit/syslog')).json().syslog.lastError).toBeNull();
  });

  it('[IAM-013] tests a receiver without moving the position, and audits the settings', async () => {
    const before = receiver.messages.length;
    const test = await admin('POST', '/api/v1/audit/syslog/test', {
      host: '127.0.0.1',
      port: receiver.port,
      transport: 'tcp',
    });
    expect(test.json()).toEqual({ ok: true });
    await expect.poll(() => receiver.messages.length).toBe(before + 1);
    expect(receiver.messages.at(-1)).toContain('audit.syslog_test');
    const unreachable = await admin('POST', '/api/v1/audit/syslog/test', {
      host: '127.0.0.1',
      port: 1,
      transport: 'tcp',
    });
    expect(unreachable.statusCode).toBe(502);
    const events = await database.db
      .selectFrom('domain_event')
      .select('type')
      .where('type', '=', 'audit.syslog_updated')
      .execute();
    expect(events.length).toBeGreaterThan(0);
  });
});
