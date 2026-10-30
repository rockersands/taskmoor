import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `mcp-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.96.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EventBus } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';

/**
 * The built-in MCP server (M1-072; API-012), spoken to by the official MCP client over
 * streamable HTTP with personal API tokens: tools listed and a ticket made that the UI shows
 * (1); a read-only profile without write tools (2); a token's scope never exceeded; every
 * call audited with client, person and tool (3); the allowed-clients list, sessions, and
 * refusals at the transport.
 */
describe('MCP server (M1-072)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let base = '';
  const users: Record<string, { id: number; cookie: string }> = {};
  const tokens: Record<string, string> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const settings = async (value: Record<string, unknown>) => {
    const res = await as('admin', {
      method: 'PUT',
      url: '/api/v1/admin/mcp',
      payload: { enabled: true, allowedClients: [], profile: 'planner', ...value },
    });
    expect(res.statusCode, res.body).toBe(200);
  };
  /** An MCP client connected with a token; closed by the caller. */
  const connect = async (token: string, name = 'taskmoor-test-client') => {
    const client = new Client({ name, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/api/v1/mcp', base), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return client;
  };
  const structured = (r: unknown) =>
    (r as { structuredContent: Record<string, unknown> }).structuredContent;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
    ] as const) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: admin,
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
      payload: { key: 'MCP', name: 'Agents', mode: 'shared' },
    });
    const members = (await database.db.selectFrom('role').select(['id', 'name']).execute()).find(
      (r) => r.name === 'Members',
    )?.id as number;
    for (const who of ['alice', 'bob']) {
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: track.json().track.id,
          role_id: members,
          user_id: users[who]?.id as number,
        })
        .execute();
    }
    for (const [name, who, scopes] of [
      ['write', 'alice', ['read', 'write']],
      ['read', 'alice', ['read']],
      ['bob', 'bob', ['read', 'write']],
    ] as const) {
      const issued = await as(who, {
        method: 'POST',
        url: '/api/v1/account/tokens',
        payload: { name, scopes: [...scopes], expiresInDays: 7 },
      });
      expect(issued.statusCode, issued.body).toBe(201);
      tokens[name] = issued.json().token;
    }
    base = await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('[API-012] lists tools and makes a ticket the UI shows', async () => {
    const client = await connect(tokens.write as string);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(['search_tickets', 'get_ticket', 'create_ticket', 'add_comment']),
      );
      // The default profile, planner, does not move tickets through workflows.
      expect(names).not.toContain('transition_ticket');
      expect(tools.find((t) => t.name === 'search_tickets')?.annotations?.readOnlyHint).toBe(true);
      const made = structured(
        await client.callTool({
          name: 'create_ticket',
          arguments: {
            track: 'MCP',
            summary: 'Made by an agent',
            description: 'With **bold** text',
            priority: 'High',
          },
        }),
      );
      expect(made).toMatchObject({ key: 'MCP-1', summary: 'Made by an agent', priority: 'High' });
      // In the UI's API, as alice.
      const shown = await as('alice', {
        method: 'GET',
        url: '/api/v1/tickets/MCP-1?format=markdown',
      });
      expect(shown.json().ticket).toMatchObject({
        summary: 'Made by an agent',
        priority: { name: 'High' },
      });
      expect(String(shown.json().ticket.description)).toContain('**bold**');
      await client.callTool({ name: 'add_comment', arguments: { key: 'MCP-1', body: 'Noted.' } });
      const found = structured(
        await client.callTool({
          name: 'search_tickets',
          arguments: { query: 'track = MCP AND priority = High' },
        }),
      );
      expect((found.tickets as { key: string }[]).map((t) => t.key)).toEqual(['MCP-1']);
      const read = structured(
        await client.callTool({ name: 'get_ticket', arguments: { key: 'MCP-1' } }),
      );
      expect(String(read.description)).toContain('**bold**');
    } finally {
      await client.close();
    }
  });

  it('[API-012] offers no write tools under the read-only profile, and moves tickets under full', async () => {
    await settings({ profile: 'read-only' });
    const reader = await connect(tokens.write as string);
    try {
      const names = (await reader.listTools()).tools.map((t) => t.name);
      expect(names).toEqual([
        'search_tickets',
        'get_ticket',
        'list_tracks',
        'list_boards',
        'list_sprints',
      ]);
      await expect(
        reader.callTool({ name: 'create_ticket', arguments: { track: 'MCP', summary: 'No' } }),
      ).rejects.toThrow(/not in this server/);
    } finally {
      await reader.close();
    }
    await settings({ profile: 'full' });
    const full = await connect(tokens.write as string);
    try {
      const moved = structured(
        await full.callTool({
          name: 'transition_ticket',
          arguments: { key: 'MCP-1', to: 'Active' },
        }),
      );
      expect(moved).toMatchObject({ key: 'MCP-1', status: 'Active', stage: 'active' });
    } finally {
      await full.close();
      await settings({ profile: 'planner' });
    }
  });

  it('[API-012] never exceeds the token’s scope: a read token cannot write', async () => {
    const client = await connect(tokens.read as string);
    try {
      const refused = (await client.callTool({
        name: 'create_ticket',
        arguments: { track: 'MCP', summary: 'Should not exist' },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toContain('403');
      const count = await database.db
        .selectFrom('ticket')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .where('summary', '=', 'Should not exist')
        .executeTakeFirstOrThrow();
      expect(Number(count.n)).toBe(0);
      // Reading still works.
      const found = structured(
        await client.callTool({ name: 'search_tickets', arguments: { query: 'track = MCP' } }),
      );
      expect((found.tickets as unknown[]).length).toBe(1);
    } finally {
      await client.close();
    }
  });

  it('[API-012] audits every call with client, person and tool', async () => {
    // The worker's part: relay the events and deliver them to the audit subscriber.
    const bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    const runner = new JobRunner(database.db, 'mcp-test');
    bus.attach(runner);
    while ((await bus.relayOnce()) > 0) {}
    while ((await runner.runOnce()) > 0) {}
    const audit = await database.db
      .selectFrom('audit_event')
      .select(['actor_id', 'details'])
      .where('action', '=', 'mcp.tool_called')
      .orderBy('seq')
      .execute();
    const calls = audit.map((a) => ({
      actor: a.actor_id,
      ...(a.details as Record<string, unknown>),
    }));
    expect(calls[0]).toMatchObject({
      actor: users.alice?.id,
      client: 'taskmoor-test-client',
      tool: 'create_ticket',
      ok: true,
    });
    expect(calls).toContainEqual(
      expect.objectContaining({ actor: users.alice?.id, tool: 'create_ticket', ok: false }),
    );
    const changed = await database.db
      .selectFrom('audit_event')
      .select('details')
      .where('action', '=', 'mcp.settings_updated')
      .execute();
    expect(changed.length).toBeGreaterThanOrEqual(3);
  });

  it('[API-012] lets in only allowed clients, and refuses at the transport as it should', async () => {
    await settings({ allowedClients: ['claude-code'] });
    await expect(connect(tokens.write as string, 'unknown-agent')).rejects.toThrow();
    const allowed = await connect(tokens.write as string, 'Claude-Code');
    await allowed.close();
    await settings({ enabled: false });
    await expect(connect(tokens.write as string, 'claude-code')).rejects.toThrow();
    await settings({});
    // Without credentials: 401 with a challenge.
    const anonymous = await fetch(new URL('/api/v1/mcp', base), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain('Bearer');
    // A session is its owner's alone; an unknown one is gone.
    const init = await fetch(new URL('/api/v1/mcp', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.write}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1' },
        },
      }),
    });
    const session = init.headers.get('mcp-session-id') as string;
    expect((await init.json()).result.protocolVersion).toBe('2025-06-18');
    const ping = (token: string, id: string) =>
      fetch(new URL('/api/v1/mcp', base), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'mcp-session-id': id,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      });
    expect((await ping(tokens.write as string, session)).status).toBe(200);
    expect((await ping(tokens.bob as string, session)).status).toBe(404);
    expect((await ping(tokens.write as string, 'nope')).status).toBe(404);
    expect(
      (
        await fetch(new URL('/api/v1/mcp', base), {
          headers: { authorization: `Bearer ${tokens.write}` },
        })
      ).status,
    ).toBe(405);
  });
});
