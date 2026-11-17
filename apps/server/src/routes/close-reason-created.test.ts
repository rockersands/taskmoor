import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { EventBus } from '../events/bus';
import { EVENT_TYPES } from '../events/catalogue';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { lockList } from '../tickets/fields';

// Made for this run: no password is written in the repository.
const PASSWORD = `reason-made-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.73.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

interface Effect {
  type: string;
  field?: string;
  value?: unknown;
}
interface Definition {
  transitions: { id: number; to: number; effects?: Effect[] }[];
}

/**
 * T-325: every path that makes a close reason records `close_reason.created` in the same
 * transaction, once (CORE-014; ADR-015), and the audit log keeps it (IAM-013). Completed is made
 * where a closing status that moves freely needs a reason and the workspace has none to name
 * (WF-008): a new workflow, the workflow editor's question, a board that starts managing its
 * workflow and a track made from a template (WF-010). Finding one makes nothing and records
 * nothing.
 */
describe('a close reason made on the way records its event (T-325)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  let adminId = 0;
  const status: Record<string, number> = {};
  const made: number[] = [];

  const as = (options: InjectOptions) =>
    app.inject({ ...options, remoteAddress: nextAddress(), headers: { cookie } });
  const post = (url: string, payload?: Record<string, unknown>) =>
    as({ method: 'POST', url, ...(payload ? { payload } : {}) });

  /** The newest event's id: what a step leaves is what comes after it. */
  const mark = async () =>
    Number(
      (
        await database.db
          .selectFrom('domain_event')
          .select((eb) => eb.fn.max('id').as('max'))
          .executeTakeFirstOrThrow()
      ).max ?? 0,
    );
  const eventsAfter = (from: number) =>
    database.db
      .selectFrom('domain_event')
      .select(['type', 'subject_type', 'subject_id', 'actor_id', 'payload'])
      .where('id', '>', String(from))
      .orderBy('id')
      .execute();
  const completedIds = async () =>
    (
      await database.db
        .selectFrom('close_reason')
        .select('id')
        .where('workspace_id', '=', 1)
        .where(sql`lower(name)`, '=', 'completed')
        .execute()
    ).map((r) => r.id);

  /**
   * The workspace with no reason to close with: the default workflow closes without one and no
   * reason is named Completed. The old Completed is renamed, not deleted, so whatever named it
   * still works.
   */
  let renamed = 0;
  async function noReasonToCloseWith() {
    const { rows } = await sql<{ workflow_id: number; version: number; definition: Definition }>`
      SELECT v.workflow_id, v.version, v.definition
        FROM workflow w
        JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
       WHERE w.workspace_id = 1 AND w.is_default`.execute(database.db);
    const row = rows[0];
    if (!row) throw new Error('no default workflow');
    const definition = {
      ...row.definition,
      transitions: row.definition.transitions.map((t) => ({
        ...t,
        ...(t.effects
          ? {
              effects: t.effects.map((e) =>
                e.field === 'close-reason' ? { type: 'clear-field', field: 'close-reason' } : e,
              ),
            }
          : {}),
      })),
    };
    await database.db
      .updateTable('workflow_version')
      .set({ definition: JSON.stringify(definition) as never })
      .where('workflow_id', '=', row.workflow_id)
      .where('version', '=', row.version)
      .execute();
    for (const id of await completedIds()) {
      await database.db
        .updateTable('close_reason')
        .set({ name: `Completed earlier ${++renamed}` })
        .where('id', '=', id)
        .execute();
    }
    expect(await completedIds()).toEqual([]);
  }

  /** The one close_reason.created a step left, checked against the catalogue; its reason's id. */
  function oneMade(events: Awaited<ReturnType<typeof eventsAfter>>): number {
    const created = events.filter((e) => e.type === 'close_reason.created');
    expect(created, events.map((e) => e.type).join(', ')).toHaveLength(1);
    const [event] = created;
    const spec = EVENT_TYPES['close_reason.created'];
    expect(event?.subject_type).toBe(spec.subject);
    expect(spec.payload.parse(event?.payload)).toEqual({ name: 'Completed' });
    expect(event?.actor_id).toBe(adminId);
    const id = Number(event?.subject_id);
    made.push(id);
    return id;
  }
  const noneMade = (events: Awaited<ReturnType<typeof eventsAfter>>) =>
    expect(events.filter((e) => e.type === 'close_reason.created')).toEqual([]);

  const statuses = () =>
    [status.New, status.Active, status.Closed].map((statusId) => ({
      statusId: statusId as number,
    }));
  const closingSets = (definition: Definition) =>
    definition.transitions
      .find((t) => t.to === status.Closed)
      ?.effects?.find((e) => e.field === 'close-reason')?.value;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const user = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'admin',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    adminId = user.id;
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    cookie =
      [session.headers['set-cookie']]
        .flat()
        .find((c) => c?.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
        ?.split(';')[0] ?? '';
    const list = (await as({ method: 'GET', url: '/api/v1/statuses' })).json().statuses as {
      id: number;
      name: string;
    }[];
    for (const s of list) status[s.name] = s.id;
  });
  afterAll(async () => {
    await app?.close();
  });

  it('[CORE-014] [WF-008] a new workflow that makes Completed records one event; the next finds it and records none', async () => {
    await noReasonToCloseWith();
    const from = await mark();
    const created = await post('/api/v1/workflows', {
      name: 'Makes Completed',
      definition: { initialStatusId: status.New, statuses: statuses() },
    });
    expect(created.statusCode, created.body).toBe(201);
    const events = await eventsAfter(from);
    expect(events.map((e) => e.type).sort()).toEqual(['close_reason.created', 'workflow.created']);
    const id = oneMade(events);
    expect(await completedIds()).toEqual([id]);
    const workflowId = created.json().workflow.id as number;
    const view = (await as({ method: 'GET', url: `/api/v1/workflows/${workflowId}` })).json();
    expect(closingSets(view.workflow.published.definition)).toBe(String(id));

    const again = await mark();
    const second = await post('/api/v1/workflows', {
      name: 'Finds Completed',
      definition: { initialStatusId: status.New, statuses: statuses() },
    });
    expect(second.statusCode, second.body).toBe(201);
    expect((await eventsAfter(again)).map((e) => e.type)).toEqual(['workflow.created']);
    const asked = await post(`/api/v1/workflows/${workflowId}/completed-reason`);
    expect(asked.json()).toEqual({ closeReasonId: id });
    noneMade(await eventsAfter(again));
  });

  it('[CORE-014] [WF-008] the editor asking twice at once makes one Completed and records one event', async () => {
    await noReasonToCloseWith();
    const workflowId = (
      (await as({ method: 'GET', url: '/api/v1/workflows' })).json().workflows as {
        id: number;
        isDefault: boolean;
      }[]
    ).find((w) => w.isDefault)?.id as number;
    const from = await mark();
    // The list is held until both have found no reason and wait for it, so they meet for sure.
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = () => {};
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const holder = database.db.transaction().execute(async (trx) => {
      await lockList(trx, 1, 'close_reason');
      holding();
      await released;
    });
    await held;
    const asking = Promise.all([
      post(`/api/v1/workflows/${workflowId}/completed-reason`),
      post(`/api/v1/workflows/${workflowId}/completed-reason`),
    ]);
    for (let waiting = 0, i = 0; waiting < 2 && i < 400; i++) {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event = 'advisory'`.execute(database.db);
      waiting = rows[0]?.n ?? 0;
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await holder;
    const [first, second] = await asking;
    expect(first?.statusCode, first?.body).toBe(200);
    expect(second?.statusCode, second?.body).toBe(200);
    const events = await eventsAfter(from);
    expect(events.map((e) => e.type)).toEqual(['close_reason.created']);
    const id = oneMade(events);
    expect(first?.json()).toEqual({ closeReasonId: id });
    expect(second?.json()).toEqual({ closeReasonId: id });
    expect(await completedIds()).toEqual([id]);

    const again = await mark();
    const third = await post(`/api/v1/workflows/${workflowId}/completed-reason`);
    expect(third.json()).toEqual({ closeReasonId: id });
    expect(await eventsAfter(again)).toEqual([]);
  });

  it('[WF-010] a board that starts managing its workflow records Completed beside board.updated', async () => {
    const track = await post('/api/v1/tracks', { key: 'CRB', name: 'Reason board', mode: 'local' });
    expect(track.statusCode, track.body).toBe(201);
    const board = await post('/api/v1/boards', {
      name: 'Reason board',
      kind: 'kanban',
      trackId: track.json().track.id,
      source: { query: 'track = CRB' },
    });
    expect(board.statusCode, board.body).toBe(201);
    await noReasonToCloseWith();
    const from = await mark();
    const managed = await as({
      method: 'PUT',
      url: `/api/v1/boards/${board.json().board.id}/workflow`,
      payload: { managed: true },
    });
    expect(managed.statusCode, managed.body).toBe(200);
    const events = await eventsAfter(from);
    expect(events.filter((e) => e.type === 'board.updated')).toHaveLength(1);
    const id = oneMade(events);
    expect(await completedIds()).toEqual([id]);
  });

  it('[WF-010] a track made from a template records the Completed its board makes, once', async () => {
    await noReasonToCloseWith();
    const from = await mark();
    const track = await post('/api/v1/tracks', {
      key: 'CRT',
      name: 'Reason template',
      mode: 'local',
      template: 'kanban',
    });
    expect(track.statusCode, track.body).toBe(201);
    expect(track.json().board, track.body).toBeTruthy();
    const events = await eventsAfter(from);
    expect(events.filter((e) => e.type === 'track.created')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'board.created')).toHaveLength(1);
    const id = oneMade(events);
    expect(await completedIds()).toEqual([id]);

    const again = await mark();
    const next = await post('/api/v1/tracks', {
      key: 'CRU',
      name: 'Reason template again',
      mode: 'local',
      template: 'kanban',
    });
    expect(next.statusCode, next.body).toBe(201);
    noneMade(await eventsAfter(again));
  });

  it('[CORE-014] the close reasons page records its one event through the same helper', async () => {
    const from = await mark();
    const res = await post('/api/v1/close-reasons', {
      name: 'Superseded',
      description: 'Replaced',
    });
    expect(res.statusCode, res.body).toBe(201);
    const reason = res.json().closeReason as { id: number; name: string; description: string };
    expect(reason).toMatchObject({ name: 'Superseded', description: 'Replaced' });
    const events = await eventsAfter(from);
    expect(events.map((e) => [e.type, Number(e.subject_id), e.payload])).toEqual([
      ['close_reason.created', reason.id, { name: 'Superseded' }],
    ]);
    const taken = await post('/api/v1/close-reasons', { name: 'superseded' });
    expect(taken.statusCode, taken.body).toBe(409);
    expect(await eventsAfter(from)).toHaveLength(1);
  });

  it('[IAM-013] the audit log records each Completed made, once', async () => {
    expect(made.length).toBeGreaterThanOrEqual(4);
    const bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    const runner = new JobRunner(database.db, 'close-reason-created-test');
    bus.attach(runner);
    for (let i = 0; i < 50; i++) {
      const relayed = await bus.relayOnce();
      const ran = await runner.runOnce();
      if (relayed === 0 && ran === 0) break;
    }
    const rows = await database.db
      .selectFrom('audit_event')
      .select(['subject_id', 'subject_type', 'actor_id', 'details'])
      .where('action', '=', 'close_reason.created')
      .where('subject_id', 'in', made.map(String))
      .execute();
    expect(rows.map((r) => Number(r.subject_id)).sort((a, b) => a - b)).toEqual(
      [...made].sort((a, b) => a - b),
    );
    for (const row of rows) {
      expect(row.subject_type).toBe('close_reason');
      expect(row.actor_id).toBe(adminId);
    }
  });
});
