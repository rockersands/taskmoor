import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
const HOUR = 3600;
let address = 0;
const nextAddress = () => `100.70.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface TimeTrackingJson {
  originalEstimate: number | null;
  remainingEstimate: number | null;
  timeSpent: number;
  effortRatio: number | null;
}
interface TicketJson {
  id: number;
  key: string;
  version: number;
  timeTracking: TimeTrackingJson;
}
interface EntryJson {
  id: number;
  author: { id: number; name: string };
  startedAt: string;
  duration: number;
  description: string;
  visibility: { roleId: number } | { groupId: number } | null;
}

describe('time tracking (M1-019)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const roles: Record<string, number> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const get = (who: string, url: string) => as(who, { method: 'GET', url });
  const post = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'POST', url, payload });
  const patch = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'PATCH', url, payload });
  const del = (who: string, url: string) => as(who, { method: 'DELETE', url });

  const ticketOf = (res: LightMyRequestResponse) => res.json().ticket as TicketJson;
  async function create(body: Record<string, unknown> = {}): Promise<TicketJson> {
    const res = await post('alice', '/api/v1/tickets', { track: 'TIM', summary: 'Work', ...body });
    expect(res.statusCode, res.body).toBe(201);
    return ticketOf(res);
  }
  const time = async (ticket: TicketJson) =>
    ticketOf(await get('alice', `/api/v1/tickets/${ticket.id}`)).timeTracking;
  async function record(who: string, ticket: TicketJson, body: Record<string, unknown>) {
    const res = await post(who, `/api/v1/tickets/${ticket.id}/time-entries`, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().timeEntry as EntryJson;
  }
  const entries = async (who: string, ticket: TicketJson) =>
    (await get(who, `/api/v1/tickets/${ticket.id}/time-entries`)).json().timeEntries as EntryJson[];

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
    const res = await post('admin', '/api/v1/tracks', { key: 'TIM', name: 'Time', mode: 'shared' });
    const trackId = res.json().track.id;
    // Alice and Dave record time; Bob views; Carol administers the track.
    for (const [who, role] of [
      ['alice', 'Members'],
      ['dave', 'Members'],
      ['bob', 'Viewers'],
      ['carol', 'Administrators'],
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
  });
  afterAll(async () => {
    await app.close();
  });

  it('[TIM-001] lowers a 5h remaining estimate to 3h when 2h is recorded automatically', async () => {
    const ticket = await create({ originalEstimate: '5h' });
    expect(ticket.timeTracking).toEqual({
      originalEstimate: 5 * HOUR,
      remainingEstimate: 5 * HOUR,
      timeSpent: 0,
      effortRatio: 0,
    });
    const entry = await record('alice', ticket, { duration: '2h', description: 'Pairing' });
    expect(entry).toMatchObject({ duration: 2 * HOUR, description: 'Pairing', visibility: null });
    expect(await time(ticket)).toEqual({
      originalEstimate: 5 * HOUR,
      remainingEstimate: 3 * HOUR,
      timeSpent: 2 * HOUR,
      effortRatio: 40,
    });
    // One change set: the entry, time spent and the remaining estimate.
    const changes = (await get('alice', `/api/v1/tickets/${ticket.id}/history`)).json().changes;
    const last = changes.filter((c: { changeSet: string }) => c.changeSet === changes[0].changeSet);
    expect(last.map((c: { field: string }) => c.field).sort()).toEqual([
      'remainingEstimate',
      'timeEntry',
      'timeSpent',
    ]);
    expect((await get('alice', `/api/v1/tickets/${ticket.id}`)).json().ticket.version).toBe(
      ticket.version + 1,
    );
  });

  it('[TIM-001] leaves, sets or reduces the remaining estimate as asked', async () => {
    const ticket = await create({ originalEstimate: '10h' });
    await record('alice', ticket, { duration: '1h', remainingEstimate: { mode: 'leave' } });
    expect((await time(ticket)).remainingEstimate).toBe(10 * HOUR);
    await record('alice', ticket, {
      duration: 3600,
      remainingEstimate: { mode: 'set', value: '4h' },
    });
    expect((await time(ticket)).remainingEstimate).toBe(4 * HOUR);
    const entry = await record('alice', ticket, {
      duration: '1h',
      remainingEstimate: { mode: 'reduce', value: '30m' },
    });
    expect(await time(ticket)).toMatchObject({
      remainingEstimate: 3.5 * HOUR,
      timeSpent: 3 * HOUR,
    });
    // Changing a duration moves the estimate by the difference; deleting gives the time back.
    const longer = await patch('alice', `/api/v1/tickets/${ticket.id}/time-entries/${entry.id}`, {
      duration: '2h 30m',
    });
    expect(longer.statusCode, longer.body).toBe(200);
    expect(await time(ticket)).toMatchObject({
      remainingEstimate: 2 * HOUR,
      timeSpent: 4.5 * HOUR,
    });
    expect(
      (await del('alice', `/api/v1/tickets/${ticket.id}/time-entries/${entry.id}`)).statusCode,
    ).toBe(204);
    expect(await time(ticket)).toMatchObject({
      remainingEstimate: 4.5 * HOUR,
      timeSpent: 2 * HOUR,
    });
    // Never below zero, and a ticket without an estimate keeps none.
    await record('alice', ticket, { duration: '1w' });
    expect((await time(ticket)).remainingEstimate).toBe(0);
    const open = await create();
    await record('alice', open, { duration: '1h' });
    expect(await time(open)).toMatchObject({ remainingEstimate: null, effortRatio: null });
  });

  it('[TIM-001] parses "1w 2d" with the working-week settings', async () => {
    const settings = (await get('bob', '/api/v1/time-tracking')).json().settings;
    expect(settings).toEqual({
      enabled: true,
      hoursPerDay: 8,
      daysPerWeek: 5,
      displayFormat: 'pretty',
      defaultUnit: 'minute',
      copyTransitionComments: false,
    });
    expect((await create({ originalEstimate: '1w 2d' })).timeTracking.originalEstimate).toBe(
      56 * HOUR,
    );
    expect((await patch('alice', '/api/v1/time-tracking', { hoursPerDay: 6 })).statusCode).toBe(
      403,
    );
    expect((await patch('admin', '/api/v1/time-tracking', { hoursPerDay: 25 })).statusCode).toBe(
      400,
    );
    const changed = await patch('admin', '/api/v1/time-tracking', {
      hoursPerDay: 7.5,
      daysPerWeek: 4,
      defaultUnit: 'hour',
    });
    expect(changed.json().settings).toMatchObject({ hoursPerDay: 7.5, daysPerWeek: 4 });
    expect((await create({ originalEstimate: '1w 2d' })).timeTracking.originalEstimate).toBe(
      45 * HOUR,
    );
    // A bare number is in the default unit.
    expect((await create({ originalEstimate: '3' })).timeTracking.originalEstimate).toBe(3 * HOUR);
    const bad = await post('alice', '/api/v1/tickets', {
      track: 'TIM',
      summary: 'x',
      originalEstimate: '2 weeks',
    });
    expect(bad.json().fields).toEqual({ originalEstimate: 'invalid' });
    await patch('admin', '/api/v1/time-tracking', {
      hoursPerDay: 8,
      daysPerWeek: 5,
      defaultUnit: 'minute',
    });
  });

  it('[TIM-001] carries the remaining estimate with the original until time is recorded', async () => {
    const ticket = await create();
    const set = await patch('alice', `/api/v1/tickets/${ticket.id}`, { originalEstimate: '2d' });
    expect(ticketOf(set).timeTracking).toMatchObject({
      originalEstimate: 16 * HOUR,
      remainingEstimate: 16 * HOUR,
    });
    await patch('alice', `/api/v1/tickets/${ticket.id}`, { originalEstimate: '3d' });
    expect((await time(ticket)).remainingEstimate).toBe(24 * HOUR);
    await record('alice', ticket, { duration: '4h' });
    await patch('alice', `/api/v1/tickets/${ticket.id}`, { originalEstimate: '4d' });
    expect(await time(ticket)).toMatchObject({
      originalEstimate: 32 * HOUR,
      remainingEstimate: 20 * HOUR,
    });
    // Viewers do not estimate.
    expect(
      (await patch('bob', `/api/v1/tickets/${ticket.id}`, { remainingEstimate: '1h' })).json()
        .permission,
    ).toBe('edit_tickets');
  });

  it('[TIM-001] gates recording, editing and deleting by own and all permissions', async () => {
    const ticket = await create();
    const denied = await post('bob', `/api/v1/tickets/${ticket.id}/time-entries`, {
      duration: '1h',
    });
    expect(denied.json()).toEqual({ error: 'forbidden', permission: 'record_time' });
    const daves = await record('dave', ticket, { duration: '1h' });
    const url = `/api/v1/tickets/${ticket.id}/time-entries/${daves.id}`;
    // Alice may change her own entries only; Carol administers the track and may change all.
    expect((await patch('alice', url, { description: 'Mine now' })).json()).toEqual({
      error: 'forbidden',
      permission: 'edit_all_time_entries',
    });
    expect((await del('alice', url)).json()).toEqual({
      error: 'forbidden',
      permission: 'delete_all_time_entries',
    });
    expect((await patch('dave', url, { description: 'Reviewed' })).statusCode).toBe(200);
    expect(
      (await patch('carol', url, { startedAt: '2026-10-01T09:00:00Z' })).json().timeEntry,
    ).toMatchObject({ startedAt: '2026-10-01T09:00:00.000Z', description: 'Reviewed' });
    expect((await del('carol', url)).statusCode).toBe(204);
    expect((await patch('dave', url, { description: 'Gone' })).statusCode).toBe(404);
    // An entry keeps the author and start it was recorded with.
    const back = await record('alice', ticket, {
      duration: '45m',
      startedAt: '2026-09-30T14:00:00+02:00',
    });
    expect(back).toMatchObject({
      author: { name: 'alice' },
      startedAt: '2026-09-30T12:00:00.000Z',
      duration: 45 * 60,
    });
    for (const duration of ['0m', 0, -60, 'soon']) {
      const res = await post('alice', `/api/v1/tickets/${ticket.id}/time-entries`, { duration });
      expect(res.statusCode, String(duration)).toBe(400);
    }
  });

  it('[TIM-001] shows a restricted time entry only to its role or group, and its author', async () => {
    const ticket = await create();
    const restricted = await record('alice', ticket, {
      duration: '2h',
      description: 'Security review',
      visibility: { roleId: roles.Administrators },
    });
    await record('dave', ticket, { duration: '1h' });
    expect((await entries('alice', ticket)).map((e) => e.description)).toEqual([
      'Security review',
      '',
    ]);
    expect((await entries('carol', ticket)).map((e) => e.duration)).toEqual([2 * HOUR, HOUR]);
    expect((await entries('bob', ticket)).map((e) => e.duration)).toEqual([HOUR]);
    expect((await entries('dave', ticket)).map((e) => e.duration)).toEqual([HOUR]);
    expect(
      (
        await patch('dave', `/api/v1/tickets/${ticket.id}/time-entries/${restricted.id}`, {
          description: 'Seen',
        })
      ).statusCode,
    ).toBe(404);
    // The total is the ticket's, hidden entries included.
    expect((await time(ticket)).timeSpent).toBe(3 * HOUR);

    const group = await database.db
      .insertInto('user_group')
      .values({ workspace_id: 1, name: 'Auditors' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const notMember = await post('alice', `/api/v1/tickets/${ticket.id}/time-entries`, {
      duration: '1h',
      visibility: { groupId: group.id },
    });
    expect(notMember.json().fields).toEqual({ visibility: 'not_a_member' });
    await database.db
      .insertInto('group_member')
      .values({ workspace_id: 1, group_id: group.id, user_id: users.alice?.id as number })
      .execute();
    await record('alice', ticket, { duration: '1h', visibility: { groupId: group.id } });
    expect((await entries('carol', ticket)).length).toBe(2);
    expect((await entries('alice', ticket)).length).toBe(3);
  });

  it('[TIM-001] refuses estimates and time entries while time tracking is off', async () => {
    const ticket = await create({ originalEstimate: '1h' });
    await patch('admin', '/api/v1/time-tracking', { enabled: false });
    expect(
      (await post('alice', `/api/v1/tickets/${ticket.id}/time-entries`, { duration: '1h' })).json(),
    ).toEqual({ error: 'time_tracking_disabled' });
    expect(
      (await patch('alice', `/api/v1/tickets/${ticket.id}`, { originalEstimate: '2h' })).json(),
    ).toEqual({ error: 'time_tracking_disabled' });
    // What was recorded stays.
    expect((await time(ticket)).originalEstimate).toBe(HOUR);
    await patch('admin', '/api/v1/time-tracking', { enabled: true });
    expect(
      (await post('alice', `/api/v1/tickets/${ticket.id}/time-entries`, { duration: '1h' }))
        .statusCode,
    ).toBe(201);
  });

  // The All feed reads a ticket's activity page by page (T-309): every time entry the reader
  // sees comes once, on the page whose stretch of time holds its start, an imported one with no
  // history row included, and a restricted one only for its audience.
  it("[CORE-022] [TIM-001] gives each time entry once across the pages of a ticket's activity", async () => {
    const ticket = await create();
    const logged: number[] = [];
    for (let i = 0; i < 4; i++) {
      const entry = await record(i % 2 === 0 ? 'alice' : 'dave', ticket, {
        duration: `${i + 1}h`,
        startedAt: new Date().toISOString(),
      });
      logged.push(entry.id);
    }
    const restricted = await record('alice', ticket, {
      duration: '1h',
      startedAt: new Date().toISOString(),
      visibility: { roleId: roles.Administrators },
    });
    // An import writes the entry and no history row for it, from long before.
    const imported = await database.db
      .insertInto('time_entry')
      .values({
        workspace_id: 1,
        ticket_id: ticket.id,
        author_id: users.dave?.id as number,
        started_at: new Date('2020-03-02T09:00:00Z'),
        duration: 30 * 60,
        description: 'Imported',
        visible_role_id: null,
        visible_group_id: null,
        created_by: users.dave?.id as number,
        created_at: new Date('2020-03-02T09:30:00Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const walk = async (who: string) => {
      const pages: EntryJson[][] = [];
      let cursor: string | null = null;
      do {
        const res = await get(
          who,
          `/api/v1/tickets/${ticket.id}/activity?kind=all&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        );
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json() as { timeEntries: EntryJson[]; next: string | null };
        pages.push(body.timeEntries);
        cursor = body.next;
      } while (cursor !== null);
      return pages;
    };
    const carol = await walk('carol');
    const seen = carol.flat().map((e) => e.id);
    expect([...seen].sort((a, b) => a - b)).toEqual(
      [...logged, restricted.id, imported.id].sort((a, b) => a - b),
    );
    // Spread over the pages, newest first within each, the imported one on the last.
    expect(carol.filter((p) => p.length > 0).length).toBeGreaterThan(1);
    expect(carol.at(-1)?.map((e) => e.description)).toContain('Imported');
    for (const p of carol) {
      const starts = p.map((e) => e.startedAt);
      expect(starts).toEqual([...starts].sort().reverse());
    }
    const bob = (await walk('bob')).flat().map((e) => e.id);
    expect([...bob].sort((a, b) => a - b)).toEqual([...logged, imported.id].sort((a, b) => a - b));
    // The default page holds them all; a cursor naming no row of the ticket, none.
    const first = (await get('carol', `/api/v1/tickets/${ticket.id}/activity`)).json();
    expect(first.timeEntries.length).toBe(6);
    expect(first.timeEntries[0]).toMatchObject({ author: { name: expect.any(String) } });
    const history = await get('carol', `/api/v1/tickets/${ticket.id}/activity?kind=history`);
    expect(history.json().timeEntries).toBeUndefined();
  });

  /** Every page of a ticket's All activity, as `who` reads them. */
  async function allPages(who: string, ticket: TicketJson, limit: number) {
    const pages: { activity: unknown[]; timeEntries: EntryJson[] }[] = [];
    let cursor: string | null = null;
    do {
      const res = await get(
        who,
        `/api/v1/tickets/${ticket.id}/activity?kind=all&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as {
        activity: unknown[];
        timeEntries: EntryJson[];
        next: string | null;
      };
      pages.push(body);
      cursor = body.next;
      expect(pages.length).toBeLessThan(50);
    } while (cursor !== null);
    return pages;
  }
  const importEntries = (ticket: TicketJson, starts: Date[]) =>
    database.db
      .insertInto('time_entry')
      .values(
        starts.map((at) => ({
          workspace_id: 1,
          ticket_id: ticket.id,
          author_id: users.dave?.id as number,
          started_at: at,
          duration: 15 * 60,
          description: 'Imported',
          visible_role_id: null,
          visible_group_id: null,
          created_by: users.dave?.id as number,
          created_at: at,
        })),
      )
      .returning('id')
      .execute();

  // A page of the All activity holds `limit` time entries at most, however many fall in the
  // stretch of time its history rows cover: an import writes entries and no history rows.
  it("[CORE-022] [TIM-001] holds at most `limit` time entries on a page of a ticket's activity", async () => {
    const ticket = await create();
    const soon = Date.now() + 60_000;
    const imported = await importEntries(
      ticket,
      Array.from({ length: 120 }, (_, i) => new Date(soon + i * 60_000)),
    );
    const first = (await get('carol', `/api/v1/tickets/${ticket.id}/activity?kind=all`)).json();
    expect(first.timeEntries.length).toBe(50);
    // Its cursor names the entry it stopped at, which only an All page takes.
    expect(first.next).toMatch(/^[0-9]+\.-?[0-9]+\.[0-9]+$/);
    const other = await get(
      'carol',
      `/api/v1/tickets/${ticket.id}/activity?kind=history&cursor=${first.next}`,
    );
    expect(other.statusCode).toBe(400);
    const pages = await allPages('carol', ticket, 20);
    for (const p of pages) expect(p.timeEntries.length).toBeLessThanOrEqual(20);
    const seen = pages.flatMap((p) => p.timeEntries.map((e) => e.id));
    expect(seen.length).toBe(120);
    expect(new Set(seen)).toEqual(new Set(imported.map((e) => e.id)));
    // Newest first across the pages too, and the history comes along.
    const starts = pages.flatMap((p) => p.timeEntries.map((e) => e.startedAt));
    expect(starts).toEqual([...starts].sort().reverse());
    expect(pages.flatMap((p) => p.activity).length).toBeGreaterThan(0);
  });

  // History rows whose times run against their order (an import's, or two writes at once) must
  // not hand a time entry out twice: each page goes on from the entry the page before stopped at.
  it("[CORE-022] [TIM-001] gives a time entry once when a ticket's history times are out of order", async () => {
    const ticket = await create();
    for (const at of ['2026-01-01T12:00:00Z', '2026-01-10T12:00:00Z', '2026-01-05T12:00:00Z']) {
      await database.db
        .insertInto('ticket_change')
        .values({
          workspace_id: 1,
          ticket_id: ticket.id,
          change_set: sql<string>`nextval('ticket_change_set_seq')`,
          at: new Date(at),
          actor_id: users.alice?.id as number,
          field: 'labels',
          from_value: null,
          to_value: at.slice(0, 10),
          from_display: null,
          to_display: null,
          transition_id: null,
        })
        .execute();
    }
    const [between] = await importEntries(ticket, [new Date('2026-01-07T12:00:00Z')]);
    const seen = (await allPages('carol', ticket, 1)).flatMap((p) =>
      p.timeEntries.map((e) => e.id),
    );
    expect(seen).toEqual([between?.id]);
  });
});
