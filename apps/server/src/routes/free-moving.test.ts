import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

/**
 * Free moving is the default wherever a workflow starts (the user's decision of 2026-11-04;
 * WF-008 (4); ADR-116): any status reaches any status with nothing asked, the closing status sets
 * Completed, and a rule is something an administrator adds on purpose.
 */
const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.72.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

interface Definition {
  initialStatusId: number;
  transitions: {
    id: number;
    name: string;
    from: unknown;
    to: number;
    layout?: unknown;
    checks?: unknown;
    guards?: unknown;
    effects?: { type: string; field?: string; value?: unknown }[];
  }[];
}

describe('free moving as the default (WF-008)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  const status: Record<string, number> = {};
  const reason: Record<string, number> = {};

  const as = (options: InjectOptions) =>
    app.inject({ ...options, remoteAddress: nextAddress(), headers: { cookie } });
  const get = (url: string) => as({ method: 'GET', url });
  const post = (url: string, payload?: Record<string, unknown>) =>
    as({ method: 'POST', url, ...(payload ? { payload } : {}) });
  const del = (url: string) => as({ method: 'DELETE', url });

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
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    const set = session.headers['set-cookie'];
    const list = Array.isArray(set) ? set : set ? [set] : [];
    cookie = list.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0] ?? '';
    for (const s of (await get('/api/v1/statuses')).json().statuses) status[s.name] = s.id;
    for (const r of (await get('/api/v1/close-reasons')).json().closeReasons) reason[r.name] = r.id;
  });
  afterAll(async () => {
    await app?.close();
  });

  const publishedOf = async (id: number) =>
    (await get(`/api/v1/workflows/${id}`)).json().workflow.published.definition as Definition;
  const defaultId = async () =>
    (
      (await get('/api/v1/workflows')).json().workflows as { id: number; isDefault: boolean }[]
    ).find((w) => w.isDefault)?.id as number;

  /** A shared-mode track on this workflow, and a ticket's every move between its statuses. */
  async function trackOn(key: string, workflowId: number) {
    const map = await post('/api/v1/workflow-maps', {
      name: `Map ${key}`,
      defaultWorkflowId: workflowId,
    });
    expect(map.statusCode, map.body).toBe(201);
    const track = await post('/api/v1/tracks', { key, name: key, mode: 'shared' });
    expect(track.statusCode, track.body).toBe(201);
    const set = await as({
      method: 'PATCH',
      url: `/api/v1/tracks/${track.json().track.id}`,
      payload: { workflowMapId: map.json().workflowMap.id },
    });
    expect(set.statusCode, set.body).toBe(200);
  }

  it('[WF-008] a workflow started with no transitions moves freely', async () => {
    const statuses = [status.New, status.Active, status.Closed].map((statusId) => ({
      statusId: statusId as number,
    }));
    const created = await post('/api/v1/workflows', {
      name: 'Starts free',
      definition: { initialStatusId: status.New, statuses },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().workflow.id as number;
    const definition = await publishedOf(id);
    expect(definition.transitions.map((t) => [t.name, t.from, t.to])).toEqual([
      ['New', 'any', status.New],
      ['Active', 'any', status.Active],
      ['Closed', 'any', status.Closed],
    ]);
    for (const t of definition.transitions) {
      expect(t.layout).toBeUndefined();
      expect(t.checks).toBeUndefined();
      expect(t.guards).toBeUndefined();
    }
    expect(definition.transitions[0]?.effects).toEqual([
      { type: 'clear-field', field: 'close-reason' },
    ]);
    expect(definition.transitions[2]?.effects).toEqual([
      { type: 'update-system-field', field: 'close-reason', value: String(reason.Completed) },
    ]);

    // An empty list says the same: nobody chose a rule.
    const empty = await post('/api/v1/workflows', {
      name: 'Starts free too',
      definition: {
        initialStatusId: status.New,
        statuses: [{ statusId: status.New as number }],
        transitions: [],
      },
    });
    expect(empty.statusCode, empty.body).toBe(201);
    expect(
      (await publishedOf(empty.json().workflow.id)).transitions.map((t) => [t.from, t.to]),
    ).toEqual([['any', status.New]]);

    // Moving: every status reaches every other, with nothing asked.
    await trackOn('FREE', id);
    const made = await post('/api/v1/tickets', { track: 'FREE', summary: 'Moves' });
    const ticket = made.json().ticket.id as number;
    for (const t of [...definition.transitions, ...definition.transitions]) {
      const moved = await post(`/api/v1/tickets/${ticket}/transitions`, { transitionId: t.id });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().ticket.status.id).toBe(t.to);
      expect(moved.json().ticket.closeReason?.name ?? null).toBe(
        t.to === status.Closed ? 'Completed' : null,
      );
    }
    const leave = await post(`/api/v1/tickets/${ticket}/transitions`, {
      transitionId: definition.transitions[0]?.id,
    });
    expect(leave.json().ticket.closeReason).toBeNull();
    expect(leave.json().ticket.closedAt).toBeNull();
  });

  it('[WF-008] a list of transitions someone wrote stays as written', async () => {
    const transitions = [
      {
        id: 1,
        name: 'Start',
        from: [status.New],
        to: status.Active,
        checks: [{ type: 'field-required', field: 'assignee' }],
      },
    ];
    const created = await post('/api/v1/workflows', {
      name: 'With a rule',
      definition: {
        initialStatusId: status.New,
        statuses: [status.New, status.Active].map((statusId) => ({ statusId })),
        transitions,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect((await publishedOf(created.json().workflow.id)).transitions).toEqual(transitions);
  });

  it('[WF-008] a workflow that closes as a reason keeps that reason from being deleted', async () => {
    const before = await defaultId();
    const refused = await del(`/api/v1/close-reasons/${reason.Completed}`);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toBe('used_by_workflow');
    expect(refused.json().workflows).toContainEqual({ id: before, name: 'Default workflow' });
    // A reason nothing sets goes as before.
    const unused = await post('/api/v1/close-reasons', { name: 'Spare' });
    expect(unused.statusCode, unused.body).toBe(201);
    const gone = await del(`/api/v1/close-reasons/${unused.json().closeReason.id}`);
    expect(gone.statusCode, gone.body).toBe(204);
  });

  it('[WF-008] deleting it with a replacement moves the workflows to the replacement, and closing still works', async () => {
    const workflowId = await defaultId();
    // An open draft stays a draft, above the new published version, with the reason replaced.
    const published = await publishedOf(workflowId);
    const draft = await as({
      method: 'PUT',
      url: `/api/v1/workflows/${workflowId}/draft`,
      payload: {
        definition: {
          ...published,
          statuses: (await get(`/api/v1/workflows/${workflowId}`)).json().workflow.published
            .definition.statuses,
        },
      },
    });
    expect(draft.statusCode, draft.body).toBe(200);
    const versionBefore = draft.json().workflow.published.version as number;

    const done = await post('/api/v1/close-reasons', { name: 'Done' });
    const doneId = done.json().closeReason.id as number;
    const replaced = await del(`/api/v1/close-reasons/${reason.Completed}?replacementId=${doneId}`);
    expect(replaced.statusCode, replaced.body).toBe(204);

    const after = (await get(`/api/v1/workflows/${workflowId}`)).json().workflow;
    expect(after.published.version).toBeGreaterThan(versionBefore);
    expect(after.draft.version).toBeGreaterThan(after.published.version);
    for (const definition of [after.published.definition, after.draft.definition] as Definition[]) {
      const closing = definition.transitions.find((t) => t.to === status.Closed);
      expect(closing?.effects).toEqual([
        { type: 'update-system-field', field: 'close-reason', value: String(doneId) },
      ]);
    }

    const track = await post('/api/v1/tracks', { key: 'DEFT', name: 'DEFT', mode: 'shared' });
    expect(track.statusCode, track.body).toBe(201);
    const made = await post('/api/v1/tickets', { track: 'DEFT', summary: 'Closes' });
    const closed = await post(`/api/v1/tickets/${made.json().ticket.id}/transitions`, {
      transitionId: (after.published.definition as Definition).transitions.find(
        (t) => t.to === status.Closed,
      )?.id,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().ticket.closeReason?.name).toBe('Done');
    expect(closed.json().ticket.closedAt).not.toBeNull();
  });
});
