import { randomBytes } from 'node:crypto';
import { type CompatRequest, formatMatrix, runCompatContract } from '@taskmoor/api-jira-compat';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `compat-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.99.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

/**
 * The Jira-compatible API's conformance suite against this server (M1-068; API-003, API-014;
 * ADR-085): a site administrator with a shared project and a Scrum board runs every case, and
 * the result is the compatibility matrix in `docs/api/jira-compat/matrix.md`, which only this
 * test writes. It signs in as scripts do, with Basic: the email address and an API token.
 */
describe('Jira-compatible API conformance (M1-068)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  let basic = '';
  let boardId = 0;

  const call = async (r: CompatRequest) => {
    const query = r.query ? `?${new URLSearchParams(r.query)}` : '';
    const res = await app.inject({
      method: r.method as 'GET',
      url: `${r.path}${query}`,
      remoteAddress: nextAddress(),
      headers: { authorization: basic },
      ...(r.body !== undefined
        ? {
            payload: JSON.stringify(r.body),
            headers: { authorization: basic, 'content-type': 'application/json' },
          }
        : {}),
    });
    let body: unknown = null;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'ada@example.com',
        name: 'Ada Admin',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .execute();
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'ada@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    const set = [signIn.headers['set-cookie']].flat().filter(Boolean) as string[];
    cookie = (set.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '').split(';')[0] ?? '';
    const track = await app.inject({
      method: 'POST',
      url: '/api/v1/tracks',
      headers: { cookie },
      remoteAddress: nextAddress(),
      payload: { key: 'CMP', name: 'Compatibility', mode: 'shared' },
    });
    expect(track.statusCode, track.body).toBe(201);
    const board = await app.inject({
      method: 'POST',
      url: '/api/v1/boards',
      headers: { cookie },
      remoteAddress: nextAddress(),
      payload: {
        name: 'Compatibility board',
        kind: 'scrum',
        trackId: track.json().track.id,
        source: { query: 'track = CMP' },
      },
    });
    expect(board.statusCode, board.body).toBe(201);
    boardId = board.json().board.id;
    // Scripts sign in with Basic: the email address and an API token.
    const token = await app.inject({
      method: 'POST',
      url: '/api/v1/account/tokens',
      headers: { cookie },
      remoteAddress: nextAddress(),
      payload: { name: 'compat suite', scopes: ['read', 'write', 'admin'], expiresInDays: 1 },
    });
    expect(token.statusCode, token.body).toBe(201);
    basic = `Basic ${Buffer.from(`ada@example.com:${token.json().token}`).toString('base64')}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  const rest = (
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    payload?: string,
  ) =>
    app.inject({
      method,
      url,
      remoteAddress: nextAddress(),
      headers: {
        ...headers,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload } : {}),
    });

  it('[API-002] signs scripts in with a token, Bearer or Basic, and nothing else', async () => {
    const myself = '/rest/api/2/myself';
    const token = Buffer.from(basic.slice('Basic '.length), 'base64')
      .toString()
      .split(':')[1] as string;
    expect((await rest('GET', myself, { authorization: basic })).json()).toMatchObject({
      displayName: 'Ada Admin',
    });
    expect((await rest('GET', myself, { authorization: `Bearer ${token}` })).statusCode).toBe(200);
    // No credential, a cookie only, a password, or another person's address: refused alike.
    const anonymous = await rest('GET', myself, {});
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ errorMessages: [expect.any(String)], errors: {} });
    expect(anonymous.headers['www-authenticate']).toContain('Basic');
    expect((await rest('GET', myself, { cookie })).statusCode).toBe(401);
    const password = `Basic ${Buffer.from(`ada@example.com:${PASSWORD}`).toString('base64')}`;
    expect((await rest('GET', myself, { authorization: password })).statusCode).toBe(401);
    const other = `Basic ${Buffer.from(`eve@example.com:${token}`).toString('base64')}`;
    expect((await rest('GET', myself, { authorization: other })).statusCode).toBe(401);
  });

  it('[API-003] (2) refuses unknown fields by name, and takes an empty JSON body', async () => {
    const made = await rest(
      'POST',
      '/rest/api/2/issue',
      { authorization: basic },
      JSON.stringify({
        fields: {
          project: { key: 'CMP' },
          issuetype: { name: 'Chore' },
          summary: 'Unknown field',
          nonsense: 1,
        },
      }),
    );
    expect(made.statusCode).toBe(400);
    expect(made.json().errors).toHaveProperty('nonsense');
    const empty = await rest('POST', '/rest/api/2/search', { authorization: basic }, '');
    expect(empty.statusCode, empty.body).toBe(200);
  });

  it('[API-014] reports each operation’s state as the generated matrix', async () => {
    const report = await runCompatContract({ project: 'CMP', issueType: 'Chore', boardId, call });
    expect(report.operations.length).toBeGreaterThan(60);
    // Every operation is complete (M1-069, M1-070) but bulk label edits, which add labels per
    // issue (native bulk edits set them; ADR-086).
    const core = report.operations.filter((o) => o.id !== 'bulkEditFields');
    expect(core.filter((o) => o.state !== 'complete').map((o) => `${o.id}: ${o.state}`)).toEqual(
      [],
    );
    await expect(
      formatMatrix(report, 'Jira-compatible API: compatibility matrix'),
    ).toMatchFileSnapshot('../../../../docs/api/jira-compat/matrix.md');
  });
});
