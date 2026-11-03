import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.71.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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
  status: Named & { stage: string };
  closeReason: Named | null;
  closedAt: string | null;
}
interface Transition {
  id: number;
  name: string;
  from: number[] | 'any';
  to: number;
  layout?: string[];
  checks?: Record<string, unknown>[];
  effects?: Record<string, unknown>[];
}

describe('statuses and workflows (M1-023)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const roles: Record<string, number> = {};
  const status: Record<string, number> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const get = (who: string, url: string) => as(who, { method: 'GET', url });
  const post = (who: string, url: string, payload?: Record<string, unknown>) =>
    as(who, { method: 'POST', url, ...(payload ? { payload } : {}) });
  const patch = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'PATCH', url, payload });
  const put = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'PUT', url, payload });
  const del = (who: string, url: string) => as(who, { method: 'DELETE', url });

  const ticketOf = (res: LightMyRequestResponse) => res.json().ticket as TicketJson;
  const statusId = (name: string) => status[name] as number;
  async function create(track: string, summary = 'Work'): Promise<TicketJson> {
    const res = await post('alice', '/api/v1/tickets', { track, summary });
    expect(res.statusCode, res.body).toBe(201);
    return ticketOf(res);
  }
  const view = async (ticket: TicketJson) =>
    ticketOf(await get('alice', `/api/v1/tickets/${ticket.id}`));
  const offered = async (who: string, ticket: TicketJson) =>
    (
      (await get(who, `/api/v1/tickets/${ticket.id}/transitions`)).json().transitions as Named[]
    ).map((t) => t.name);
  async function move(ticket: TicketJson, transitionId: number, extra = {}) {
    const res = await post('alice', `/api/v1/tickets/${ticket.id}/transitions`, {
      transitionId,
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(200);
    return ticketOf(res);
  }
  const definition = (
    statuses: number[],
    transitions: Transition[],
    initialStatusId = statuses[0] as number,
  ) => ({
    initialStatusId,
    statuses: statuses.map((statusId) => ({ statusId })),
    transitions,
  });
  async function newWorkflow(name: string, def: ReturnType<typeof definition>) {
    const res = await post('admin', '/api/v1/workflows', { name, definition: def });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().workflow.id as number;
  }
  /** A shared workflow map that gives every ticket type the workflow (M1-028). */
  async function mapOf(workflowId: number) {
    const res = await post('admin', '/api/v1/workflow-maps', {
      name: `Map of ${workflowId}`,
      defaultWorkflowId: workflowId,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().workflowMap.id as number;
  }
  async function newTrack(key: string, workflowId?: number) {
    const res = await post('admin', '/api/v1/tracks', { key, name: key, mode: 'shared' });
    expect(res.statusCode, res.body).toBe(201);
    tracks[key] = res.json().track.id;
    for (const [who, role] of [
      ['alice', 'Members'],
      ['bob', 'Viewers'],
    ] as const) {
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: tracks[key] as number,
          role_id: roles[role] as number,
          user_id: users[who]?.id as number,
        })
        .execute();
    }
    if (workflowId !== undefined) {
      const set = await patch('admin', `/api/v1/tracks/${tracks[key]}`, {
        workflowMapId: await mapOf(workflowId),
      });
      expect(set.statusCode, set.body).toBe(200);
    }
  }
  const history = async (ticket: TicketJson, field: string) =>
    (
      (await get('alice', `/api/v1/tickets/${ticket.id}/history?order=asc`)).json().changes as {
        field: string;
        from: { display: string | null };
        to: { display: string | null };
      }[]
    ).filter((c) => c.field === field);

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
    for (const role of await database.db.selectFrom('role').select(['id', 'name']).execute()) {
      roles[role.name] = role.id;
    }
    for (const s of (await get('alice', '/api/v1/statuses')).json().statuses as Named[]) {
      status[s.name] = s.id;
    }
    await newTrack('DEF');
  });
  afterAll(async () => {
    await app.close();
  });

  describe('statuses', () => {
    it('[CORE-014] ships the default statuses with their stages and a default workflow', async () => {
      const statuses = (await get('bob', '/api/v1/statuses')).json().statuses;
      expect(statuses.map((s: Named & { stage: string }) => `${s.name}:${s.stage}`)).toEqual([
        'Open:new',
        'New:new',
        'Backlog:new',
        'Selected for Development:new',
        'Active:active',
        'In Review:active',
        'Under review:active',
        'Approved:closed',
        'Rejected:closed',
        'Cancelled:closed',
        'Draft:new',
        'Published:closed',
        'Closed:closed',
      ]);
      const ticket = await create('DEF');
      expect(ticket.status).toEqual({ id: status.New, name: 'New', stage: 'new' });
      expect(await offered('alice', ticket)).toEqual(['New', 'Active', 'In Review', 'Closed']);
    });

    it('[CORE-014] lets administrators add, edit, order and delete statuses', async () => {
      expect(
        (await post('alice', '/api/v1/statuses', { name: 'QA', stage: 'active' })).statusCode,
      ).toBe(403);
      const created = await post('admin', '/api/v1/statuses', {
        name: 'Verified',
        stage: 'closed',
      });
      expect(created.statusCode, created.body).toBe(201);
      const verified = created.json().status;
      expect(verified).toMatchObject({ name: 'Verified', stage: 'closed', order: 14 });
      expect(
        (await post('admin', '/api/v1/statuses', { name: 'verified', stage: 'new' })).json(),
      ).toEqual({ error: 'name_taken' });
      // In no workflow and with no tickets, it changes stage and goes.
      expect(
        (await patch('admin', `/api/v1/statuses/${verified.id}`, { stage: 'active' })).json().status
          .stage,
      ).toBe('active');
      // A status in use keeps its stage and stays.
      expect(
        (await patch('admin', `/api/v1/statuses/${status.New}`, { stage: 'active' })).json(),
      ).toMatchObject({ error: 'status_in_use' });
      const refused = await del('admin', `/api/v1/statuses/${status.New}`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().workflows.map((w: Named) => w.name)).toEqual(['Default workflow']);
      expect((await del('admin', `/api/v1/statuses/${verified.id}`)).statusCode).toBe(204);
      const ids = ((await get('alice', '/api/v1/statuses')).json().statuses as Named[]).map(
        (s) => s.id,
      );
      expect(ids).toHaveLength(13);
      const reordered = await put('admin', '/api/v1/statuses/order', {
        statusIds: [...ids].reverse(),
      });
      expect(reordered.json().statuses[0]).toMatchObject({ name: 'Closed', order: 1 });
      await put('admin', '/api/v1/statuses/order', { statusIds: ids });
    });
  });

  describe('workflows and transitions', () => {
    it('[WF-001] offers a global transition from every status and a multi-source one from each', async () => {
      const New = statusId('New');
      const Active = statusId('Active');
      const Closed = statusId('Closed');
      const Cancelled = statusId('Cancelled');
      const workflowId = await newWorkflow(
        'Global cancel',
        definition(
          [New, Active, Closed, Cancelled],
          [
            { id: 1, name: 'Start', from: [New], to: Active },
            { id: 2, name: 'Finish', from: [New, Active], to: Closed },
            { id: 3, name: 'Cancel', from: 'any', to: Cancelled },
            { id: 4, name: 'Restart', from: [Active], to: Active },
          ],
        ),
      );
      await newTrack('GLB', workflowId);
      const ticket = await create('GLB');
      expect(await offered('alice', ticket)).toEqual(['Start', 'Finish', 'Cancel']);
      await move(ticket, 1);
      // The loop back to Active is offered from Active too.
      expect(await offered('alice', ticket)).toEqual(['Finish', 'Cancel', 'Restart']);
      expect((await move(ticket, 4)).status.name).toBe('Active');
      await move(ticket, 3);
      // A global transition is offered from every status, its own target included.
      expect(await offered('alice', ticket)).toEqual(['Cancel']);
      // Viewers see no transitions and may not move tickets.
      const other = await create('GLB');
      expect(await offered('bob', other)).toEqual([]);
      expect(
        (await post('bob', `/api/v1/tickets/${other.id}/transitions`, { transitionId: 1 })).json(),
      ).toEqual({ error: 'forbidden', permission: 'transition_tickets' });
      expect(
        (
          await post('alice', `/api/v1/tickets/${other.id}/transitions`, { transitionId: 4 })
        ).json(),
      ).toEqual({ error: 'transition_unavailable', transitionId: 4 });
    });

    it('[WF-008] the default workflow moves freely: Closed sets Completed, leaving clears it', async () => {
      const ticket = await create('DEF');
      // Each move goes straight there, the leftmost status included, and asks for nothing.
      const closed = await move(ticket, 4);
      expect([closed.status.name, closed.closeReason?.name]).toEqual(['Closed', 'Completed']);
      expect(closed.closedAt).not.toBeNull();
      const reopened = await move(ticket, 5);
      expect([reopened.status.name, reopened.closeReason, reopened.closedAt]).toEqual([
        'New',
        null,
        null,
      ]);
      expect((await move(ticket, 2)).status.name).toBe('In Review');
      expect((await move(ticket, 4)).status.name).toBe('Closed');
      const active = await move(ticket, 1);
      expect([active.status.name, active.closeReason]).toEqual(['Active', null]);
      const published = (await get('bob', `/api/v1/tracks/${tracks.DEF}/workflow`)).json().workflow
        .definition as { transitions: Record<string, unknown>[] };
      expect(
        published.transitions.map((t) => [t.id, t.name, t.from, t.layout, t.checks, t.guards]),
      ).toEqual([
        [5, 'New', 'any', undefined, undefined, undefined],
        [1, 'Active', 'any', undefined, undefined, undefined],
        [2, 'In Review', 'any', undefined, undefined, undefined],
        [4, 'Closed', 'any', undefined, undefined, undefined],
      ]);
    });

    it('[WF-008] closes with a close reason and the Closed time stamp; reopening clears both', async () => {
      // What an administrator can ask for on purpose; the default workflow asks for none of it.
      const New = statusId('New');
      const Closed = statusId('Closed');
      const workflowId = await newWorkflow(
        'Close asks why',
        definition(
          [New, Closed],
          [
            {
              id: 4,
              name: 'Close',
              from: 'any',
              to: Closed,
              layout: ['close-reason'],
              checks: [{ type: 'field-required', field: 'close-reason' }],
            },
            {
              id: 5,
              name: 'Reopen',
              from: [Closed],
              to: New,
              effects: [{ type: 'clear-field', field: 'close-reason' }],
            },
          ],
        ),
      );
      await newTrack('WHY', workflowId);
      const ticket = await create('WHY');
      const reasons = (await get('alice', '/api/v1/close-reasons')).json().closeReasons as Named[];
      const reason = (name: string) => reasons.find((r) => r.name === name)?.id;
      // This workflow's Close asks for a close reason on its layout.
      const missing = await post('alice', `/api/v1/tickets/${ticket.id}/transitions`, {
        transitionId: 4,
      });
      expect(missing.json()).toEqual({
        error: 'transition_refused',
        by: 'check',
        name: 'field-required',
        message: 'close-reason is required',
        check: { type: 'field-required', field: 'close-reason', configured: false },
      });
      const closed = await move(ticket, 4, { fields: { 'close-reason': reason('Completed') } });
      expect(closed.status.name).toBe('Closed');
      expect(closed.closeReason?.name).toBe('Completed');
      expect(closed.closedAt).not.toBeNull();
      expect(closed.version).toBe(ticket.version + 1);
      // Reopen clears it with an effect.
      const reopened = await move(ticket, 5);
      expect([reopened.status.name, reopened.closeReason, reopened.closedAt]).toEqual([
        'New',
        null,
        null,
      ]);
      const duplicate = reason('Duplicate');
      expect(
        (await move(ticket, 4, { fields: { 'close-reason': duplicate } })).closeReason?.name,
      ).toBe('Duplicate');
      expect((await history(ticket, 'status')).map((c) => c.to.display)).toEqual([
        'New',
        'Closed',
        'New',
        'Closed',
      ]);
      expect((await history(ticket, 'closeReason')).map((c) => c.to.display)).toEqual([
        'Completed',
        null,
        'Duplicate',
      ]);
      // A close reason set by hand closes the ticket too; clearing it reopens.
      const other = await create('WHY');
      const set = ticketOf(
        await patch('alice', `/api/v1/tickets/${other.id}`, { closeReasonId: duplicate }),
      );
      expect(set.closedAt).not.toBeNull();
      const cleared = ticketOf(
        await patch('alice', `/api/v1/tickets/${other.id}`, { closeReasonId: null }),
      );
      expect(cleared.closedAt).toBeNull();
    });

    it('[WF-002] publishes a draft that drops a status by moving its 120 tickets first', async () => {
      const qa = (await post('admin', '/api/v1/statuses', { name: 'QA', stage: 'active' })).json()
        .status.id as number;
      const New = statusId('New');
      const Active = statusId('Active');
      const Closed = statusId('Closed');
      const workflowId = await newWorkflow(
        'With QA',
        definition(
          [New, Active, qa, Closed],
          [
            { id: 1, name: 'Start', from: [New], to: Active },
            { id: 2, name: 'Test', from: [Active], to: qa },
            { id: 3, name: 'Pass', from: [qa], to: Closed },
          ],
        ),
      );
      await newTrack('QAT', workflowId);
      const tested = await create('QAT');
      await move(tested, 1);
      await move(tested, 2);
      // 119 more in QA, written directly.
      const type = await database.db
        .selectFrom('ticket')
        .select('ticket_type_id')
        .where('id', '=', tested.id)
        .executeTakeFirstOrThrow();
      await database.db.executeQuery(
        sql`INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary,
              requester_id, creator_id, rank, status_id)
            SELECT 1, ${tracks.QAT}, g + 1, ${type.ticket_type_id}, 'Bulk ' || g,
                   ${users.alice?.id}, ${users.alice?.id}, 'zqat' || lpad(g::text, 4, '0'), ${qa}
              FROM generate_series(1, 119) g`.compile(database.db),
      );
      await database.db.executeQuery(
        sql`UPDATE ticket_counter SET last_number = 120 WHERE track_id = ${tracks.QAT}`.compile(
          database.db,
        ),
      );
      const draft = definition(
        [New, Active, Closed],
        [
          { id: 1, name: 'Start', from: [New], to: Active },
          { id: 4, name: 'Ship', from: [Active], to: Closed },
        ],
      );
      expect(
        (await put('admin', `/api/v1/workflows/${workflowId}/draft`, { definition: draft }))
          .statusCode,
      ).toBe(200);
      const impact = await get('admin', `/api/v1/workflows/${workflowId}/impact`);
      expect(impact.json()).toMatchObject({
        removedStatuses: [{ statusId: qa, ticketCount: 120 }],
        tracks: [{ key: 'QAT' }],
      });
      // Tickets still move through the published version until the draft is published.
      expect(await offered('alice', tested)).toEqual(['Pass']);
      const asked = await post('admin', `/api/v1/workflows/${workflowId}/publish`, {});
      expect(asked.statusCode).toBe(409);
      expect(asked.json()).toEqual({
        error: 'status_mapping_required',
        statuses: [{ statusId: qa, ticketCount: 120 }],
      });
      expect(
        (
          await post('admin', `/api/v1/workflows/${workflowId}/publish`, {
            statusMapping: { [qa]: qa },
          })
        ).statusCode,
      ).toBe(400);
      const published = await post('admin', `/api/v1/workflows/${workflowId}/publish`, {
        statusMapping: { [qa]: Active },
      });
      expect(published.statusCode, published.body).toBe(200);
      expect(published.json().workflow).toMatchObject({ published: { version: 2 }, draft: null });
      const left = await database.db
        .selectFrom('ticket')
        .select(sql<string>`count(*)`.as('n'))
        .where('status_id', '=', qa)
        .executeTakeFirstOrThrow();
      expect(Number(left.n)).toBe(0);
      const moved = await view(tested);
      expect(moved.status.name).toBe('Active');
      expect(moved.version).toBeGreaterThan(tested.version);
      expect((await history(moved, 'status')).at(-1)).toMatchObject({
        from: { display: 'QA' },
        to: { display: 'Active' },
      });
      const historyRows = await database.db
        .selectFrom('ticket_change')
        .select(sql<string>`count(*)`.as('n'))
        .where('field', '=', 'status')
        .where('to_value', '=', String(Active))
        .where('from_value', '=', String(qa))
        .executeTakeFirstOrThrow();
      expect(Number(historyRows.n)).toBe(120);
      // The next transition uses the new version at once.
      expect(await offered('alice', tested)).toEqual(['Ship']);
    });

    it('[WF-002] restores an earlier version as the draft and publishes it', async () => {
      const New = statusId('New');
      const Active = statusId('Active');
      const Closed = statusId('Closed');
      const first = definition([New, Closed], [{ id: 1, name: 'Done', from: [New], to: Closed }]);
      const workflowId = await newWorkflow('Restorable', first);
      await put('admin', `/api/v1/workflows/${workflowId}/draft`, {
        definition: definition(
          [New, Active, Closed],
          [
            { id: 1, name: 'Done', from: [New], to: Closed },
            { id: 2, name: 'Start', from: [New], to: Active },
          ],
        ),
      });
      await post('admin', `/api/v1/workflows/${workflowId}/publish`, {});
      const restored = await post('admin', `/api/v1/workflows/${workflowId}/versions/1/restore`);
      expect(restored.statusCode, restored.body).toBe(200);
      expect(restored.json().workflow.draft).toMatchObject({ version: 3, definition: first });
      await post('admin', `/api/v1/workflows/${workflowId}/publish`, {});
      const versions = (await get('admin', `/api/v1/workflows/${workflowId}/versions`)).json()
        .versions;
      expect(
        versions.map((v: { version: number; state: string }) => `${v.version}:${v.state}`),
      ).toEqual(['3:published', '2:earlier', '1:earlier']);
      expect(
        (await get('admin', `/api/v1/workflows/${workflowId}/versions/3`)).json().definition,
      ).toEqual(first);
      // A discarded draft leaves the published version as it was.
      await put('admin', `/api/v1/workflows/${workflowId}/draft`, { definition: first });
      expect((await del('admin', `/api/v1/workflows/${workflowId}/draft`)).statusCode).toBe(204);
      expect((await del('admin', `/api/v1/workflows/${workflowId}/draft`)).json()).toEqual({
        error: 'no_draft',
      });
      expect((await del('admin', `/api/v1/workflows/${workflowId}`)).statusCode).toBe(204);
    });

    it('[WF-001] refuses definitions that name statuses outside the workflow', async () => {
      const New = statusId('New');
      const Active = statusId('Active');
      const Closed = statusId('Closed');
      const bad = async (def: unknown) =>
        (
          await post('admin', '/api/v1/workflows', { name: `Bad ${address}`, definition: def })
        ).json().detail;
      expect(await bad(definition([New], [], Active))).toEqual({
        problem: 'initial_not_in_workflow',
      });
      expect(await bad(definition([New, 999_999], []))).toEqual({
        problem: 'unknown_status',
        statusId: 999_999,
      });
      expect(
        await bad(definition([New, Active], [{ id: 1, name: 'x', from: [New], to: Closed }])),
      ).toEqual({
        problem: 'transition_status_not_in_workflow',
        transitionId: 1,
        statusId: Closed,
      });
      expect(
        await bad(
          definition(
            [New, Active],
            [
              { id: 1, name: 'a', from: [New], to: Active },
              { id: 1, name: 'b', from: [Active], to: New },
            ],
          ),
        ),
      ).toEqual({ problem: 'duplicate_transition', transitionId: 1 });
      expect(
        (await post('alice', '/api/v1/workflows', { name: 'x', definition: definition([New], []) }))
          .statusCode,
      ).toBe(403);
    });

    it('[WF-001] maps statuses when a track switches workflow map or a ticket moves tracks', async () => {
      const New = statusId('New');
      const Active = statusId('Active');
      const Closed = statusId('Closed');
      const Backlog = statusId('Backlog');
      const kanban = await newWorkflow(
        'Kanban',
        definition(
          [Backlog, Active, Closed],
          [
            { id: 1, name: 'Pull', from: [Backlog], to: Active },
            { id: 2, name: 'Done', from: 'any', to: Closed },
          ],
        ),
      );
      await newTrack('SWT');
      const fresh = await create('SWT');
      const started = await create('SWT');
      await move(started, 1);
      const done = await create('SWT');
      const completed = (
        (await get('alice', '/api/v1/close-reasons')).json().closeReasons as Named[]
      ).find((r) => r.name === 'Completed')?.id;
      await move(done, 4, { fields: { 'close-reason': completed } });
      // New and Active? Kanban has Active, so only New needs a home.
      const kanbanMap = await mapOf(kanban);
      const type = (
        await database.db
          .selectFrom('ticket')
          .select('ticket_type_id')
          .where('id', '=', fresh.id)
          .executeTakeFirstOrThrow()
      ).ticket_type_id;
      const asked = await patch('admin', `/api/v1/tracks/${tracks.SWT}`, {
        workflowMapId: kanbanMap,
      });
      expect(asked.json()).toEqual({
        error: 'status_mapping_required',
        statuses: [{ ticketTypeId: type, statusId: New, ticketCount: 1, workflowId: kanban }],
      });
      const switched = await patch('admin', `/api/v1/tracks/${tracks.SWT}`, {
        workflowMapId: kanbanMap,
        statusMapping: { [New]: Backlog },
      });
      expect(switched.statusCode, switched.body).toBe(200);
      expect(switched.json().track.workflowMapId).toBe(kanbanMap);
      // One ticket moves, in the request: the migration is done when the answer comes.
      expect(switched.json().statusMigration).toMatchObject({
        status: 'done',
        total: 1,
        migrated: 1,
      });
      expect((await view(fresh)).status.name).toBe('Backlog');
      expect((await view(started)).status.name).toBe('Active');
      expect((await view(done)).closeReason?.name).toBe('Completed');
      expect(await offered('alice', fresh)).toEqual(['Pull', 'Done']);
      expect((await create('SWT')).status.name).toBe('Backlog');

      // Into a track whose workflow lacks the status: the one asked for, or the initial one.
      const moved = await post('alice', `/api/v1/tickets/${fresh.id}/move`, { track: 'DEF' });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(ticketOf(moved).status.name).toBe('New');
      const closedMove = await post('alice', `/api/v1/tickets/${(await create('SWT')).id}/move`, {
        track: 'DEF',
        statusId: Closed,
      });
      // A move only maps the status; the close reason is the transitions' to set.
      expect(ticketOf(closedMove)).toMatchObject({ status: { name: 'Closed' }, closeReason: null });
      expect(
        (
          await post('alice', `/api/v1/tickets/${started.id}/move`, {
            track: 'DEF',
            statusId: Backlog,
          })
        ).json().fields,
      ).toEqual({ statusId: 'not_in_workflow' });
    });

    it('[WF-002] never leaves a ticket in a status a publish removed, whatever the timing', async () => {
      const review = (
        await post('admin', '/api/v1/statuses', { name: 'Peer review', stage: 'active' })
      ).json().status.id as number;
      const New = statusId('New');
      const Active = statusId('Active');
      const workflowId = await newWorkflow(
        'Racy',
        definition(
          [New, Active, review],
          [
            { id: 1, name: 'Review', from: [New], to: review },
            { id: 2, name: 'Start', from: [New], to: Active },
          ],
        ),
      );
      await newTrack('RCE', workflowId);
      const tickets = await Promise.all(Array.from({ length: 30 }, () => create('RCE')));
      await put('admin', `/api/v1/workflows/${workflowId}/draft`, {
        definition: definition([New, Active], [{ id: 2, name: 'Start', from: [New], to: Active }]),
      });
      const results = await Promise.all([
        ...tickets.map((t) =>
          post('alice', `/api/v1/tickets/${t.id}/transitions`, { transitionId: 1 }),
        ),
        post('admin', `/api/v1/workflows/${workflowId}/publish`, {
          statusMapping: { [review]: Active },
        }),
      ]);
      const publish = results.at(-1) as LightMyRequestResponse;
      // Every transition either came first (and was remapped) or found the transition gone; a
      // publish that saw no ticket in the status yet needs no mapping and may refuse none.
      expect([200, 409]).toContain(publish.statusCode);
      for (const res of results.slice(0, -1)) {
        expect([200, 409], res.body).toContain(res.statusCode);
      }
      if (publish.statusCode === 200) {
        const stuck = await database.db
          .selectFrom('ticket')
          .select('id')
          .where('status_id', '=', review)
          .execute();
        expect(stuck).toEqual([]);
      }
    });

    it('[WF-002] shows a track its workflow read-only with "View read-only workflow"', async () => {
      const res = await get('bob', `/api/v1/tracks/${tracks.DEF}/workflow`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().workflow).toMatchObject({ name: 'Default workflow', version: 2 });
      expect((await get('bob', '/api/v1/workflows')).statusCode).toBe(403);
    });
  });
});
