import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { expectWithinBudget } from '@taskmoor/testkit/budget';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.78.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

/**
 * The next message of a socket, parsed; inbox messages (M1-058), which the same socket carries,
 * are passed over.
 */
function nextMessage(socket: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('no message'));
    }, timeoutMs);
    function onMessage(data: unknown) {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (message.type === 'inbox') return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    }
    socket.on('message', onMessage);
  });
}

/**
 * The outbox's side of the server (M1-032; ADR-013): a mutation sent twice with the same client
 * and mutation id runs once, and the realtime socket says when the change log moves.
 */
describe('mutations at most once and the realtime socket (M1-032)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  let key = '';

  const call = (options: InjectOptions, ids?: [string, string]) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: {
        ...(options.headers ?? {}),
        cookie,
        ...(ids ? { 'taskmoor-client-id': ids[0], 'taskmoor-mutation-id': ids[1] } : {}),
      },
    });

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api', 'realtime'] });
    await app.ready();
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'outbox@example.com',
        name: 'Outbox',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .execute();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'outbox@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    cookie = sessionCookie(res.headers['set-cookie']);
    await call({
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'OUT', name: 'Outbox', mode: 'shared' },
    });
    const ticket = await call({
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track: 'OUT', summary: 'Offline edits' },
    });
    key = ticket.json().ticket.key;
  });
  afterAll(async () => {
    await app.close();
  });

  it('[NTF-008] a mutation sent twice runs once; the second gets the first answer', async () => {
    const edit = {
      method: 'PATCH' as const,
      url: `/api/v1/tickets/${key}`,
      payload: { summary: 'Renamed offline' },
    };
    const first = await call(edit, ['client-a', 'm-1']);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['taskmoor-position']).toMatch(/^\d+$/);
    const again = await call(edit, ['client-a', 'm-1']);
    expect(again.statusCode).toBe(200);
    expect(again.headers['taskmoor-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    // Once: one version step and one history entry for the summary.
    const view = await call({ method: 'GET', url: `/api/v1/tickets/${key}` });
    expect(view.json().ticket.version).toBe(first.json().ticket.version);
    const history = await call({ method: 'GET', url: `/api/v1/tickets/${key}/history` });
    expect(
      (history.json().changes as { field: string }[]).filter((c) => c.field === 'summary'),
    ).toHaveLength(2);
    // Another client may use the same mutation id.
    const other = await call({ ...edit, payload: { summary: 'Renamed by another device' } }, [
      'client-b',
      'm-1',
    ]);
    expect(other.headers['taskmoor-replayed']).toBeUndefined();
  });

  it('[NTF-008] refuses a reused id, an unfinished twin and malformed ids; refusals replay too', async () => {
    await call({ method: 'PATCH', url: `/api/v1/tickets/${key}`, payload: { summary: 'x' } }, [
      'client-c',
      'm-7',
    ]);
    const reused = await call({ method: 'DELETE', url: `/api/v1/tickets/${key}` }, [
      'client-c',
      'm-7',
    ]);
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toEqual({ error: 'mutation_id_reused' });
    const user = await database.db
      .selectFrom('app_user')
      .select('id')
      .where('email', '=', 'outbox@example.com')
      .executeTakeFirstOrThrow();
    for (const [id, age, error] of [
      ['m-run', 0, 'mutation_in_progress'],
      ['m-lost', 10 * 60 * 1000, 'mutation_outcome_unknown'],
    ] as const) {
      await database.db
        .insertInto('mutation_receipt')
        .values({
          workspace_id: 1,
          user_id: user.id,
          client_id: 'client-c',
          mutation_id: id,
          method: 'PATCH',
          path: `/api/v1/tickets/${key}`,
          status: 'pending',
          created_at: new Date(Date.now() - age),
        })
        .execute();
      const twin = await call(
        { method: 'PATCH', url: `/api/v1/tickets/${key}`, payload: { summary: 'y' } },
        ['client-c', id],
      );
      expect(twin.statusCode).toBe(409);
      expect(twin.json()).toEqual({ error });
    }
    const bad = await call(
      { method: 'PATCH', url: `/api/v1/tickets/${key}`, payload: { summary: 'z' } },
      ['client c!', 'm-1'],
    );
    expect(bad.statusCode).toBe(400);
    // A refusal is an answer too: sent again, it is replayed, not run again.
    const refused = await call(
      { method: 'PATCH', url: `/api/v1/tickets/${key}`, payload: { summary: '' } },
      ['client-c', 'm-8'],
    );
    expect(refused.statusCode).toBe(400);
    const refusedAgain = await call(
      { method: 'PATCH', url: `/api/v1/tickets/${key}`, payload: { summary: '' } },
      ['client-c', 'm-8'],
    );
    expect(refusedAgain.statusCode).toBe(400);
    expect(refusedAgain.headers['taskmoor-replayed']).toBe('true');
  });

  it('[NTF-008] the socket says where the log stands and pushes a change within a second', async () => {
    const socket = await app.injectWS('/api/v1/sync/socket', { headers: { cookie } });
    const first = await nextMessage(socket);
    expect(first).toMatchObject({ type: 'position' });
    const started = Date.now();
    const pushed = nextMessage(socket);
    await call({ method: 'PATCH', url: `/api/v1/tickets/${key}`, payload: { summary: 'Pushed' } });
    const moved = await pushed;
    expectWithinBudget(Date.now() - started, 1000, 'sync position push (ms)');
    expect(BigInt(moved.position as string) > BigInt(first.position as string)).toBe(true);
    socket.send('ping');
    expect(await nextMessage(socket)).toEqual({ type: 'pong' });
    socket.terminate();
  });

  it('[NTF-008] closes a socket without a session or from another site', async () => {
    const closed = (socket: WebSocket) =>
      new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    const anonymous = await app.injectWS('/api/v1/sync/socket', { headers: {} });
    expect(await closed(anonymous)).toBe(4401);
    const foreign = await app.injectWS('/api/v1/sync/socket', {
      headers: { cookie, origin: 'https://evil.example', host: 'localhost:80' },
    });
    expect(await closed(foreign)).toBe(4401);
  });
});
