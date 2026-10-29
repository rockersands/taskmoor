import type { AddressInfo } from 'node:net';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { EventBus } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { deliverEmail, inQuietHours, type MailerOptions } from './deliver';
import { smtpTransport } from './transport';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.77.${Math.floor(++address / 250)}.${(address % 250) + 1}`;
const MINUTE = 60 * 1000;

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (
      list.find(
        (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
      ) ?? ''
    ).split(';')[0] ?? ''
  );
}

interface Received {
  to: string;
  /** The message as sent, quoted-printable decoded. */
  raw: string;
  header: (name: string) => string;
}

const PEOPLE = ['admin', 'alice', 'bob', 'carol', 'dan'] as const;
type Person = (typeof PEOPLE)[number];

/**
 * Email notifications (M1-057; NTF-002, NTF-004) end to end: changes become notifications
 * (M1-056), the mailer sends them through a real SMTP conversation to a test server, batching
 * one ticket's changes, sending digests, holding quiet hours, rechecking visibility and
 * honouring one-click unsubscribe links.
 */
describe('email notifications (M1-057)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let smtp: SMTPServer;
  let mailer: MailerOptions;
  const inbox: Received[] = [];
  const users = {} as Record<Person, { id: number; cookie: string }>;
  let trackId = 0;

  const as = (who: Person | null, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: who ? users[who].cookie : '' },
    });
  async function deliverEvents(): Promise<void> {
    const bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    const runner = new JobRunner(database.db, 'email-test');
    bus.attach(runner);
    while ((await bus.relayOnce()) > 0) {}
    while ((await runner.runOnce()) > 0) {}
  }
  const authorizer = () => new Authorizer(database.db);
  const mail = (now: Date) => deliverEmail(database.db, authorizer(), { ...mailer, now });
  const later = (minutes: number) => new Date(Date.now() + minutes * MINUTE);
  /** Noon UTC tomorrow: after anything written now, and outside everyone's quiet hours. */
  const tomorrowNoon = () => {
    const at = new Date();
    at.setUTCDate(at.getUTCDate() + 1);
    at.setUTCHours(12, 0, 0, 0);
    return at;
  };
  const to = (who: Person) => inbox.filter((m) => m.to === `${who}@example.com`);
  const create = async (summary: string, extra: Record<string, unknown> = {}) => {
    const res = await as('alice', {
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track: 'MAIL', summary, ...extra },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as { id: number; key: string };
  };
  const follow = async (who: Person, key: string) => {
    const res = await as(who, { method: 'PUT', url: `/api/v1/tickets/${key}/followers/me` });
    expect(res.statusCode).toBeLessThan(300);
  };
  const edit = (key: string, summary: string) =>
    as('alice', { method: 'PATCH', url: `/api/v1/tickets/${key}`, payload: { summary } });

  beforeAll(async () => {
    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      logger: false,
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          const message = chunks.join('');
          const end = message.search(/\r?\n\r?\n/);
          const headers = end < 0 ? message : message.slice(0, end);
          // Only the body is quoted-printable: a header keeps its `=` (an unsubscribe token
          // may begin with two hex digits, which decoding would turn into one character).
          const body = (end < 0 ? '' : message.slice(end))
            .replace(/=\r?\n/g, '')
            .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
          const raw = headers + body;
          const head = headers.replace(/\r?\n[ \t]+/g, ' ');
          inbox.push({
            to: session.envelope.rcptTo[0]?.address ?? '',
            raw,
            header: (name) =>
              head
                .split(/\r?\n/)
                .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
                ?.slice(name.length + 1)
                .trim() ?? '',
          });
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
    const port = (smtp.server.address() as AddressInfo).port;
    mailer = {
      transport: smtpTransport({
        url: `smtp://127.0.0.1:${port}`,
        user: undefined,
        password: undefined,
        from: 'Taskmoor <taskmoor@example.com>',
      }),
      from: 'Taskmoor <taskmoor@example.com>',
      publicUrl: 'https://tracker.example.com',
    };

    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      smtpConfigured: true,
    });
    const hash = await hashPassword(PASSWORD);
    for (const name of PEOPLE) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: name === 'admin',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      users[name] = { id: row.id, cookie: sessionCookie(res.headers['set-cookie']) };
    }
    const track = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'MAIL', name: 'Mail', mode: 'shared' },
    });
    trackId = track.json().track.id;
    const members = (
      await database.db
        .selectFrom('role')
        .select('id')
        .where('name', '=', 'Members')
        .executeTakeFirstOrThrow()
    ).id;
    for (const who of ['alice', 'bob', 'carol', 'dan'] as const) {
      await database.db
        .insertInto('track_role_actor')
        .values({ workspace_id: 1, track_id: trackId, role_id: members, user_id: users[who].id })
        .execute();
    }
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
  });

  it('[NTF-002] five edits within the window make one email listing all five, with its links', async () => {
    const ticket = await create('Checkout fails');
    await follow('bob', ticket.key);
    await deliverEvents();
    await mail(later(3));
    const before = to('bob').length;
    for (let i = 1; i <= 5; i++) {
      expect((await edit(ticket.key, `Checkout fails, take ${i}`)).statusCode).toBe(200);
    }
    await deliverEvents();
    // Inside the two-minute window nothing goes out yet.
    expect((await mail(new Date())).sent).toBe(0);
    expect(to('bob')).toHaveLength(before);
    const run = await mail(later(3));
    expect(run.sent).toBe(1);
    const sent = to('bob').slice(before);
    expect(sent).toHaveLength(1);
    const email = sent[0] as Received;
    expect(email.header('subject')).toBe(`[${ticket.key}] Checkout fails, take 5 (5 changes)`);
    const record = await database.db
      .selectFrom('email_delivery')
      .selectAll()
      .where('user_id', '=', users.bob.id)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(record).toMatchObject({ kind: 'instant', notification_count: 5, error: null });
    // Links to the ticket and the settings, and a one-click unsubscribe (RFC 8058).
    expect(email.raw).toContain(`https://tracker.example.com/#/tickets/${ticket.key}`);
    expect(email.raw).toContain('https://tracker.example.com/#/account/notifications');
    expect(email.header('list-unsubscribe-post')).toBe('List-Unsubscribe=One-Click');
    expect(email.header('list-unsubscribe')).toMatch(
      /^<https:\/\/tracker\.example\.com\/api\/v1\/unsubscribe\?token=[\w-]+>$/,
    );
    // Sending again sends nothing twice.
    expect((await mail(later(10))).sent).toBe(0);
  });

  it('[NTF-004] twenty updates make one daily digest, sent once a day at the digest hour', async () => {
    await as('carol', {
      method: 'PATCH',
      url: '/api/v1/account/notification-preferences',
      payload: { emailDelivery: 'daily' },
    });
    const tickets = [];
    for (let i = 1; i <= 4; i++) tickets.push(await create(`Digest ${i}`));
    // Created before Carol follows: only the updates are hers.
    await deliverEvents();
    for (const ticket of tickets) await follow('carol', ticket.key);
    for (const ticket of tickets) {
      for (let i = 1; i <= 5; i++) await edit(ticket.key, `${ticket.key} edit ${i}`);
    }
    await deliverEvents();
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 1);
    day.setUTCHours(6, 0, 0, 0);
    // Before the digest hour (08:00 in Carol's zone, UTC here), nothing goes to her.
    await mail(day);
    expect(to('carol')).toHaveLength(0);
    day.setUTCHours(8, 30);
    await mail(day);
    expect(to('carol')).toHaveLength(1);
    expect(to('carol')[0]?.header('subject')).toBe(
      'Your daily Taskmoor digest: 20 updates on 4 tickets',
    );
    // Later that day another change waits for tomorrow's digest.
    await edit(tickets[0]?.key as string, 'One more');
    await deliverEvents();
    day.setUTCHours(20);
    await mail(day);
    expect(to('carol')).toHaveLength(1);
  });

  it('[NTF-004] quiet hours hold email until they end', async () => {
    await as('dan', {
      method: 'PATCH',
      url: '/api/v1/account/notification-preferences',
      payload: { quietHours: { start: 22, end: 7 } },
    });
    expect(inQuietHours(23, 22, 7)).toBe(true);
    expect(inQuietHours(7, 22, 7)).toBe(false);
    const ticket = await create('Overnight');
    await follow('dan', ticket.key);
    await edit(ticket.key, 'Overnight change');
    await deliverEvents();
    const night = new Date();
    night.setUTCDate(night.getUTCDate() + 1);
    night.setUTCHours(23, 0, 0, 0);
    await mail(night);
    expect(to('dan')).toHaveLength(0);
    night.setUTCHours(night.getUTCHours() + 8);
    await mail(night);
    expect(to('dan')).toHaveLength(1);
  });

  it('[NTF-002] a one-click unsubscribe turns that email off; another link turns all email off', async () => {
    const ticket = await create('Unsubscribe me');
    await follow('bob', ticket.key);
    await deliverEvents();
    await mail(later(3));
    await edit(ticket.key, 'Unsubscribe me now');
    await deliverEvents();
    await mail(later(6));
    const last = to('bob').at(-1) as Received;
    const oneClick = /<(https:[^>]+)>/.exec(last.header('list-unsubscribe'))?.[1] as string;
    const token = new URL(oneClick).searchParams.get('token') as string;
    const shown = await as(null, { method: 'GET', url: `/api/v1/unsubscribe?token=${token}` });
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json().unsubscribe).toEqual({
      event: 'ticket_updated',
      email: 'b…@example.com',
      used: false,
    });
    // The mail client's one-click POST, with no session.
    const done = await as(null, {
      method: 'POST',
      url: `/api/v1/unsubscribe?token=${token}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(done.statusCode, done.body).toBe(200);
    const prefs = await as('bob', {
      method: 'GET',
      url: '/api/v1/account/notification-preferences',
    });
    expect(prefs.json().preferences.events.ticket_updated).toEqual({ email: false, inbox: true });
    const count = to('bob').length;
    await edit(ticket.key, 'Bob no longer gets email for updates');
    await deliverEvents();
    await mail(later(9));
    expect(to('bob')).toHaveLength(count);
    // Inbox notifications still come.
    const inboxRows = await database.db
      .selectFrom('notification')
      .select('id')
      .where('user_id', '=', users.bob.id)
      .where('channel', '=', 'inbox')
      .where('ticket_id', '=', ticket.id)
      .execute();
    expect(inboxRows.length).toBeGreaterThan(0);
    expect(
      (await as(null, { method: 'GET', url: '/api/v1/unsubscribe?token=not-a-real-token-at-all' }))
        .statusCode,
    ).toBe(404);
  });

  it('[NTF-001] a ticket hidden from the recipient before sending is not emailed', async () => {
    const policy = await as('admin', {
      method: 'POST',
      url: '/api/v1/visibility-policies',
      payload: {
        name: 'Alice only',
        levels: [{ name: 'Private', members: [{ grantee: 'user', userId: users.alice.id }] }],
      },
    });
    const level = policy.json().visibilityPolicy.levels[0].id;
    const used = await as('admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${trackId}`,
      payload: { visibilityPolicyId: policy.json().visibilityPolicy.id },
    });
    expect(used.statusCode, used.body).toBe(200);
    const ticket = await create('Soon private');
    await follow('dan', ticket.key);
    await edit(ticket.key, 'Soon private: edited');
    await deliverEvents();
    // The level is set after the notification was written but before the email goes out.
    const hidden = await as('alice', {
      method: 'PATCH',
      url: `/api/v1/tickets/${ticket.key}`,
      payload: { visibilityLevelId: level },
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
    const count = to('dan').length;
    // Dan keeps the quiet hours of an earlier test: send when they cannot hold the email.
    const run = await mail(tomorrowNoon());
    expect(to('dan')).toHaveLength(count);
    expect(run.dropped).toBeGreaterThan(0);
  });

  it('[NTF-002] a failed send is recorded and retried; there is no daily cap', async () => {
    const failing: MailerOptions = {
      ...mailer,
      transport: { send: () => Promise.reject(new Error('SMTP 451 try again later')) },
    };
    const ticket = await create('Retry me');
    await follow('bob', ticket.key);
    await deliverEvents();
    const failed = await deliverEmail(database.db, authorizer(), { ...failing, now: later(60) });
    expect(failed.failed).toBeGreaterThan(0);
    const error = await database.db
      .selectFrom('email_delivery')
      .select('error')
      .where('user_id', '=', users.bob.id)
      .where('error', 'is not', null)
      .executeTakeFirstOrThrow();
    expect(error.error).toContain('451');
    const count = to('bob').length;
    await mail(later(61));
    expect(to('bob').length).toBe(count + 1);

    // No cap: 300 tickets' notifications for one person go out in one run, one email each. A
    // person of their own, so what earlier tests left waiting for others is not counted.
    const reader = await database.db
      .insertInto('app_user')
      .values({ workspace_id: 1, email: 'reader@example.com', name: 'Reader' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const member = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('track_role_actor')
      .values({ workspace_id: 1, track_id: trackId, role_id: member.id, user_id: reader.id })
      .execute();
    const track = await database.db
      .selectFrom('ticket')
      .select(['track_id', 'ticket_type_id'])
      .where('id', '=', ticket.id)
      .executeTakeFirstOrThrow();
    const { rows } = await sql<{ id: number }>`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, rank,
                          requester_id, creator_id)
      SELECT 1, ${track.track_id}, 10000 + g, ${track.ticket_type_id}, 'Bulk ' || g,
             'zz' || lpad(g::text, 6, '0'), ${users.alice.id}, ${users.alice.id}
        FROM generate_series(1, 300) g
      RETURNING id`.execute(database.db);
    await database.db
      .insertInto('notification')
      .values(
        rows.map((r, i) => ({
          workspace_id: 1,
          user_id: reader.id,
          channel: 'email' as const,
          event: 'ticket_updated',
          ticket_id: r.id,
          domain_event_id: String(9_000_000 + i),
          payload: JSON.stringify({ key: 'X', summary: 'x', type: 'ticket.updated' }),
        })),
      )
      .execute();
    let sent = 0;
    const counting: MailerOptions = {
      ...mailer,
      transport: {
        send: async (email) => {
          if (email.to === 'reader@example.com') sent++;
          return { messageId: null };
        },
      },
    };
    const run = await deliverEmail(database.db, authorizer(), { ...counting, now: later(120) });
    expect(run.sent).toBeGreaterThanOrEqual(300);
    expect(sent).toBe(300);
  });
});
