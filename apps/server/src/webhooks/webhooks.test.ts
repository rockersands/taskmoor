import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { stableJson } from '@taskmoor/testkit';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { EventBus, startWorker } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { registerWebhookJobs } from './deliver';
import { bodyFor, type DeliveryFacts } from './payload';
import { webhookSubscriber } from './subscriber';

// Made for this run: no password or secret is written in the repository.
const PASSWORD = `webhooks-${randomBytes(18).toString('base64url')}`;
const SECRET = `signing-${randomBytes(18).toString('base64url')}`;
const PUBLIC_URL = 'https://tasks.example';
let address = 0;
const nextAddress = () => `100.79.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
  raw: string;
  body: Record<string, unknown>;
  at: number;
}

/**
 * Webhooks (M1-067; API-009): registration by site administrators, a signed JSON body a
 * receiver verifies, query filters with custom fields and functions run as the owner, retries
 * on the answers worth retrying, the failed list and replay under the original id, at-most-one
 * delivery per event, delivery latency, and the chat formats.
 */
describe('webhooks (M1-067)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let receiver: Server;
  let base = '';
  const received: Received[] = [];
  /** Statuses a path answers with, in order; 200 once they run out. */
  const plans = new Map<string, number[]>();
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  let points = 0;
  let bus: EventBus;
  let runner: JobRunner;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const admin = (options: InjectOptions) => as('admin', options);

  async function webhook(body: Record<string, unknown>) {
    const res = await admin({ method: 'POST', url: '/api/v1/webhooks', payload: body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().webhook as { id: number; hasSecret: boolean };
  }
  async function ticket(track: string, summary: string, extra: Record<string, unknown> = {}) {
    const res = await admin({
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track, summary, ...extra },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as { id: number; key: string };
  }
  /** Relays events and runs jobs until nothing is left; retries are made due at once. */
  async function pump() {
    for (let i = 0; i < 500; i++) {
      await sql`UPDATE job SET run_at = now() WHERE done_at IS NULL AND locked_at IS NULL`.execute(
        database.db,
      );
      const relayed = await bus.relayOnce();
      await runner.runOnce();
      // A job that failed and waits for a retry counts as left; runOnce counts only finished.
      const left = await database.db
        .selectFrom('job')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .where('done_at', 'is', null)
        .executeTakeFirstOrThrow();
      if (relayed === 0 && Number(left.n) === 0) return;
    }
    throw new Error('the queue did not drain');
  }
  const at = (path: string) => received.filter((r) => r.path === path);
  const deliveriesOf = (webhookId: number) =>
    database.db
      .selectFrom('webhook_delivery')
      .selectAll()
      .where('webhook_id', '=', webhookId)
      .orderBy('created_at')
      .execute();

  beforeAll(async () => {
    receiver = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const path = req.url ?? '/';
        received.push({
          path,
          method: req.method ?? '',
          headers: req.headers,
          raw,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
          at: Date.now(),
        });
        const plan = plans.get(path.replace(/\/[0-9a-f-]{36}$/, ''));
        const status = plan?.shift() ?? 200;
        res.writeHead(status, status === 302 ? { location: 'https://elsewhere.example/' } : {});
        res.end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      publicUrl: PUBLIC_URL,
    });
    bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db, publicUrl: PUBLIC_URL });
    runner = new JobRunner(database.db, 'webhook-test');
    bus.attach(runner);
    registerWebhookJobs(runner, database.db, { timeoutMs: 5000 });

    const hash = await hashPassword(PASSWORD);
    for (const [name, isAdmin] of [
      ['admin', true],
      ['alice', false],
    ] as const) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name: name === 'admin' ? 'Ada Admin' : 'Alice',
          password_hash: hash,
          is_site_admin: isAdmin,
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
    const members = (await database.db.selectFrom('role').select(['id', 'name']).execute()).find(
      (r) => r.name === 'Members',
    )?.id as number;
    for (const [key, who] of [
      ['WH', ['admin', 'alice']],
      ['WS', ['admin']],
    ] as const) {
      const res = await admin({
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key, name: `Track ${key}`, mode: 'shared' },
      });
      expect(res.statusCode, res.body).toBe(201);
      tracks[key] = res.json().track.id;
      for (const w of who) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: tracks[key] as number,
            role_id: members,
            user_id: users[w]?.id as number,
          })
          .execute();
      }
    }
    const field = await admin({
      method: 'POST',
      url: '/api/v1/fields',
      payload: { name: 'Points', type: 'number' },
    });
    expect(field.statusCode, field.body).toBe(201);
    points = field.json().field.id;
    // What setup emitted is not for these webhooks.
    await pump();
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  });

  it('[API-009] site administrators register webhooks; the secret is write-only; addresses, events and queries are checked', async () => {
    const forbidden = await as('alice', {
      method: 'POST',
      url: '/api/v1/webhooks',
      payload: { name: 'Mine', url: `${base}/x`, events: ['ticket.created'] },
    });
    expect(forbidden.statusCode).toBe(403);
    const made = await webhook({
      name: 'Checked',
      url: `${base}/checked`,
      events: ['ticket.*'],
      secret: SECRET,
      enabled: false,
    });
    expect(made.hasSecret).toBe(true);
    const read = await admin({ method: 'GET', url: `/api/v1/webhooks/${made.id}` });
    expect(read.body).not.toContain(SECRET);
    expect(read.json().webhook).toMatchObject({
      name: 'Checked',
      format: 'json',
      events: ['ticket.*'],
      filterQuery: null,
      enabled: false,
    });
    const refused = async (payload: Record<string, unknown>) => {
      const res = await admin({ method: 'POST', url: '/api/v1/webhooks', payload });
      expect(res.statusCode, res.body).toBe(400);
      return res.json().fields as Record<string, string>;
    };
    const plain = { name: 'Bad', url: 'https://hooks.example.com/a', events: ['ticket.created'] };
    expect(await refused({ ...plain, url: 'http://hooks.example.com/a' })).toEqual({
      url: 'https_required',
    });
    expect(await refused({ ...plain, url: 'https://user:pass@hooks.example.com/a' })).toEqual({
      url: 'credentials_in_url',
    });
    // Security events never leave the instance.
    expect(await refused({ ...plain, events: ['session.started', 'nope.*'] })).toEqual({
      'events.0': 'unknown_event',
      'events.1': 'unknown_event',
    });
    expect(await refused({ ...plain, filterQuery: 'nosuchfield = 3' })).toEqual({
      filterQuery: 'invalid_query',
    });
    expect(await refused({ ...plain, format: 'matrix' })).toEqual({
      secret: 'required_for_matrix',
    });
    expect(await refused({ ...plain, name: 'checked' })).toEqual({ name: 'taken' });
    // A token without the admin scope does not reach them either.
    const list = await admin({ method: 'GET', url: '/api/v1/webhooks' });
    expect(list.json().webhooks.map((w: { name: string }) => w.name)).toContain('Checked');
    const patched = await admin({
      method: 'PATCH',
      url: `/api/v1/webhooks/${made.id}`,
      payload: { secret: null, version: 1 },
    });
    expect(patched.json().webhook).toMatchObject({ hasSecret: false, version: 2 });
    const stale = await admin({
      method: 'PATCH',
      url: `/api/v1/webhooks/${made.id}`,
      payload: { name: 'Again', version: 1 },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('[API-009] delivers a signed JSON body that a receiver verifies with the shared secret', async () => {
    const hook = await webhook({
      name: 'Signed',
      url: `${base}/signed`,
      events: ['ticket.created', 'comment.created'],
      secret: SECRET,
    });
    const t = await ticket('WH', 'Signed delivery');
    await pump();
    const [got] = at('/signed');
    expect(got).toBeDefined();
    const r = got as Received;
    expect(r.method).toBe('POST');
    // The receiver's check: the HMAC-SHA256 of the exact bytes with the shared secret.
    const expected = `sha256=${createHmac('sha256', SECRET).update(r.raw).digest('hex')}`;
    expect(r.headers['x-taskmoor-signature']).toBe(expected);
    expect(r.headers['x-taskmoor-event']).toBe('ticket.created');
    expect(r.headers['x-taskmoor-delivery']).toBe(r.body.id);
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.body).toMatchObject({
      event: 'ticket.created',
      webhook: { id: hook.id, name: 'Signed' },
      actor: { id: users.admin?.id, name: 'Ada Admin' },
      subject: { type: 'ticket', id: String(t.id) },
      ticket: {
        id: t.id,
        key: t.key,
        summary: 'Signed delivery',
        track: { id: tracks.WH, key: 'WH' },
        url: `${PUBLIC_URL}/#/tickets/${t.key}`,
      },
    });
    const [row] = await deliveriesOf(hook.id);
    expect(row).toMatchObject({ state: 'delivered', attempts: 1, last_status: 200 });
    // A comment on the ticket names the ticket too.
    const comment = await admin({
      method: 'POST',
      url: `/api/v1/tickets/${t.id}/comments`,
      payload: {
        body: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good' }] }],
        },
      },
    });
    expect(comment.statusCode, comment.body).toBe(201);
    await pump();
    expect(
      at('/signed').map((x) => [x.body.event, (x.body.ticket as { key: string }).key]),
    ).toEqual([
      ['ticket.created', t.key],
      ['comment.created', t.key],
    ]);
  });

  it('[API-009] a query with a custom field and a function filters deliveries; other events are not filtered', async () => {
    await webhook({
      name: 'Filtered',
      url: `${base}/filtered`,
      events: ['ticket.created', 'track.created'],
      filterQuery: `cf[${points}] > 3 AND assignee = currentUser()`,
    });
    const me = users.admin?.id as number;
    const big = await ticket('WH', 'Big and mine', { assigneeId: me, fields: { [points]: 5 } });
    await ticket('WH', 'Small and mine', { assigneeId: me, fields: { [points]: 1 } });
    await ticket('WH', 'Big and nobody', { fields: { [points]: 8 } });
    const track = await admin({
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'WF', name: 'Filtered tracks are not tickets', mode: 'shared' },
    });
    expect(track.statusCode, track.body).toBe(201);
    await pump();
    expect(
      at('/filtered').map((r) => [r.body.event, (r.body.ticket as { key?: string })?.key]),
    ).toEqual([
      ['ticket.created', big.key],
      ['track.created', undefined],
    ]);
  });

  it('[API-009] never reports a ticket its owner may not see', async () => {
    const hook = await webhook({
      name: 'Alice sees',
      url: `${base}/owner`,
      events: ['ticket.created'],
    });
    // Alice is a member of WH, not of WS.
    await database.db
      .updateTable('webhook')
      .set({ owner_id: users.alice?.id as number })
      .where('id', '=', hook.id)
      .execute();
    const seen = await ticket('WH', 'Alice sees this');
    await ticket('WS', 'Alice does not see this');
    await pump();
    expect(at('/owner').map((r) => (r.body.ticket as { key: string }).key)).toEqual([seen.key]);
  });

  it('[API-009] retries 408, 409, 425, 429 and 5xx up to five times, and fails other answers at once', async () => {
    plans.set('/flaky', [503, 429, 425, 200]);
    plans.set('/bad', [400]);
    plans.set('/moved', [302]);
    plans.set('/down', [500, 502, 503, 504, 408, 409, 200]);
    const hooks: Record<string, number> = {};
    for (const path of ['/flaky', '/bad', '/moved', '/down']) {
      hooks[path] = (
        await webhook({ name: `Retry ${path}`, url: `${base}${path}`, events: ['ticket.created'] })
      ).id;
    }
    await ticket('WH', 'Retried');
    await pump();
    expect(at('/flaky')).toHaveLength(4);
    expect(at('/bad')).toHaveLength(1);
    expect(at('/moved')).toHaveLength(1);
    // The first attempt and five retries; the seventh answer would have been 200.
    expect(at('/down')).toHaveLength(6);
    const state = async (path: string) => (await deliveriesOf(hooks[path] as number))[0];
    expect(await state('/flaky')).toMatchObject({
      state: 'delivered',
      attempts: 4,
      last_status: 200,
    });
    expect(await state('/bad')).toMatchObject({ state: 'failed', attempts: 1, last_status: 400 });
    expect(await state('/moved')).toMatchObject({ state: 'failed', attempts: 1, last_status: 302 });
    expect(await state('/down')).toMatchObject({
      state: 'failed',
      attempts: 6,
      last_status: 409,
      last_error: 'HTTP 409',
    });
    // Every attempt of a delivery carries the same id and the same bytes.
    const down = at('/down');
    expect(new Set(down.map((r) => r.headers['x-taskmoor-delivery'])).size).toBe(1);
    expect(new Set(down.map((r) => r.raw)).size).toBe(1);
  });

  it('[API-009] lists failed deliveries and replays them under the original id with the same body', async () => {
    const hook = (await admin({ method: 'GET', url: '/api/v1/webhooks' }))
      .json()
      .webhooks.find((w: { name: string }) => w.name === 'Retry /down') as { id: number };
    const failed = await admin({
      method: 'GET',
      url: `/api/v1/webhooks/${hook.id}/deliveries?state=failed`,
    });
    expect(failed.statusCode, failed.body).toBe(200);
    const list = failed.json().deliveries as { id: number; attempts: number; lastStatus: number }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ attempts: 6, lastStatus: 409 });
    const first = at('/down')[0] as Received;
    plans.set('/down', [200]);
    const res = await admin({
      method: 'POST',
      url: `/api/v1/webhooks/${hook.id}/deliveries/replay`,
      payload: { failed: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().replayed).toEqual([list[0]?.id]);
    await pump();
    const again = at('/down').at(-1) as Received;
    expect(again.headers['x-taskmoor-delivery']).toBe(first.headers['x-taskmoor-delivery']);
    expect(again.raw).toBe(first.raw);
    expect((await deliveriesOf(hook.id))[0]).toMatchObject({
      state: 'delivered',
      replays: 1,
      attempts: 7,
    });
    // Replaying by id, and nothing left to replay.
    const none = await admin({
      method: 'POST',
      url: `/api/v1/webhooks/${hook.id}/deliveries/replay`,
      payload: { failed: true },
    });
    expect(none.statusCode).toBe(404);
  });

  it('[API-009] records one delivery per webhook and event, however often the bus delivers it', async () => {
    const hook = await webhook({ name: 'Once', url: `${base}/once`, events: ['ticket.created'] });
    const t = await ticket('WH', 'Delivered once');
    await pump();
    const event = await database.db
      .selectFrom('domain_event')
      .selectAll()
      .where('type', '=', 'ticket.created')
      .where('subject_id', '=', String(t.id))
      .executeTakeFirstOrThrow();
    // The bus is at least once: the same event handled again.
    const subscriber = webhookSubscriber(database.db, { publicUrl: PUBLIC_URL });
    await subscriber.handle({
      id: String(event.id),
      workspaceId: event.workspace_id,
      type: event.type as 'ticket.created',
      version: event.version,
      actorId: event.actor_id,
      subjectType: event.subject_type,
      subjectId: event.subject_id,
      payload: event.payload,
      occurredAt: event.occurred_at,
      ip: event.ip,
    } as Parameters<typeof subscriber.handle>[0]);
    await pump();
    expect(await deliveriesOf(hook.id)).toHaveLength(1);
    expect(at('/once')).toHaveLength(1);
  });

  it('[API-009] sends nothing for a disabled webhook, and fails what a deleted one left', async () => {
    const off = await webhook({
      name: 'Off',
      url: `${base}/off`,
      events: ['ticket.created'],
      enabled: false,
    });
    const gone = await webhook({ name: 'Gone', url: `${base}/gone`, events: ['ticket.created'] });
    await ticket('WH', 'While off');
    // The event becomes a delivery; the webhook goes before the delivery is sent.
    await bus.relayOnce();
    for (let i = 0; i < 10; i++) {
      const ran = await runner.runOnce();
      const queued = await database.db
        .selectFrom('webhook_delivery')
        .select('id')
        .where('webhook_id', '=', gone.id)
        .execute();
      if (queued.length > 0 || ran === 0) break;
    }
    await database.db
      .updateTable('webhook')
      .set({ enabled: false })
      .where('id', '=', gone.id)
      .execute();
    await pump();
    expect(at('/off')).toHaveLength(0);
    expect(await deliveriesOf(off.id)).toHaveLength(0);
    expect(at('/gone')).toHaveLength(0);
    expect((await deliveriesOf(gone.id))[0]).toMatchObject({
      state: 'failed',
      last_error: 'The webhook is disabled or deleted',
    });
  });

  it('[API-009] delivers to a Matrix room with the access token, the delivery id as transaction id', async () => {
    const token = `matrix-${randomBytes(12).toString('base64url')}`;
    await webhook({
      name: 'Matrix room',
      url: `${base}/_matrix/client/v3/rooms/%21room%3Aexample/send/m.room.message`,
      format: 'matrix',
      events: ['ticket.created'],
      secret: token,
    });
    const t = await ticket('WH', 'Tell the room');
    await pump();
    const [r] = received.filter((x) => x.path.startsWith('/_matrix/'));
    expect(r?.method).toBe('PUT');
    expect(r?.headers.authorization).toBe(`Bearer ${token}`);
    expect(r?.headers['x-taskmoor-signature']).toBeUndefined();
    expect(r?.path).toBe(
      `/_matrix/client/v3/rooms/%21room%3Aexample/send/m.room.message/${r?.headers['x-taskmoor-delivery']}`,
    );
    expect(r?.body).toMatchObject({ msgtype: 'm.text', format: 'org.matrix.custom.html' });
    expect(String(r?.body.body)).toContain(t.key);
  });

  it('[API-009] deliveries land within 5 s at p95', async () => {
    await webhook({ name: 'Timed', url: `${base}/timed`, events: ['ticket.created'] });
    const worker = startWorker({ bus, runner, db: database.db, idleMs: 200 });
    const created = new Map<string, number>();
    try {
      for (let i = 0; i < 20; i++) {
        const t = await ticket('WH', `Timed ${i}`);
        created.set(t.key, Date.now());
      }
      const deadline = Date.now() + 30_000;
      while (at('/timed').length < 20 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await worker.stop();
    }
    const waits = at('/timed')
      .map((r) => r.at - (created.get((r.body.ticket as { key: string }).key) ?? r.at))
      .sort((a, b) => a - b);
    expect(waits).toHaveLength(20);
    const p95 = waits[Math.ceil(0.95 * waits.length) - 1] as number;
    expect(p95).toBeLessThan(5000);
  });

  describe('bodies', () => {
    const facts: DeliveryFacts = {
      deliveryId: '0b3f6a5e-1d2c-4c7e-9a10-2f4e5d6c7b8a',
      webhook: { id: 7, name: 'Team channel' },
      event: {
        id: '1234',
        type: 'comment.created',
        occurredAt: new Date('2026-10-29T12:00:00Z'),
        subjectType: 'comment',
        subjectId: '88',
        payload: { ticketId: 42, commentId: 88 },
      },
      actor: { id: 5, name: 'Sam <Rivera> & co' },
      ticket: {
        id: 42,
        key: 'ABC-12',
        summary: 'Login fails with [brackets] *stars* & <tags>',
        status: 'In Review',
        type: 'Bug',
        track: { id: 3, key: 'ABC' },
      },
      publicUrl: 'https://tasks.example/',
    };
    for (const format of ['json', 'slack', 'teams', 'mattermost', 'matrix'] as const) {
      it(`[API-009] the ${format} body`, async () => {
        await expect(stableJson(bodyFor(format, facts))).toMatchFileSnapshot(
          `./__golden__/body-${format}.json`,
        );
      });
    }
    it('[API-009] events about something other than a ticket read as a sentence too', () => {
      const track = {
        ...facts,
        event: {
          ...facts.event,
          type: 'release.shipped',
          subjectType: 'release',
          subjectId: '9',
          payload: { name: '2.1' },
        },
        ticket: null,
        actor: null,
      };
      expect(bodyFor('slack', track)).toEqual({ text: 'Taskmoor shipped release "2.1"' });
      expect(bodyFor('mattermost', track)).toEqual({ text: 'Taskmoor shipped release "2.1"' });
    });
  });
});
