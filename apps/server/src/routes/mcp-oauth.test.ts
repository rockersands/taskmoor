import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `oauth-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.98.${Math.floor(++address / 250)}.${(address % 250) + 1}`;
const REDIRECT = 'http://127.0.0.1:33418/callback';

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

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** An MCP client's OAuth state, kept in memory; `approve` plays the person at the browser. */
class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  code = '';
  constructor(
    private readonly approve: (url: URL) => Promise<string>,
    private readonly name = 'Test assistant',
  ) {}
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  async redirectToAuthorization(url: URL) {
    this.code = await this.approve(url);
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/**
 * OAuth 2.1 for MCP clients (M1-072; API-002, API-012; ADR-084), driven by the official MCP
 * client's own OAuth support: discovery from the 401, self-registration, the person's consent
 * at their browser session, scoped tokens good at the MCP endpoint alone, grants that outlive
 * the browser session, and an administrator removing a client.
 */
describe('OAuth for MCP clients (M1-072)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let base = '';
  const users: Record<string, { id: number; cookie: string }> = {};

  const as = (who: string | null, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: who ? (users[who]?.cookie ?? '') : '' },
    });
  const settings = async (value: Record<string, unknown>) => {
    const res = await as('admin', {
      method: 'PUT',
      url: '/api/v1/admin/mcp',
      payload: { enabled: true, allowedClients: [], profile: 'planner', ...value },
    });
    expect(res.statusCode, res.body).toBe(200);
  };
  const pathOf = (url: string | URL) => {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  };
  /** The request id the consent page gets, after the browser's way through authorize. */
  async function consentRequest(who: string, authorizeUrl: string | URL) {
    const res = await as(who, { method: 'GET', url: pathOf(authorizeUrl) });
    expect(res.statusCode, res.body).toBe(302);
    const location = String(res.headers.location);
    expect(location).toContain('/#/oauth/consent?request=');
    return decodeURIComponent(location.split('request=')[1] ?? '');
  }
  /** The person approves (or refuses) at the consent page; the answer's redirect. */
  async function answer(who: string, id: string, body: Record<string, unknown>) {
    const res = await as(who, {
      method: 'POST',
      url: `/api/v1/oauth/requests/${id}`,
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(200);
    return new URL(res.json().redirect as string);
  }
  const approver =
    (who: string, scope?: 'read' | 'read write') =>
    async (url: URL): Promise<string> => {
      const id = await consentRequest(who, url);
      const back = await answer(who, id, { approve: true, ...(scope ? { scope } : {}) });
      expect(back.origin + back.pathname).toBe(REDIRECT);
      expect(back.searchParams.get('iss')).toBe(new URL(base).origin);
      expect(back.searchParams.get('state')).toBe(url.searchParams.get('state'));
      return back.searchParams.get('code') ?? '';
    };
  /** Connects the official client through its OAuth flow: the 401, the browser, the code. */
  async function connectWithOAuth(provider: MemoryProvider, name = 'test-assistant') {
    const url = new URL('/api/v1/mcp', base);
    const first = new Client({ name, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    await expect(first.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    await transport.finishAuth(provider.code);
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
    return client;
  }
  const structured = (r: unknown) =>
    (r as { structuredContent: Record<string, unknown> }).structuredContent;
  const errorText = (r: unknown) => {
    const result = r as { isError?: boolean; content?: { text?: string }[] };
    return result.isError ? (result.content?.[0]?.text ?? 'error') : null;
  };

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'], publicUrl: base });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
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
      payload: { key: 'OAU', name: 'Agents', mode: 'shared' },
    });
    const members = (await database.db.selectFrom('role').select(['id', 'name']).execute()).find(
      (r) => r.name === 'Members',
    )?.id as number;
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: track.json().track.id,
        role_id: members,
        user_id: users.alice?.id as number,
      })
      .execute();
    await app.listen({ port, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('[API-012] says where to sign in: the challenge and both discovery documents', async () => {
    const challenge = await app.inject({ method: 'POST', url: '/api/v1/mcp', payload: {} });
    expect(challenge.statusCode).toBe(401);
    expect(challenge.headers['www-authenticate']).toContain(
      `resource_metadata="${base}/.well-known/oauth-protected-resource/api/v1/mcp"`,
    );
    const resource = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource/api/v1/mcp',
    });
    expect(resource.json()).toMatchObject({
      resource: `${base}/api/v1/mcp`,
      authorization_servers: [base],
      scopes_supported: ['read', 'write'],
    });
    expect(resource.headers['access-control-allow-origin']).toBe('*');
    const server = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    expect(server.json()).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/api/v1/oauth/authorize`,
      token_endpoint: `${base}/api/v1/oauth/token`,
      registration_endpoint: `${base}/api/v1/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  it('[API-002] (3) the official client registers, the person consents, and it works as them', async () => {
    const provider = new MemoryProvider(approver('alice'));
    const client = await connectWithOAuth(provider);
    try {
      expect(provider.info?.client_id).toMatch(/^tmc_/);
      const made = structured(
        await client.callTool({
          name: 'create_ticket',
          arguments: { track: 'OAU', summary: 'Made through OAuth' },
        }),
      );
      expect(made).toMatchObject({ key: 'OAU-1', summary: 'Made through OAuth' });
      const ticket = await database.db
        .selectFrom('ticket')
        .select('requester_id')
        .where('number', '=', 1)
        .executeTakeFirstOrThrow();
      expect(ticket.requester_id).toBe(users.alice?.id);
    } finally {
      await client.close();
    }
    // The consent was recorded, and the audit log has it.
    const events = await database.db
      .selectFrom('domain_event')
      .select(['type', 'actor_id', 'payload'])
      .where('type', 'in', ['oauth_client.registered', 'oauth_client.consent'])
      .orderBy('id')
      .execute();
    expect(events).toEqual([
      expect.objectContaining({ type: 'oauth_client.registered', actor_id: null }),
      {
        type: 'oauth_client.consent',
        actor_id: users.alice?.id,
        payload: { name: 'Test assistant', approved: true, scope: 'read write' },
      },
    ]);
  });

  it('[API-002] (1) a client the person allowed to read cannot write', async () => {
    const provider = new MemoryProvider(approver('alice', 'read'), 'Reader');
    const client = await connectWithOAuth(provider, 'reader');
    try {
      const found = structured(
        await client.callTool({ name: 'search_tickets', arguments: { query: 'track = OAU' } }),
      );
      expect(JSON.stringify(found)).toContain('OAU-1');
      const refused = await client.callTool({
        name: 'create_ticket',
        arguments: { track: 'OAU', summary: 'Should not exist' },
      });
      expect(errorText(refused)).toBeTruthy();
      const count = await database.db
        .selectFrom('ticket')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      expect(Number(count.n)).toBe(1);
    } finally {
      await client.close();
    }
  });

  it('[API-012] keeps a registered client’s token to the MCP endpoint', async () => {
    const provider = new MemoryProvider(approver('alice'), 'Bound');
    const client = await connectWithOAuth(provider, 'bound');
    await client.close();
    const token = provider.saved?.access_token as string;
    expect(token).toMatch(/^tma_/);
    const elsewhere = await app.inject({
      method: 'GET',
      url: '/api/v1/tickets/OAU-1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(elsewhere.statusCode).toBe(401);
    expect(elsewhere.json()).toEqual({ error: 'invalid_token', reason: 'wrong_resource' });
    // Nor can it approve another client: that takes the person's browser session.
    const asked = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/requests/abcdefghijklmnopqrstuvwxyz',
      headers: { authorization: `Bearer ${token}` },
      payload: { approve: true },
    });
    expect(asked.statusCode).toBe(401);
  });

  it('[API-012] outlives the browser session that approved it, until an administrator removes it', async () => {
    const provider = new MemoryProvider(approver('alice'), 'Lasting');
    (await connectWithOAuth(provider, 'lasting')).close();
    // Alice signs out of the browser where she approved it.
    expect((await as('alice', { method: 'DELETE', url: '/api/v1/session' })).statusCode).toBe(204);
    const again = new Client({ name: 'lasting', version: '1.0.0' });
    await again.connect(
      new StreamableHTTPClientTransport(new URL('/api/v1/mcp', base), { authProvider: provider }),
    );
    expect((await again.listTools()).tools.length).toBeGreaterThan(0);
    await again.close();
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'alice@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    (users.alice as { cookie: string }).cookie = sessionCookie(signIn.headers['set-cookie']);
    // Alice's sessions name the app she allowed.
    const sessions = await as('alice', { method: 'GET', url: '/api/v1/sessions' });
    expect(sessions.json().sessions).toContainEqual(expect.objectContaining({ app: 'Lasting' }));

    const listed = await as('admin', { method: 'GET', url: '/api/v1/admin/oauth-clients' });
    const mine = (listed.json().clients as { id: string; name: string; grants: number }[]).find(
      (c) => c.id === provider.info?.client_id,
    );
    expect(mine).toMatchObject({ name: 'Lasting', grants: 1 });
    expect(
      (await as('alice', { method: 'GET', url: '/api/v1/admin/oauth-clients' })).statusCode,
    ).toBe(403);
    const removed = await as('admin', {
      method: 'DELETE',
      url: `/api/v1/admin/oauth-clients/${mine?.id}`,
    });
    expect(removed.statusCode).toBe(204);
    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${provider.saved?.access_token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(after.statusCode).toBe(401);
  });

  it('[API-002] refuses bad registrations, unregistered redirects and more scope than asked', async () => {
    const register = (body: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/v1/oauth/register', payload: body });
    for (const uri of [
      'http://tools.example.com/cb',
      'javascript:alert(1)',
      'https://tools.example.com/cb#frag',
    ]) {
      const res = await register({ redirect_uris: [uri], client_name: 'Bad' });
      expect(res.statusCode, uri).toBe(400);
      expect(res.json().error).toBe('invalid_redirect_uri');
    }
    expect(
      (
        await register({
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'client_secret_basic',
        })
      ).json().error,
    ).toBe('invalid_client_metadata');
    const made = await register({
      redirect_uris: [REDIRECT, 'cursor://example.app/cb'],
      scope: 'read',
    });
    expect(made.statusCode, made.body).toBe(201);
    const clientId = made.json().client_id as string;
    const { challenge } = pkce();
    const authorize = (redirect: string, extra: Record<string, string> = {}) =>
      `/api/v1/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirect,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 's1',
        ...extra,
      })}`;
    // A loopback redirect may come back on another port (RFC 8252); another host may not.
    expect(
      (await as('alice', { method: 'GET', url: authorize('http://127.0.0.1:5999/callback') }))
        .statusCode,
    ).toBe(302);
    expect(
      (await as('alice', { method: 'GET', url: authorize('http://127.0.0.1:5999/other') }))
        .statusCode,
    ).toBe(400);
    // An unknown scope or another resource goes back to the client as an error.
    const scope = await as('alice', {
      method: 'GET',
      url: authorize(REDIRECT, { scope: 'admin' }),
    });
    expect(String(scope.headers.location)).toContain('error=invalid_scope');
    const target = await as('alice', {
      method: 'GET',
      url: authorize(REDIRECT, { resource: 'https://other.example.com/mcp' }),
    });
    expect(String(target.headers.location)).toContain('error=invalid_target');
    // A read request cannot be approved for writing; refusing sends access_denied, once.
    const id = await consentRequest('alice', `${base}${authorize(REDIRECT, { scope: 'read' })}`);
    const more = await as('alice', {
      method: 'POST',
      url: `/api/v1/oauth/requests/${id}`,
      payload: { approve: true, scope: 'read write' },
    });
    expect(more.statusCode).toBe(400);
    const id2 = await consentRequest('alice', `${base}${authorize(REDIRECT, { scope: 'read' })}`);
    const shown = await as('alice', { method: 'GET', url: `/api/v1/oauth/requests/${id2}` });
    expect(shown.json().request).toMatchObject({
      client: { id: clientId, name: 'Unnamed client' },
      redirectUri: REDIRECT,
      scope: 'read',
    });
    const refused = await answer('alice', id2, { approve: false });
    expect(refused.searchParams.get('error')).toBe('access_denied');
    expect(refused.searchParams.get('state')).toBe('s1');
    expect(
      (
        await as('alice', {
          method: 'POST',
          url: `/api/v1/oauth/requests/${id2}`,
          payload: { approve: true },
        })
      ).statusCode,
    ).toBe(404);
    // Someone not signed in goes to sign in first, with only the request's id in the address.
    const anonymous = await as(null, { method: 'GET', url: authorize(REDIRECT) });
    const location = String(anonymous.headers.location);
    expect(location).toContain('/#/sign-in?continue=');
    const resume = decodeURIComponent(location.split('continue=')[1] ?? '');
    expect(resume).toMatch(/^\/api\/v1\/oauth\/authorize\?request=[^&]+$/);
    // The consent page tells someone signed out at once whether the request is there (D35).
    const waiting = new URLSearchParams(resume.split('?')[1]).get('request') ?? '';
    const unseen = await as(null, { method: 'GET', url: `/api/v1/oauth/requests/${waiting}` });
    expect(unseen.statusCode).toBe(401);
    const unknown = await as(null, {
      method: 'GET',
      url: '/api/v1/oauth/requests/abcdefghijklmnopqrstuvwxyz',
    });
    expect(unknown.statusCode).toBe(404);
    const resumed = await as('alice', { method: 'GET', url: resume });
    expect(String(resumed.headers.location)).toContain('/#/oauth/consent?request=');
  });

  it('[API-012] turns registration off with the setting, and the server document says so', async () => {
    await settings({ oauthRegistration: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/register',
      payload: { redirect_uris: [REDIRECT] },
    });
    expect(res.statusCode).toBe(403);
    const server = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    expect(server.json().registration_endpoint).toBeUndefined();
    await settings({ oauthRegistration: true });
  });
});
