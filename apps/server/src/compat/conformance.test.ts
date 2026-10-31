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
 * test writes. Until the compatible API is served (M1-069, M1-070), every operation reads
 * missing or untested.
 */
describe('Jira-compatible API conformance (M1-068)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  let boardId = 0;

  const call = async (r: CompatRequest) => {
    const query = r.query ? `?${new URLSearchParams(r.query)}` : '';
    const res = await app.inject({
      method: r.method as 'GET',
      url: `${r.path}${query}`,
      remoteAddress: nextAddress(),
      headers: { cookie },
      ...(r.body !== undefined
        ? {
            payload: JSON.stringify(r.body),
            headers: { cookie, 'content-type': 'application/json' },
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
  });

  afterAll(async () => {
    await app?.close();
  });

  it('[API-014] reports each operation’s state as the generated matrix', async () => {
    const report = await runCompatContract({ project: 'CMP', issueType: 'Chore', boardId, call });
    expect(report.operations.length).toBeGreaterThan(60);
    await expect(
      formatMatrix(report, 'Jira-compatible API: compatibility matrix'),
    ).toMatchFileSnapshot('../../../../docs/api/jira-compat/matrix.md');
  });
});
