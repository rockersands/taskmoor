import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { LocalStore } from '@taskmoor/storage';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { storesOf } from '../attachments/stores';
import { SESSION_COOKIE } from '../auth';
import { multipartFile } from '../testing/multipart';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.73.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface TicketJson {
  id: number;
  key: string;
  status: { id: number; name: string };
}
type Who = 'alice' | 'dave' | 'erin';

/**
 * Per-status locks (WF-007) and per-field edit permissions (M1-029). In status Approved only
 * Administrators and the Approvers group may edit, only Administrators may assign or move the
 * ticket on, and only Approvers may attach. Alice is a Member, Dave a Member in Approvers, Erin
 * an Administrator: each holds the track permissions for every action, so what refuses them is
 * the lock alone.
 */
describe('per-status locks and per-field edit permissions (M1-029)', () => {
  const database = useMigratedDatabase();
  const filesRoot = mkdtempSync(join(tmpdir(), 'taskmoor-locks-'));
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const roles: Record<string, number> = {};
  const status: Record<string, number> = {};
  let approvers = 0;
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
  const patch = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'PATCH', url, payload });
  const upload = (who: string, ticket: TicketJson, name = 'notes.txt') =>
    as(who, {
      method: 'POST',
      url: `/api/v1/tickets/${ticket.id}/attachments`,
      ...multipartFile(name, 'text/plain', 'some notes'),
    });
  const S = (name: string) => status[name] as number;
  /** The fields the ticket view says the person may change now (T-191). */
  const editable = async (who: Who, ticket: TicketJson) =>
    (await get(who, `/api/v1/tickets/${ticket.id}`)).json().ticket.editableFields as string[];

  /** A track whose workflow is `definition`; Alice, Dave and Erin work in it. */
  async function trackWith(definition: Record<string, unknown>, extra = {}) {
    const key = `L${++trackCount}`;
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
      payload: { workflowMapId: map.json().workflowMap.id, ...extra },
    });
    expect(set.statusCode, set.body).toBe(200);
    return { key, id: trackId };
  }
  async function create(who: string, track: string, extra: Record<string, unknown> = {}) {
    const res = await post(who, '/api/v1/tickets', { track, summary: 'Work', ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as TicketJson;
  }

  // The locked workflow and two tracks that use it (the second is where moves go).
  let locked = '';
  let destination = '';
  const lockedFlow = () => ({
    initialStatusId: S('New'),
    statuses: [{ statusId: S('New') }, { statusId: S('Approved') }],
    transitions: [
      { id: 1, name: 'Approve', from: [S('New')], to: S('Approved') },
      { id: 2, name: 'Reopen', from: [S('Approved')], to: S('New') },
    ],
    statusPermissions: {
      [String(S('Approved'))]: {
        edit: [{ role: String(roles.Administrators) }, { group: String(approvers) }],
        assign: [{ role: String(roles.Administrators) }],
        attach: [{ group: String(approvers) }],
        transition: [{ role: String(roles.Administrators) }],
        comment: [{ role: String(roles.Administrators) }],
      },
    },
  });
  async function approved() {
    const ticket = await create('alice', locked);
    const res = await post('erin', `/api/v1/tickets/${ticket.id}/transitions`, {
      transitionId: 1,
    });
    expect(res.statusCode, res.body).toBe(200);
    return ticket;
  }
  const lock = (action: string, allowed: [string, number, string][]) => ({
    by: 'status',
    statusId: S('Approved'),
    statusName: 'Approved',
    allowed: allowed.map(([type, id, name]) => ({ type, id, name })),
  });
  const editors = () =>
    lock('edit', [
      ['role', roles.Administrators as number, 'Administrators'],
      ['group', approvers, 'Approvers'],
    ]);
  const admins = (action: string) =>
    lock(action, [['role', roles.Administrators as number, 'Administrators']]);

  beforeAll(async () => {
    const local = await LocalStore.open(filesRoot);
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      attachments: storesOf(local),
    });
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
    for (const s of (await get('alice', '/api/v1/statuses')).json().statuses as {
      id: number;
      name: string;
    }[]) {
      status[s.name] = s.id;
    }
    const group = await post('admin', '/api/v1/groups', { name: 'Approvers' });
    expect(group.statusCode, group.body).toBe(201);
    approvers = group.json().group.id;
    const member = await as('admin', {
      method: 'PUT',
      url: `/api/v1/groups/${approvers}/members/${users.dave?.id}`,
    });
    expect(member.statusCode, member.body).toBeLessThan(300);
    locked = (await trackWith(lockedFlow())).key;
    destination = (await trackWith(lockedFlow())).key;
  });
  afterAll(async () => {
    await app.close();
    rmSync(filesRoot, { recursive: true, force: true });
  });

  it('[WF-007] the permission matrix: edit, assign, attach, move and transition in a locked status', async () => {
    type Action = 'edit' | 'assign' | 'attach' | 'move' | 'transition';
    const run: Record<Action, (who: Who, t: TicketJson) => Promise<LightMyRequestResponse>> = {
      edit: (who, t) => patch(who, `/api/v1/tickets/${t.id}`, { summary: `Edited by ${who}` }),
      assign: (who, t) =>
        patch(who, `/api/v1/tickets/${t.id}`, { assigneeId: users.alice?.id as number }),
      attach: (who, t) => upload(who, t),
      move: (who, t) => post(who, `/api/v1/tickets/${t.id}/move`, { track: destination }),
      transition: (who, t) => post(who, `/api/v1/tickets/${t.id}/transitions`, { transitionId: 2 }),
    };
    // What each person gets, and the lock that refuses the others.
    const expected: Record<Action, { allowed: Who[]; permission: string; lock: () => unknown }> = {
      edit: { allowed: ['dave', 'erin'], permission: 'edit', lock: editors },
      assign: { allowed: ['erin'], permission: 'assign', lock: () => admins('assign') },
      attach: {
        allowed: ['dave'],
        permission: 'attach',
        lock: () => lock('attach', [['group', approvers, 'Approvers']]),
      },
      move: { allowed: ['dave', 'erin'], permission: 'edit', lock: editors },
      transition: { allowed: ['erin'], permission: 'transition', lock: () => admins('transition') },
    };
    const seen: string[] = [];
    const want: string[] = [];
    for (const action of Object.keys(run) as Action[]) {
      for (const who of ['alice', 'dave', 'erin'] as const) {
        const ticket = await approved();
        const res = await run[action](who, ticket);
        const rule = expected[action];
        const ok = rule.allowed.includes(who);
        seen.push(`${action} ${who} ${res.statusCode < 300 ? 'ok' : res.statusCode}`);
        want.push(`${action} ${who} ${ok ? 'ok' : 403}`);
        if (!ok) {
          expect(res.json(), `${action} by ${who}`).toMatchObject({
            error: 'forbidden',
            permission: rule.permission,
            locks: [rule.lock()],
          });
        }
      }
    }
    expect(seen).toEqual(want);

    // Out of the locked status everyone does everything their role lets them.
    const open = await create('alice', locked);
    expect((await run.edit('alice', open)).statusCode).toBe(200);
    expect((await run.assign('alice', open)).statusCode).toBe(200);
    expect((await run.attach('alice', open)).statusCode).toBe(201);
    expect((await run.move('alice', open)).statusCode).toBe(200);
  });

  it('[WF-007] [IAM-010] reading a ticket says which fields each person may change in its status', async () => {
    // Out of the locked status: what the role lets each set, in the edit form's order.
    const open = await create('alice', locked);
    const free = await editable('alice', open);
    expect(free).toEqual(
      expect.arrayContaining(['summary', 'assignee', 'priority', 'labels', 'startDate', 'dueDate']),
    );
    expect(free.indexOf('summary')).toBeLessThan(free.indexOf('dueDate'));
    expect(await editable('dave', open)).toEqual(free);
    // Approved: Alice may change nothing, Dave (an approver) all but the assignee, Erin all.
    const ticket = await approved();
    expect(await editable('alice', ticket)).toEqual([]);
    expect(await editable('dave', ticket)).toEqual(free.filter((key) => key !== 'assignee'));
    expect(await editable('erin', ticket)).toEqual(
      expect.arrayContaining(['summary', 'assignee', 'dueDate']),
    );
    // What it says agrees with an edit: offered passes, not offered is refused.
    const url = `/api/v1/tickets/${ticket.id}`;
    expect((await patch('dave', url, { labels: ['checked'] })).statusCode).toBe(200);
    expect((await patch('dave', url, { assigneeId: users.dave?.id as number })).statusCode).toBe(
      403,
    );
    expect((await patch('alice', url, { labels: ['refused'] })).statusCode).toBe(403);
  });

  it('[WF-007] a refusal changes nothing, and a file is removed only by the attach list', async () => {
    const ticket = await approved();
    expect(
      (await patch('alice', `/api/v1/tickets/${ticket.id}`, { summary: 'No' })).statusCode,
    ).toBe(403);
    const after = (await get('alice', `/api/v1/tickets/${ticket.id}`)).json().ticket;
    expect(after.summary).toBe('Work');
    const file = await upload('dave', ticket);
    expect(file.statusCode, file.body).toBe(201);
    const id = file.json().attachment.id as number;
    // Erin may delete every attachment in the track, but not while the status holds them.
    const byErin = await as('erin', {
      method: 'DELETE',
      url: `/api/v1/tickets/${ticket.id}/attachments/${id}`,
    });
    expect(byErin.statusCode).toBe(403);
    expect(byErin.json()).toMatchObject({ permission: 'attach' });
    const byDave = await as('dave', {
      method: 'DELETE',
      url: `/api/v1/tickets/${ticket.id}/attachments/${id}`,
    });
    expect(byDave.statusCode).toBe(204);
  });

  it('[WF-007] tells each person what the status keeps them from, and why', async () => {
    const ticket = await approved();
    const locksOf = async (who: Who) =>
      (await get(who, `/api/v1/tickets/${ticket.id}/locks`)).json().locks as Record<
        string,
        unknown
      >;
    expect(await locksOf('alice')).toEqual({
      edit: editors(),
      comment: admins('comment'),
      attach: lock('attach', [['group', approvers, 'Approvers']]),
      assign: admins('assign'),
      transition: admins('transition'),
    });
    expect(Object.keys(await locksOf('dave'))).toEqual(['comment', 'assign', 'transition']);
    expect(Object.keys(await locksOf('erin'))).toEqual(['attach']);
    // The attachment panel and the edit form say it too.
    const panel = (await get('alice', `/api/v1/tickets/${ticket.id}/attachments`)).json();
    expect(panel).toMatchObject({
      canCreate: false,
      locked: lock('attach', [['group', approvers, 'Approvers']]),
    });
    expect((await get('dave', `/api/v1/tickets/${ticket.id}/attachments`)).json()).toMatchObject({
      canCreate: true,
      locked: null,
    });
    const form = (await get('alice', `/api/v1/tickets/${ticket.id}/layout?operation=edit`)).json();
    expect(form.locks).toEqual([editors()]);
    expect(
      (await get('erin', `/api/v1/tickets/${ticket.id}/layout?operation=edit`)).json().locks,
    ).toEqual([]);
  });

  it('[CORE-013] [WF-007] a field rule lets only its roles and groups set the field: create, edit and transition layouts', async () => {
    const rules = await post('admin', '/api/v1/field-rule-sets', {
      name: 'Approvers date the work',
      rules: [{ field: 'dueDate', editableBy: [{ groupId: approvers }] }],
    });
    expect(rules.statusCode, rules.body).toBe(201);
    const set = rules.json().fieldRuleSet;
    expect(set.rules).toEqual([
      {
        ticketTypeId: null,
        field: 'dueDate',
        required: false,
        hidden: false,
        description: null,
        editableBy: [{ groupId: approvers }],
      },
    ]);
    const track = await trackWith(
      {
        initialStatusId: S('New'),
        statuses: [{ statusId: S('New') }, { statusId: S('Approved') }],
        transitions: [
          { id: 1, name: 'Plan', from: [S('New')], to: S('Approved'), layout: ['due-date'] },
        ],
      },
      { fieldRuleSetId: set.id },
    );
    const fieldLock = {
      by: 'field',
      field: 'dueDate',
      allowed: [{ type: 'group', id: approvers, name: 'Approvers' }],
    };

    // Create: Alice may create, but not with a due date; Dave may.
    const refused = await post('alice', '/api/v1/tickets', {
      track: track.key,
      summary: 'Dated',
      dueDate: '2026-12-01',
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({
      error: 'forbidden',
      permission: 'edit_field',
      locks: [fieldLock],
    });
    const ticket = await create('alice', track.key);
    await create('dave', track.key, { dueDate: '2026-12-01' });

    // Edit: the field alone is locked, and the ticket view offers it to Dave only (T-191).
    const url = `/api/v1/tickets/${ticket.id}`;
    expect((await patch('alice', url, { dueDate: '2026-12-02' })).statusCode).toBe(403);
    expect((await patch('alice', url, { summary: 'Renamed' })).statusCode).toBe(200);
    expect((await patch('dave', url, { dueDate: '2026-12-02' })).statusCode).toBe(200);
    const byDave = await editable('dave', ticket);
    expect(byDave).toContain('dueDate');
    expect(await editable('alice', ticket)).toEqual(byDave.filter((key) => key !== 'dueDate'));

    // A transition layout: the value entered needs the field's editors too.
    const viaLayout = (who: Who) =>
      post(who, `/api/v1/tickets/${ticket.id}/transitions`, {
        transitionId: 1,
        fields: { 'due-date': '2026-12-03' },
      });
    const byAlice = await viaLayout('alice');
    expect(byAlice.statusCode).toBe(403);
    expect(byAlice.json()).toMatchObject({ permission: 'edit_field', locks: [fieldLock] });
    expect((await viaLayout('dave')).statusCode).toBe(200);

    // The create form says which fields the person may not set.
    const types = (await get('alice', `/api/v1/tracks/${track.key}/ticket-types`)).json();
    const layout = (who: Who) =>
      get(
        who,
        `/api/v1/tracks/${track.key}/layout?ticketTypeId=${types.defaultTypeId}&operation=create`,
      );
    expect((await layout('alice')).json().locks).toEqual([fieldLock]);
    expect((await layout('dave')).json().locks).toEqual([]);
  });

  it('[CORE-013] refuses rules that could not be met, or that name nobody known', async () => {
    const save = (rule: Record<string, unknown>) =>
      post('admin', '/api/v1/field-rule-sets', { name: `Rules ${Math.random()}`, rules: [rule] });
    expect(
      (await save({ field: 'dueDate', required: true, editableBy: [{ roleId: 1 }] })).statusCode,
    ).toBe(400);
    expect(
      (await save({ field: 'dueDate', hidden: true, editableBy: [{ roleId: 1 }] })).statusCode,
    ).toBe(400);
    expect((await save({ field: 'dueDate', editableBy: [] })).statusCode).toBe(400);
    const unknown = await save({ field: 'dueDate', editableBy: [{ groupId: 999_999 }] });
    expect(unknown.json()).toMatchObject({ error: 'unknown_group' });
    const role = await save({ field: 'dueDate', editableBy: [{ roleId: 999_999 }] });
    expect(role.json()).toMatchObject({ error: 'unknown_role' });
  });
});
