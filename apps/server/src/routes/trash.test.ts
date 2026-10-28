import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { JobRunner } from '../events/queue';
import { purgeExpired, registerTrashJobs, schedulePurge } from '../trash/purge';

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

interface TicketJson {
  id: number;
  key: string;
  parent: { id: number; key: string | null } | null;
  trash: { deletedAt: string; purgeAfter: string; deletedWith: { id: number } | null } | null;
}

const DAY = 86_400_000;

/**
 * The trash beyond delete and restore (M1-101; CORE-025 (3)): the retention setting, the
 * purge (tickets with what cannot outlive them, tracks with everything in them) and the trash
 * for tracks.
 */
describe('the trash (M1-101)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const types: Record<string, number> = {};
  const roles: Record<string, number> = {};
  let blocks = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const get = (who: string, url: string) => as(who, { method: 'GET', url });
  const post = (who: string, url: string, payload?: Record<string, unknown>) =>
    as(who, { method: 'POST', url, ...(payload ? { payload } : {}) });
  const put = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'PUT', url, payload });
  const patch = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'PATCH', url, payload });
  const del = (who: string, url: string) => as(who, { method: 'DELETE', url });
  const ticketOf = (res: LightMyRequestResponse) => res.json().ticket as TicketJson;

  async function create(body: Record<string, unknown>): Promise<TicketJson> {
    const res = await post('alice', '/api/v1/tickets', body);
    expect(res.statusCode, res.body).toBe(201);
    return ticketOf(res);
  }
  async function link(from: TicketJson, to: TicketJson) {
    const res = await post('alice', `/api/v1/tickets/${from.key}/links`, {
      linkTypeId: blocks,
      ticket: to.key,
    });
    expect(res.statusCode, res.body).toBe(201);
  }
  async function newTrack(key: string, extra: Record<string, unknown> = {}) {
    const res = await post('admin', '/api/v1/tracks', { key, name: key, mode: 'shared', ...extra });
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
    return tracks[key] as number;
  }
  /** Moves a deletion back in time, as if it happened `days` ago. */
  async function deletedDaysAgo(table: 'ticket' | 'track', ids: number[], days: number) {
    await database.db
      .updateTable(table)
      .set({ deleted_at: new Date(Date.now() - days * DAY) })
      .where('id', 'in', ids)
      .execute();
  }
  const exists = async (ticketId: number) =>
    (await database.db
      .selectFrom('ticket')
      .select('id')
      .where('id', '=', ticketId)
      .executeTakeFirst()) !== undefined;
  const historyOf = (ticketId: number) =>
    database.db
      .selectFrom('ticket_change')
      .select(['field', 'from_value', 'to_value', 'from_display', 'to_display', 'actor_id'])
      .where('ticket_id', '=', ticketId)
      .orderBy('id')
      .execute();
  const events = (type: string) =>
    database.db
      .selectFrom('domain_event')
      .select(['subject_id', 'payload', 'actor_id'])
      .where('type', '=', type as never)
      .orderBy('id')
      .execute();

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['config', false],
      ['alice', false],
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
    await database.db
      .insertInto('global_grant')
      .values({
        workspace_id: 1,
        permission: 'configuration_admin',
        grantee: 'user',
        user_id: users.config?.id as number,
      })
      .execute();
    for (const role of await database.db.selectFrom('role').select(['id', 'name']).execute()) {
      roles[role.name] = role.id;
    }
    for (const type of await database.db
      .selectFrom('ticket_type')
      .select(['id', 'name'])
      .where('owner_track_id', 'is', null)
      .execute()) {
      types[type.name] = type.id;
    }
    blocks = (
      await database.db
        .selectFrom('link_type')
        .select('id')
        .where('name', '=', 'Blocks')
        .executeTakeFirstOrThrow()
    ).id;
    await newTrack('ABC');
    await newTrack('XYZ');
  });
  afterAll(async () => {
    await app.close();
  });

  describe('retention', () => {
    it('[CORE-025] lets site administrators set the retention between 1 and 365 days, 30 by default', async () => {
      expect((await get('admin', '/api/v1/admin/trash-policy')).json()).toEqual({
        retentionDays: 30,
        limits: { min: 1, max: 365, default: 30 },
      });
      expect((await get('config', '/api/v1/admin/trash-policy')).statusCode).toBe(403);
      for (const retentionDays of [0, 366, 7.5, '7']) {
        const res = await put('admin', '/api/v1/admin/trash-policy', { retentionDays });
        expect(res.statusCode, String(retentionDays)).toBe(400);
      }
      expect(
        (await put('alice', '/api/v1/admin/trash-policy', { retentionDays: 7 })).statusCode,
      ).toBe(403);

      const ticket = await create({ track: 'ABC', summary: 'Shown with its purge date' });
      expect((await del('admin', `/api/v1/tickets/${ticket.key}`)).statusCode).toBe(204);
      const before = ticketOf(await get('admin', `/api/v1/tickets/${ticket.key}`)).trash;
      expect(Date.parse(before?.purgeAfter ?? '') - Date.parse(before?.deletedAt ?? '')).toBe(
        30 * DAY,
      );

      const res = await put('admin', '/api/v1/admin/trash-policy', { retentionDays: 7 });
      expect(res.json()).toMatchObject({ retentionDays: 7 });
      // The purge date follows the setting, also for what is already in the trash.
      const after = ticketOf(await get('admin', `/api/v1/tickets/${ticket.key}`)).trash;
      expect(Date.parse(after?.purgeAfter ?? '') - Date.parse(after?.deletedAt ?? '')).toBe(
        7 * DAY,
      );
      const [event] = (await events('trash_policy.updated')).slice(-1);
      expect(event?.payload).toEqual({ changes: { retentionDays: { from: 30, to: 7 } } });
      // The same value again changes nothing and records nothing.
      await put('admin', '/api/v1/admin/trash-policy', { retentionDays: 7 });
      expect(await events('trash_policy.updated')).toHaveLength(1);
      await put('admin', '/api/v1/admin/trash-policy', { retentionDays: 30 });
      await post('admin', `/api/v1/tickets/${ticket.key}/restore`);
    });

    it('[CORE-025] restores within the retention with history, links, subtickets and children', async () => {
      const outcome = await create({
        track: 'ABC',
        summary: 'An outcome',
        ticketTypeId: types.Outcome,
      });
      const feature = await create({ track: 'XYZ', summary: 'Its feature', parent: outcome.key });
      const part = await create({
        track: 'XYZ',
        summary: 'A part',
        ticketTypeId: types.Subticket,
        parent: feature.key,
      });
      const other = await create({ track: 'ABC', summary: 'Blocked by the feature' });
      await link(feature, other);
      await patch('alice', `/api/v1/tickets/${feature.key}`, { summary: 'Its feature, renamed' });
      const history = await historyOf(feature.id);

      // The feature goes with its part; the outcome goes too, a week later.
      expect((await del('admin', `/api/v1/tickets/${feature.key}`)).statusCode).toBe(204);
      expect((await del('admin', `/api/v1/tickets/${outcome.key}`)).statusCode).toBe(204);
      await deletedDaysAgo('ticket', [feature.id, part.id], 29);
      // 29 days in: nothing has outlived the 30-day retention.
      expect(await purgeExpired(database.db)).toEqual({ tickets: 0, tracks: 0, more: false });
      const links = (await get('admin', `/api/v1/tickets/${other.key}`)).statusCode;
      expect(links).toBe(200);
      expect((await get('admin', `/api/v1/tickets/${other.key}/links`)).json().links).toHaveLength(
        0,
      );

      expect((await post('admin', `/api/v1/tickets/${outcome.key}/restore`)).statusCode).toBe(200);
      const restored = await post('admin', `/api/v1/tickets/${feature.key}/restore`);
      expect(restored.statusCode, restored.body).toBe(200);
      // The part, the parent link, the history and the link all came back.
      const back = ticketOf(restored);
      expect(back.trash).toBeNull();
      expect(back.parent?.id).toBe(outcome.id);
      expect(ticketOf(await get('alice', `/api/v1/tickets/${part.key}`)).trash).toBeNull();
      const now = await historyOf(feature.id);
      expect(now.slice(0, history.length)).toEqual(history);
      expect(now.slice(history.length).map((h) => h.field)).toEqual(['trash', 'trash']);
      const links2 = (await get('alice', `/api/v1/tickets/${other.key}/links`)).json().links;
      expect(links2).toHaveLength(1);
    });
  });

  describe('the purge', () => {
    it('[CORE-025] deletes for good what outlived the retention, with history, links and subtickets, and tells the tickets that stay', async () => {
      const outcome = await create({
        track: 'ABC',
        summary: 'Old outcome',
        ticketTypeId: types.Outcome,
      });
      const child = await create({ track: 'XYZ', summary: 'Stays', parent: outcome.key });
      const doomed = await create({ track: 'ABC', summary: 'Doomed', parent: outcome.key });
      const part = await create({
        track: 'ABC',
        summary: 'Doomed part',
        ticketTypeId: types.Subticket,
        parent: doomed.key,
      });
      const survivor = await create({ track: 'XYZ', summary: 'Survivor' });
      await link(doomed, survivor);
      await link(survivor, part);
      const recent = await create({ track: 'ABC', summary: 'Deleted yesterday' });
      await post('alice', `/api/v1/tickets/${doomed.key}/followers/me`);

      // The doomed feature first (its part goes along), then the outcome: the child elsewhere
      // loses its parent at that point already.
      expect((await del('admin', `/api/v1/tickets/${doomed.key}`)).statusCode).toBe(204);
      expect((await del('admin', `/api/v1/tickets/${outcome.key}`)).statusCode).toBe(204);
      expect((await del('admin', `/api/v1/tickets/${recent.key}`)).statusCode).toBe(204);
      await deletedDaysAgo('ticket', [doomed.id, part.id], 32);
      await deletedDaysAgo('ticket', [outcome.id], 31);
      await deletedDaysAgo('ticket', [recent.id], 1);
      const survivorHistory = (await historyOf(survivor.id)).length;

      const report = await purgeExpired(database.db);
      expect(report).toEqual({ tickets: 3, tracks: 0, more: false });
      expect(await exists(doomed.id)).toBe(false);
      expect(await exists(part.id)).toBe(false);
      expect(await exists(outcome.id)).toBe(false);
      expect(await exists(recent.id)).toBe(true);
      expect(await exists(child.id)).toBe(true);
      // Everything of theirs went with them.
      for (const table of [
        'ticket_change',
        'ticket_follower',
        'ticket_key_history',
        'ticket_detached_parent',
      ] as const) {
        const { rows } = await sql<{ n: string }>`
          SELECT count(*) AS n FROM ${sql.table(table)}
           WHERE ticket_id = ANY(${[doomed.id, part.id, outcome.id]}::int[])`.execute(database.db);
        expect(Number(rows[0]?.n), table).toBe(0);
      }
      const { rows: links } = await sql<{ n: string }>`
        SELECT count(*) AS n FROM ticket_link
         WHERE source_id = ANY(${[doomed.id, part.id]}::int[])
            OR target_id = ANY(${[doomed.id, part.id]}::int[])`.execute(database.db);
      expect(Number(links[0]?.n)).toBe(0);
      // The survivor records both links it lost, by the system.
      const lost = (await historyOf(survivor.id)).slice(survivorHistory);
      expect(lost).toEqual([
        {
          field: 'link',
          from_value: `${blocks}:inward:${doomed.id}`,
          to_value: null,
          from_display: `is blocked by ${doomed.key}`,
          to_display: null,
          actor_id: null,
        },
        {
          field: 'link',
          from_value: `${blocks}:outward:${part.id}`,
          to_value: null,
          from_display: `blocks ${part.key}`,
          to_display: null,
          actor_id: null,
        },
      ]);
      // A key of a purged ticket answers nothing any more.
      expect((await get('admin', `/api/v1/tickets/${doomed.key}`)).statusCode).toBe(404);
      // One audited event per ticket purged, naming what went with it.
      const purged = await events('ticket.purged');
      expect(purged.map((e) => [e.subject_id, e.payload, e.actor_id])).toEqual([
        [
          String(doomed.id),
          { key: doomed.key, subtickets: [part.id], detachedChildren: [], reason: 'retention' },
          null,
        ],
        [
          String(outcome.id),
          { key: outcome.key, subtickets: [], detachedChildren: [], reason: 'retention' },
          null,
        ],
      ]);
      await post('admin', `/api/v1/tickets/${recent.key}/restore`);
    });

    it('[CORE-025] detaches children elsewhere that still point at a purged parent', async () => {
      const outcome = await create({
        track: 'ABC',
        summary: 'Parent',
        ticketTypeId: types.Outcome,
      });
      const late = await create({ track: 'XYZ', summary: 'Deleted first', parent: outcome.key });
      // The child goes to the trash first and keeps its parent; then the parent goes and is
      // purged by an administrator at once.
      expect((await del('admin', `/api/v1/tickets/${late.key}`)).statusCode).toBe(204);
      expect((await del('admin', `/api/v1/tickets/${outcome.key}`)).statusCode).toBe(204);
      const res = await post('admin', `/api/v1/tickets/${outcome.key}/purge`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().purged).toMatchObject({ key: outcome.key, detachedChildren: [late.id] });
      const back = await post('admin', `/api/v1/tickets/${late.key}/restore`);
      expect(back.statusCode, back.body).toBe(200);
      expect(ticketOf(back).parent).toBeNull();
      const last = (await historyOf(late.id)).filter((h) => h.field === 'parent').slice(-1)[0];
      expect(last).toMatchObject({ from_value: String(outcome.id), to_value: null });
    });

    it('[CORE-025] lets only site administrators purge one ticket early, and only from the trash', async () => {
      const feature = await create({ track: 'ABC', summary: 'Purged early' });
      const part = await create({
        track: 'ABC',
        summary: 'Its part',
        ticketTypeId: types.Subticket,
        parent: feature.key,
      });
      expect((await post('admin', `/api/v1/tickets/${feature.key}/purge`)).json()).toEqual({
        error: 'not_in_trash',
      });
      expect((await del('admin', `/api/v1/tickets/${feature.key}`)).statusCode).toBe(204);
      expect((await post('config', `/api/v1/tickets/${feature.key}/purge`)).statusCode).toBe(403);
      expect((await post('alice', `/api/v1/tickets/${feature.key}/purge`)).statusCode).toBe(403);
      expect((await post('admin', `/api/v1/tickets/${part.key}/purge`)).json()).toEqual({
        error: 'deleted_with_parent',
      });
      expect((await post('admin', '/api/v1/tickets/ABC-99999/purge')).statusCode).toBe(404);
      const res = await post('admin', `/api/v1/tickets/${feature.key}/purge`);
      expect(res.json().purged).toEqual({
        id: feature.id,
        key: feature.key,
        subtickets: [part.id],
        detachedChildren: [],
      });
      expect(await exists(part.id)).toBe(false);
      const [event] = (await events('ticket.purged')).slice(-1);
      expect(event).toMatchObject({
        subject_id: String(feature.id),
        actor_id: users.admin?.id,
        payload: { reason: 'admin' },
      });
    });

    it('[CORE-025] purges in batches, one event per ticket, and carries on in the next run', async () => {
      const many = [];
      for (let i = 0; i < 25; i++) many.push(await create({ track: 'XYZ', summary: `Bulk ${i}` }));
      for (const t of many)
        expect((await del('admin', `/api/v1/tickets/${t.id}`)).statusCode).toBe(204);
      await deletedDaysAgo(
        'ticket',
        many.map((t) => t.id),
        40,
      );
      const before = (await events('ticket.purged')).length;
      // Two batches of 7 in the first run, the rest in the next.
      expect(await purgeExpired(database.db, { batchSize: 7, maxBatches: 2 })).toEqual({
        tickets: 14,
        tracks: 0,
        more: true,
      });
      // A run past its deadline stops before the next batch and says there is more.
      expect(await purgeExpired(database.db, { batchSize: 7, deadline: Date.now() - 1 })).toEqual({
        tickets: 0,
        tracks: 0,
        more: true,
      });
      expect(await purgeExpired(database.db, { batchSize: 7 })).toEqual({
        tickets: 11,
        tracks: 0,
        more: false,
      });
      expect((await events('ticket.purged')).length - before).toBe(25);
      for (const t of many) expect(await exists(t.id)).toBe(false);
    });
  });

  describe('the purge job', () => {
    it('[CORE-025] runs once an hour in the worker and empties what outlived the retention', async () => {
      const old = await create({ track: 'XYZ', summary: 'Purged by the job' });
      expect((await del('admin', `/api/v1/tickets/${old.key}`)).statusCode).toBe(204);
      await deletedDaysAgo('ticket', [old.id], 31);
      const hour = new Date('2026-10-28T10:15:00Z');
      expect(await schedulePurge(database.db, hour)).toBe(true);
      // Every worker asks; one job per hour runs.
      expect(await schedulePurge(database.db, new Date('2026-10-28T10:55:00Z'))).toBe(false);
      const runner = new JobRunner(database.db, 'test-worker');
      const reports: unknown[] = [];
      registerTrashJobs(runner, database.db, (report) => reports.push(report));
      expect(await runner.runOnce()).toBe(1);
      expect(await exists(old.id)).toBe(false);
      expect(reports).toEqual([{ tickets: 1, tracks: 0, more: false }]);
    });
  });

  describe('tracks in the trash', () => {
    it('[CORE-025] hides a deleted track and everything in it from everyone but administrators, and brings it back as it was', async () => {
      const id = await newTrack('TRA');
      const live = await create({ track: 'TRA', summary: 'Lives in TRA' });
      const binned = await create({ track: 'TRA', summary: 'Already in the ticket trash' });
      expect((await del('admin', `/api/v1/tickets/${binned.key}`)).statusCode).toBe(204);
      const release = await post('admin', `/api/v1/tracks/${id}/releases`, { name: '1.0' });
      expect(release.statusCode, release.body).toBe(201);

      // Configuration administrators delete tracks; track members do not.
      expect((await del('alice', `/api/v1/tracks/${id}`)).statusCode).toBe(403);
      expect((await del('config', `/api/v1/tracks/${id}`)).statusCode).toBe(204);
      expect((await del('config', `/api/v1/tracks/${id}`)).json()).toEqual({ error: 'in_trash' });
      const [deleted] = (await events('track.deleted')).slice(-1);
      expect(deleted).toMatchObject({ subject_id: String(id), payload: { key: 'TRA' } });

      // Gone for the members, and for everything the administrators reach through routes.
      expect((await get('alice', `/api/v1/tracks/${id}`)).statusCode).toBe(404);
      for (const who of ['alice', 'admin']) {
        const list = (await get(who, '/api/v1/tracks?limit=500')).json().tracks as {
          key: string;
        }[];
        expect(list.map((t) => t.key)).not.toContain('TRA');
        expect((await get(who, `/api/v1/tickets/${live.key}`)).statusCode).toBe(404);
        const tickets = (await get(who, '/api/v1/tickets?limit=200')).json()
          .tickets as TicketJson[];
        expect(tickets.map((t) => t.id)).not.toContain(live.id);
        const trash = (await get(who, '/api/v1/trash?limit=200')).json().tickets as TicketJson[];
        expect(trash.map((t) => t.id)).not.toContain(binned.id);
      }
      expect(
        (await get('admin', '/api/v1/tracks?archived=include&limit=500')).json().tracks,
      ).not.toContainEqual(expect.objectContaining({ key: 'TRA' }));
      expect((await get('admin', `/api/v1/tracks/${id}/releases`)).statusCode).toBe(404);
      expect((await get('admin', `/api/v1/tracks/${id}/ticket-types`)).statusCode).toBe(404);
      expect((await get('admin', `/api/v1/tracks/${id}/role-actors`)).statusCode).toBe(404);
      expect((await patch('admin', `/api/v1/tracks/${id}`, { name: 'Renamed' })).statusCode).toBe(
        404,
      );
      expect((await post('admin', `/api/v1/tracks/${id}/archive`)).statusCode).toBe(404);
      // A track nobody may see is no track to create in.
      expect(
        (await post('alice', '/api/v1/tickets', { track: 'TRA', summary: 'No' })).json(),
      ).toEqual({
        error: 'invalid_fields',
        fields: { track: 'not_found' },
      });
      // Its key stays taken while it may come back.
      expect(
        (
          await post('admin', '/api/v1/tracks', { key: 'TRA', name: 'Again', mode: 'shared' })
        ).json(),
      ).toEqual({ error: 'key_taken' });
      // Nobody holds anything there, site administrators included.
      const authorizer = new Authorizer(database.db);
      expect([
        ...(await authorizer.trackPermissions(1, { userId: users.admin?.id as number }, id)),
      ]).toEqual([]);
      expect(
        await authorizer.allowedTracks(1, { userId: users.admin?.id as number }),
      ).not.toContain(id);
      expect(
        await authorizer.allowedTracks(
          1,
          { userId: users.admin?.id as number },
          'browse_track',
          undefined,
          {
            includeArchived: true,
          },
        ),
      ).not.toContain(id);
      expect(
        (await authorizer.explain(1, { userId: users.admin?.id as number }, id, 'browse_track'))
          .trackInTrash,
      ).toBe(true);

      // Administrators see it, in the trash list and by id.
      expect((await get('alice', '/api/v1/trash/tracks')).statusCode).toBe(403);
      const listed = (await get('config', '/api/v1/trash/tracks')).json().tracks;
      expect(listed).toEqual([
        expect.objectContaining({
          id,
          key: 'TRA',
          ticketCount: 2,
          trash: expect.objectContaining({
            deletedBy: { id: users.config?.id, name: 'config' },
            purging: false,
          }),
        }),
      ]);
      const viewed = (await get('admin', `/api/v1/tracks/${id}`)).json().track;
      expect(Date.parse(viewed.trash.purgeAfter) - Date.parse(viewed.trash.deletedAt)).toBe(
        30 * DAY,
      );

      // Undeleting brings it back exactly as it was: the ticket in the ticket trash stays there.
      expect((await post('alice', `/api/v1/tracks/${id}/undelete`)).statusCode).toBe(403);
      const back = await post('config', `/api/v1/tracks/${id}/undelete`);
      expect(back.statusCode, back.body).toBe(200);
      expect(back.json().track).toMatchObject({ key: 'TRA', trash: null });
      expect((await post('config', `/api/v1/tracks/${id}/undelete`)).json()).toEqual({
        error: 'not_in_trash',
      });
      expect((await get('alice', `/api/v1/tickets/${live.key}`)).statusCode).toBe(200);
      expect(ticketOf(await get('admin', `/api/v1/tickets/${binned.key}`)).trash).not.toBeNull();
      expect((await get('alice', `/api/v1/tracks/${id}/releases`)).json().releases).toHaveLength(1);
      expect([
        ...(await authorizer.trackPermissions(1, { userId: users.admin?.id as number }, id)),
      ]).not.toEqual([]);
    });

    it('[CORE-025] purges a track after the retention with its tickets, releases and areas, and frees its key', async () => {
      const id = await newTrack('OLD');
      const outcome = await create({
        track: 'OLD',
        summary: 'Outcome in OLD',
        ticketTypeId: types.Outcome,
      });
      const feature = await create({
        track: 'OLD',
        summary: 'Feature in OLD',
        parent: outcome.key,
      });
      await create({
        track: 'OLD',
        summary: 'Part',
        ticketTypeId: types.Subticket,
        parent: feature.key,
      });
      const elsewhere = await create({
        track: 'XYZ',
        summary: 'Child in XYZ',
        parent: outcome.key,
      });
      const partner = await create({ track: 'XYZ', summary: 'Linked from XYZ' });
      await link(partner, feature);
      const leaver = await create({ track: 'OLD', summary: 'Moves to XYZ' });
      const moved = await post('alice', `/api/v1/tickets/${leaver.key}/move`, { track: 'XYZ' });
      expect(moved.statusCode, moved.body).toBe(200);
      const release = await post('admin', `/api/v1/tracks/${id}/releases`, { name: 'Old 1' });
      const area = await post('admin', `/api/v1/tracks/${id}/areas`, { name: 'Old area' });
      expect([release.statusCode, area.statusCode]).toEqual([201, 201]);
      await patch('alice', `/api/v1/tickets/${feature.key}`, {
        targetReleaseIds: [release.json().release.id],
        areaIds: [area.json().area.id],
      });

      expect((await del('admin', `/api/v1/tracks/${id}`)).statusCode).toBe(204);
      // A day short of the retention it stays.
      await deletedDaysAgo('track', [id], 29);
      expect(await purgeExpired(database.db)).toEqual({ tickets: 0, tracks: 0, more: false });
      await deletedDaysAgo('track', [id], 31);
      expect(await purgeExpired(database.db, { batchSize: 2 })).toEqual({
        tickets: 0,
        tracks: 1,
        more: false,
      });

      const left = await sql<{ name: string; n: string }>`
        SELECT 'track' AS name, count(*) AS n FROM track WHERE id = ${id}
        UNION ALL SELECT 'ticket', count(*) FROM ticket WHERE track_id = ${id}
        UNION ALL SELECT 'release', count(*) FROM release WHERE track_id = ${id}
        UNION ALL SELECT 'area', count(*) FROM area WHERE track_id = ${id}
        UNION ALL SELECT 'track_key_history', count(*) FROM track_key_history WHERE track_id = ${id}
        UNION ALL SELECT 'ticket_key_history', count(*) FROM ticket_key_history WHERE track_id = ${id}
        UNION ALL SELECT 'ticket_counter', count(*) FROM ticket_counter WHERE track_id = ${id}
        UNION ALL SELECT 'track_role_actor', count(*) FROM track_role_actor WHERE track_id = ${id}`.execute(
        database.db,
      );
      expect(Object.fromEntries(left.rows.map((r) => [r.name, Number(r.n)]))).toEqual({
        track: 0,
        ticket: 0,
        release: 0,
        area: 0,
        track_key_history: 0,
        ticket_key_history: 0,
        ticket_counter: 0,
        track_role_actor: 0,
      });
      // What stays elsewhere records the loss; the ticket that moved away keeps its new key.
      expect(ticketOf(await get('alice', `/api/v1/tickets/${elsewhere.key}`)).parent).toBeNull();
      const partnerHistory = await historyOf(partner.id);
      expect(partnerHistory.slice(-1)[0]).toMatchObject({
        field: 'link',
        from_display: `blocks ${feature.key}`,
        to_value: null,
      });
      const movedKey = ticketOf(moved).key;
      expect((await get('alice', `/api/v1/tickets/${movedKey}`)).statusCode).toBe(200);
      expect((await get('alice', `/api/v1/tickets/${leaver.key}`)).statusCode).toBe(404);
      const [purged] = (await events('track.purged')).slice(-1);
      expect(purged).toMatchObject({
        subject_id: String(id),
        actor_id: null,
        payload: { key: 'OLD', name: 'OLD', tickets: 3, reason: 'retention' },
      });
      // The key is free again.
      expect(
        (await post('admin', '/api/v1/tracks', { key: 'OLD', name: 'New old', mode: 'shared' }))
          .statusCode,
      ).toBe(201);
    });

    it('[CORE-025] purges a local-mode track with its own policy, type set and types', async () => {
      const res = await post('admin', '/api/v1/tracks', {
        key: 'LCL',
        name: 'Local',
        mode: 'local',
      });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json().track.id as number;
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: id,
          role_id: roles.Members as number,
          user_id: users.alice?.id as number,
        })
        .execute();
      await create({ track: 'LCL', summary: 'In a local track' });
      expect((await post('admin', `/api/v1/tracks/${id}/purge`)).json()).toEqual({
        error: 'not_in_trash',
      });
      expect((await del('admin', `/api/v1/tracks/${id}`)).statusCode).toBe(204);
      // Configuration administrators send tracks to the trash; only site administrators purge.
      expect((await post('config', `/api/v1/tracks/${id}/purge`)).statusCode).toBe(403);
      const purged = await post('admin', `/api/v1/tracks/${id}/purge`);
      expect(purged.statusCode, purged.body).toBe(200);
      expect(purged.json()).toEqual({ purged: { id, key: 'LCL', tickets: 1 } });
      const owned = await sql<{ n: string }>`
        SELECT (SELECT count(*) FROM access_policy WHERE owner_track_id = ${id})
             + (SELECT count(*) FROM type_set WHERE owner_track_id = ${id})
             + (SELECT count(*) FROM ticket_type WHERE owner_track_id = ${id}) AS n`.execute(
        database.db,
      );
      expect(Number(owned.rows[0]?.n)).toBe(0);
      expect((await get('admin', `/api/v1/tracks/${id}`)).statusCode).toBe(404);
    });

    it('[CORE-025] refuses to undelete a track whose purge has begun', async () => {
      const id = await newTrack('HALF');
      expect((await del('admin', `/api/v1/tracks/${id}`)).statusCode).toBe(204);
      await database.db
        .updateTable('track')
        .set({ purge_started_at: new Date() })
        .where('id', '=', id)
        .execute();
      expect((await post('admin', `/api/v1/tracks/${id}/undelete`)).json()).toEqual({
        error: 'purging',
      });
      expect((await get('admin', '/api/v1/trash/tracks')).json().tracks).toContainEqual(
        expect.objectContaining({ key: 'HALF', trash: expect.objectContaining({ purging: true }) }),
      );
      // The next purge run finishes it, whatever the retention says.
      expect(await purgeExpired(database.db)).toMatchObject({ tracks: 1 });
      expect((await get('admin', `/api/v1/tracks/${id}`)).statusCode).toBe(404);
    });
  });
});
