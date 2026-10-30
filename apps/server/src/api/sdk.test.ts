import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `sdk-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.95.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

import { createClient, TaskmoorError } from '@taskmoor/sdk';
import type { FastifyInstance } from 'fastify';

/**
 * The generated SDK against a real server (M1-065; API-001 (2)): with an API token, typed
 * calls make, change, read and list tickets, `pages` reads a paged list to its end, and a
 * refusal arrives as `TaskmoorError` with the server's code.
 */
describe('the TypeScript SDK (M1-065)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let baseUrl = '';
  let token = '';

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'Ada Admin',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .execute();
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    const cookie = sessionCookie(signIn.headers['set-cookie']);
    const issued = await app.inject({
      method: 'POST',
      url: '/api/v1/account/tokens',
      headers: { cookie },
      payload: { name: 'SDK test', scopes: ['read', 'write'], expiresInDays: 7 },
      remoteAddress: nextAddress(),
    });
    expect(issued.statusCode, issued.body).toBe(201);
    token = issued.json().token;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tracks',
      headers: { cookie },
      payload: { key: 'SDK', name: 'Sdk', mode: 'shared' },
      remoteAddress: nextAddress(),
    });
    expect(created.statusCode, created.body).toBe(201);
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('[API-001] makes, changes, reads and lists tickets with typed calls', async () => {
    const taskmoor = createClient({ baseUrl, token });
    const { user } = await taskmoor.call('getSession');
    expect(user.email).toBe('admin@example.com');
    const { ticket } = await taskmoor.call('createTicket', {
      body: { track: 'SDK', summary: 'From the SDK' },
    });
    expect(ticket.key).toBe('SDK-1');
    await taskmoor.call('createTicket', { body: { track: 'SDK', summary: 'Another' } });
    const changed = await taskmoor.call('updateTicket', {
      path: { id: ticket.key },
      body: { summary: 'Changed from the SDK', version: ticket.version },
    });
    expect(changed.ticket.summary).toBe('Changed from the SDK');
    const read = await taskmoor.call('getTicket', {
      path: { id: 'SDK-1' },
      query: { format: 'markdown' },
    });
    expect(read.ticket.version).toBe(2);
    const keys: string[] = [];
    for await (const page of taskmoor.pages('listTickets', { query: { track: 'SDK', limit: 1 } })) {
      keys.push(...page.tickets.map((t) => t.key));
    }
    expect(keys.sort()).toEqual(['SDK-1', 'SDK-2']);
    const found = await taskmoor.call('search', {
      query: { q: 'track = SDK AND summary ~ another' },
    });
    expect(found.tickets.map((t) => t.key)).toEqual(['SDK-2']);
  });

  it('[API-001] turns a refusal into TaskmoorError with the server’s code', async () => {
    const taskmoor = createClient({ baseUrl, token });
    const missing = await taskmoor
      .call('getTicket', { path: { id: 'SDK-999' } })
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(TaskmoorError);
    expect([(missing as TaskmoorError).status, (missing as TaskmoorError).code]).toEqual([
      404,
      'not_found',
    ]);
    const anonymous = createClient({ baseUrl });
    const refused = await anonymous.call('getSession').catch((e: unknown) => e);
    expect((refused as TaskmoorError).status).toBe(401);
  });
});
