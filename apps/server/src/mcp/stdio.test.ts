import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `stdio-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.97.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { bridgeStdio } from './stdio';

/**
 * MCP over stdio (M1-072; API-012): the bridge takes JSON-RPC lines on stdin to a running
 * server with an API token and writes each answer as one line on stdout; notifications get no
 * line; the session ends when stdin does.
 */
describe('the MCP stdio bridge (M1-072)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let url = '';
  let token = '';

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'Ada',
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
    await app.inject({
      method: 'POST',
      url: '/api/v1/tracks',
      headers: { cookie },
      payload: { key: 'STD', name: 'Stdio', mode: 'shared' },
      remoteAddress: nextAddress(),
    });
    const issued = await app.inject({
      method: 'POST',
      url: '/api/v1/account/tokens',
      headers: { cookie },
      payload: { name: 'stdio', scopes: ['read', 'write'], expiresInDays: 1 },
      remoteAddress: nextAddress(),
    });
    token = issued.json().token;
    url = await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('[API-012] answers each request on its own line and ends the session with stdin', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) =>
      lines.push(...chunk.toString().split('\n').filter(Boolean)),
    );
    const bridge = bridgeStdio({ url, token, input, output });
    const send = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'desktop', version: '1' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_tracks', arguments: {} },
    });
    input.write('not json\n');
    input.end();
    await bridge;
    const answers = lines.map((l) => JSON.parse(l));
    expect(answers.map((a) => a.id)).toEqual([1, 2, 3, null]);
    expect(answers[0].result.serverInfo.name).toBe('taskmoor');
    expect(answers[1].result.tools.length).toBeGreaterThan(5);
    expect(answers[2].result.structuredContent.tracks).toEqual([
      { key: 'STD', name: 'Stdio', type: 'software' },
    ]);
    expect(answers[3].error.code).toBe(-32700);
    // The tool call was audited as from the client "desktop".
    const event = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'mcp.tool_called')
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ client: 'desktop', tool: 'list_tracks', ok: true });
  });
});
