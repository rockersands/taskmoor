import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.67.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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
  number: number;
  track: { id: number; key: string; name: string };
  ticketType: { id: number; name: string; level: { id: number; rank: number; name: string } };
  parent: { id: number; key: string | null; summary: string | null } | null;
  summary: string;
  description: unknown;
  environment: unknown;
  assignee: { id: number; name: string } | null;
  requester: { id: number; name: string } | null;
  creator: { id: number; name: string } | null;
  startDate: string | null;
  dueDate: string | null;
  rank: string;
  version: number;
  trash: {
    deletedAt: string;
    deletedBy: { id: number; name: string } | null;
    purgeAfter: string;
    deletedWith: { id: number; key: string } | null;
  } | null;
}

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('tickets (M1-008)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const types: Record<string, number> = {};
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
  /** Creates a ticket and returns it; fails the test on any refusal. */
  async function create(who: string, body: Record<string, unknown>): Promise<TicketJson> {
    const res = await post(who, '/api/v1/tickets', body);
    expect(res.statusCode, res.body).toBe(201);
    return ticketOf(res);
  }
  const view = async (who: string, ref: string | number) =>
    ticketOf(await get(who, `/api/v1/tickets/${ref}`));
  const events = (type: string) =>
    database.db
      .selectFrom('domain_event')
      .select(['subject_id', 'payload'])
      .where('type', '=', type)
      .orderBy('id')
      .execute();
  const keysInRankOrder = async (track: string) =>
    (
      (await get('alice', `/api/v1/tickets?track=${track}&limit=200`)).json()
        .tickets as TicketJson[]
    ).map((t) => t.key);

  async function newTrack(key: string, extra: Record<string, unknown> = {}) {
    const res = await post('admin', '/api/v1/tracks', {
      key,
      name: key,
      mode: 'shared',
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(201);
    tracks[key] = res.json().track.id;
    // Alice works everywhere; Bob only looks at ABC; Carol works in XYZ only.
    const actors: [string, string][] = [['alice', 'Members']];
    if (key === 'ABC') actors.push(['bob', 'Viewers'], ['dave', 'Members']);
    if (key === 'XYZ') actors.push(['carol', 'Members']);
    for (const [who, role] of actors) {
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
      ['carol', false],
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
    for (const type of await database.db
      .selectFrom('ticket_type')
      .select(['id', 'name'])
      .where('owner_track_id', 'is', null)
      .execute()) {
      types[type.name] = type.id;
    }
    await newTrack('ABC');
    await newTrack('XYZ');
    await newTrack('OPS', { type: 'business' });
  });
  afterAll(async () => {
    await app.close();
  });

  describe('keys', () => {
    it('[CORE-001] numbers tickets KEY-n per track, from 1', async () => {
      const first = await create('alice', { track: 'ABC', summary: 'The first one' });
      const second = await create('alice', { track: tracks.ABC, summary: 'The second one' });
      const other = await create('alice', { track: 'xyz', summary: 'Elsewhere' });
      expect([first.key, second.key, other.key]).toEqual(['ABC-1', 'ABC-2', 'XYZ-1']);
      // Found by id, by key and by key in any case.
      expect((await view('alice', first.id)).key).toBe('ABC-1');
      expect((await view('alice', 'abc-2')).id).toBe(second.id);
      expect((await get('alice', '/api/v1/tickets/ABC-99')).statusCode).toBe(404);
      expect((await get('alice', '/api/v1/tickets/ABC-')).statusCode).toBe(404);
    });

    it('[CORE-001] gives 1,000 parallel creates in one track unique, consecutive keys', async () => {
      const track = await newTrack('PAR');
      const results = await Promise.all(
        Array.from({ length: 1_000 }, (_, i) =>
          post('alice', '/api/v1/tickets', { track: 'PAR', summary: `Parallel ${i}` }),
        ),
      );
      expect(results.filter((r) => r.statusCode !== 201).map((r) => r.body)).toEqual([]);
      const numbers = results.map((r) => ticketOf(r).number).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: 1_000 }, (_, i) => i + 1));
      const stored = await database.db
        .selectFrom('ticket')
        .select(['number', 'rank'])
        .where('track_id', '=', track)
        .execute();
      expect(new Set(stored.map((s) => s.number)).size).toBe(1_000);
      expect(new Set(stored.map((s) => s.rank)).size).toBe(1_000);
    }, 180_000);

    it('[CORE-001] keeps resolving old keys after the track key changes', async () => {
      await newTrack('REN');
      const ticket = await create('alice', { track: 'REN', summary: 'Before the rename' });
      expect(ticket.key).toBe('REN-1');
      const renamed = await patch('admin', `/api/v1/tracks/${tracks.REN}`, { key: 'RNW' });
      expect(renamed.statusCode, renamed.body).toBe(200);
      const res = await get('alice', '/api/v1/tickets/REN-1');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        ticket: { id: ticket.id, key: 'RNW-1' },
        redirect: { from: 'REN-1', to: 'RNW-1' },
      });
      // The next ticket continues the same sequence under the new key.
      expect((await create('alice', { track: 'RNW', summary: 'After' })).key).toBe('RNW-2');
    });
  });

  describe('create and view', () => {
    it('[CORE-008] creates through the API with the system fields of section 1.3', async () => {
      const ticket = await create('alice', {
        track: 'ABC',
        summary: '  Checkout fails on Safari  ',
        description: doc('Steps to reproduce'),
        environment: doc('Safari 19'),
        assigneeId: users.dave?.id,
        startDate: '2026-11-02',
        dueDate: '2026-11-30',
      });
      expect(ticket).toMatchObject({
        track: { key: 'ABC' },
        // The track's preselected type (CORE-005 (1)).
        ticketType: { name: 'Feature', level: { rank: 0 } },
        summary: 'Checkout fails on Safari',
        assignee: { id: users.dave?.id, name: 'dave' },
        requester: { id: users.alice?.id },
        creator: { id: users.alice?.id },
        startDate: '2026-11-02',
        dueDate: '2026-11-30',
        parent: null,
        version: 1,
        trash: null,
      });
      expect(ticket.description).toMatchObject({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Steps to reproduce' }] }],
      });
      const [event] = (await events('ticket.created')).slice(-1);
      expect(event).toMatchObject({
        subject_id: String(ticket.id),
        payload: {
          key: ticket.key,
          trackId: tracks.ABC,
          ticketTypeId: types.Feature,
          parentId: null,
        },
      });
    });

    it('[CORE-008] refuses missing and invalid values field by field', async () => {
      const res = await post('alice', '/api/v1/tickets', {
        track: 'ABC',
        summary: '   ',
        description: { type: 'doc', content: [{ type: 'nonsense' }] },
        dueDate: '2026-02-30',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'invalid_fields',
        fields: { summary: 'required', description: 'invalid', dueDate: 'invalid' },
      });
      const long = await post('alice', '/api/v1/tickets', {
        track: 'ABC',
        summary: 'x'.repeat(256),
        colour: 'red',
      });
      expect(long.json()).toEqual({ error: 'invalid_fields', fields: { colour: 'unknown' } });
      const tooLong = await post('alice', '/api/v1/tickets', {
        track: 'ABC',
        summary: 'x'.repeat(256),
      });
      expect(tooLong.json().fields).toEqual({ summary: 'too_long' });
      const noTrack = await post('alice', '/api/v1/tickets', { track: 'NOPE', summary: 'Hi' });
      expect(noTrack.json()).toEqual({ error: 'invalid_fields', fields: { track: 'not_found' } });
      const wrongType = await post('alice', '/api/v1/tickets', {
        track: 'OPS',
        summary: 'Not offered here',
        ticketTypeId: types.Bug,
      });
      expect(wrongType.json().fields).toEqual({ ticketTypeId: 'not_in_track' });
    });

    it('[CORE-008] treats an empty document as no description', async () => {
      const ticket = await create('alice', {
        track: 'ABC',
        summary: 'Nothing to say',
        description: { type: 'doc', content: [{ type: 'paragraph' }] },
      });
      expect(ticket.description).toBeNull();
    });

    it('[IAM-010] needs the permission for each thing it sets', async () => {
      // Bob only views ABC.
      expect(
        await post('bob', '/api/v1/tickets', { track: 'ABC', summary: 'No' }).then((r) => r.json()),
      ).toEqual({
        error: 'forbidden',
        permission: 'create_tickets',
      });
      // Carol does not even see ABC.
      expect(
        (await post('carol', '/api/v1/tickets', { track: 'ABC', summary: 'No' })).json(),
      ).toEqual({
        error: 'invalid_fields',
        fields: { track: 'not_found' },
      });
      // Bob is no assignable user in ABC, and nobody may name an inactive person.
      const notAssignable = await post('alice', '/api/v1/tickets', {
        track: 'ABC',
        summary: 'For Bob',
        assigneeId: users.bob?.id,
      });
      expect(notAssignable.json().fields).toEqual({ assigneeId: 'not_assignable' });
      const ticket = await create('alice', {
        track: 'ABC',
        summary: 'Reported for Dave',
        requesterId: users.dave?.id,
      });
      expect(ticket.requester?.id).toBe(users.dave?.id);
      // Bob reads what he cannot write; Carol does not see it at all.
      expect((await get('bob', `/api/v1/tickets/${ticket.key}`)).statusCode).toBe(200);
      expect((await get('carol', `/api/v1/tickets/${ticket.key}`)).statusCode).toBe(404);
      expect(
        (await patch('bob', `/api/v1/tickets/${ticket.id}`, { summary: 'Mine' })).json(),
      ).toEqual({
        error: 'forbidden',
        permission: 'edit_tickets',
      });
    });
  });

  describe('hierarchy', () => {
    const ids: Record<string, TicketJson> = {};

    it('[CORE-006] puts a parent one level up and a subticket under a parent in its own track', async () => {
      ids.outcome = await create('alice', {
        track: 'ABC',
        summary: 'Faster checkout',
        ticketTypeId: types.Outcome,
      });
      ids.feature = await create('alice', {
        track: 'ABC',
        summary: 'One-click pay',
        parent: ids.outcome.key,
      });
      ids.sub = await create('alice', {
        track: 'ABC',
        summary: 'Button',
        ticketTypeId: types.Subticket,
        parent: ids.feature.id,
      });
      expect(ids.sub.parent).toEqual({
        id: ids.feature.id,
        key: ids.feature.key,
        summary: 'One-click pay',
      });
      expect(ids.feature.parent?.key).toBe(ids.outcome.key);

      const sideways = await post('alice', '/api/v1/tickets', {
        track: 'ABC',
        summary: 'Under a peer',
        parent: ids.feature.key,
      });
      expect(sideways.json().fields).toEqual({ parent: 'wrong_level' });
      const orphan = await post('alice', '/api/v1/tickets', {
        track: 'ABC',
        summary: 'No parent',
        ticketTypeId: types.Subticket,
      });
      expect(orphan.json().fields).toEqual({ parent: 'required' });
      const elsewhere = await create('alice', { track: 'XYZ', summary: 'Feature in XYZ' });
      const abroad = await post('alice', '/api/v1/tickets', {
        track: 'ABC',
        summary: 'Subticket of another track',
        ticketTypeId: types.Subticket,
        parent: elsewhere.key,
      });
      expect(abroad.json().fields).toEqual({ parent: 'other_track' });
    });

    it('[CORE-006] lets a parent sit in another track and hides it from those who cannot browse it', async () => {
      const child = await create('alice', {
        track: 'XYZ',
        summary: 'Part of an ABC outcome',
        parent: ids.outcome?.key,
      });
      expect(child.parent).toMatchObject({ id: ids.outcome?.id, key: ids.outcome?.key });
      // Carol works in XYZ but cannot browse ABC.
      expect((await view('carol', child.key)).parent).toEqual({
        id: ids.outcome?.id,
        key: null,
        summary: null,
      });
      const hidden = await post('carol', '/api/v1/tickets', {
        track: 'XYZ',
        summary: 'Under something she cannot see',
        parent: ids.outcome?.key,
      });
      expect(hidden.json().fields).toEqual({ parent: 'not_found' });
    });

    it('[CORE-006] keeps levels valid when a type or a parent changes', async () => {
      const url = (t?: TicketJson) => `/api/v1/tickets/${t?.id}`;
      // The outcome has a feature below it: it cannot become a feature itself.
      expect(
        (await patch('alice', url(ids.outcome), { ticketTypeId: types.Feature })).json(),
      ).toEqual({
        error: 'invalid_fields',
        fields: { ticketTypeId: 'children_wrong_level' },
      });
      // The feature sits under an outcome: it cannot become an outcome there.
      expect(
        (await patch('alice', url(ids.feature), { ticketTypeId: types.Outcome })).json().fields,
      ).toEqual({
        ticketTypeId: 'wrong_level',
      });
      expect((await patch('alice', url(ids.sub), { parent: null })).json().fields).toEqual({
        parent: 'required',
      });
      expect(
        (await patch('alice', url(ids.feature), { parent: ids.feature?.key })).json().fields,
      ).toEqual({
        parent: 'self',
      });
      // A bug may take the feature's place under the outcome; then the feature leaves it.
      const bug = await patch('alice', url(ids.feature), { ticketTypeId: types.Bug });
      expect(bug.statusCode, bug.body).toBe(200);
      expect(ticketOf(bug)).toMatchObject({ ticketType: { name: 'Bug' }, version: 2 });
      const loose = await patch('alice', url(ids.feature), { parent: null });
      expect(ticketOf(loose).parent).toBeNull();
      const [event] = (await events('ticket.updated')).slice(-1);
      expect(event?.payload).toMatchObject({
        changes: { parentId: { from: ids.outcome?.id, to: null } },
      });
    });
  });

  describe('editing', () => {
    it("[CORE-008] saves only what changed, and refuses a write over someone else's", async () => {
      const ticket = await create('alice', {
        track: 'ABC',
        summary: 'Draft',
        description: doc('First words'),
      });
      const saved = await patch('alice', `/api/v1/tickets/${ticket.key}`, {
        summary: 'Final',
        version: 1,
      });
      expect(ticketOf(saved)).toMatchObject({ summary: 'Final', version: 2 });
      // Another editor still holds version 1.
      const stale = await patch('alice', `/api/v1/tickets/${ticket.key}`, {
        summary: 'Overwritten',
        version: 1,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toEqual({ error: 'version_conflict' });
      // The same document with its keys in another order is no change: no new version, no event.
      const before = (await events('ticket.updated')).length;
      const reordered = {
        content: [{ content: [{ text: 'First words', type: 'text' }], type: 'paragraph' }],
        type: 'doc',
      };
      const same = await patch('alice', `/api/v1/tickets/${ticket.id}`, {
        summary: 'Final',
        description: reordered,
      });
      expect(ticketOf(same).version).toBe(2);
      expect((await events('ticket.updated')).length).toBe(before);
      // Assigning needs the assignee to be assignable; Dave is.
      const assigned = await patch('alice', `/api/v1/tickets/${ticket.id}`, {
        assigneeId: users.dave?.id,
        dueDate: '2027-01-15',
      });
      expect(ticketOf(assigned)).toMatchObject({
        assignee: { id: users.dave?.id },
        dueDate: '2027-01-15',
        version: 3,
      });
      const [event] = (await events('ticket.updated')).slice(-1);
      expect(event?.payload).toEqual({
        key: ticket.key,
        changes: {
          assigneeId: { from: null, to: users.dave?.id },
          dueDate: { from: null, to: '2027-01-15' },
        },
      });
    });
  });

  describe('rank', () => {
    it('[AGL-009] puts new tickets at the bottom and moves them before, after, to the top and bottom', async () => {
      await newTrack('RNK');
      const [a, b, c] = [
        await create('alice', { track: 'RNK', summary: 'A' }),
        await create('alice', { track: 'RNK', summary: 'B' }),
        await create('alice', { track: 'RNK', summary: 'C' }),
      ] as [TicketJson, TicketJson, TicketJson];
      expect(await keysInRankOrder('RNK')).toEqual([a.key, b.key, c.key]);
      const rank = (t: TicketJson, body: Record<string, unknown>) =>
        put('alice', `/api/v1/tickets/${t.key}/rank`, body);

      expect((await rank(c, { before: a.key })).statusCode).toBe(200);
      expect(await keysInRankOrder('RNK')).toEqual([c.key, a.key, b.key]);
      await rank(c, { position: 'bottom' });
      expect(await keysInRankOrder('RNK')).toEqual([a.key, b.key, c.key]);
      await rank(a, { after: b.id });
      expect(await keysInRankOrder('RNK')).toEqual([b.key, a.key, c.key]);
      await rank(c, { position: 'top' });
      expect(await keysInRankOrder('RNK')).toEqual([c.key, b.key, a.key]);

      // Already in place: nothing changes and no event is written.
      const before = (await events('ticket.ranked')).length;
      expect((await rank(c, { position: 'top' })).statusCode).toBe(200);
      expect((await rank(b, { before: a.key })).statusCode).toBe(200);
      expect((await events('ticket.ranked')).length).toBe(before);

      expect((await rank(a, { before: a.key })).json().fields).toEqual({ before: 'self' });
      expect((await rank(a, { before: 'RNK-99' })).json().fields).toEqual({ before: 'not_found' });
      expect((await rank(a, { position: 'top', after: b.key })).statusCode).toBe(400);
    });

    it('[AGL-009] settles concurrent moves into one gap without a duplicate rank', async () => {
      await newTrack('GAP');
      const anchor = await create('alice', { track: 'GAP', summary: 'Anchor' });
      const next = await create('alice', { track: 'GAP', summary: 'Next' });
      const movers: TicketJson[] = [];
      for (let i = 0; i < 20; i++)
        movers.push(await create('alice', { track: 'GAP', summary: `M${i}` }));
      const results = await Promise.all(
        movers.map((m) => put('alice', `/api/v1/tickets/${m.id}/rank`, { after: anchor.key })),
      );
      expect(results.map((r) => r.statusCode)).toEqual(movers.map(() => 200));
      const order = await keysInRankOrder('GAP');
      expect(order[0]).toBe(anchor.key);
      expect(order[order.length - 1]).toBe(next.key);
      expect(new Set(order).size).toBe(22);
    });

    it('[AGL-009] needs "Schedule tickets" to rank', async () => {
      const ticket = await create('alice', { track: 'ABC', summary: 'Ranked by others' });
      expect(
        (await put('bob', `/api/v1/tickets/${ticket.id}/rank`, { position: 'top' })).json(),
      ).toEqual({
        error: 'forbidden',
        permission: 'schedule_tickets',
      });
    });
  });

  describe('moving to another track', () => {
    it('[CORE-023] gives the ticket and its subtickets keys in the new track and keeps the old ones', async () => {
      const parent = await create('alice', { track: 'ABC', summary: 'Moves away' });
      const subs = [
        await create('alice', {
          track: 'ABC',
          summary: 'Part 1',
          ticketTypeId: types.Subticket,
          parent: parent.key,
        }),
        await create('alice', {
          track: 'ABC',
          summary: 'Part 2',
          ticketTypeId: types.Subticket,
          parent: parent.key,
        }),
      ];
      const xyzBefore = (await get('alice', '/api/v1/tickets?track=XYZ&limit=200')).json().tickets
        .length;
      const res = await post('alice', `/api/v1/tickets/${parent.key}/move`, {
        track: 'XYZ',
        version: 1,
      });
      expect(res.statusCode, res.body).toBe(200);
      const moved = ticketOf(res);
      expect(moved).toMatchObject({
        track: { key: 'XYZ' },
        ticketType: { name: 'Feature' },
        version: 2,
      });
      expect(moved.key).toMatch(/^XYZ-\d+$/);
      for (const sub of subs) {
        const now = await get('alice', `/api/v1/tickets/${sub.key}`);
        expect(now.json()).toMatchObject({
          ticket: { id: sub.id, track: { key: 'XYZ' }, parent: { id: parent.id } },
          redirect: { from: sub.key },
        });
      }
      const old = await get('alice', `/api/v1/tickets/${parent.key}`);
      expect(old.json().redirect).toEqual({ from: parent.key, to: moved.key });
      expect(
        (await get('alice', '/api/v1/tickets?track=XYZ&limit=200')).json().tickets.length,
      ).toBe(xyzBefore + 3);
      // ABC never hands out the numbers the moved tickets had.
      const next = await create('alice', { track: 'ABC', summary: 'After the move' });
      expect(next.number).toBeGreaterThan(subs[1]?.number as number);
      const history = await database.db
        .selectFrom('ticket_key_history')
        .select(['track_id', 'number', 'replaced_at'])
        .where('ticket_id', '=', parent.id)
        .orderBy('id')
        .execute();
      expect(history.map((h) => [h.track_id, h.number, h.replaced_at === null])).toEqual([
        [tracks.ABC, parent.number, false],
        [tracks.XYZ, moved.number, true],
      ]);
      const [event] = (await events('ticket.moved')).slice(-1);
      expect(event?.payload).toMatchObject({
        from: { key: parent.key, trackId: tracks.ABC },
        to: { key: moved.key, trackId: tracks.XYZ },
        subtickets: subs.map((s) => ({ id: s.id, from: s.key })),
      });
    });

    it('[CORE-023] asks for a type the target track offers, and moves subtickets only with their parent', async () => {
      const ticket = await create('alice', { track: 'ABC', summary: 'To operations' });
      const sub = await create('alice', {
        track: 'ABC',
        summary: 'Its part',
        ticketTypeId: types.Subticket,
        parent: ticket.id,
      });
      // OPS is a business track: no features there.
      expect(
        (await post('alice', `/api/v1/tickets/${ticket.id}/move`, { track: 'OPS' })).json(),
      ).toEqual({
        error: 'invalid_fields',
        fields: { ticketTypeId: 'required' },
      });
      expect(
        (await post('alice', `/api/v1/tickets/${sub.id}/move`, { track: 'OPS' })).json(),
      ).toEqual({
        error: 'subticket_moves_with_parent',
      });
      expect(
        (await post('alice', `/api/v1/tickets/${ticket.id}/move`, { track: 'ABC' })).json().fields,
      ).toEqual({
        track: 'same_track',
      });
      // Carol may create in XYZ but cannot move out of ABC, which she cannot even see.
      expect(
        (await post('carol', `/api/v1/tickets/${ticket.id}/move`, { track: 'XYZ' })).statusCode,
      ).toBe(404);
      const moved = await post('alice', `/api/v1/tickets/${ticket.id}/move`, {
        track: 'OPS',
        ticketTypeId: types['To-do'],
      });
      expect(ticketOf(moved)).toMatchObject({
        track: { key: 'OPS' },
        ticketType: { name: 'To-do' },
      });
      expect((await view('alice', sub.id)).track.key).toBe('OPS');
    });
  });

  describe('trash', () => {
    it('[CORE-025] sends a ticket and its subtickets to the trash and brings them back with their links', async () => {
      const outcome = await create('alice', {
        track: 'ABC',
        summary: 'Retire me',
        ticketTypeId: types.Outcome,
      });
      const child = await create('alice', {
        track: 'XYZ',
        summary: 'Child elsewhere',
        parent: outcome.key,
      });
      const feature = await create('alice', {
        track: 'ABC',
        summary: 'Feature with parts',
        parent: outcome.key,
      });
      const sub = await create('alice', {
        track: 'ABC',
        summary: 'A part',
        ticketTypeId: types.Subticket,
        parent: feature.key,
      });

      // Deleting is for track administrators.
      expect((await del('alice', `/api/v1/tickets/${feature.key}`)).json()).toEqual({
        error: 'forbidden',
        permission: 'delete_tickets',
      });
      expect((await del('admin', `/api/v1/tickets/${feature.key}`)).statusCode).toBe(204);
      // Gone for the people who cannot restore it; the administrator sees it in the trash.
      expect((await get('alice', `/api/v1/tickets/${sub.key}`)).statusCode).toBe(404);
      const trashed = await view('admin', feature.key);
      expect(trashed.trash).toMatchObject({
        deletedBy: { id: users.admin?.id },
        deletedWith: null,
      });
      expect(
        Date.parse(trashed.trash?.purgeAfter ?? '') - Date.parse(trashed.trash?.deletedAt ?? ''),
      ).toBe(30 * 86_400_000);
      expect((await view('admin', sub.key)).trash?.deletedWith).toEqual({
        id: feature.id,
        key: feature.key,
      });
      const trash = (await get('admin', '/api/v1/trash?track=ABC')).json().tickets as TicketJson[];
      expect(trash.map((t) => t.key).sort()).toEqual([feature.key, sub.key].sort());
      expect((await get('alice', '/api/v1/trash')).json().tickets).toEqual([]);
      expect(await keysInRankOrder('ABC')).not.toContain(feature.key);
      // A subticket that went with its parent comes back with it, not alone.
      expect((await post('admin', `/api/v1/tickets/${sub.key}/restore`)).json()).toEqual({
        error: 'deleted_with_parent',
        parent: { id: feature.id, key: feature.key },
      });

      // Deleting the outcome takes the link from its child in XYZ.
      expect((await del('admin', `/api/v1/tickets/${outcome.key}`)).statusCode).toBe(204);
      expect((await view('alice', child.key)).parent).toBeNull();
      const [deleted] = (await events('ticket.deleted')).slice(-1);
      expect(deleted?.payload).toEqual({
        key: outcome.key,
        subtickets: [],
        detachedChildren: [child.id],
      });

      // The feature comes back without its parent, which is still in the trash.
      const back = await post('admin', `/api/v1/tickets/${feature.key}/restore`);
      expect(back.statusCode, back.body).toBe(200);
      expect(ticketOf(back)).toMatchObject({ trash: null, parent: null });
      expect((await view('alice', sub.key)).trash).toBeNull();
      // Restoring the outcome gives both children their link back.
      const outcomeBack = await post('admin', `/api/v1/tickets/${outcome.key}/restore`);
      expect(outcomeBack.statusCode, outcomeBack.body).toBe(200);
      expect((await view('alice', child.key)).parent?.id).toBe(outcome.id);
      expect((await view('alice', feature.key)).parent?.id).toBe(outcome.id);
      const [restored] = (await events('ticket.restored')).slice(-1);
      expect(restored?.payload).toEqual({
        key: outcome.key,
        subtickets: [],
        reattachedChildren: [child.id, feature.id].sort((a, b) => a - b),
        detachedFrom: null,
      });
      expect((await post('admin', `/api/v1/tickets/${outcome.key}/restore`)).json()).toEqual({
        error: 'not_in_trash',
      });
    });
  });

  describe('archived tracks', () => {
    it('[CORE-025] keeps the tickets of an archived track readable and unchangeable', async () => {
      await newTrack('ARC');
      const ticket = await create('alice', { track: 'ARC', summary: 'Frozen' });
      expect((await post('admin', `/api/v1/tracks/${tracks.ARC}/archive`)).statusCode).toBe(200);
      expect((await get('alice', `/api/v1/tickets/${ticket.key}`)).statusCode).toBe(200);
      for (const res of [
        await patch('alice', `/api/v1/tickets/${ticket.key}`, { summary: 'Thawed' }),
        await put('alice', `/api/v1/tickets/${ticket.key}/rank`, { position: 'top' }),
        await post('alice', `/api/v1/tickets/${ticket.key}/move`, { track: 'XYZ' }),
        await del('admin', `/api/v1/tickets/${ticket.key}`),
        await post('alice', '/api/v1/tickets', { track: 'ARC', summary: 'New' }),
      ]) {
        expect(res.json()).toEqual({ error: 'track_archived' });
      }
    });
  });

  describe('lists', () => {
    it("[CORE-008] lists a track's tickets in rank order, page by page, and the children of a ticket", async () => {
      const page1 = (await get('alice', '/api/v1/tickets?track=RNK&limit=2')).json();
      expect(page1.tickets).toHaveLength(2);
      const page2 = (
        await get('alice', `/api/v1/tickets?track=RNK&limit=2&after=${page1.next}`)
      ).json();
      expect(page2.tickets).toHaveLength(1);
      expect(page2.next).toBeNull();
      const parent = await create('alice', { track: 'ABC', summary: 'Has parts' });
      const part = await create('alice', {
        track: 'ABC',
        summary: 'Part',
        ticketTypeId: types.Subticket,
        parent: parent.key,
      });
      const children = (await get('alice', `/api/v1/tickets?parent=${parent.key}`)).json()
        .tickets as TicketJson[];
      expect(children.map((c) => c.id)).toEqual([part.id]);
      expect((await get('carol', '/api/v1/tickets?track=ABC')).statusCode).toBe(404);
      const carolSees = (await get('carol', '/api/v1/tickets?limit=200')).json()
        .tickets as TicketJson[];
      expect(carolSees.every((t) => t.track.key === 'XYZ')).toBe(true);
    });
  });

  describe('type sets and hierarchy changes see tickets', () => {
    it('[CORE-005] maps the tickets of a type a set drops to another type at its level', async () => {
      const set = await post('admin', '/api/v1/type-sets', {
        name: 'Mapping set',
        ticketTypeIds: [types.Outcome, types.Feature, types.Bug, types.Subticket],
        defaultTypeId: types.Feature,
      });
      expect(set.statusCode, set.body).toBe(201);
      const setId = set.json().typeSet.id;
      await newTrack('MAP', { typeSetId: setId });
      const bugs = [
        await create('alice', { track: 'MAP', summary: 'Bug 1', ticketTypeId: types.Bug }),
        await create('alice', { track: 'MAP', summary: 'Bug 2', ticketTypeId: types.Bug }),
      ];
      const kept = [types.Outcome, types.Feature, types.Subticket];
      const refused = await patch('admin', `/api/v1/type-sets/${setId}`, { ticketTypeIds: kept });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({
        error: 'type_in_use',
        ticketTypeIds: [types.Bug],
        ticketCount: 2,
      });
      const wrongLevel = await patch('admin', `/api/v1/type-sets/${setId}`, {
        ticketTypeIds: kept,
        ticketTypeMapping: { [String(types.Bug)]: types.Outcome },
      });
      expect(wrongLevel.json()).toMatchObject({ error: 'invalid_mapping', problem: 'other_level' });
      const mapped = await patch('admin', `/api/v1/type-sets/${setId}`, {
        ticketTypeIds: kept,
        ticketTypeMapping: { [String(types.Bug)]: types.Feature },
      });
      expect(mapped.statusCode, mapped.body).toBe(200);
      for (const bug of bugs) {
        expect(await view('alice', bug.id)).toMatchObject({
          ticketType: { name: 'Feature' },
          version: 2,
        });
      }
      const [event] = (await events('type_set.updated')).slice(-1);
      expect(event?.payload).toMatchObject({
        mapped: [{ fromTypeId: types.Bug, toTypeId: types.Feature, ticketCount: 2 }],
      });

      // The same when the track switches to a set without features.
      const business = (await get('admin', '/api/v1/type-sets'))
        .json()
        .typeSets.find((s: { name: string }) => s.name === 'Business type set');
      const switched = await patch('admin', `/api/v1/tracks/${tracks.MAP}`, {
        typeSetId: business.id,
      });
      expect(switched.json()).toMatchObject({
        error: 'type_in_use',
        ticketTypeIds: [types.Feature],
      });
      const done = await patch('admin', `/api/v1/tracks/${tracks.MAP}`, {
        typeSetId: business.id,
        ticketTypeMapping: { [String(types.Feature)]: types['To-do'] },
      });
      expect(done.statusCode, done.body).toBe(200);
      expect((await view('alice', bugs[0]?.id as number)).ticketType.name).toBe('To-do');
    });

    it('[CORE-007] refuses a hierarchy change that would break the links of existing tickets', async () => {
      const level = await post('admin', '/api/v1/hierarchy-levels', { name: 'Objective' });
      expect(level.statusCode, level.body).toBe(201);
      const levelId = level.json().level.id;
      const objectiveType = await post('admin', '/api/v1/ticket-types', {
        name: 'Objective',
        levelId,
      });
      const objective = objectiveType.json().ticketType.id;
      const set = await post('admin', '/api/v1/type-sets', {
        name: 'Planning set',
        ticketTypeIds: [objective, types.Outcome, types.Feature],
        defaultTypeId: types.Feature,
      });
      await newTrack('PLN', { typeSetId: set.json().typeSet.id });
      const top = await create('alice', { track: 'PLN', summary: 'Grow', ticketTypeId: objective });
      const below = await create('alice', {
        track: 'PLN',
        summary: 'Onboarding',
        ticketTypeId: types.Outcome,
        parent: top.key,
      });
      // Removing the level puts Objective at the standard level, below its outcome child.
      const impact = await get(
        'admin',
        `/api/v1/hierarchy-levels/impact?change=remove&levelId=${levelId}`,
      );
      expect(impact.json().impact).toMatchObject({
        brokenLinks: [{ ticketId: below.id, parentId: top.id }],
        breaksTickets: true,
      });
      const removed = await del('admin', `/api/v1/hierarchy-levels/${levelId}`);
      expect(removed.statusCode).toBe(409);
      expect(removed.json().error).toBe('breaks_tickets');
      // Without the link, the level goes.
      await patch('alice', `/api/v1/tickets/${below.id}`, { parent: null });
      expect((await del('admin', `/api/v1/hierarchy-levels/${levelId}`)).statusCode).toBe(204);
    });
  });

  describe('change history (M1-009)', () => {
    interface ChangeJson {
      id: string;
      changeSet: string;
      at: string;
      actor: { id: number; name: string } | null;
      field: string;
      from: { value: string | null; display: string | null };
      to: { value: string | null; display: string | null };
    }
    const historyOf = async (ref: string | number, query = '') =>
      (await get('admin', `/api/v1/tickets/${ref}/history?order=asc&limit=1000${query}`)).json()
        .changes as ChangeJson[];
    /** The changes of the latest change set: field, from and to (values and names). */
    const lastSet = async (ref: string | number) => {
      const all = await historyOf(ref);
      const set = all[all.length - 1]?.changeSet;
      return all
        .filter((c) => c.changeSet === set)
        .map((c) => [c.field, c.from.display ?? c.from.value, c.to.display ?? c.to.value]);
    };

    it('[CORE-022] records every starting value of a new ticket, with names', async () => {
      const ticket = await create('alice', {
        track: 'ABC',
        summary: 'Recorded',
        assigneeId: users.dave?.id,
        dueDate: '2027-02-01',
        description: doc('Why'),
      });
      const changes = await historyOf(ticket.key);
      expect(new Set(changes.map((c) => c.changeSet)).size).toBe(1);
      expect(changes.map((c) => c.field)).toEqual([
        'track',
        'key',
        'type',
        'summary',
        'description',
        'assignee',
        'requester',
        'dueDate',
        // The track's default priority (M1-014).
        'priority',
        'rank',
      ]);
      expect(changes.every((c) => c.from.value === null && c.actor?.id === users.alice?.id)).toBe(
        true,
      );
      const by = Object.fromEntries(changes.map((c) => [c.field, c.to]));
      expect(by.priority?.display).toBe('Normal');
      expect(by.track).toEqual({ value: String(tracks.ABC), display: 'ABC' });
      expect(by.type).toEqual({ value: String(types.Feature), display: 'Feature' });
      expect(by.assignee).toEqual({ value: String(users.dave?.id), display: 'dave' });
      expect(JSON.parse(by.description?.value ?? 'null')).toMatchObject({ type: 'doc' });
    });

    it('[CORE-022] records each edit, rank move, track move, deletion and restore', async () => {
      const parent = await create('alice', {
        track: 'ABC',
        summary: 'Parent',
        ticketTypeId: types.Outcome,
      });
      const ticket = await create('alice', { track: 'ABC', summary: 'Before', parent: parent.key });
      const sub = await create('alice', {
        track: 'ABC',
        summary: 'Part',
        ticketTypeId: types.Subticket,
        parent: ticket.key,
      });
      await patch('alice', `/api/v1/tickets/${ticket.id}`, {
        summary: 'After',
        assigneeId: users.dave?.id,
      });
      expect(await lastSet(ticket.id)).toEqual([
        ['summary', 'Before', 'After'],
        ['assignee', null, 'dave'],
      ]);
      const oldRank = (await view('alice', ticket.id)).rank;
      await put('alice', `/api/v1/tickets/${ticket.id}/rank`, { position: 'top' });
      const ranked = await lastSet(ticket.id);
      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.slice(0, 2)).toEqual(['rank', oldRank]);

      const moved = ticketOf(
        await post('alice', `/api/v1/tickets/${ticket.id}/move`, { track: 'XYZ' }),
      );
      expect(await lastSet(ticket.id)).toEqual([
        ['track', 'ABC', 'XYZ'],
        ['key', ticket.key, moved.key],
      ]);
      // The subticket moved in the same change set.
      const subHistory = await historyOf(sub.id);
      const last = subHistory[subHistory.length - 1];
      const ticketHistory = await historyOf(ticket.id);
      expect(last?.changeSet).toBe(ticketHistory[ticketHistory.length - 1]?.changeSet);

      // Deleting the parent detaches its child and says so in the child's history.
      expect((await del('admin', `/api/v1/tickets/${parent.key}`)).statusCode).toBe(204);
      expect(await lastSet(parent.id)).toEqual([['trash', null, 'in_trash']]);
      expect(await lastSet(ticket.id)).toEqual([['parent', parent.key, null]]);
      expect((await post('admin', `/api/v1/tickets/${parent.key}/restore`)).statusCode).toBe(200);
      expect(await lastSet(parent.id)).toEqual([['trash', 'in_trash', null]]);
      expect(await lastSet(ticket.id)).toEqual([['parent', null, parent.key]]);
      const deleter = (await historyOf(parent.id)).find((c) => c.field === 'trash');
      expect(deleter?.actor?.id).toBe(users.admin?.id);
    });

    it('[CORE-022] records the type of tickets mapped when their type leaves a track', async () => {
      const set = await post('admin', '/api/v1/type-sets', {
        name: 'History mapping set',
        ticketTypeIds: [types.Feature, types.Bug],
        defaultTypeId: types.Feature,
      });
      await newTrack('HMS', { typeSetId: set.json().typeSet.id });
      const bug = await create('alice', {
        track: 'HMS',
        summary: 'A bug',
        ticketTypeId: types.Bug,
      });
      const mapped = await patch('admin', `/api/v1/type-sets/${set.json().typeSet.id}`, {
        ticketTypeIds: [types.Feature],
        ticketTypeMapping: { [String(types.Bug)]: types.Feature },
      });
      expect(mapped.statusCode, mapped.body).toBe(200);
      expect(await lastSet(bug.id)).toEqual([['type', 'Bug', 'Feature']]);
    });

    it('[CORE-022] holds a complete history after a 1,000-step scripted edit sequence', async () => {
      await newTrack('SEQ');
      const ticket = await create('alice', { track: 'SEQ', summary: 'Step 0' });
      // People assignable in SEQ: Alice works there; nobody is a choice too.
      const people = [users.alice?.id, users.admin?.id, null];
      let seed = 42;
      const next = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed;
      };
      for (let step = 1; step <= 1_000; step++) {
        const pick = next() % 4;
        const body =
          pick === 0
            ? { summary: `Step ${step}` }
            : pick === 1
              ? { assigneeId: people[next() % people.length] ?? null }
              : pick === 2
                ? { dueDate: next() % 3 === 0 ? null : `2027-0${(next() % 9) + 1}-1${next() % 9}` }
                : { ticketTypeId: next() % 2 === 0 ? types.Bug : types.Feature };
        const res = await patch('alice', `/api/v1/tickets/${ticket.id}`, body);
        expect(res.statusCode, res.body).toBe(200);
      }
      // Replaying the history from nothing gives the ticket as it is now.
      const state: Record<string, string | null> = {};
      let cursor = '';
      for (;;) {
        const page = (
          await get('alice', `/api/v1/tickets/${ticket.id}/history?order=asc&limit=500${cursor}`)
        ).json();
        for (const c of page.changes as ChangeJson[]) {
          expect(state[c.field] ?? null, `${c.id} ${c.field}`).toBe(c.from.value);
          state[c.field] = c.to.value;
        }
        if (!page.next) break;
        cursor = `&cursor=${page.next}`;
      }
      const now = await view('alice', ticket.id);
      expect(state.summary).toBe(now.summary);
      expect(state.assignee ?? null).toBe(now.assignee ? String(now.assignee.id) : null);
      expect(state.dueDate ?? null).toBe(now.dueDate);
      expect(state.type).toBe(String(now.ticketType.id));
      expect(now.version).toBeGreaterThan(1);
    }, 120_000);

    it('[CORE-022] reads any page of a 20,000-change history in under 300 ms', async () => {
      const ticket = await create('alice', { track: 'ABC', summary: 'Long history' });
      await database.db.executeQuery(
        sql`INSERT INTO ticket_change (workspace_id, ticket_id, change_set, actor_id, field,
              from_value, to_value)
            SELECT 1, ${ticket.id}, 1000000 + g, ${users.alice?.id}, 'summary', 'v' || g, 'v' || (g + 1)
              FROM generate_series(1, 20000) g`.compile(database.db),
      );
      await database.db.executeQuery(sql`ANALYZE ticket_change`.compile(database.db));
      const timed = async (query: string) => {
        const started = performance.now();
        const res = await get('alice', `/api/v1/tickets/${ticket.id}/history?${query}`);
        const ms = performance.now() - started;
        expect(res.statusCode).toBe(200);
        return { ms, body: res.json() };
      };
      const first = await timed('limit=100');
      expect(first.body.changes).toHaveLength(100);
      const deep = await timed(`limit=100&cursor=${Number(first.body.next) - 15_000}`);
      expect(deep.body.changes).toHaveLength(100);
      const oldest = await timed('order=asc&limit=1000');
      expect(oldest.body.changes).toHaveLength(1000);
      for (const { ms } of [first, deep, oldest]) expect(ms).toBeLessThan(300);
      // And the whole history, a thousand at a time.
      let pages = 0;
      let cursor = '';
      const started = performance.now();
      for (;;) {
        const page = (
          await get('alice', `/api/v1/tickets/${ticket.id}/history?limit=1000${cursor}`)
        ).json();
        pages++;
        if (!page.next) break;
        cursor = `&cursor=${page.next}`;
      }
      expect(pages).toBe(21);
      expect((performance.now() - started) / pages).toBeLessThan(300);
    }, 60_000);

    it('[CORE-022] shows the history only to those who see the ticket', async () => {
      const ticket = await create('alice', { track: 'ABC', summary: 'Private to ABC' });
      expect((await get('carol', `/api/v1/tickets/${ticket.key}/history`)).statusCode).toBe(404);
      expect((await get('bob', `/api/v1/tickets/${ticket.key}/history`)).statusCode).toBe(200);
      expect(
        (await get('bob', `/api/v1/tickets/${ticket.key}/history?limit=5000`)).statusCode,
      ).toBe(400);
    });
  });
});
