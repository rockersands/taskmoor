import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.72.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Named {
  id: number;
  name: string;
}
interface TicketJson {
  id: number;
  key: string;
  version: number;
  status: Named;
  assignee: Named | null;
  priority: Named | null;
  dueDate: string | null;
  closeReason: Named | null;
  closedAt: string | null;
}

/**
 * Transitions through the workflow engine (M1-024 to M1-027): layouts, properties, events and
 * the trigger hook; guards, checks and effects on real tickets; the conformance suite covers
 * the engine's behaviour case by case (`packages/workflow/src/engine.test.ts`).
 */
describe('transitions through the workflow engine (M1-024 to M1-027)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const roles: Record<string, number> = {};
  const status: Record<string, number> = {};
  const priority: Record<string, number> = {};
  const reason: Record<string, number> = {};
  let tokenOfAlice = '';
  let trackCount = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const get = (who: string, url: string) => as(who, { method: 'GET', url });
  const post = (who: string, url: string, payload?: Record<string, unknown>) =>
    as(who, { method: 'POST', url, ...(payload ? { payload } : {}) });
  const ticketOf = (res: LightMyRequestResponse) => res.json().ticket as TicketJson;
  const S = (name: string) => status[name] as number;

  /** A track whose workflow is `definition`; Alice, Dave and Erin work in it. */
  async function trackWith(definition: Record<string, unknown>) {
    const key = `T${++trackCount}`;
    const workflow = await post('admin', '/api/v1/workflows', { name: `Flow ${key}`, definition });
    expect(workflow.statusCode, workflow.body).toBe(201);
    const track = await post('admin', '/api/v1/tracks', { key, name: key, mode: 'shared' });
    const trackId = track.json().track.id as number;
    for (const [who, role] of [
      ['alice', 'Members'],
      ['dave', 'Members'],
      ['erin', 'Administrators'],
    ] as const) {
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: trackId,
          role_id: roles[role] as number,
          user_id: users[who]?.id as number,
        })
        .execute();
    }
    // Every type of the track uses it, through a workflow map (M1-028).
    const map = await post('admin', '/api/v1/workflow-maps', {
      name: `Map ${key}`,
      defaultWorkflowId: workflow.json().workflow.id,
    });
    expect(map.statusCode, map.body).toBe(201);
    const set = await as('admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${trackId}`,
      payload: { workflowMapId: map.json().workflowMap.id },
    });
    expect(set.statusCode, set.body).toBe(200);
    return key;
  }
  async function create(who: string, track: string, extra: Record<string, unknown> = {}) {
    const res = await post(who, '/api/v1/tickets', { track, summary: 'Work', ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return ticketOf(res);
  }
  const offered = async (who: string, ticket: TicketJson) =>
    (
      (await get(who, `/api/v1/tickets/${ticket.id}/transitions`)).json().transitions as Named[]
    ).map((t) => t.name);
  const transition = (who: string, ticket: TicketJson, body: Record<string, unknown>) =>
    post(who, `/api/v1/tickets/${ticket.id}/transitions`, body);
  const lastEvent = async (type: string) =>
    (
      await database.db
        .selectFrom('domain_event')
        .select('payload')
        .where('type', '=', type)
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow()
    ).payload as Record<string, unknown>;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['dave', false],
      ['erin', false],
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
    for (const role of await database.db.selectFrom('role').select(['id', 'name']).execute()) {
      roles[role.name] = role.id;
    }
    for (const s of (await get('alice', '/api/v1/statuses')).json().statuses as Named[]) {
      status[s.name] = s.id;
    }
    for (const p of (await get('alice', '/api/v1/priorities')).json().priorities as Named[]) {
      priority[p.name] = p.id;
    }
    for (const r of (await get('alice', '/api/v1/close-reasons')).json().closeReasons as Named[]) {
      reason[r.name] = r.id;
    }
    const token = await as('alice', {
      method: 'POST',
      url: '/api/v1/account/tokens',
      payload: { name: 'Script', scopes: ['read', 'write'], expiresInDays: 30 },
    });
    expect(token.statusCode, token.body).toBe(201);
    tokenOfAlice = token.json().secret ?? token.json().token;
  });
  afterAll(async () => {
    await app.close();
  });

  it('[WF-006] saves layout values atomically with the transition and shows its properties', async () => {
    const track = await trackWith({
      initialStatusId: S('New'),
      statuses: [{ statusId: S('New') }, { statusId: S('Active') }],
      transitions: [
        {
          id: 1,
          name: 'Plan',
          from: [S('New')],
          to: S('Active'),
          layout: ['due-date', 'priority'],
          properties: { 'ui.button': 'primary' },
        },
      ],
    });
    const ticket = await create('alice', track);
    const listed = (await get('alice', `/api/v1/tickets/${ticket.id}/transitions`)).json();
    expect(listed.transitions).toEqual([
      expect.objectContaining({
        id: 1,
        name: 'Plan',
        layout: ['due-date', 'priority'],
        properties: { 'ui.button': 'primary' },
      }),
    ]);
    const bad = await transition('alice', ticket, {
      transitionId: 1,
      fields: { 'due-date': 'tomorrow' },
    });
    expect(bad.json()).toEqual({ error: 'invalid_fields', fields: { 'due-date': 'invalid' } });
    const res = await transition('alice', ticket, {
      transitionId: 1,
      fields: { 'due-date': '2026-12-24', priority: priority.High },
    });
    expect(res.statusCode, res.body).toBe(200);
    const moved = ticketOf(res);
    expect([moved.status.name, moved.dueDate, moved.priority?.name]).toEqual([
      'Active',
      '2026-12-24',
      'High',
    ]);
    expect(moved.version).toBe(ticket.version + 1);
    const changes = (await get('alice', `/api/v1/tickets/${ticket.id}/history`)).json().changes as {
      field: string;
      transitionId: number | null;
      changeSet: string;
    }[];
    const set = changes.filter((c) => c.changeSet === changes[0]?.changeSet);
    expect(set.map((c) => [c.field, c.transitionId]).sort()).toEqual([
      ['dueDate', 1],
      ['priority', 1],
      ['status', 1],
    ]);
    expect(await lastEvent('ticket.transitioned')).toMatchObject({
      transitionId: 1,
      event: 'generic',
      webhookCount: 0,
      channel: 'ui',
    });
  });

  it('[WF-003] hides a guarded transition and names the guard to REST', async () => {
    const track = await trackWith({
      initialStatusId: S('New'),
      statuses: [{ statusId: S('New') }, { statusId: S('Active') }, { statusId: S('Closed') }],
      transitions: [
        {
          id: 1,
          name: 'Take',
          from: [S('New')],
          to: S('Active'),
          guards: { type: 'only-assignee' },
        },
        {
          id: 2,
          name: 'Approve',
          from: [S('New')],
          to: S('Closed'),
          guards: { all: [{ type: 'user-in-role', role: String(roles.Administrators) }] },
        },
        {
          id: 3,
          name: 'Sync',
          from: 'any',
          to: S('Active'),
          guards: { type: 'hide-from-user' },
        },
      ],
    });
    const ticket = await create('alice', track, { assigneeId: users.dave?.id });
    expect(await offered('alice', ticket)).toEqual([]);
    expect(await offered('dave', ticket)).toEqual(['Take']);
    expect(await offered('erin', ticket)).toEqual(['Approve']);
    const refused = await transition('alice', ticket, { transitionId: 1 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      error: 'transition_refused',
      by: 'guard',
      name: 'only-assignee',
    });
    // Hidden from the UI, offered to REST callers such as scripts.
    const viaToken = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${ticket.id}/transitions`,
      remoteAddress: nextAddress(),
      headers: { authorization: `Bearer ${tokenOfAlice}` },
    });
    expect(viaToken.json().transitions.map((t: Named) => t.name)).toEqual(['Sync']);
    expect((await transition('dave', ticket, { transitionId: 1 })).statusCode).toBe(200);
  });

  it('[WF-004] blocks on a failed check with its message and changes nothing', async () => {
    const track = await trackWith({
      initialStatusId: S('New'),
      statuses: [{ statusId: S('New') }, { statusId: S('Closed') }],
      transitions: [
        {
          id: 1,
          name: 'Close',
          from: [S('New')],
          to: S('Closed'),
          layout: ['close-reason', 'summary'],
          checks: [
            { type: 'field-required', field: 'close-reason', message: 'Say why it closes' },
            { type: 'regex', field: 'summary', pattern: '^[A-Z]' },
          ],
        },
      ],
    });
    const ticket = await create('alice', track);
    const missing = await transition('alice', ticket, { transitionId: 1 });
    expect(missing.json()).toEqual({
      error: 'transition_refused',
      by: 'check',
      name: 'field-required',
      message: 'Say why it closes',
      check: { type: 'field-required', field: 'close-reason', configured: true },
    });
    const lower = await transition('alice', ticket, {
      transitionId: 1,
      fields: { 'close-reason': reason.Completed, summary: 'lower case' },
    });
    expect(lower.json()).toMatchObject({ by: 'check', name: 'regex' });
    const after = ticketOf(await get('alice', `/api/v1/tickets/${ticket.id}`));
    expect([after.status.name, after.version, after.closeReason]).toEqual([
      'New',
      ticket.version,
      null,
    ]);
    const closed = ticketOf(
      await transition('alice', ticket, {
        transitionId: 1,
        fields: { 'close-reason': reason.Duplicate, summary: 'Upper case' },
      }),
    );
    expect(closed).toMatchObject({
      status: { name: 'Closed' },
      closeReason: { name: 'Duplicate' },
    });
    expect(closed.closedAt).not.toBeNull();
  });

  it('[WF-005] runs effects after the essentials: assign, set fields, custom event, webhooks', async () => {
    const track = await trackWith({
      initialStatusId: S('New'),
      statuses: [{ statusId: S('New') }, { statusId: S('Active') }, { statusId: S('Closed') }],
      onCreate: {
        effects: [{ type: 'webhook', url: 'https://hooks.example.com/created' }],
        event: 'ticket-opened',
      },
      transitions: [
        {
          id: 1,
          name: 'Start',
          from: [S('New')],
          to: S('Active'),
          effects: [
            { type: 'assign-to-current-user' },
            { type: 'update-system-field', field: 'priority', value: String(priority.Urgent) },
            { type: 'webhook', url: 'https://hooks.example.com/started' },
          ],
          event: 'work-started',
        },
        {
          id: 2,
          name: 'Reopen',
          from: [S('Closed')],
          to: S('New'),
          effects: [
            { type: 'clear-field', field: 'close-reason' },
            // A ticket always has a priority (CORE-014): this leaves it as it is.
            { type: 'clear-field', field: 'priority' },
          ],
        },
        {
          id: 3,
          name: 'Close',
          from: 'any',
          to: S('Closed'),
          effects: [
            { type: 'update-system-field', field: 'close-reason', value: String(reason.Completed) },
          ],
        },
      ],
    });
    const ticket = await create('alice', track);
    expect(await lastEvent('ticket.created')).toMatchObject({
      event: 'ticket-opened',
      webhookCount: 1,
    });
    const started = ticketOf(await transition('dave', ticket, { transitionId: 1 }));
    expect([started.assignee?.name, started.priority?.name]).toEqual(['dave', 'Urgent']);
    expect(await lastEvent('ticket.transitioned')).toMatchObject({
      event: 'work-started',
      webhookCount: 1,
    });
    // The webhook address stays in the workflow: events can travel further than it should.
    expect(JSON.stringify(await lastEvent('ticket.transitioned'))).not.toContain('hooks.example');
    const closed = ticketOf(await transition('dave', ticket, { transitionId: 3 }));
    expect([closed.closeReason?.name, closed.closedAt === null]).toEqual(['Completed', false]);
    const reopened = ticketOf(await transition('dave', ticket, { transitionId: 2 }));
    expect([reopened.status.name, reopened.closeReason, reopened.closedAt]).toEqual([
      'New',
      null,
      null,
    ]);
    expect(reopened.priority?.name).toBe('Urgent');
  });

  it('[WF-003] enforces separation of duties from the recorded transition history', async () => {
    const track = await trackWith({
      initialStatusId: S('New'),
      statuses: [{ statusId: S('New') }, { statusId: S('Approved') }, { statusId: S('Published') }],
      transitions: [
        { id: 1, name: 'Approve', from: [S('New')], to: S('Approved') },
        {
          id: 2,
          name: 'Publish',
          from: [S('Approved')],
          to: S('Published'),
          guards: { type: 'separation-of-duties', transition: '1' },
        },
      ],
    });
    const ticket = await create('alice', track);
    await transition('dave', ticket, { transitionId: 1 });
    expect(await offered('dave', ticket)).toEqual([]);
    expect(await offered('alice', ticket)).toEqual(['Publish']);
    expect((await transition('alice', ticket, { transitionId: 2 })).statusCode).toBe(200);
  });

  it('[WF-007] refuses a transition the status reserves for a role, with the reason', async () => {
    const track = await trackWith({
      initialStatusId: S('Under review'),
      statuses: [{ statusId: S('Under review') }, { statusId: S('Approved') }],
      transitions: [{ id: 1, name: 'Approve', from: [S('Under review')], to: S('Approved') }],
      statusPermissions: {
        [String(S('Under review'))]: { transition: [{ role: String(roles.Administrators) }] },
      },
    });
    const ticket = await create('alice', track);
    expect(await offered('alice', ticket)).toEqual([]);
    const refused = await transition('alice', ticket, { transitionId: 1 });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({
      error: 'forbidden',
      permission: 'transition',
      reason: `in status ${S('Under review')} only role ${roles.Administrators} may transition`,
      locks: [
        {
          by: 'status',
          statusId: S('Under review'),
          statusName: 'Under review',
          allowed: [{ type: 'role', id: roles.Administrators, name: 'Administrators' }],
        },
      ],
    });
    expect((await transition('erin', ticket, { transitionId: 1 })).statusCode).toBe(200);
  });

  it('[WF-001] fires a transition from an injected external event (the M2 hook)', async () => {
    const track = await trackWith({
      initialStatusId: S('New'),
      statuses: [{ statusId: S('New') }, { statusId: S('In Review') }, { statusId: S('Closed') }],
      transitions: [
        {
          id: 1,
          name: 'Review',
          from: [S('New')],
          to: S('In Review'),
          triggers: [{ event: 'dev.pull-request-opened' }],
          guards: { type: 'hide-from-user' },
        },
        {
          id: 2,
          name: 'Merge',
          from: [S('In Review')],
          to: S('Closed'),
          triggers: [{ event: 'dev.pull-request-merged' }],
          effects: [
            { type: 'update-system-field', field: 'close-reason', value: String(reason.Completed) },
          ],
        },
      ],
    });
    const ticket = await create('alice', track);
    const unknown = await post('alice', `/api/v1/tickets/${ticket.id}/trigger`, {
      event: 'dev.pull-request-merged',
    });
    expect(unknown.json()).toEqual({
      error: 'no_transition_for_event',
      event: 'dev.pull-request-merged',
    });
    const opened = await post('alice', `/api/v1/tickets/${ticket.id}/trigger`, {
      event: 'dev.pull-request-opened',
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(ticketOf(opened).status.name).toBe('In Review');
    expect(await lastEvent('ticket.transitioned')).toMatchObject({
      transitionId: 1,
      channel: 'automation',
    });
    const merged = ticketOf(
      await post('alice', `/api/v1/tickets/${ticket.id}/trigger`, {
        event: 'dev.pull-request-merged',
      }),
    );
    expect([merged.status.name, merged.closeReason?.name]).toEqual(['Closed', 'Completed']);
  });

  it('[WF-002] refuses definitions whose layouts and effects name fields it cannot write', async () => {
    const bad = async (transition: Record<string, unknown>) =>
      (
        await post('admin', '/api/v1/workflows', {
          name: `Bad ${address}`,
          definition: {
            initialStatusId: S('New'),
            statuses: [{ statusId: S('New') }],
            transitions: [{ id: 1, name: 'x', from: [S('New')], to: S('New'), ...transition }],
          },
        })
      ).json().detail;
    expect(await bad({ layout: ['colour'] })).toEqual({
      problem: 'unknown_field',
      transitionId: 1,
      field: 'colour',
    });
    expect(await bad({ layout: ['time-spent'] })).toEqual({
      problem: 'field_not_writable',
      transitionId: 1,
      field: 'time-spent',
    });
    expect(
      await bad({ effects: [{ type: 'update-field', field: 'due-date', value: 'soon' }] }),
    ).toEqual({ problem: 'invalid_value', transitionId: 1, field: 'due-date' });
    expect(await bad({ checks: [{ type: 'regex', field: 'summary', pattern: '(' }] })).toEqual({
      problem: 'invalid_pattern',
      transitionId: 1,
      pattern: '(',
    });
    // A pattern that can backtrack catastrophically on ticket text (M1-118).
    expect(
      await bad({ checks: [{ type: 'regex', field: 'summary', pattern: '^(a+)+$' }] }),
    ).toEqual({ problem: 'invalid_pattern', transitionId: 1, pattern: '^(a+)+$' });
  });
});
