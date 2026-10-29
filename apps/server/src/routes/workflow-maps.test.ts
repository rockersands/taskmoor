import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { BULK_TASK, registerBulkJobs } from '../bulk/jobs';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import {
  IN_REQUEST_TICKETS,
  MIGRATION_TASK,
  registerWorkflowMigrationJobs,
} from '../workflows/migration';

/** Made per run: no password is written down. */
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.76.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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
  ticketType: Named;
}
interface Transition {
  id: number;
  name: string;
  from: number[] | 'any';
  to: number;
}

/**
 * Workflow maps (M1-028; WF-001 (3)): a track's map gives each ticket type its workflow, and a
 * change of map moves tickets whose status the new workflow lacks, in the background when
 * there are many. Alice is a Member of the tracks made here; Erin administers the local-mode
 * track LOC and nothing else.
 *
 * Workflows: Bug flow (Open, Active, Closed: Triage, Fix) and Chore flow (Backlog, Active,
 * Closed: Pick, Finish), besides the workspace's default (New, Active, In Review, Closed).
 */
describe('workflow maps (M1-028)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let runner: JobRunner;
  const users: Record<string, { id: number; cookie: string }> = {};
  const roles: Record<string, number> = {};
  const status: Record<string, number> = {};
  const types: Record<string, number> = {};
  const tracks: Record<string, number> = {};
  const flows = { bug: 0, chore: 0, default: 0 };
  const maps = { split: 0 };

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
  const S = (name: string) => status[name] as number;
  const T = (name: string) => types[name] as number;
  const ticketOf = (res: LightMyRequestResponse) => res.json().ticket as TicketJson;

  const definition = (statuses: number[], transitions: Transition[], extra = {}) => ({
    initialStatusId: statuses[0] as number,
    statuses: statuses.map((statusId) => ({ statusId })),
    transitions,
    ...extra,
  });
  async function newWorkflow(who: string, name: string, def: object, trackId?: number) {
    const res = await post(who, '/api/v1/workflows', {
      name,
      definition: def,
      ...(trackId !== undefined ? { trackId } : {}),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().workflow.id as number;
  }
  async function newMap(name: string, defaultWorkflowId: number, entries: [string, number][] = []) {
    const res = await post('admin', '/api/v1/workflow-maps', {
      name,
      defaultWorkflowId,
      entries: entries.map(([type, workflowId]) => ({ ticketTypeId: T(type), workflowId })),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().workflowMap.id as number;
  }
  async function newTrack(key: string, mapId?: number, mode: 'shared' | 'local' = 'shared') {
    const res = await post('admin', '/api/v1/tracks', { key, name: key, mode });
    expect(res.statusCode, res.body).toBe(201);
    tracks[key] = res.json().track.id;
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: tracks[key] as number,
        role_id: roles.Members as number,
        user_id: users.alice?.id as number,
      })
      .execute();
    if (mapId !== undefined) {
      const set = await patch('admin', `/api/v1/tracks/${tracks[key]}`, { workflowMapId: mapId });
      expect(set.statusCode, set.body).toBe(200);
    }
  }
  async function create(track: string, type: string, extra = {}): Promise<TicketJson> {
    const res = await post('alice', '/api/v1/tickets', {
      track,
      summary: `${type} work`,
      ticketTypeId: T(type),
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(201);
    return ticketOf(res);
  }
  const view = async (ticket: { id: number }) =>
    ticketOf(await get('alice', `/api/v1/tickets/${ticket.id}`));
  const offered = async (ticket: { id: number }, who = 'alice') =>
    (
      (await get(who, `/api/v1/tickets/${ticket.id}/transitions`)).json().transitions as Named[]
    ).map((t) => t.name);
  async function transition(ticket: { id: number }, transitionId: number, extra = {}) {
    return post('alice', `/api/v1/tickets/${ticket.id}/transitions`, { transitionId, ...extra });
  }
  /** Tickets written straight into the database, as an import would. */
  async function seed(track: string, type: string, statusName: string, count: number) {
    const { rows } = await sql<{ n: number }>`
      SELECT coalesce(max(number), 0)::int AS n FROM ticket WHERE track_id = ${tracks[track]}`.execute(
      database.db,
    );
    const from = (rows[0]?.n ?? 0) + 1;
    await sql`INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary,
          requester_id, creator_id, rank, status_id)
        SELECT 1, ${tracks[track]}, g, ${T(type)}, 'Seeded ' || g, ${users.alice?.id},
               ${users.alice?.id}, ${`z${track.toLowerCase()}`} || lpad(g::text, 6, '0'), ${S(statusName)}
          FROM generate_series(${from}::int, ${from + count - 1}::int) g`.execute(database.db);
    await sql`INSERT INTO ticket_counter (track_id, workspace_id, last_number)
        VALUES (${tracks[track]}, 1, ${from + count - 1})
        ON CONFLICT (track_id) DO UPDATE SET last_number = excluded.last_number`.execute(
      database.db,
    );
  }
  const statusCount = async (track: string, type: string, statusName: string) => {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ticket
       WHERE track_id = ${tracks[track]} AND ticket_type_id = ${T(type)}
         AND status_id = ${S(statusName)}`.execute(database.db);
    return rows[0]?.n ?? 0;
  };
  const history = async (ticket: { id: number }) =>
    (
      (await get('alice', `/api/v1/tickets/${ticket.id}/history?order=asc`)).json().changes as {
        field: string;
        actor: { id: number } | null;
        from: { display: string | null };
        to: { display: string | null };
      }[]
    ).filter((c) => c.field === 'status');
  /** Runs queued status migrations (and bulk operations) until none is left. */
  async function drain() {
    for (let i = 0; i < 100; i++) {
      if ((await runner.runOnce()) === 0) return;
    }
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const catalogs = new FieldCatalogs(database.db);
    runner = new JobRunner(database.db, 'maps-test', { tasks: [MIGRATION_TASK, BULK_TASK] });
    registerWorkflowMigrationJobs(runner, database.db, catalogs, { batch: 100 });
    registerBulkJobs(runner, database.db, new Authorizer(database.db), catalogs);
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
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
    for (const t of await database.db
      .selectFrom('ticket_type')
      .select(['id', 'name'])
      .where('owner_track_id', 'is', null)
      .execute()) {
      types[t.name] = t.id;
    }
    flows.bug = await newWorkflow(
      'admin',
      'Bug flow',
      definition(
        [S('Open'), S('Active'), S('Closed')],
        [
          { id: 1, name: 'Triage', from: [S('Open')], to: S('Active') },
          { id: 2, name: 'Fix', from: [S('Active')], to: S('Closed') },
        ],
      ),
    );
    flows.chore = await newWorkflow(
      'admin',
      'Chore flow',
      definition(
        [S('Backlog'), S('Active'), S('Closed')],
        [
          { id: 6, name: 'Pick', from: [S('Backlog')], to: S('Active') },
          { id: 7, name: 'Finish', from: [S('Active')], to: S('Closed') },
        ],
        // In Backlog only Administrators edit a chore (WF-007), whatever the other types do.
        {
          statusPermissions: {
            [String(S('Backlog'))]: { edit: [{ role: String(roles.Administrators) }] },
          },
        },
      ),
    );
    flows.default = (
      await database.db
        .selectFrom('workflow')
        .select('id')
        .where('is_default', '=', true)
        .executeTakeFirstOrThrow()
    ).id;
    maps.split = await newMap('Split', flows.default, [
      ['Bug', flows.bug],
      ['Chore', flows.chore],
    ]);
    await newTrack('MIX', maps.split);
    await newTrack('PLAIN');
  });
  afterAll(async () => {
    await app.close();
  });

  it('[WF-001] gives Bug one workflow and Chore another in the same track', async () => {
    const bug = await create('MIX', 'Bug');
    const chore = await create('MIX', 'Chore');
    const feature = await create('MIX', 'Feature');
    // Each starts in its own workflow's initial status and offers its own transitions.
    expect([bug.status.name, chore.status.name, feature.status.name]).toEqual([
      'Open',
      'Backlog',
      'New',
    ]);
    expect(await offered(bug)).toEqual(['Triage']);
    expect(await offered(chore)).toEqual(['Pick']);
    expect(await offered(feature)).toEqual(['Start', 'Close']);
    // A transition of the other workflow is not this ticket's.
    expect((await transition(bug, 6)).json()).toEqual({
      error: 'transition_unavailable',
      transitionId: 6,
    });
    expect(ticketOf(await transition(bug, 1)).status.name).toBe('Active');
    expect(ticketOf(await transition(chore, 6)).status.name).toBe('Active');
    expect(await offered(bug)).toEqual(['Fix']);
    expect(await offered(chore)).toEqual(['Finish']);
    // A ticket written without a status (an import) starts where its type's workflow says.
    const imported = await sql<{ status_id: number }>`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, requester_id,
                          creator_id, rank)
      VALUES (1, ${tracks.MIX}, 9999, ${T('Bug')}, 'Imported', ${users.alice?.id},
              ${users.alice?.id}, 'zzimported')
      RETURNING status_id`.execute(database.db);
    expect(imported.rows[0]?.status_id).toBe(S('Open'));
    await sql`DELETE FROM ticket WHERE number = 9999 AND track_id = ${tracks.MIX}`.execute(
      database.db,
    );

    // The track's map and each type's workflow, read-only for its members ("View read-only
    // workflow"); nobody outside the track sees it.
    expect((await get('erin', `/api/v1/tracks/${tracks.MIX}/workflow-map`)).statusCode).toBe(404);
    const read = await get('alice', `/api/v1/tracks/${tracks.MIX}/workflow-map`);
    expect(read.statusCode, read.body).toBe(200);
    const byType = Object.fromEntries(
      (read.json().ticketTypes as { ticketType: Named; workflow: Named }[]).map((t) => [
        t.ticketType.name,
        t.workflow.name,
      ]),
    );
    expect(byType).toMatchObject({
      Bug: 'Bug flow',
      Chore: 'Chore flow',
      Feature: 'Default workflow',
    });
    expect(read.json().workflowMap).toMatchObject({
      id: maps.split,
      name: 'Split',
      defaultWorkflow: { name: 'Default workflow' },
      tracks: [{ key: 'MIX' }],
    });
    const chores = await get(
      'admin',
      `/api/v1/tracks/${tracks.MIX}/workflow?ticketTypeId=${T('Chore')}`,
    );
    expect(chores.json().workflow).toMatchObject({ id: flows.chore, name: 'Chore flow' });
    expect((await get('admin', `/api/v1/tracks/${tracks.MIX}/workflow`)).json().workflow.id).toBe(
      flows.default,
    );
  });

  it('[WF-007] applies the per-status locks of the workflow of the ticket type', async () => {
    const chore = await create('MIX', 'Chore');
    const bug = await create('MIX', 'Bug');
    const refused = await patch('alice', `/api/v1/tickets/${chore.id}`, { summary: 'Edited' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      permission: 'edit',
      locks: [{ statusName: 'Backlog' }],
    });
    expect((await get('alice', `/api/v1/tickets/${chore.id}/locks`)).json().locks).toHaveProperty(
      'edit',
    );
    expect(
      (await patch('alice', `/api/v1/tickets/${bug.id}`, { summary: 'Edited' })).statusCode,
    ).toBe(200);
    expect((await get('alice', `/api/v1/tickets/${bug.id}/locks`)).json().locks).toEqual({});
  });

  it('[WF-001] maps the status when a ticket changes to a type with another workflow', async () => {
    const bug = await create('MIX', 'Bug');
    // Open is not a Chore status: the Chore workflow's initial status, with history.
    const retyped = await patch('alice', `/api/v1/tickets/${bug.id}`, { ticketTypeId: T('Chore') });
    expect(retyped.statusCode, retyped.body).toBe(200);
    expect(ticketOf(retyped)).toMatchObject({
      ticketType: { name: 'Chore' },
      status: { name: 'Backlog' },
    });
    expect((await history(bug)).map((c) => c.to.display)).toEqual(['Open', 'Backlog']);
    // Or the status asked for, when the new type's workflow has it.
    const other = await create('MIX', 'Bug');
    expect(
      (
        await patch('alice', `/api/v1/tickets/${other.id}`, {
          ticketTypeId: T('Chore'),
          statusId: S('Open'),
        })
      ).json().fields,
    ).toEqual({ statusId: 'not_in_workflow' });
    expect(
      (await patch('alice', `/api/v1/tickets/${other.id}`, { statusId: S('Active') })).json()
        .fields,
    ).toEqual({ statusId: 'without_type_change' });
    const asked = await patch('alice', `/api/v1/tickets/${other.id}`, {
      ticketTypeId: T('Feature'),
      statusId: S('In Review'),
    });
    expect(ticketOf(asked)).toMatchObject({ status: { name: 'In Review' } });
    // A status both workflows have stays.
    const active = await create('MIX', 'Bug');
    await transition(active, 1);
    const kept = await patch('alice', `/api/v1/tickets/${active.id}`, {
      ticketTypeId: T('Feature'),
    });
    expect(ticketOf(kept).status.name).toBe('Active');
  });

  it('[WF-001] moves tickets a type set change retypes to the initial status of their new workflow', async () => {
    await newTrack('RTY', maps.split);
    const feature = await create('RTY', 'Feature');
    const active = await create('RTY', 'Feature');
    await transition(active, 1);
    const set = await post('admin', '/api/v1/type-sets', {
      name: 'No features',
      ticketTypeIds: [T('Bug'), T('Chore'), T('Outcome'), T('Subticket')],
      defaultTypeId: T('Bug'),
    });
    expect(set.statusCode, set.body).toBe(201);
    const switched = await patch('admin', `/api/v1/tracks/${tracks.RTY}`, {
      typeSetId: set.json().typeSet.id,
      ticketTypeMapping: { [T('Feature')]: T('Bug') },
    });
    expect(switched.statusCode, switched.body).toBe(200);
    // New is not a Bug status: Bug's initial status; Active is, and stays.
    expect(await view(feature)).toMatchObject({
      ticketType: { name: 'Bug' },
      status: { name: 'Open' },
    });
    expect((await view(active)).status.name).toBe('Active');
    expect((await history(feature)).map((c) => c.to.display)).toEqual(['New', 'Open']);
    expect(await offered(feature)).toEqual(['Triage']);
  });

  it('[WF-001] maps statuses by the target type workflow when a ticket moves tracks', async () => {
    // Into a track on the default map: Open is not a default status.
    const bug = await create('MIX', 'Bug');
    const moved = await post('alice', `/api/v1/tickets/${bug.id}/move`, { track: 'PLAIN' });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(ticketOf(moved).status.name).toBe('New');
    // Back as a Chore: New is not a Chore status; the status asked for must be a Chore one.
    expect(
      (
        await post('alice', `/api/v1/tickets/${bug.id}/move`, {
          track: 'MIX',
          ticketTypeId: T('Chore'),
          statusId: S('In Review'),
        })
      ).json().fields,
    ).toEqual({ statusId: 'not_in_workflow' });
    const back = await post('alice', `/api/v1/tickets/${bug.id}/move`, {
      track: 'MIX',
      ticketTypeId: T('Chore'),
      statusId: S('Active'),
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(ticketOf(back)).toMatchObject({
      ticketType: { name: 'Chore' },
      status: { name: 'Active' },
    });
    const plain = await create('PLAIN', 'Bug');
    const asBug = await post('alice', `/api/v1/tickets/${plain.id}/move`, { track: 'MIX' });
    expect(ticketOf(asBug).status.name).toBe('Open');
  });

  it('[WF-001] switches a track to another map with a status mapping, refused without one', async () => {
    await newTrack('SWT');
    const bugNew = await create('SWT', 'Bug');
    const bugActive = await create('SWT', 'Bug');
    expect(ticketOf(await transition(bugActive, 1)).status.name).toBe('Active');
    const chore = await create('SWT', 'Chore');
    await transition(chore, 1);
    expect(ticketOf(await transition(chore, 2)).status.name).toBe('In Review');
    const feature = await create('SWT', 'Feature');

    // What the switch would do, before doing it.
    const impact = await get(
      'admin',
      `/api/v1/tracks/${tracks.SWT}/workflow-map/impact?workflowMapId=${maps.split}`,
    );
    expect(impact.statusCode, impact.body).toBe(200);
    expect(impact.json().impact).toMatchObject({
      tracks: [{ key: 'SWT' }],
      types: [
        {
          ticketType: { name: 'Bug' },
          ticketCount: 2,
          from: { name: 'Default workflow' },
          to: { name: 'Bug flow' },
        },
        { ticketType: { name: 'Chore' }, ticketCount: 1, to: { name: 'Chore flow' } },
      ].sort((a, b) => T(a.ticketType.name) - T(b.ticketType.name)),
      lostStatuses: expect.arrayContaining([
        {
          ticketType: { id: T('Bug'), name: 'Bug' },
          status: { id: S('New'), name: 'New' },
          ticketCount: 1,
          workflow: { id: flows.bug, name: 'Bug flow' },
        },
        {
          ticketType: { id: T('Chore'), name: 'Chore' },
          status: { id: S('In Review'), name: 'In Review' },
          ticketCount: 1,
          workflow: { id: flows.chore, name: 'Chore flow' },
        },
      ]),
      ticketCount: 2,
    });

    const refused = await patch('admin', `/api/v1/tracks/${tracks.SWT}`, {
      workflowMapId: maps.split,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      error: 'status_mapping_required',
      statuses: [
        { ticketTypeId: T('Bug'), statusId: S('New'), ticketCount: 1, workflowId: flows.bug },
        {
          ticketTypeId: T('Chore'),
          statusId: S('In Review'),
          ticketCount: 1,
          workflowId: flows.chore,
        },
      ].sort((a, b) => a.ticketTypeId - b.ticketTypeId),
    });
    // A target outside the type's new workflow is no mapping.
    expect(
      (
        await patch('admin', `/api/v1/tracks/${tracks.SWT}`, {
          workflowMapId: maps.split,
          statusMapping: { [S('New')]: S('Backlog'), [S('In Review')]: S('Active') },
        })
      ).json(),
    ).toEqual({ error: 'invalid_request', detail: 'statusMapping' });
    expect((await view(bugNew)).status.name).toBe('New');
    // One target for every type, and another for Chore alone.
    const switched = await patch('admin', `/api/v1/tracks/${tracks.SWT}`, {
      workflowMapId: maps.split,
      statusMapping: { [S('New')]: S('Open'), [S('In Review')]: S('Active') },
      typeStatusMapping: { [T('Chore')]: { [S('In Review')]: S('Backlog') } },
    });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json().track.workflowMapId).toBe(maps.split);
    expect(switched.json().statusMigration).toMatchObject({
      status: 'done',
      total: 2,
      migrated: 2,
    });
    expect((await view(bugNew)).status.name).toBe('Open');
    expect((await view(bugActive)).status.name).toBe('Active');
    expect((await view(chore)).status.name).toBe('Backlog');
    expect((await view(feature)).status.name).toBe('New');
    const moves = await history(bugNew);
    expect(moves.at(-1)).toMatchObject({
      actor: { id: users.admin?.id },
      from: { display: 'New' },
      to: { display: 'Open' },
    });
    expect(await offered(chore)).toEqual(['Pick']);
    // The request is audited with its migration.
    const event = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'track.updated')
      .where('subject_id', '=', String(tracks.SWT))
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      changes: { workflowMapId: { from: null, to: maps.split } },
      statusMapped: 2,
      statusMigrationId: switched.json().statusMigration.id,
    });
    const progress = await get(
      'admin',
      `/api/v1/workflow-migrations/${switched.json().statusMigration.id}`,
    );
    expect(progress.json().statusMigration).toMatchObject({
      status: 'done',
      reason: 'track_map',
      trackId: tracks.SWT,
      total: 2,
      migrated: 2,
      pending: 0,
    });
    expect(
      (await get('alice', `/api/v1/workflow-migrations/${switched.json().statusMigration.id}`))
        .statusCode,
    ).toBe(404);
  });

  it('[WF-001] migrates a shared map change in the background; tickets keep working meanwhile', async () => {
    const shared = await newMap('Shared later', flows.default);
    await newTrack('BGA', shared);
    await newTrack('BGB', shared);
    await seed('BGA', 'Bug', 'In Review', IN_REQUEST_TICKETS + 60);
    await seed('BGB', 'Bug', 'In Review', 5);
    await seed('BGB', 'Chore', 'In Review', 3);
    const total = IN_REQUEST_TICKETS + 65;
    const change = { entries: [{ ticketTypeId: T('Bug'), workflowId: flows.bug }] };

    const impact = await post('admin', `/api/v1/workflow-maps/${shared}/impact`, change);
    expect(impact.statusCode, impact.body).toBe(200);
    expect(impact.json().impact).toMatchObject({
      tracks: [{ key: 'BGA' }, { key: 'BGB' }],
      types: [{ ticketType: { name: 'Bug' }, ticketCount: total, to: { name: 'Bug flow' } }],
      lostStatuses: [
        { ticketType: { name: 'Bug' }, status: { name: 'In Review' }, ticketCount: total },
      ],
      ticketCount: total,
    });
    expect((await patch('admin', `/api/v1/workflow-maps/${shared}`, change)).json()).toMatchObject({
      error: 'status_mapping_required',
      statuses: [{ ticketTypeId: T('Bug'), statusId: S('In Review'), ticketCount: total }],
    });
    const changed = await patch('admin', `/api/v1/workflow-maps/${shared}`, {
      ...change,
      statusMapping: { [S('In Review')]: S('Active') },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().workflowMap.entries).toEqual([
      { ticketType: { id: T('Bug'), name: 'Bug' }, workflow: { id: flows.bug, name: 'Bug flow' } },
    ]);
    const migration = changed.json().statusMigration as {
      id: number;
      status: string;
      total: number;
    };
    expect(migration).toMatchObject({ status: 'queued', total, migrated: 0 });
    // The change is in force at once; the tickets are not moved yet.
    expect(await statusCount('BGA', 'Bug', 'In Review')).toBe(IN_REQUEST_TICKETS + 60);
    expect((await create('BGA', 'Bug')).status.name).toBe('Open');

    // A ticket not reached yet offers what its mapped status offers, and a transition moves it
    // there first, as the migration would, then on.
    const [first, second] = await database.db
      .selectFrom('ticket')
      .select('id')
      .where('track_id', '=', tracks.BGB as number)
      .where('ticket_type_id', '=', T('Bug'))
      .where('status_id', '=', S('In Review'))
      .orderBy('id')
      .limit(2)
      .execute();
    expect(await offered(first as { id: number })).toEqual(['Fix']);
    // A refused transition changes nothing: the ticket waits for the migration.
    expect((await transition(second as { id: number }, 1)).json()).toEqual({
      error: 'transition_unavailable',
      transitionId: 1,
    });
    expect((await view(second as { id: number })).status.name).toBe('In Review');
    const fixed = await transition(first as { id: number }, 2);
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(ticketOf(fixed).status.name).toBe('Closed');
    expect(
      (await history(first as { id: number })).map((c) => [c.from.display, c.to.display]),
    ).toEqual([
      ['In Review', 'Active'],
      ['Active', 'Closed'],
    ]);

    // While it runs, the tracks and workflows it covers keep their configuration.
    const again = await patch('admin', `/api/v1/workflow-maps/${shared}`, { entries: [] });
    expect(again.json()).toEqual({ error: 'status_migration_running', migrationId: migration.id });
    expect(
      (await patch('admin', `/api/v1/tracks/${tracks.BGA}`, { workflowMapId: maps.split })).json(),
    ).toEqual({ error: 'status_migration_running', migrationId: migration.id });
    const bugDefinition = (await get('admin', `/api/v1/workflows/${flows.bug}`)).json().workflow
      .published.definition;
    expect(
      (await put('admin', `/api/v1/workflows/${flows.bug}/draft`, { definition: bugDefinition }))
        .statusCode,
    ).toBe(200);
    expect((await post('admin', `/api/v1/workflows/${flows.bug}/publish`, {})).json()).toEqual({
      error: 'status_migration_running',
      migrationId: migration.id,
    });
    // A rename is no change of workflows.
    expect(
      (await patch('admin', `/api/v1/workflow-maps/${shared}`, { name: 'Shared now' })).statusCode,
    ).toBe(200);
    const running = await get('admin', `/api/v1/workflow-migrations/${migration.id}`);
    expect(running.json().statusMigration).toMatchObject({
      status: 'queued',
      total,
      pending: total,
    });

    await drain();
    const done = (await get('admin', `/api/v1/workflow-migrations/${migration.id}`)).json()
      .statusMigration;
    expect(done).toMatchObject({ status: 'done', total, migrated: total, pending: 0 });
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();
    expect(await statusCount('BGA', 'Bug', 'In Review')).toBe(0);
    expect(await statusCount('BGB', 'Bug', 'In Review')).toBe(0);
    expect(await statusCount('BGA', 'Bug', 'Active')).toBe(IN_REQUEST_TICKETS + 60);
    // Chores keep the default workflow, In Review included.
    expect(await statusCount('BGB', 'Chore', 'In Review')).toBe(3);
    // One history row per ticket moved, in one change set, by the person who asked.
    const rows = await sql<{ n: number; sets: number; actors: number; versions: number }>`
      SELECT count(*)::int AS n, count(DISTINCT change_set)::int AS sets,
             count(DISTINCT actor_id)::int AS actors,
             (SELECT count(*)::int FROM ticket WHERE track_id IN (${tracks.BGA}, ${tracks.BGB})
                AND ticket_type_id = ${T('Bug')} AND version > 1) AS versions
        FROM ticket_change
       WHERE field = 'status' AND from_value = ${String(S('In Review'))}
         AND to_value = ${String(S('Active'))}
         AND ticket_id IN (SELECT id FROM ticket WHERE track_id IN (${tracks.BGA}, ${tracks.BGB}))`.execute(
      database.db,
    );
    expect(rows.rows[0]).toEqual({ n: total, sets: 1, actors: 1, versions: total });
    // The workflows are free again.
    expect((await post('admin', `/api/v1/workflows/${flows.bug}/publish`, {})).statusCode).toBe(
      200,
    );
    const event = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'workflow_map.updated')
      .where('subject_id', '=', String(shared))
      .orderBy('id')
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ statusMapped: total, statusMigrationId: migration.id });
  });

  it('[WF-001] runs bulk transitions through each ticket type workflow', async () => {
    const bug = await create('MIX', 'Bug');
    const chore = await create('MIX', 'Chore');
    await transition(bug, 1);
    await transition(chore, 6);
    const res = await post('alice', '/api/v1/bulk-operations', {
      action: 'transition',
      tickets: [bug.id, chore.id],
      transition: { statusId: S('Closed') },
    });
    expect(res.statusCode, res.body).toBe(202);
    await drain();
    const operation = (
      await get('alice', `/api/v1/bulk-operations/${res.json().bulkOperation.id}`)
    ).json().bulkOperation;
    expect(operation).toMatchObject({ status: 'done', succeeded: 2, failed: 0 });
    expect((await view(bug)).status.name).toBe('Closed');
    expect((await view(chore)).status.name).toBe('Closed');
  });

  it('[WF-001] lets a local-mode track own its map and workflows, and nothing leaks', async () => {
    await newTrack('LOC', undefined, 'local');
    await newTrack('LOC2', undefined, 'local');
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: tracks.LOC as number,
        role_id: roles.Administrators as number,
        user_id: users.erin?.id as number,
      })
      .execute();
    const own = await get('erin', `/api/v1/tracks/${tracks.LOC}/workflow-map`);
    expect(own.statusCode, own.body).toBe(200);
    const mapId = own.json().workflowMap.id as number;
    expect(own.json().workflowMap).toMatchObject({
      name: 'LOC workflows',
      trackId: tracks.LOC,
      defaultWorkflow: { id: flows.default },
      entries: [],
      tracks: [{ key: 'LOC' }],
    });
    // Its administrator makes a workflow of the track's own and gives it to Chore.
    const local = await newWorkflow(
      'erin',
      'Local chores',
      definition(
        [S('Draft'), S('Published')],
        [{ id: 1, name: 'Publish', from: [S('Draft')], to: S('Published') }],
      ),
      tracks.LOC,
    );
    expect((await get('erin', `/api/v1/workflows/${local}`)).json().workflow.trackId).toBe(
      tracks.LOC,
    );
    expect(
      (
        (await get('erin', `/api/v1/workflows?trackId=${tracks.LOC}`)).json().workflows as Named[]
      ).map((w) => w.name),
    ).toContain('Local chores');
    expect((await get('erin', '/api/v1/workflows')).statusCode).toBe(403);
    const before = await create('LOC', 'Chore');
    expect(before.status.name).toBe('New');
    const set = await patch('erin', `/api/v1/workflow-maps/${mapId}`, {
      entries: [{ ticketTypeId: T('Chore'), workflowId: local }],
      statusMapping: { [S('New')]: S('Draft') },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().statusMigration).toMatchObject({ status: 'done', total: 1 });
    expect((await view(before)).status.name).toBe('Draft');
    expect((await create('LOC', 'Chore')).status.name).toBe('Draft');
    expect(await offered(before)).toEqual(['Publish']);
    // Its administrator changes its workflow and nothing else.
    expect(
      (await patch('erin', `/api/v1/workflows/${local}`, { description: 'Ours' })).statusCode,
    ).toBe(200);
    expect(
      (await patch('erin', `/api/v1/workflows/${flows.bug}`, { description: 'Theirs' })).statusCode,
    ).toBe(403);
    expect(
      (await patch('erin', `/api/v1/workflow-maps/${maps.split}`, { name: 'Mine' })).statusCode,
    ).toBe(403);
    expect((await get('erin', `/api/v1/tracks/${tracks.LOC2}/workflow-map`)).statusCode).toBe(404);
    // Another track's map, and shared ones, cannot name it.
    const other = (await get('admin', `/api/v1/tracks/${tracks.LOC2}/workflow-map`)).json()
      .workflowMap.id;
    expect(
      (
        await patch('admin', `/api/v1/workflow-maps/${other}`, {
          entries: [{ ticketTypeId: T('Chore'), workflowId: local }],
        })
      ).json(),
    ).toEqual({ error: 'invalid_request', detail: 'workflowId' });
    expect(
      (
        await post('admin', '/api/v1/workflow-maps', { name: 'Leaky', defaultWorkflowId: local })
      ).json(),
    ).toEqual({ error: 'invalid_request', detail: 'workflowId' });
    // A local-mode track keeps its own map; a shared-mode track uses shared workflows only.
    expect(
      (await patch('admin', `/api/v1/tracks/${tracks.LOC}`, { workflowMapId: maps.split })).json(),
    ).toEqual({
      error: 'invalid_request',
      detail: 'a local-mode track keeps its own workflow map',
    });
    expect(
      (
        await post('admin', '/api/v1/workflows', {
          name: 'Shared track own',
          definition: definition([S('New')], []),
          trackId: tracks.MIX,
        })
      ).json(),
    ).toEqual({ error: 'invalid_request', detail: 'a shared-mode track uses shared workflows' });
    expect((await del('admin', `/api/v1/workflow-maps/${mapId}`)).json()).toEqual({
      error: 'owned_by_track',
    });
    // Its workflow stays while its map names it.
    expect((await del('erin', `/api/v1/workflows/${local}`)).json()).toMatchObject({
      error: 'workflow_in_use',
      tracks: [{ key: 'LOC' }],
      maps: [{ id: mapId, trackId: tracks.LOC }],
    });
  });

  it('[WF-002] lists shared maps, shows what uses a workflow, and keeps what is in use', async () => {
    expect((await get('alice', '/api/v1/workflow-maps')).statusCode).toBe(403);
    const list = (await get('admin', '/api/v1/workflow-maps')).json().workflowMaps as (Named & {
      isDefault: boolean;
      trackCount: number;
      entryCount: number;
    })[];
    expect(list[0]).toMatchObject({ name: 'Default workflow map', isDefault: true });
    expect(list.find((m) => m.id === maps.split)).toMatchObject({ entryCount: 2 });
    expect(list.some((m) => m.name === 'LOC workflows')).toBe(false);
    // "Used by" comes from the maps that name a workflow.
    const bug = (await get('admin', `/api/v1/workflows/${flows.bug}`)).json().workflow;
    expect(bug.tracks.map((t: { key: string }) => t.key)).toEqual(
      expect.arrayContaining(['MIX', 'SWT']),
    );
    expect(bug.maps.map((m: Named) => m.id)).toContain(maps.split);
    const listed = (await get('admin', '/api/v1/workflows')).json().workflows as (Named & {
      trackCount: number;
    })[];
    expect(listed.find((w) => w.id === flows.chore)?.trackCount).toBeGreaterThanOrEqual(2);
    expect((await del('admin', `/api/v1/workflows/${flows.chore}`)).json()).toMatchObject({
      error: 'workflow_in_use',
      maps: expect.arrayContaining([expect.objectContaining({ id: maps.split })]),
    });
    expect((await del('admin', `/api/v1/workflow-maps/${maps.split}`)).json()).toMatchObject({
      error: 'workflow_map_in_use',
      tracks: expect.arrayContaining([expect.objectContaining({ key: 'MIX' })]),
    });
    const defaultMap = list[0]?.id as number;
    expect((await del('admin', `/api/v1/workflow-maps/${defaultMap}`)).json()).toEqual({
      error: 'default_map',
    });
    expect(
      (
        await post('admin', '/api/v1/workflow-maps', {
          name: 'split',
          defaultWorkflowId: flows.bug,
        })
      ).json(),
    ).toEqual({
      error: 'name_taken',
    });
    expect(
      (
        await post('admin', '/api/v1/workflow-maps', {
          name: 'Twice',
          defaultWorkflowId: flows.bug,
          entries: [
            { ticketTypeId: T('Bug'), workflowId: flows.bug },
            { ticketTypeId: T('Bug'), workflowId: flows.chore },
          ],
        })
      ).statusCode,
    ).toBe(400);
    // An unused map goes.
    const spare = await newMap('Spare', flows.bug);
    expect((await get('admin', `/api/v1/workflow-maps/${spare}`)).json().workflowMap).toMatchObject(
      {
        name: 'Spare',
        tracks: [],
      },
    );
    expect((await del('admin', `/api/v1/workflow-maps/${spare}`)).statusCode).toBe(204);
    expect((await get('admin', `/api/v1/workflow-maps/${spare}`)).statusCode).toBe(404);
  });
});
