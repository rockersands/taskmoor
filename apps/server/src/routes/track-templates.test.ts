import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `tpl-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.90.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Card {
  key: string;
}

/**
 * Track templates and copied configuration (M1-054; CORE-002 (1)): Scrum, Kanban, Bug tracking
 * and Business templates each make a track with a board that shows its tickets, Blank makes
 * none; a track made from another takes its configuration sets and toggles.
 */
describe('track templates (M1-054)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  const types: Record<string, number> = {};

  const call = async (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
    code = 200,
  ) => {
    const res = await app.inject({
      method,
      url,
      remoteAddress: nextAddress(),
      headers: { cookie },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(code);
    return res.json();
  };
  const make = (payload: Record<string, unknown>, code = 201) =>
    call('POST', '/api/v1/tracks', { mode: 'shared', ...payload }, code);
  const ticket = async (track: string, summary: string, type?: string) =>
    (
      await call(
        'POST',
        '/api/v1/tickets',
        { track, summary, ...(type ? { ticketTypeId: types[type] } : {}) },
        201,
      )
    ).ticket.key as string;
  const cards = async (board: number) =>
    ((await call('GET', `/api/v1/boards/${board}/data`)).cards as Card[]).map((c) => c.key);

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'admin',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .execute();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    cookie = sessionCookie(res.headers['set-cookie']);
    for (const y of await database.db
      .selectFrom('ticket_type')
      .select(['id', 'name'])
      .where('owner_track_id', 'is', null)
      .execute()) {
      types[y.name] = y.id;
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-002] Scrum and Kanban templates each make a track with a working board', async () => {
    const scrum = await make({ key: 'SCR', name: 'Payments', template: 'scrum' });
    expect(scrum.track).toMatchObject({
      type: 'software',
      features: { sprints: true, backlog: true },
    });
    expect(scrum.board).toMatchObject({
      name: 'Payments',
      kind: 'scrum',
      location: { type: 'track', track: { key: 'SCR' } },
    });
    const first = await ticket('SCR', 'Accept cards');
    // A Scrum board shows its active sprints: the ticket waits in the backlog.
    const backlog = await call('GET', `/api/v1/boards/${scrum.board.id}/backlog`);
    expect(backlog.backlog.tickets.map((x: Card) => x.key)).toEqual([first]);
    const kanban = await make({ key: 'KAN', name: 'Support', template: 'kanban' });
    expect(kanban.track.features).toMatchObject({ board: true, sprints: false, backlog: false });
    expect(kanban.board.kind).toBe('kanban');
    const second = await ticket('KAN', 'Answer the phone');
    expect(await cards(kanban.board.id)).toEqual([second]);
  });

  it('[CORE-002] Bug tracking shows the bugs; Business is a business track; Blank has no board', async () => {
    const bugs = await make({ key: 'BUG', name: 'Defects', template: 'bug-tracking' });
    expect(bugs.board.kind).toBe('kanban');
    const bug = await ticket('BUG', 'Totals off by a cent', 'Bug');
    await ticket('BUG', 'A new report', 'Feature');
    expect(await cards(bugs.board.id)).toEqual([bug]);
    const business = await make({ key: 'BIZ', name: 'Hiring', template: 'business' });
    expect(business.track).toMatchObject({ type: 'business', features: { sprints: false } });
    const offered = await call('GET', `/api/v1/tracks/${business.track.id}/ticket-types`);
    expect(offered.ticketTypes.map((y: { name: string }) => y.name)).toContain('To-do');
    const todo = await ticket('BIZ', 'Post the job');
    expect(await cards(business.board.id)).toEqual([todo]);
    const blank = await make({ key: 'BLK', name: 'Empty', template: 'blank' });
    expect(blank.board).toBeUndefined();
    expect((await call('GET', `/api/v1/boards?trackId=${blank.track.id}`)).boards).toEqual([]);
    // The template's event names it; the board has its own.
    const events = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload'])
      .where('type', 'in', ['track.created', 'board.created'])
      .orderBy('id')
      .execute();
    expect(
      events
        .filter((e) => e.type === 'track.created')
        .map((e) => (e.payload as { template?: string }).template),
    ).toEqual(['scrum', 'kanban', 'bug-tracking', 'business', 'blank']);
    expect(events.filter((e) => e.type === 'board.created')).toHaveLength(4);
  });

  it('[CORE-002] refuses a template with another type, or with a track to copy', async () => {
    await make({ key: 'BAD', name: 'Bad', template: 'business', type: 'software' }, 400);
    await make({ key: 'BAD', name: 'Bad', template: 'scrum', copyFrom: 1 }, 400);
    await make({ key: 'BAD', name: 'Bad', mode: 'local', copyFrom: 1 }, 400);
  });

  it('[CORE-002] a track made from another takes its configuration sets and toggles', async () => {
    const original = (await make({ key: 'ORG', name: 'Original' })).track;
    const priorities = (
      await database.db.selectFrom('priority').select('id').orderBy('sort_order').execute()
    ).map((p) => p.id);
    const prioritySet = (
      await call(
        'POST',
        '/api/v1/priority-sets',
        { name: 'Two levels', priorityIds: priorities.slice(0, 2) },
        201,
      )
    ).prioritySet.id;
    const businessSet = (
      await database.db
        .selectFrom('type_set')
        .select('id')
        .where('name', '=', 'Business type set')
        .executeTakeFirstOrThrow()
    ).id;
    await call('PATCH', `/api/v1/tracks/${original.id}`, {
      prioritySetId: prioritySet,
      typeSetId: businessSet,
      features: { timeline: false, forms: false },
    });
    const copy = (await make({ key: 'CPY', name: 'Copy', copyFrom: original.id })).track;
    expect(copy).toMatchObject({
      type: 'software',
      typeSetId: businessSet,
      prioritySetId: prioritySet,
      accessPolicyId: original.accessPolicyId,
      workflowMapId: original.workflowMapId,
      features: { timeline: false, forms: false, sprints: true },
    });
    // A local-mode source owns its sets: nothing to share.
    const local = (await make({ key: 'LOC', name: 'Local', mode: 'local' })).track;
    expect((await make({ key: 'CP2', name: 'Copy 2', copyFrom: local.id }, 409)).error).toBe(
      'source_not_shared',
    );
    await make({ key: 'CP3', name: 'Copy 3', copyFrom: 999_999 }, 400);
  });
});
