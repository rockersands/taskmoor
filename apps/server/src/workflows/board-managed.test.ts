import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `board-wf-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.85.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

interface BoardView {
  id: number;
  version: number;
  managesWorkflow: boolean;
  columns: { id: string; name: string; statusIds: number[] }[];
}

/**
 * Board-managed workflows through the API (M1-126; WF-010; spec 01a section 3.6): a board of
 * a local-mode track manages its workflow, a new column makes a status, any card moves to any
 * column, and the rightmost column closes a ticket as Completed until it leaves.
 */
describe('board-managed workflows (M1-126)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  let board: BoardView;
  let trackId = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: cookies[who] ?? '' },
    });
  const call = async (
    who: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    url: string,
    payload?: unknown,
  ) => as(who, { method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
  async function ticket(summary: string) {
    const res = await call('admin', 'POST', '/api/v1/tickets', { track: 'BM', summary });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as { id: number; key: string };
  }
  const read = async (t: { key: string }) =>
    (await call('admin', 'GET', `/api/v1/tickets/${t.key}`)).json().ticket as {
      status: { id: number; name: string };
      closeReason: { name: string } | null;
      closedAt: string | null;
    };
  const move = (t: { id: number }, columnId: string) =>
    call('admin', 'POST', `/api/v1/boards/${board.id}/moves`, { ticket: t.id, columnId });
  const workflow = async () =>
    (await call('admin', 'GET', `/api/v1/tracks/${trackId}/workflow`)).json().workflow as {
      definition: {
        initialStatusId: number;
        transitions: { id: number; name: string; from: unknown; to: number }[];
        board?: { boardId: number; columns: number[] };
      };
    };

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['member', false],
    ] as const) {
      await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: admin,
        })
        .execute();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      cookies[name] =
        [res.headers['set-cookie']]
          .flat()
          .find((c) => c?.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
          ?.split(';')[0] ?? '';
    }
    const track = await call('admin', 'POST', '/api/v1/tracks', {
      key: 'BM',
      name: 'Board managed',
      mode: 'local',
    });
    expect(track.statusCode, track.body).toBe(201);
    trackId = track.json().track.id;
    const created = await call('admin', 'POST', '/api/v1/boards', {
      name: 'Team board',
      kind: 'kanban',
      trackId,
      source: { query: 'track = BM' },
    });
    expect(created.statusCode, created.body).toBe(201);
    board = created.json().board;
  });
  afterAll(async () => {
    await app?.close();
  });

  it('[WF-010] lets a board of a local-mode track manage its workflow, one status per column', async () => {
    // Someone who cannot administer the track cannot (here, cannot even see the board).
    const outsider = await call('member', 'PUT', `/api/v1/boards/${board.id}/workflow`, {
      managed: true,
    });
    expect([403, 404]).toContain(outsider.statusCode);
    const res = await call('admin', 'PUT', `/api/v1/boards/${board.id}/workflow`, {
      managed: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    board = res.json().board;
    expect(board.managesWorkflow).toBe(true);
    expect(board.columns.every((c) => c.statusIds.length === 1)).toBe(true);
    const { definition } = await workflow();
    const statuses = board.columns.map((c) => c.statusIds[0]);
    expect(definition.board).toEqual({ boardId: board.id, columns: statuses });
    expect(definition.transitions.map((t) => [t.name, t.from, t.to])).toEqual(
      board.columns.map((c) => [c.name, 'any', c.statusIds[0]]),
    );
    expect(definition.initialStatusId).toBe(statuses[0]);
  });

  it('[WF-010] (1) makes a status when a column is added', async () => {
    const columns = [
      ...board.columns.slice(0, 1),
      { name: 'Waiting on design', statusIds: [] },
      ...board.columns.slice(1),
    ];
    const res = await call('admin', 'PATCH', `/api/v1/boards/${board.id}`, {
      version: board.version,
      columns,
    });
    expect(res.statusCode, res.body).toBe(200);
    board = res.json().board;
    const review = board.columns[1];
    expect(review?.name).toBe('Waiting on design');
    expect(review?.statusIds).toHaveLength(1);
    const statuses = (await call('admin', 'GET', '/api/v1/statuses')).json().statuses as {
      id: number;
      name: string;
      stage: string;
    }[];
    expect(statuses.find((s) => s.id === review?.statusIds[0])).toMatchObject({
      name: 'Waiting on design',
      stage: 'active',
    });
    expect((await workflow()).definition.board?.columns).toEqual(
      board.columns.map((c) => c.statusIds[0]),
    );
    // A column on a managed board holds one status.
    const two = await call('admin', 'PATCH', `/api/v1/boards/${board.id}`, {
      columns: [{ name: 'Both', statusIds: board.columns.slice(0, 2).flatMap((c) => c.statusIds) }],
    });
    expect(two.statusCode).toBe(409);
    expect(two.json()).toEqual({ error: 'one_status_per_column' });
  });

  it('[WF-010] (2) (3) moves any card to any column; the rightmost closes it as Completed and leaving clears it', async () => {
    const t = await ticket('Moved around');
    const last = board.columns.at(-1) as BoardView['columns'][number];
    const first = board.columns[0] as BoardView['columns'][number];
    const middle = board.columns[2] as BoardView['columns'][number];
    expect((await read(t)).status.id).toBe(first.statusIds[0]);
    // Straight from the first column to the rightmost.
    const done = await move(t, last.id);
    expect(done.statusCode, done.body).toBe(200);
    expect(await read(t)).toMatchObject({
      status: { id: last.statusIds[0] },
      closeReason: { name: 'Completed' },
    });
    expect((await read(t)).closedAt).not.toBeNull();
    // Back to a middle column: the close reason goes.
    expect((await move(t, middle.id)).statusCode).toBe(200);
    expect(await read(t)).toMatchObject({
      status: { id: middle.statusIds[0] },
      closeReason: null,
      closedAt: null,
    });
    // Backwards too.
    expect((await move(t, first.id)).statusCode).toBe(200);
    expect((await read(t)).status.id).toBe(first.statusIds[0]);
  });

  it('[WF-010] moves the tickets of a removed column to the leftmost one, or where asked', async () => {
    const review = board.columns[1] as BoardView['columns'][number];
    const t = await ticket('In review when the column goes');
    expect((await move(t, review.id)).statusCode).toBe(200);
    const target = board.columns[2] as BoardView['columns'][number];
    const res = await call('admin', 'PATCH', `/api/v1/boards/${board.id}`, {
      version: board.version,
      columns: board.columns.filter((c) => c.id !== review.id),
      statusMapping: { [String(review.statusIds[0])]: target.statusIds[0] },
    });
    expect(res.statusCode, res.body).toBe(200);
    board = res.json().board;
    expect((await read(t)).status.id).toBe(target.statusIds[0]);
    expect((await workflow()).definition.transitions.map((x) => x.to)).not.toContain(
      review.statusIds[0],
    );
  });

  it('[WF-010] refuses a board of a shared-mode track, and a second board on the track', async () => {
    const shared = await call('admin', 'POST', '/api/v1/tracks', {
      key: 'SH',
      name: 'Shared',
      mode: 'shared',
    });
    const sharedBoard = await call('admin', 'POST', '/api/v1/boards', {
      name: 'Shared board',
      kind: 'scrum',
      trackId: shared.json().track.id,
      source: { query: 'track = SH' },
    });
    const refused = await call(
      'admin',
      'PUT',
      `/api/v1/boards/${sharedBoard.json().board.id}/workflow`,
      { managed: true },
    );
    expect(refused.json()).toEqual({ error: 'shared_mode_track' });
    // A track has one board (ADR-116), so no second board can come to manage its workflow.
    const second = await call('admin', 'POST', '/api/v1/boards', {
      name: 'Second board',
      kind: 'kanban',
      trackId,
      source: { query: 'track = BM' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'track_has_board', boardId: board.id });
  });

  it('[WF-010] stops managing and leaves the workflow as it was', async () => {
    const before = await workflow();
    const res = await call('admin', 'PUT', `/api/v1/boards/${board.id}/workflow`, {
      managed: false,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().board.managesWorkflow).toBe(false);
    expect((await workflow()).definition.transitions).toEqual(before.definition.transitions);
  });
});
