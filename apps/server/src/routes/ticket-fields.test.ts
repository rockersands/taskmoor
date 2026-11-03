import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.68.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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
  assignee: Named | null;
  priority: (Named & { icon: string | null; color: string | null }) | null;
  closeReason: Named | null;
  closedAt: string | null;
  labels: string[];
  targetReleases: (Named & { shipped: boolean })[];
  foundInReleases: (Named & { shipped: boolean })[];
  areas: Named[];
}
interface ReleaseJson {
  id: number;
  name: string;
  order: number;
  shipped: boolean;
  archived: boolean;
  releaseDate: string | null;
  progress: { tickets: number; closed: number; open: number };
  approvers: { user: Named; decision: string | null; comment: string }[];
}
interface ChangeJson {
  field: string;
  from: { value: string | null; display: string | null };
  to: { value: string | null; display: string | null };
}

describe('priorities, close reasons, labels, releases and areas (M1-014)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const roles: Record<string, number> = {};

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
  async function create(who: string, body: Record<string, unknown>): Promise<TicketJson> {
    const res = await post(who, '/api/v1/tickets', body);
    expect(res.statusCode, res.body).toBe(201);
    return ticketOf(res);
  }
  async function edit(who: string, id: number, body: Record<string, unknown>) {
    const res = await patch(who, `/api/v1/tickets/${id}`, body);
    expect(res.statusCode, res.body).toBe(200);
    return ticketOf(res);
  }
  const view = async (id: number) => ticketOf(await get('alice', `/api/v1/tickets/${id}`));
  const history = async (id: number, field: string) =>
    (
      (await get('alice', `/api/v1/tickets/${id}/history?order=asc`)).json().changes as ChangeJson[]
    ).filter((c) => c.field === field);
  const priorities = async () =>
    (await get('alice', '/api/v1/priorities')).json().priorities as (Named & { order: number })[];
  const priorityId = async (name: string) =>
    (await priorities()).find((p) => p.name === name)?.id as number;
  async function newRelease(track: string, name: string, extra: Record<string, unknown> = {}) {
    const res = await post('alice', `/api/v1/tracks/${tracks[track]}/releases`, {
      name,
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().release as ReleaseJson;
  }
  async function newArea(track: string, name: string, extra: Record<string, unknown> = {}) {
    const res = await post('alice', `/api/v1/tracks/${tracks[track]}/areas`, { name, ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().area as Named & { owner: Named | null; defaultAssignee: string };
  }
  const release = async (id: number) =>
    (await get('alice', `/api/v1/releases/${id}`)).json().release as ReleaseJson;

  async function newTrack(key: string) {
    // Alice owns every track, so she administers its releases and areas.
    const res = await post('admin', '/api/v1/tracks', {
      key,
      name: key,
      mode: 'shared',
      ownerId: users.alice?.id,
    });
    expect(res.statusCode, res.body).toBe(201);
    tracks[key] = res.json().track.id;
    for (const [who, role] of [
      ['alice', 'Members'],
      ['dave', 'Members'],
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
    return tracks[key] as number;
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
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
    for (const role of await database.db.selectFrom('role').select(['id', 'name']).execute()) {
      roles[role.name] = role.id;
    }
    await newTrack('ABC');
    await newTrack('XYZ');
  });
  afterAll(async () => {
    await app.close();
  });

  describe('priorities and close reasons', () => {
    it('[CORE-014] ships the default priorities, close reasons and priority set', async () => {
      expect((await priorities()).map((p) => [p.name, p.order])).toEqual([
        ['Urgent', 1],
        ['High', 2],
        ['Normal', 3],
        ['Low', 4],
        ['Very low', 5],
      ]);
      const reasons = (await get('alice', '/api/v1/close-reasons')).json().closeReasons;
      expect(reasons.map((r: Named) => r.name)).toEqual([
        'Completed',
        'Not planned',
        'Duplicate',
        'Not reproducible',
      ]);
      const sets = (await get('alice', '/api/v1/priority-sets')).json().prioritySets;
      expect(sets).toEqual([
        expect.objectContaining({
          name: 'Default priority set',
          isDefault: true,
          priorityIds: (await priorities()).map((p) => p.id),
          defaultPriorityId: await priorityId('Normal'),
        }),
      ]);
      // A new ticket takes the default set's default.
      const ticket = await create('alice', { track: 'ABC', summary: 'Defaults' });
      // Which icon it shows comes from its place in the order: the middle of the five.
      expect(ticket.priority).toMatchObject({ name: 'Normal', icon: 'priority-normal', level: 4 });
      expect(
        (await get('alice', '/api/v1/priorities'))
          .json()
          .priorities.map((p: { level: number }) => p.level),
      ).toEqual([1, 2, 4, 5, 6]);
      expect(ticket.closeReason).toBeNull();
    });

    it('[CORE-014] always gives a ticket a priority; only an import can leave it empty', async () => {
      const normal = await priorityId('Normal');
      // Null is not a choice when creating: the ticket takes the default, as if left out.
      const made = await create('alice', { track: 'ABC', summary: 'No choice', priorityId: null });
      expect(made.priority?.id).toBe(normal);
      // An edit cannot take a priority away.
      const refused = await patch('alice', `/api/v1/tickets/${made.id}`, { priorityId: null });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().fields).toEqual({ priorityId: 'required' });
      expect((await view(made.id)).priority?.id).toBe(normal);
      // What an import left stays as it is until someone chooses, and other edits still work.
      await database.db
        .updateTable('ticket')
        .set({ priority_id: null })
        .where('id', '=', made.id)
        .execute();
      expect(
        (await edit('alice', made.id, { summary: 'Still none', priorityId: null })).priority,
      ).toBeNull();
      expect((await edit('alice', made.id, { priorityId: normal })).priority?.id).toBe(normal);
    });

    it('[CORE-014] tells the create form what a new ticket would take and what it may choose', async () => {
      const type = (await get('alice', '/api/v1/tracks/ABC/ticket-types')).json()
        .ticketTypes[0] as Named;
      const form = (
        await get('alice', `/api/v1/tracks/ABC/layout?ticketTypeId=${type.id}&operation=create`)
      ).json();
      expect(form.priorities.defaultId).toBe(await priorityId('Normal'));
      expect([...form.priorities.offered].sort()).toEqual(
        (await priorities()).map((p) => p.id).sort(),
      );
    });

    it('[CORE-014] a set with no default gives the middle of what it offers', async () => {
      const ids = await Promise.all(['Urgent', 'High', 'Low'].map((n) => priorityId(n)));
      const set = await post('admin', '/api/v1/priority-sets', {
        name: 'No default',
        priorityIds: ids,
      });
      expect(set.statusCode, set.body).toBe(201);
      expect(
        (
          await patch('admin', `/api/v1/tracks/${tracks.XYZ}`, {
            prioritySetId: set.json().prioritySet.id,
          })
        ).statusCode,
      ).toBe(200);
      const ticket = await create('alice', { track: 'XYZ', summary: 'Middle' });
      expect(ticket.priority?.name).toBe('High');
      await patch('admin', `/api/v1/tracks/${tracks.XYZ}`, { prioritySetId: null });
      await del('admin', `/api/v1/priority-sets/${set.json().prioritySet.id}`);
    });

    it('[CORE-014] lets administrators add, edit and reorder priorities', async () => {
      expect((await post('alice', '/api/v1/priorities', { name: 'Blocker' })).statusCode).toBe(403);
      const created = await post('admin', '/api/v1/priorities', {
        name: 'Blocker',
        icon: 'priority-blocker',
        color: '#AA0000',
      });
      expect(created.statusCode, created.body).toBe(201);
      const blocker = created.json().priority;
      expect(blocker).toMatchObject({ name: 'Blocker', color: '#aa0000', order: 6 });
      expect((await post('admin', '/api/v1/priorities', { name: 'blocker' })).json()).toEqual({
        error: 'name_taken',
      });
      const edited = await patch('admin', `/api/v1/priorities/${blocker.id}`, {
        description: 'Stops a release',
      });
      expect(edited.json().priority.description).toBe('Stops a release');
      // A new priority joins the default set.
      const [defaults] = (await get('alice', '/api/v1/priority-sets')).json().prioritySets;
      expect(defaults.priorityIds).toContain(blocker.id);

      const ids = (await priorities()).map((p) => p.id);
      const reordered = [blocker.id, ...ids.filter((i) => i !== blocker.id)];
      // The order lists every priority once.
      expect(
        (await put('admin', '/api/v1/priorities/order', { priorityIds: reordered.slice(1) }))
          .statusCode,
      ).toBe(400);
      const res = await put('admin', '/api/v1/priorities/order', { priorityIds: reordered });
      expect(res.statusCode, res.body).toBe(200);
      expect((await priorities()).map((p) => [p.name, p.order])).toEqual([
        ['Blocker', 1],
        ['Urgent', 2],
        ['High', 3],
        ['Normal', 4],
        ['Low', 5],
        ['Very low', 6],
      ]);
    });

    it('[CORE-014] offers only the priorities of the track’s priority set', async () => {
      const [urgent, high, low] = await Promise.all(
        ['Urgent', 'High', 'Low'].map((n) => priorityId(n)),
      );
      // The default must be one of the set's priorities.
      expect(
        (
          await post('admin', '/api/v1/priority-sets', {
            name: 'Incidents',
            priorityIds: [urgent, high],
            defaultPriorityId: low,
          })
        ).statusCode,
      ).toBe(400);
      const created = await post('admin', '/api/v1/priority-sets', {
        name: 'Incidents',
        priorityIds: [urgent, high],
        defaultPriorityId: high,
      });
      expect(created.statusCode, created.body).toBe(201);
      const set = created.json().prioritySet;
      // Only configuration administrators switch a track's set.
      expect(
        (await patch('alice', `/api/v1/tracks/${tracks.XYZ}`, { prioritySetId: set.id }))
          .statusCode,
      ).toBe(403);
      const switched = await patch('admin', `/api/v1/tracks/${tracks.XYZ}`, {
        prioritySetId: set.id,
      });
      expect(switched.json().track.prioritySetId).toBe(set.id);

      const ticket = await create('alice', { track: 'XYZ', summary: 'Database down' });
      expect(ticket.priority?.name).toBe('High');
      const refused = await patch('alice', `/api/v1/tickets/${ticket.id}`, { priorityId: low });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({
        error: 'invalid_fields',
        fields: { priorityId: 'not_in_track' },
      });
      expect(
        (
          await post('alice', '/api/v1/tickets', { track: 'XYZ', summary: 'x', priorityId: low })
        ).json().fields,
      ).toEqual({ priorityId: 'not_in_track' });
      expect((await edit('alice', ticket.id, { priorityId: urgent })).priority?.name).toBe(
        'Urgent',
      );
      expect(await history(ticket.id, 'priority')).toEqual([
        expect.objectContaining({ to: { value: String(high), display: 'High' } }),
        expect.objectContaining({
          from: { value: String(high), display: 'High' },
          to: { value: String(urgent), display: 'Urgent' },
        }),
      ]);
      // The other track still offers every priority, with Normal first.
      const elsewhere = await create('alice', {
        track: 'ABC',
        summary: 'Low one',
        priorityId: low,
      });
      expect(elsewhere.priority?.name).toBe('Low');

      // A deleted set sends its tracks back to the default set; the default set stays.
      const [defaults] = (await get('alice', '/api/v1/priority-sets')).json().prioritySets;
      expect((await del('admin', `/api/v1/priority-sets/${defaults.id}`)).json()).toEqual({
        error: 'default_set',
      });
      expect((await del('admin', `/api/v1/priority-sets/${set.id}`)).statusCode).toBe(204);
      expect(
        (await get('alice', `/api/v1/tracks/${tracks.XYZ}`)).json().track.prioritySetId,
      ).toBeNull();
      expect(
        (await create('alice', { track: 'XYZ', summary: 'Back to normal' })).priority?.name,
      ).toBe('Normal');
    });

    it('[CORE-014] needs a replacement to delete a priority tickets use', async () => {
      const created = await post('admin', '/api/v1/priorities', { name: 'Trivial' });
      const trivial = created.json().priority.id as number;
      const low = await priorityId('Low');
      const set = await post('admin', '/api/v1/priority-sets', {
        name: 'Small things',
        priorityIds: [trivial],
        defaultPriorityId: trivial,
      });
      const setId = set.json().prioritySet.id;
      const ticket = await create('alice', {
        track: 'ABC',
        summary: 'Typo',
        priorityId: trivial,
      });
      const refused = await del('admin', `/api/v1/priorities/${trivial}`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'in_use', ticketCount: 1 });
      expect(
        (await del('admin', `/api/v1/priorities/${trivial}?replacementId=999999`)).statusCode,
      ).toBe(400);

      const res = await del('admin', `/api/v1/priorities/${trivial}?replacementId=${low}`);
      expect(res.statusCode, res.body).toBe(204);
      const after = await view(ticket.id);
      expect(after.priority?.name).toBe('Low');
      expect(after.version).toBe(ticket.version + 1);
      expect((await history(ticket.id, 'priority')).at(-1)).toMatchObject({
        from: { display: 'Trivial' },
        to: { display: 'Low' },
      });
      // The set that offered it offers the replacement, as its default.
      const sets = (await get('alice', '/api/v1/priority-sets')).json().prioritySets;
      expect(sets.find((s: { id: number }) => s.id === setId)).toMatchObject({
        priorityIds: [low],
        defaultPriorityId: low,
      });
      // The order closes the gap.
      const orders = (await priorities()).map((p) => p.order);
      expect(orders).toEqual(orders.map((_, i) => i + 1));
      // A priority nothing uses goes without one.
      const spare = (await post('admin', '/api/v1/priorities', { name: 'Spare' })).json().priority
        .id;
      expect((await del('admin', `/api/v1/priorities/${spare}`)).statusCode).toBe(204);
    });

    it('[CORE-014] deletes a priority while tickets take it, without errors or orphans', async () => {
      const doomed = (await post('admin', '/api/v1/priorities', { name: 'Doomed' })).json().priority
        .id as number;
      const high = await priorityId('High');
      const tickets = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          create('alice', {
            track: 'ABC',
            summary: `Race ${i}`,
            priorityId: i < 10 ? doomed : high,
          }),
        ),
      );
      const results = await Promise.all([
        ...tickets
          .slice(10)
          .map((t) => patch('alice', `/api/v1/tickets/${t.id}`, { priorityId: doomed })),
        del('admin', `/api/v1/priorities/${doomed}?replacementId=${high}`),
        ...tickets
          .slice(10)
          .map(() =>
            post('alice', '/api/v1/tickets', { track: 'ABC', summary: 'Late', priorityId: doomed }),
          ),
      ]);
      // Each write either came first (and the deletion rewrote it) or found the priority gone.
      for (const res of results) {
        expect([200, 201, 204, 400], res.body).toContain(res.statusCode);
        if (res.statusCode === 400) expect(res.json().fields).toEqual({ priorityId: 'not_found' });
      }
      const left = await database.db
        .selectFrom('ticket')
        .select('id')
        .where('priority_id', '=', doomed)
        .execute();
      expect(left).toEqual([]);
      expect((await priorities()).some((p) => p.id === doomed)).toBe(false);
    });

    it('[CORE-014] manages close reasons; setting one needs "Set close reason"', async () => {
      const created = await post('admin', '/api/v1/close-reasons', {
        name: 'Obsolete',
        description: 'Overtaken by events',
      });
      expect(created.statusCode, created.body).toBe(201);
      const obsolete = created.json().closeReason;
      expect(obsolete.order).toBe(5);
      const reasons = (await get('alice', '/api/v1/close-reasons')).json().closeReasons as Named[];
      const ids = reasons.map((r) => r.id);
      const res = await put('admin', '/api/v1/close-reasons/order', {
        closeReasonIds: [obsolete.id, ...ids.filter((i) => i !== obsolete.id)],
      });
      expect(res.json().closeReasons[0]).toMatchObject({ name: 'Obsolete', order: 1 });

      const ticket = await create('alice', { track: 'ABC', summary: 'Old idea' });
      // Bob only views the track.
      const denied = await patch('bob', `/api/v1/tickets/${ticket.id}`, {
        closeReasonId: obsolete.id,
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().permission).toBe('set_close_reason');
      expect(
        (await edit('alice', ticket.id, { closeReasonId: obsolete.id })).closeReason?.name,
      ).toBe('Obsolete');
      expect(
        (await patch('alice', `/api/v1/tickets/${ticket.id}`, { closeReasonId: 999999 })).json()
          .fields,
      ).toEqual({ closeReasonId: 'not_found' });

      expect((await del('admin', `/api/v1/close-reasons/${obsolete.id}`)).json()).toEqual({
        error: 'in_use',
        ticketCount: 1,
      });
      const notPlanned = reasons.find((r) => r.name === 'Not planned')?.id;
      expect(
        (await del('admin', `/api/v1/close-reasons/${obsolete.id}?replacementId=${notPlanned}`))
          .statusCode,
      ).toBe(204);
      expect((await view(ticket.id)).closeReason?.name).toBe('Not planned');
      expect((await history(ticket.id, 'closeReason')).at(-1)).toMatchObject({
        from: { display: 'Obsolete' },
        to: { display: 'Not planned' },
      });
    });
  });

  describe('labels', () => {
    it('[CORE-017] suggests existing labels as people type', async () => {
      const ticket = await create('alice', {
        track: 'ABC',
        summary: 'Labelled',
        labels: ['frontend', ' backend ', 'frontend', 'Front-Office'],
      });
      expect(ticket.labels).toEqual(['frontend', 'backend', 'Front-Office']);
      const suggest = async (q: string) =>
        (await get('bob', `/api/v1/labels?q=${encodeURIComponent(q)}`)).json().labels;
      expect(await suggest('fro')).toEqual(['Front-Office', 'frontend']);
      expect(await suggest('FRONTE')).toEqual(['frontend']);
      expect(await suggest('%')).toEqual([]);
      expect(
        (
          await post('alice', '/api/v1/tickets', { track: 'ABC', summary: 'x', labels: ['a b'] })
        ).json().fields,
      ).toEqual({ labels: 'invalid' });
      expect(
        (
          await post('alice', '/api/v1/tickets', {
            track: 'ABC',
            summary: 'x',
            labels: ['l'.repeat(256)],
          })
        ).json().fields,
      ).toEqual({ labels: 'too_long' });
      // Viewers do not edit labels.
      expect(
        (await patch('bob', `/api/v1/tickets/${ticket.id}`, { labels: [] })).json().permission,
      ).toBe('edit_tickets');
      expect(await history(ticket.id, 'labels')).toEqual([
        expect.objectContaining({ to: { value: 'frontend backend Front-Office', display: null } }),
      ]);
    });

    it('[CORE-017] merges labels into one across every ticket, with history', async () => {
      const one = await create('alice', {
        track: 'ABC',
        summary: 'One',
        labels: ['front-end', 'ui'],
      });
      const both = await create('alice', {
        track: 'XYZ',
        summary: 'Both',
        labels: ['frontend', 'front-end', 'FE'],
      });
      const none = await create('alice', { track: 'ABC', summary: 'None', labels: ['ops'] });
      expect(
        (await post('alice', '/api/v1/labels/merge', { labels: ['front-end'], into: 'frontend' }))
          .statusCode,
      ).toBe(403);
      const res = await post('admin', '/api/v1/labels/merge', {
        labels: ['front-end', 'FE'],
        into: 'frontend',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ into: 'frontend', labels: ['front-end', 'FE'], ticketCount: 2 });
      expect((await view(one.id)).labels).toEqual(['frontend', 'ui']);
      expect((await view(both.id)).labels).toEqual(['frontend']);
      expect((await view(none.id)).version).toBe(none.version);
      expect((await history(one.id, 'labels')).at(-1)).toMatchObject({
        from: { value: 'front-end ui' },
        to: { value: 'frontend ui' },
      });
      expect((await get('alice', '/api/v1/labels?q=f')).json().labels).not.toContain('front-end');

      // A rename is a merge into a new name.
      await post('admin', '/api/v1/labels/merge', { labels: ['ui'], into: 'user-interface' });
      expect((await view(one.id)).labels).toEqual(['frontend', 'user-interface']);
      expect(
        (await post('admin', '/api/v1/labels/merge', { labels: ['ops'], into: 'two words' }))
          .statusCode,
      ).toBe(400);
    });
  });

  describe('releases', () => {
    it('[CORE-016] creates, edits, orders, archives and restores releases', async () => {
      await newTrack('REL');
      // Members of the track do not manage releases; its owner does.
      expect(
        (await post('dave', `/api/v1/tracks/${tracks.REL}/releases`, { name: '1.0' })).statusCode,
      ).toBe(403);
      const first = await newRelease('REL', '1.0', {
        startDate: '2026-11-01',
        releaseDate: '2026-12-01',
      });
      const second = await newRelease('REL', '1.1');
      const third = await newRelease('REL', '2.0');
      expect([first.order, second.order, third.order]).toEqual([1, 2, 3]);
      expect(
        (await post('alice', `/api/v1/tracks/${tracks.REL}/releases`, { name: '1.0' })).json(),
      ).toEqual({ error: 'name_taken' });
      expect(
        (
          await post('alice', `/api/v1/tracks/${tracks.REL}/releases`, {
            name: 'Backwards',
            startDate: '2026-12-02',
            releaseDate: '2026-12-01',
          })
        ).statusCode,
      ).toBe(400);
      const edited = await patch('alice', `/api/v1/releases/${second.id}`, {
        releaseDate: '2027-01-15',
        description: 'Fixes',
      });
      expect(edited.json().release).toMatchObject({
        releaseDate: '2027-01-15',
        description: 'Fixes',
      });

      const order = `/api/v1/tracks/${tracks.REL}/releases/order`;
      expect((await put('alice', order, { releaseIds: [third.id, first.id] })).statusCode).toBe(
        400,
      );
      const reordered = await put('alice', order, {
        releaseIds: [third.id, first.id, second.id],
      });
      expect(reordered.statusCode, reordered.body).toBe(200);
      const list = async (q = '') =>
        (await get('bob', `/api/v1/tracks/${tracks.REL}/releases${q}`)).json()
          .releases as ReleaseJson[];
      expect((await list()).map((r) => [r.name, r.order])).toEqual([
        ['2.0', 1],
        ['1.0', 2],
        ['1.1', 3],
      ]);

      // An archived release leaves the list and new tickets, and stays on those that have it.
      const ticket = await create('alice', {
        track: 'REL',
        summary: 'In 1.0',
        targetReleaseIds: [first.id],
      });
      expect(
        (await post('alice', `/api/v1/releases/${first.id}/archive`)).json().release.archived,
      ).toBe(true);
      expect((await list()).map((r) => r.name)).toEqual(['2.0', '1.1']);
      expect((await list('?archived=only')).map((r) => r.name)).toEqual(['1.0']);
      expect((await list('?archived=include')).map((r) => r.name)).toEqual(['2.0', '1.0', '1.1']);
      const kept = await edit('alice', ticket.id, {
        targetReleaseIds: [first.id, second.id],
      });
      expect(kept.targetReleases.map((r) => r.name)).toEqual(['1.0', '1.1']);
      const refused = await post('alice', '/api/v1/tickets', {
        track: 'REL',
        summary: 'Too late',
        targetReleaseIds: [first.id],
      });
      expect(refused.json().fields).toEqual({ targetReleaseIds: 'archived' });
      expect((await post('alice', `/api/v1/releases/${first.id}/archive`)).statusCode).toBe(409);
      expect(
        (await post('alice', `/api/v1/releases/${first.id}/restore`)).json().release.archived,
      ).toBe(false);
      // Releases belong to their track.
      expect(
        (
          await post('alice', '/api/v1/tickets', {
            track: 'ABC',
            summary: 'Wrong track',
            foundInReleaseIds: [first.id],
          })
        ).json().fields,
      ).toEqual({ foundInReleaseIds: 'not_in_track' });
    });

    it('[CORE-016] asks where open tickets go when a release ships', async () => {
      await newTrack('SHP');
      const current = await newRelease('SHP', '3.0');
      const next = await newRelease('SHP', '3.1');
      const open = await create('alice', {
        track: 'SHP',
        summary: 'Still open',
        targetReleaseIds: [current.id],
        foundInReleaseIds: [current.id],
      });
      const closed = await create('alice', {
        track: 'SHP',
        summary: 'Done',
        targetReleaseIds: [current.id],
      });
      // Workflows close tickets (M1-023); here the stamp stands in for that.
      await database.db
        .updateTable('ticket')
        .set({ closed_at: new Date() })
        .where('id', '=', closed.id)
        .execute();
      expect((await release(current.id)).progress).toEqual({ tickets: 2, closed: 1, open: 1 });

      const ship = `/api/v1/releases/${current.id}/ship`;
      const asked = await post('alice', ship, {});
      expect(asked.statusCode).toBe(409);
      expect(asked.json()).toEqual({ error: 'open_tickets', openTickets: 1 });
      expect((await post('alice', ship, { moveOpenTo: current.id })).statusCode).toBe(400);
      const shipped = await post('alice', ship, {
        moveOpenTo: next.id,
        releaseDate: '2026-10-20',
      });
      expect(shipped.statusCode, shipped.body).toBe(200);
      expect(shipped.json().release).toMatchObject({
        shipped: true,
        releaseDate: '2026-10-20',
        progress: { tickets: 1, closed: 1, open: 0 },
      });
      // The open ticket now targets the next release; where it was found stays.
      const moved = await view(open.id);
      expect(moved.targetReleases.map((r) => r.name)).toEqual(['3.1']);
      expect(moved.foundInReleases).toEqual([{ id: current.id, name: '3.0', shipped: true }]);
      expect((await history(open.id, 'targetRelease')).at(-1)).toMatchObject({
        from: { value: String(current.id), display: '3.0' },
        to: { value: String(next.id), display: '3.1' },
      });
      expect((await view(closed.id)).targetReleases.map((r) => r.name)).toEqual(['3.0']);
      expect((await post('alice', ship, {})).json()).toEqual({ error: 'already_shipped' });

      // Unshipped, then shipped leaving open tickets where they are.
      expect((await post('alice', `/api/v1/releases/${current.id}/unship`)).statusCode).toBe(200);
      await edit('alice', open.id, { targetReleaseIds: [current.id, next.id] });
      const left = await post('alice', ship, { moveOpenTo: null });
      expect(left.statusCode, left.body).toBe(200);
      expect((await view(open.id)).targetReleases.map((r) => r.name)).toEqual(['3.0', '3.1']);
    });

    it('[CORE-016] ships a release that needs approvals once every approver approves', async () => {
      await newTrack('APR');
      const gated = await newRelease('APR', '5.0', { requireApprovals: true });
      const approvers = `/api/v1/releases/${gated.id}/approvers`;
      // Approvers are active people who may browse the track.
      expect((await put('alice', approvers, { userIds: [999_999] })).statusCode).toBe(400);
      const set = await put('alice', approvers, {
        userIds: [users.alice?.id as number, users.dave?.id as number],
      });
      expect(set.json().release.approvers.map((a: { user: Named }) => a.user.name)).toEqual([
        'alice',
        'dave',
      ]);
      const ship = `/api/v1/releases/${gated.id}/ship`;
      expect((await post('alice', ship, {})).json()).toEqual({
        error: 'approvals_pending',
        pending: [users.alice?.id, users.dave?.id],
        declined: [],
      });
      const decide = (who: string, decision: string, comment?: string) =>
        post(who, `/api/v1/releases/${gated.id}/approval`, {
          decision,
          ...(comment ? { comment } : {}),
        });
      expect((await decide('bob', 'approved')).json()).toEqual({ error: 'not_an_approver' });
      expect((await decide('alice', 'approved')).statusCode).toBe(200);
      const declined = await decide('dave', 'declined', 'The migration is not tested');
      expect(declined.json().release.approvers).toEqual([
        expect.objectContaining({
          user: expect.objectContaining({ name: 'alice' }),
          decision: 'approved',
        }),
        expect.objectContaining({
          user: expect.objectContaining({ name: 'dave' }),
          decision: 'declined',
          comment: 'The migration is not tested',
        }),
      ]);
      expect((await post('alice', ship, {})).json()).toEqual({
        error: 'approvals_pending',
        pending: [],
        declined: [users.dave?.id],
      });
      const decisions = await database.db
        .selectFrom('domain_event')
        .select('payload')
        .where('type', '=', 'release.approval_decided')
        .where('subject_id', '=', String(gated.id))
        .orderBy('id')
        .execute();
      expect(decisions.map((d) => (d.payload as { decision: string }).decision)).toEqual([
        'approved',
        'declined',
      ]);
      await decide('dave', 'approved');
      expect((await post('alice', ship, {})).statusCode).toBe(200);
      expect((await decide('dave', 'declined')).json()).toEqual({ error: 'already_shipped' });
    });

    it('[CORE-016] merges releases and deletes them, with ticket history', async () => {
      await newTrack('MRG');
      const a = await newRelease('MRG', '1.0.1');
      const b = await newRelease('MRG', '1.0.2');
      const c = await newRelease('MRG', '1.0.3');
      const ticket = await create('alice', {
        track: 'MRG',
        summary: 'Patched twice',
        targetReleaseIds: [a.id, b.id],
        foundInReleaseIds: [a.id],
      });
      const merged = await post('alice', `/api/v1/releases/${a.id}/merge`, { into: b.id });
      expect(merged.statusCode, merged.body).toBe(200);
      const after = await view(ticket.id);
      expect(after.targetReleases.map((r) => r.name)).toEqual(['1.0.2']);
      expect(after.foundInReleases.map((r) => r.name)).toEqual(['1.0.2']);
      expect((await get('alice', `/api/v1/releases/${a.id}`)).statusCode).toBe(404);
      // The order closes the gap.
      const list = (await get('alice', `/api/v1/tracks/${tracks.MRG}/releases`)).json().releases;
      expect(list.map((r: ReleaseJson) => [r.name, r.order])).toEqual([
        ['1.0.2', 1],
        ['1.0.3', 2],
      ]);

      expect((await del('alice', `/api/v1/releases/${b.id}`)).json()).toEqual({
        error: 'in_use',
        ticketCount: 1,
      });
      expect(
        (await del('alice', `/api/v1/releases/${b.id}?removeFromTickets=true`)).statusCode,
      ).toBe(204);
      const cleared = await view(ticket.id);
      expect([cleared.targetReleases, cleared.foundInReleases]).toEqual([[], []]);
      expect((await history(ticket.id, 'foundInRelease')).map((h) => h.to.display)).toEqual([
        '1.0.1',
        '1.0.2',
        null,
      ]);
      expect((await del('alice', `/api/v1/releases/${c.id}`)).statusCode).toBe(204);
    });

    it('[CORE-016] lists a ticket’s releases in release order and drops them on a move', async () => {
      await newTrack('ORD');
      const late = await newRelease('ORD', 'Late');
      const early = await newRelease('ORD', 'Early');
      await put('alice', `/api/v1/tracks/${tracks.ORD}/releases/order`, {
        releaseIds: [early.id, late.id],
      });
      const area = await newArea('ORD', 'Billing');
      const ticket = await create('alice', {
        track: 'ORD',
        summary: 'Ordered',
        targetReleaseIds: [late.id, early.id],
        areaIds: [area.id],
      });
      expect(ticket.targetReleases.map((r) => r.name)).toEqual(['Early', 'Late']);
      // The same set in another order is no change.
      const same = await edit('alice', ticket.id, { targetReleaseIds: [early.id, late.id] });
      expect(same.version).toBe(ticket.version);
      const moved = await post('alice', `/api/v1/tickets/${ticket.id}/move`, { track: 'ABC' });
      expect(moved.statusCode, moved.body).toBe(200);
      const there = ticketOf(moved);
      expect([there.targetReleases, there.areas]).toEqual([[], []]);
      expect((await history(ticket.id, 'area')).at(-1)).toMatchObject({
        from: { value: String(area.id), display: 'Billing' },
        to: { value: null },
      });
    });
  });

  describe('areas', () => {
    it('[CORE-015] assigns a new ticket to its area’s owner when the rule says so', async () => {
      await newTrack('AREA');
      const owned = await newArea('AREA', 'Payments', {
        ownerId: users.dave?.id,
        defaultAssignee: 'area_owner',
      });
      const toTrackOwner = await newArea('AREA', 'Search', { defaultAssignee: 'track_owner' });
      const nobody = await newArea('AREA', 'Docs', { ownerId: users.dave?.id });
      const viewerOwned = await newArea('AREA', 'Reports', {
        ownerId: users.bob?.id,
        defaultAssignee: 'area_owner',
      });
      expect(owned).toMatchObject({ owner: { id: users.dave?.id }, defaultAssignee: 'area_owner' });

      const pick = async (areaIds: number[], extra: Record<string, unknown> = {}) =>
        (await create('alice', { track: 'AREA', summary: 'Routed', areaIds, ...extra })).assignee
          ?.name ?? null;
      expect(await pick([owned.id])).toBe('dave');
      expect(await pick([toTrackOwner.id])).toBe('alice');
      expect(await pick([nobody.id])).toBeNull();
      // The first area whose rule names someone wins.
      expect(await pick([nobody.id, toTrackOwner.id, owned.id])).toBe('alice');
      // Someone who may not be assigned is skipped.
      expect(await pick([viewerOwned.id])).toBeNull();
      // An assignee given, or no assignee asked for, stands.
      expect(await pick([owned.id], { assigneeId: users.alice?.id })).toBe('alice');
      expect(await pick([owned.id], { assigneeId: null })).toBeNull();
    });

    it('[CORE-015] archives, restores, edits and deletes areas', async () => {
      await newTrack('ARC');
      const ui = await newArea('ARC', 'UI');
      const web = await newArea('ARC', 'Web');
      expect((await post('dave', `/api/v1/areas/${ui.id}/archive`)).statusCode).toBe(403);
      const ticket = await create('alice', { track: 'ARC', summary: 'Button', areaIds: [ui.id] });
      expect((await post('alice', `/api/v1/areas/${ui.id}/archive`)).json().area.archived).toBe(
        true,
      );
      const names = async (q = '') =>
        (await get('bob', `/api/v1/tracks/${tracks.ARC}/areas${q}`))
          .json()
          .areas.map((a: Named) => a.name);
      expect(await names()).toEqual(['Web']);
      expect(await names('?archived=include')).toEqual(['UI', 'Web']);
      expect(
        (
          await post('alice', '/api/v1/tickets', { track: 'ARC', summary: 'x', areaIds: [ui.id] })
        ).json().fields,
      ).toEqual({ areaIds: 'archived' });
      expect((await post('alice', `/api/v1/areas/${ui.id}/restore`)).json().area.archived).toBe(
        false,
      );
      const renamed = await patch('alice', `/api/v1/areas/${ui.id}`, {
        name: 'Interface',
        ownerId: users.dave?.id,
      });
      expect(renamed.json().area).toMatchObject({ name: 'Interface', owner: { name: 'dave' } });
      expect((await patch('alice', `/api/v1/areas/${ui.id}`, { name: 'web' })).json()).toEqual({
        error: 'name_taken',
      });

      expect((await del('alice', `/api/v1/areas/${ui.id}`)).json()).toEqual({
        error: 'in_use',
        ticketCount: 1,
      });
      expect(
        (await del('alice', `/api/v1/areas/${ui.id}?replacementId=${web.id}`)).statusCode,
      ).toBe(204);
      expect((await view(ticket.id)).areas.map((a) => a.name)).toEqual(['Web']);
      expect((await history(ticket.id, 'area')).at(-1)).toMatchObject({
        from: { display: 'Interface' },
        to: { display: 'Web' },
      });
      expect(
        (await del('alice', `/api/v1/areas/${web.id}?removeFromTickets=true`)).statusCode,
      ).toBe(204);
      expect((await view(ticket.id)).areas).toEqual([]);
    });
  });
});
