import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { ticketRoutes } from '../routes/tickets';
import { registerBulkJobs } from './jobs';
import { runBulkOperation } from './run';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.74.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Operation {
  id: number;
  status: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  pending: number;
}
interface Item {
  position: number;
  ref: string;
  key: string | null;
  outcome: string;
  statusCode: number | null;
  error: { error?: string; permission?: string; by?: string } | null;
}

/**
 * Bulk operations (M1-021; CORE-024): a job makes the change ticket by ticket through the
 * ticket routes, as the person who asked. Alice may make bulk changes and is a Member of track
 * BA and a Viewer of BV (and of others, per test); Dave is a Member of BA without the global
 * permission.
 */
describe('bulk operations (M1-021)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let runner: JobRunner;
  let authorizer: Authorizer;
  let catalogs: FieldCatalogs;
  const users: Record<string, { id: number; cookie: string }> = {};
  const roles: Record<string, number> = {};
  const status: Record<string, number> = {};
  const tracks: Record<string, number> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const post = (who: string, url: string, payload?: Record<string, unknown>) =>
    as(who, { method: 'POST', url, ...(payload ? { payload } : {}) });
  const get = (who: string, url: string) => as(who, { method: 'GET', url });

  async function track(key: string, members: [string, string][], workflow?: unknown) {
    const res = await post('admin', '/api/v1/tracks', { key, name: key, mode: 'shared' });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().track.id as number;
    tracks[key] = id;
    for (const [who, role] of members) {
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: id,
          role_id: roles[role] as number,
          user_id: users[who]?.id as number,
        })
        .execute();
    }
    if (workflow) {
      const made = await post('admin', '/api/v1/workflows', {
        name: `Flow ${key}`,
        definition: workflow,
      });
      expect(made.statusCode, made.body).toBe(201);
      const set = await as('admin', {
        method: 'PATCH',
        url: `/api/v1/tracks/${id}`,
        payload: { workflowId: made.json().workflow.id },
      });
      expect(set.statusCode, set.body).toBe(200);
    }
    return id;
  }
  async function tickets(key: string, summaries: string[]): Promise<string[]> {
    const keys: string[] = [];
    for (const summary of summaries) {
      const res = await post('admin', '/api/v1/tickets', { track: key, summary });
      expect(res.statusCode, res.body).toBe(201);
      keys.push(res.json().ticket.key);
    }
    return keys;
  }
  /** Runs queued jobs until none is left, as a worker would. */
  async function drain() {
    for (let i = 0; i < 100; i++) {
      const done = await runner.runOnce();
      if (done === 0) return;
    }
  }
  async function bulk(who: string, body: Record<string, unknown>) {
    const res = await post(who, '/api/v1/bulk-operations', body);
    expect(res.statusCode, res.body).toBe(202);
    return res.json().bulkOperation as Operation;
  }
  const operation = async (id: number, who = 'alice') =>
    (await get(who, `/api/v1/bulk-operations/${id}`)).json().bulkOperation as Operation;
  const items = async (id: number, query = '') =>
    (await get('alice', `/api/v1/bulk-operations/${id}/items${query}`)).json().items as Item[];

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    authorizer = new Authorizer(database.db);
    catalogs = new FieldCatalogs(database.db);
    runner = new JobRunner(database.db, 'bulk-test');
    registerBulkJobs(runner, database.db, authorizer, catalogs);
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['dave', false],
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
    // Everyone signed in may make bulk changes by default; here only Alice may.
    await database.db
      .deleteFrom('global_grant')
      .where('permission', '=', 'bulk_change')
      .where('grantee', '=', 'any_user')
      .execute();
    await database.db
      .insertInto('global_grant')
      .values({
        workspace_id: 1,
        permission: 'bulk_change',
        grantee: 'user',
        group_id: null,
        user_id: users.alice?.id as number,
      })
      .execute();
    for (const role of await database.db.selectFrom('role').select(['id', 'name']).execute()) {
      roles[role.name] = role.id;
    }
    for (const s of (await get('admin', '/api/v1/statuses')).json().statuses as {
      id: number;
      name: string;
    }[]) {
      status[s.name] = s.id;
    }
    await track('BA', [
      ['alice', 'Members'],
      ['dave', 'Members'],
    ]);
    await track('BV', [['alice', 'Viewers']]);
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-024] edits many tickets in one job; those the person may not change are listed with why', async () => {
    const mine = await tickets('BA', ['One', 'Two', 'Three', 'Four', 'Five']);
    const viewed = await tickets('BV', ['Read only', 'Also read only']);
    const op = await bulk('alice', {
      action: 'edit',
      tickets: [...mine, ...viewed, 'NOPE-9'],
      edit: { labels: ['bulk'] },
    });
    expect(op).toMatchObject({ status: 'queued', total: 8, failed: 1, pending: 7 });
    await drain();
    expect(await operation(op.id)).toMatchObject({
      status: 'done',
      succeeded: 5,
      failed: 3,
      skipped: 0,
      pending: 0,
    });
    const failed = await items(op.id, '?outcome=failed');
    expect(failed.map((i) => [i.ref, i.statusCode, i.error?.error, i.error?.permission])).toEqual([
      [viewed[0], 403, 'forbidden', 'edit_tickets'],
      [viewed[1], 403, 'forbidden', 'edit_tickets'],
      ['NOPE-9', 404, 'not_found', undefined],
    ]);
    // Each change is in its ticket's history, by Alice; the request itself is audited.
    const history = await database.db
      .selectFrom('ticket_change')
      .select(['ticket_id', 'actor_id'])
      .where('field', '=', 'labels')
      .execute();
    expect(history.filter((h) => h.actor_id === users.alice?.id)).toHaveLength(5);
    const audited = await database.db
      .selectFrom('domain_event')
      .select(['type', 'actor_id'])
      .where('type', '=', 'bulk_operation.created')
      .execute();
    expect(audited).toContainEqual({ type: 'bulk_operation.created', actor_id: users.alice?.id });
    const done = await items(op.id, '?outcome=done');
    expect(done.map((i) => i.key)).toEqual(mine);
  });

  it('[CORE-024] transitions to a status: tickets a check refuses are listed, the rest move', async () => {
    const S = (name: string) => status[name] as number;
    await track('BT', [['alice', 'Members']], {
      initialStatusId: S('New'),
      statuses: [{ statusId: S('New') }, { statusId: S('Approved') }],
      transitions: [
        {
          id: 1,
          name: 'Approve',
          from: [S('New')],
          to: S('Approved'),
          checks: [{ type: 'regex', field: 'summary', pattern: '^[A-Z]' }],
        },
      ],
    });
    const keys = await tickets('BT', ['Ready', 'Also ready', 'not yet', 'Fine', 'lower']);
    const op = await bulk('alice', {
      action: 'transition',
      tickets: keys,
      transition: { statusId: S('Approved') },
    });
    await drain();
    expect(await operation(op.id)).toMatchObject({ status: 'done', succeeded: 3, failed: 2 });
    const failed = await items(op.id, '?outcome=failed');
    expect(failed.map((i) => [i.ref, i.statusCode, i.error?.error, i.error?.by])).toEqual([
      [keys[2], 409, 'transition_refused', 'check'],
      [keys[4], 409, 'transition_refused', 'check'],
    ]);
    const moved = await database.db
      .selectFrom('ticket')
      .select('status_id')
      .where('track_id', '=', tracks.BT as number)
      .where('status_id', '=', S('Approved'))
      .execute();
    expect(moved).toHaveLength(3);
  });

  it('[CORE-024] moves tickets, and a bulk delete sends them to the trash', async () => {
    await track('BM', [['alice', 'Members']]);
    // Members may not delete tickets; in BD Alice administers the track.
    await track('BD', [['alice', 'Administrators']]);
    const keys = [
      ...(await tickets('BA', ['Move me', 'Me too'])),
      ...(await tickets('BD', ['Bin me', 'Bin me too'])),
    ];
    const moving = await bulk('alice', {
      action: 'move',
      tickets: keys.slice(0, 2),
      move: { track: 'BM' },
    });
    const deleting = await bulk('alice', { action: 'delete', tickets: keys.slice(2) });
    await drain();
    expect(await operation(moving.id)).toMatchObject({ status: 'done', succeeded: 2 });
    expect(await operation(deleting.id)).toMatchObject({ status: 'done', succeeded: 2 });
    const rows = await database.db
      .selectFrom('ticket')
      .select(['summary', 'track_id', 'deleted_at'])
      .where('summary', 'in', ['Move me', 'Me too', 'Bin me', 'Bin me too'])
      .orderBy('id')
      .execute();
    expect(rows.map((r) => [r.summary, r.track_id === tracks.BM, r.deleted_at !== null])).toEqual([
      ['Move me', true, false],
      ['Me too', true, false],
      ['Bin me', false, true],
      ['Bin me too', false, true],
    ]);
  });

  it('[CORE-024] needs Make bulk changes; an operation shows only to its owner and site admins', async () => {
    const [key] = await tickets('BA', ['Guarded']);
    const refused = await post('dave', '/api/v1/bulk-operations', {
      action: 'edit',
      tickets: [key],
      edit: { labels: ['x'] },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'forbidden', permission: 'bulk_change' });
    const op = await bulk('alice', { action: 'edit', tickets: [key], edit: { labels: ['y'] } });
    expect((await get('dave', `/api/v1/bulk-operations/${op.id}`)).statusCode).toBe(404);
    expect((await get('admin', `/api/v1/bulk-operations/${op.id}`)).statusCode).toBe(200);
    const listed = (await get('alice', '/api/v1/bulk-operations')).json().bulkOperations as {
      id: number;
    }[];
    expect(listed[0]?.id).toBe(op.id);
    const bad = await post('alice', '/api/v1/bulk-operations', {
      action: 'edit',
      tickets: [key],
      edit: { version: 3 },
    });
    expect(bad.statusCode).toBe(400);
    await drain();
  });

  it('[CORE-024] a cancel skips what is left; there is no cap at 1,000 tickets', async () => {
    const trackId = tracks.BA as number;
    const type = await database.db
      .selectFrom('ticket')
      .select('ticket_type_id')
      .where('track_id', '=', trackId)
      .executeTakeFirstOrThrow();
    const counter = await database.db
      .selectFrom('ticket_counter')
      .select('last_number')
      .where('track_id', '=', trackId)
      .executeTakeFirstOrThrow();
    const first = counter.last_number + 1;
    await sql`INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary,
          requester_id, creator_id, rank, status_id)
        SELECT 1, ${trackId}, ${first} + g, ${type.ticket_type_id}, 'Many ' || g,
               ${users.admin?.id}, ${users.admin?.id}, 'zbulk' || lpad(g::text, 5, '0'),
               ${status.New}
          FROM generate_series(0, 1199) g`.execute(database.db);
    await sql`UPDATE ticket_counter SET last_number = ${first + 1199} WHERE track_id = ${trackId}`.execute(
      database.db,
    );
    const keys = Array.from({ length: 1200 }, (_, i) => `BA-${first + i}`);

    // A cancel after the first batch: the rest are skipped, nothing more changes.
    const cancelled = await bulk('alice', {
      action: 'edit',
      tickets: keys.slice(0, 120),
      edit: { labels: ['cancelled'] },
    });
    const deps = {
      db: database.db,
      authorizer,
      routes: ticketRoutes(database.db, authorizer, catalogs),
    };
    expect(await runBulkOperation(deps, String(cancelled.id), { until: 0, batch: 50 })).toBe(
      'more',
    );
    const cancel = await post('alice', `/api/v1/bulk-operations/${cancelled.id}/cancel`);
    expect(cancel.statusCode).toBe(202);
    expect(await runBulkOperation(deps, String(cancelled.id), { until: 0 })).toBe('finished');
    expect(await operation(cancelled.id)).toMatchObject({
      status: 'cancelled',
      succeeded: 50,
      skipped: 70,
      pending: 0,
    });
    expect((await post('alice', `/api/v1/bulk-operations/${cancelled.id}/cancel`)).statusCode).toBe(
      409,
    );

    // 1,200 tickets in one operation.
    const many = await bulk('alice', { action: 'edit', tickets: keys, edit: { labels: ['many'] } });
    await drain();
    expect(await operation(many.id)).toMatchObject({
      status: 'done',
      total: 1200,
      succeeded: 1200,
    });
    const labelled = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ticket
       WHERE track_id = ${trackId} AND labels @> ARRAY['many']::text[]`.execute(database.db);
    expect(labelled.rows[0]?.n).toBe(1200);
  }, 300_000);
});
