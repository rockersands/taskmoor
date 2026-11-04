import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { deliverEmail } from '../email/deliver';
import type { OutgoingEmail } from '../email/transport';
import { EventBus } from '../events/bus';
import type { DomainEvent } from '../events/catalogue';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { CHECKLIST_EVENT, MAX_NOTICE_CHANGES, notifyChecklist } from './checklists';
import { bumpInbox } from './subscriber';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.79.${Math.floor(++address / 250)}.${(address % 250) + 1}`;
const MINUTE = 60 * 1000;

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

/**
 * Lead runs the track. Ana makes the changes; Finn, Gil, Hal and Uma follow and may see the
 * ticket; Max may see it and follows nothing; Out follows but has no role, so may not see it.
 */
const PEOPLE = ['admin', 'lead', 'ana', 'finn', 'gil', 'hal', 'uma', 'max', 'out'] as const;
type Person = (typeof PEOPLE)[number];

interface InboxJson {
  id: string;
  event: string;
  ticket: { key: string } | null;
  actor: { name: string } | null;
  checklist?: { changes: number; others: number };
}

/**
 * Checklist notices (T-196a; NTF-015; ADR-120): on a track whose administrators turn them on,
 * a change to a ticket's checklists reaches its followers who may see it, in the inbox and by
 * email as each chooses, never the person who made it, and a run of changes as one notice that
 * names no list and no item.
 */
describe('checklist notices (NTF-015)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  const nameOf = new Map<number, Person>();
  let trackId = 0;

  const as = (who: Person, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who].cookie },
    });
  const roleId = async (name: string) =>
    (
      await database.db
        .selectFrom('role')
        .select('id')
        .where('name', '=', name)
        .executeTakeFirstOrThrow()
    ).id;

  /** The worker's part: relay events and deliver them to the subscribers. */
  async function deliver(): Promise<void> {
    const bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    const runner = new JobRunner(database.db, 'checklist-notice-test');
    bus.attach(runner);
    while ((await bus.relayOnce()) > 0) {}
    while ((await runner.runOnce()) > 0) {}
  }

  /** The checklist notices about a ticket: who, on which channel, with what. */
  async function notices(ticketId: number) {
    const rows = await database.db
      .selectFrom('notification')
      .select(['id', 'user_id', 'channel', 'payload', 'actor_id'])
      .where('ticket_id', '=', ticketId)
      .where('event', '=', CHECKLIST_EVENT)
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ ...r, who: nameOf.get(r.user_id) as Person }));
  }
  const reached = async (ticketId: number, channel: 'inbox' | 'email') =>
    [
      ...new Set((await notices(ticketId)).filter((n) => n.channel === channel).map((n) => n.who)),
    ].sort();

  const setNotices = (who: Person, on: boolean) =>
    as(who, {
      method: 'PATCH',
      url: `/api/v1/tracks/${trackId}`,
      payload: { checklistNotices: on },
    });

  /** A ticket Ana writes, followed by Finn, Gil, Hal, Uma and Out (Ana follows by writing). */
  async function followedTicket(summary: string) {
    const res = await as('ana', {
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track: 'CLN', summary },
    });
    expect(res.statusCode, res.body).toBe(201);
    const ticket = res.json().ticket as { id: number; key: string };
    for (const who of ['finn', 'gil', 'hal', 'uma'] as const) {
      const follow = await as(who, {
        method: 'PUT',
        url: `/api/v1/tickets/${ticket.id}/followers/${users[who].id}`,
      });
      expect(follow.statusCode, follow.body).toBe(204);
    }
    // Out once followed it, from before losing the track.
    await database.db
      .insertInto('ticket_follower')
      .values({ workspace_id: 1, ticket_id: ticket.id, user_id: users.out.id })
      .execute();
    await deliver();
    return ticket;
  }
  const lists = (ticketId: number) => `/api/v1/tickets/${ticketId}/checklists`;
  async function addList(who: Person, ticketId: number, name: string, items: string[]) {
    const res = await as(who, {
      method: 'POST',
      url: lists(ticketId),
      payload: { name, items },
    });
    expect(res.statusCode, res.body).toBe(201);
    const list = (
      res.json().checklists as { id: number; name: string; items: { id: number }[] }[]
    ).find((l) => l.name === name);
    return list as { id: number; items: { id: number }[] };
  }
  async function tick(who: Person, ticketId: number, listId: number, itemId: number) {
    const res = await as(who, {
      method: 'PATCH',
      url: `${lists(ticketId)}/${listId}/items/${itemId}`,
      payload: { state: 'done' },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  const inboxOf = async (who: Person) =>
    (await as(who, { method: 'GET', url: `/api/v1/inbox?event=${CHECKLIST_EVENT}` })).json()
      .items as InboxJson[];

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const name of PEOPLE) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: name === 'admin',
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
      nameOf.set(row.id, name);
    }
    const track = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'CLN', name: 'Checklist notices', mode: 'shared' },
    });
    expect(track.statusCode, track.body).toBe(201);
    trackId = track.json().track.id;
    const members = await roleId('Members');
    const values = [
      { user: users.lead.id, role: await roleId('Administrators') },
      ...(['ana', 'finn', 'gil', 'hal', 'uma', 'max'] as const).map((who) => ({
        user: users[who].id,
        role: members,
      })),
    ];
    await database.db
      .insertInto('track_role_actor')
      .values(
        values.map((v) => ({
          workspace_id: 1,
          track_id: trackId,
          role_id: v.role,
          user_id: v.user,
        })),
      )
      .execute();
    // Gil keeps checklist notices out of his inbox; Hal takes no email; Ana would hear of her
    // own changes elsewhere.
    expect(
      (
        await as('gil', {
          method: 'PATCH',
          url: '/api/v1/account/notification-preferences',
          payload: { events: { [CHECKLIST_EVENT]: { inbox: false } } },
        })
      ).statusCode,
    ).toBe(200);
    for (const [who, payload] of [
      ['hal', { emailDelivery: 'off' }],
      ['ana', { ownChanges: true }],
    ] as const) {
      const res = await as(who, {
        method: 'PATCH',
        url: '/api/v1/account/notification-preferences',
        payload,
      });
      expect(res.statusCode, res.body).toBe(200);
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('[NTF-015] is off for a track until its administrators turn it on, and then tells nobody', async () => {
    const read = await as('lead', { method: 'GET', url: `/api/v1/tracks/${trackId}` });
    expect(read.json().track.checklistNotices).toBe(false);
    const ticket = await followedTicket('Quiet by default');
    const list = await addList('ana', ticket.id, 'Steps', ['One', 'Two']);
    await tick('ana', ticket.id, list.id, list.items[0]?.id as number);
    await deliver();
    expect(await notices(ticket.id)).toEqual([]);
  });

  it('[NTF-015] is the track administrators’ choice: a member may not turn it on', async () => {
    const refused = await setNotices('finn', true);
    expect(refused.statusCode).toBe(403);
    const on = await setNotices('lead', true);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().track.checklistNotices).toBe(true);
    // One change of the track, recorded with what changed.
    const event = await database.db
      .selectFrom('domain_event')
      .select(['payload', 'actor_id'])
      .where('type', '=', 'track.updated')
      .where('subject_id', '=', String(trackId))
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(event.actor_id).toBe(users.lead.id);
    expect((event.payload as { changes: unknown }).changes).toEqual({
      checklistNotices: { from: false, to: true },
    });
    // Saying the same again changes nothing and records nothing.
    const before = await database.db
      .selectFrom('domain_event')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('type', '=', 'track.updated')
      .executeTakeFirstOrThrow();
    expect((await setNotices('lead', true)).statusCode).toBe(200);
    const after = await database.db
      .selectFrom('domain_event')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('type', '=', 'track.updated')
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
  });

  it('[NTF-015] (2) tells the followers who may see the ticket, on their channels, never the one who changed it', async () => {
    const ticket = await followedTicket('Release steps');
    await addList('ana', ticket.id, 'Steps', ['Write notes']);
    await deliver();
    // Finn and Uma by both; Gil by email only; Hal in the inbox only. Not Ana, who made the
    // change though she follows and hears of her own changes; not Max, who follows nothing;
    // not Out, who may not see the ticket.
    expect(await reached(ticket.id, 'inbox')).toEqual(['finn', 'hal', 'uma']);
    expect(await reached(ticket.id, 'email')).toEqual(['finn', 'gil', 'uma']);
    const finn = await inboxOf('finn');
    const item = finn.find((i) => i.ticket?.key === ticket.key);
    expect(item).toMatchObject({
      event: CHECKLIST_EVENT,
      actor: { name: 'ana' },
      checklist: { changes: 1, others: 0 },
    });
    // The change is a notice of its own and nothing else: no policy event stands for it.
    const others = await database.db
      .selectFrom('notification')
      .select('event')
      .where('ticket_id', '=', ticket.id)
      .where('event', '!=', CHECKLIST_EVENT)
      .where('domain_event_id', 'in', (eb) =>
        eb.selectFrom('domain_event').select('id').where('type', '=', 'ticket.checklist_changed'),
      )
      .execute();
    expect(others).toEqual([]);
  });

  it('[NTF-015] (2) gathers a run of changes to one ticket into one notice per person and channel', async () => {
    const ticket = await followedTicket('Many ticks');
    const list = await addList('ana', ticket.id, 'Steps', ['One', 'Two', 'Three', 'Four']);
    for (const item of list.items) await tick('ana', ticket.id, list.id, item.id);
    await deliver();
    // Five changes: the list with its items, then four ticks.
    const rows = await notices(ticket.id);
    expect(rows.filter((r) => r.who === 'finn').map((r) => r.channel)).toEqual(['email', 'inbox']);
    for (const row of rows) {
      expect(row.payload.changes).toBe(5);
      expect(row.payload.people).toEqual([users.ana.id]);
    }
    expect((await inboxOf('finn')).filter((i) => i.ticket?.key === ticket.key)).toEqual([
      expect.objectContaining({ checklist: { changes: 5, others: 0 } }),
    ]);
    // Someone else joins the run: the same notice counts them.
    await addList('max', ticket.id, 'After', ['Tell people']);
    await deliver();
    const item = (await inboxOf('finn')).filter((i) => i.ticket?.key === ticket.key);
    expect(item).toEqual([expect.objectContaining({ actor: { id: users.ana.id, name: 'ana' } })]);
    expect(item[0]?.checklist).toEqual({ changes: 6, others: 1 });
    // Max made a change and so follows now, but hears nothing of his own.
    expect((await notices(ticket.id)).filter((r) => r.who === 'max')).toEqual([]);
  });

  it('[NTF-015] starts a new notice once the first is read, or older than the batch window', async () => {
    const ticket = await followedTicket('Later changes');
    const list = await addList('ana', ticket.id, 'Steps', ['One', 'Two', 'Three']);
    await deliver();
    const [first] = (await inboxOf('finn')).filter((i) => i.ticket?.key === ticket.key);
    // Finn reads it: the next change is a notice of its own, and so is his email (NTF-003 (2)).
    const read = await as('finn', {
      method: 'PATCH',
      url: `/api/v1/inbox/${first?.id}`,
      payload: { read: true },
    });
    expect(read.statusCode, read.body).toBe(200);
    await tick('ana', ticket.id, list.id, list.items[0]?.id as number);
    await deliver();
    const finn = (await notices(ticket.id)).filter((r) => r.who === 'finn');
    expect(finn.map((r) => [r.channel, r.payload.changes])).toEqual([
      ['email', 1],
      ['inbox', 1],
      ['email', 1],
      ['inbox', 1],
    ]);
    // Uma's notice grows meanwhile, until the window from its first change has passed.
    expect((await notices(ticket.id)).filter((r) => r.who === 'uma').length).toBe(2);
    await database.db
      .updateTable('notification')
      .set({ created_at: new Date(Date.now() - 10 * MINUTE) })
      .where('ticket_id', '=', ticket.id)
      .where('event', '=', CHECKLIST_EVENT)
      .execute();
    await tick('ana', ticket.id, list.id, list.items[1]?.id as number);
    await deliver();
    const uma = (await notices(ticket.id)).filter((r) => r.who === 'uma');
    expect(uma.map((r) => [r.channel, r.payload.changes])).toEqual([
      ['email', 2],
      ['inbox', 2],
      ['email', 1],
      ['inbox', 1],
    ]);
  });

  it(`[NTF-015] holds at most ${MAX_NOTICE_CHANGES} changes in one notice, and counts an event delivered twice once`, async () => {
    const ticket = await followedTicket('Idempotent');
    await addList('ana', ticket.id, 'Steps', ['One']);
    await deliver();
    const event = await database.db
      .selectFrom('domain_event')
      .selectAll()
      .where('type', '=', 'ticket.checklist_changed')
      .where('subject_id', '=', String(ticket.id))
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    const domainEvent: DomainEvent = {
      id: event.id,
      workspaceId: event.workspace_id,
      type: 'ticket.checklist_changed',
      version: event.version,
      actorId: event.actor_id,
      subjectType: event.subject_type,
      subjectId: event.subject_id,
      payload: event.payload,
      occurredAt: event.occurred_at,
      ip: null,
    };
    const authorizer = new Authorizer(database.db);
    // Delivered again: it writes and counts nothing.
    expect(await notifyChecklist(database.db, authorizer, domainEvent, bumpInbox)).toBe(0);
    const once = (await notices(ticket.id)).filter((r) => r.who === 'finn');
    expect(once.map((r) => r.payload.changes)).toEqual([1, 1]);
    // A full notice takes no more: the next change starts another.
    await database.db
      .updateTable('notification')
      .set({ payload: sql`payload || jsonb_build_object('changes', ${MAX_NOTICE_CHANGES}::int)` })
      .where('ticket_id', '=', ticket.id)
      .where('event', '=', CHECKLIST_EVENT)
      .execute();
    const more = await addList('ana', ticket.id, 'More', []);
    const renamed = await as('ana', {
      method: 'PATCH',
      url: `${lists(ticket.id)}/${more.id}`,
      payload: { name: 'More steps' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    await deliver();
    const finn = (await notices(ticket.id)).filter((r) => r.who === 'finn');
    expect(finn.map((r) => r.payload.changes)).toEqual([
      MAX_NOTICE_CHANGES,
      MAX_NOTICE_CHANGES,
      2,
      2,
    ]);
  });

  it('[NTF-015] (3) names no list and no item, and leaves the inbox of whoever may no longer see the ticket', async () => {
    const ticket = await followedTicket('Private words');
    const list = await addList('ana', ticket.id, 'Secret plan', ['Call the vendor at night']);
    await tick('ana', ticket.id, list.id, list.items[0]?.id as number);
    await deliver();
    for (const row of await notices(ticket.id)) {
      const text = JSON.stringify(row.payload);
      expect(text).not.toContain('Secret plan');
      expect(text).not.toContain('Call the vendor');
    }
    const shown = JSON.stringify(await inboxOf('uma'));
    expect(shown).toContain(ticket.key);
    expect(shown).not.toContain('Secret plan');
    expect(shown).not.toContain('Call the vendor');
    // Uma leaves the track: her item goes from her inbox.
    await database.db
      .deleteFrom('track_role_actor')
      .where('track_id', '=', trackId)
      .where('user_id', '=', users.uma.id)
      .execute();
    expect((await inboxOf('uma')).some((i) => i.ticket?.key === ticket.key)).toBe(false);
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: trackId,
        role_id: await roleId('Members'),
        user_id: users.uma.id,
      })
      .execute();
  });

  it('[NTF-015] (2) emails one line for the run, with who and how many, and no item’s words', async () => {
    const ticket = await followedTicket('Mailed run');
    const list = await addList('ana', ticket.id, 'Rollout', ['Flip the switch', 'Watch graphs']);
    for (const item of list.items) await tick('ana', ticket.id, list.id, item.id);
    await deliver();
    const sent: OutgoingEmail[] = [];
    const run = await deliverEmail(database.db, new Authorizer(database.db), {
      transport: {
        send: async (email) => {
          sent.push(email);
          return { messageId: null };
        },
      },
      from: 'Taskmoor <taskmoor@example.com>',
      publicUrl: 'https://taskmoor.example.com',
      now: new Date(Date.now() + 10 * MINUTE),
    });
    expect(run.failed).toBe(0);
    const finn = sent.filter((e) => e.to === 'finn@example.com' && e.text.includes(ticket.key));
    expect(finn).toHaveLength(1);
    expect(finn[0]?.text).toContain('- ana made 3 changes to checklists');
    expect(finn[0]?.text).not.toContain('Flip the switch');
    expect(finn[0]?.html).not.toContain('Rollout');
    // Hal takes no email; Ana is not told of her own changes, though she hears of others.
    expect(sent.some((e) => e.to === 'hal@example.com' && e.text.includes(ticket.key))).toBe(false);
    const ana = sent.filter((e) => e.to === 'ana@example.com' && e.text.includes(ticket.key));
    expect(ana.some((e) => /checklist/i.test(e.text))).toBe(false);
  });

  it('[NTF-015] tells nobody again once the track turns it off', async () => {
    const ticket = await followedTicket('Turned off');
    expect((await setNotices('lead', false)).statusCode).toBe(200);
    await addList('ana', ticket.id, 'Steps', ['One']);
    await deliver();
    expect(await notices(ticket.id)).toEqual([]);
    expect((await setNotices('lead', true)).statusCode).toBe(200);
  });

  it('[NTF-015] a copy of a track takes the source’s choice', async () => {
    const copy = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'CLC', name: 'A copy', mode: 'shared', copyFrom: trackId },
    });
    expect(copy.statusCode, copy.body).toBe(201);
    expect(copy.json().track.checklistNotices).toBe(true);
  });

  it('[NTF-015] (3) a ticket restricted to a visibility level tells only those in the level, and a notice written before it was restricted is neither shown nor sent', async () => {
    const policy = await as('admin', {
      method: 'POST',
      url: '/api/v1/visibility-policies',
      payload: {
        name: 'Checklist secrets',
        levels: [
          {
            name: 'Only Ana and Uma',
            members: [
              { grantee: 'user', userId: users.ana.id },
              { grantee: 'user', userId: users.uma.id },
            ],
          },
        ],
      },
    });
    expect(policy.statusCode, policy.body).toBe(201);
    const level = policy.json().visibilityPolicy.levels[0].id as number;
    const applied = await as('admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${trackId}`,
      payload: { visibilityPolicyId: policy.json().visibilityPolicy.id },
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const restrict = async (key: string, to: number | null) => {
      const res = await as('admin', {
        method: 'PATCH',
        url: `/api/v1/tickets/${key}`,
        payload: { visibilityLevelId: to },
      });
      expect(res.statusCode, res.body).toBe(200);
    };
    const unreadOf = async (who: Person) =>
      (await as(who, { method: 'GET', url: '/api/v1/inbox/count' })).json().unread.all as number;

    // Restricted first: Finn, Gil and Hal follow it but are outside the level, so nothing at all.
    const hidden = await followedTicket('Restricted before the change');
    await restrict(hidden.key, level);
    await deliver();
    await addList('ana', hidden.id, 'Hidden steps', ['Hidden item']);
    await deliver();
    expect(await reached(hidden.id, 'inbox')).toEqual(['uma']);
    expect(await reached(hidden.id, 'email')).toEqual(['uma']);

    // Restricted after a notice was written: it goes from the inbox and its count, a further
    // change does not extend it, and the mailer drops it.
    const later = await followedTicket('Restricted after the notice');
    const list = await addList('ana', later.id, 'Steps', ['One']);
    await deliver();
    expect((await inboxOf('finn')).some((i) => i.ticket?.key === later.key)).toBe(true);
    const unreadBefore = await unreadOf('finn');
    await restrict(later.key, level);
    await deliver();
    expect((await inboxOf('finn')).some((i) => i.ticket?.key === later.key)).toBe(false);
    expect(await unreadOf('finn')).toBeLessThan(unreadBefore);
    await tick('ana', later.id, list.id, list.items[0]?.id as number);
    await deliver();
    const finn = (await notices(later.id)).filter((n) => n.who === 'finn');
    expect(finn.map((n) => n.payload.changes)).toEqual([1, 1]);
    const uma = (await notices(later.id)).filter((n) => n.who === 'uma');
    expect(uma.map((n) => n.payload.changes)).toEqual([2, 2]);

    const sent: OutgoingEmail[] = [];
    const run = await deliverEmail(database.db, new Authorizer(database.db), {
      transport: {
        send: async (email) => {
          sent.push(email);
          return { messageId: null };
        },
      },
      from: 'Taskmoor <taskmoor@example.com>',
      publicUrl: 'https://taskmoor.example.com',
      now: new Date(Date.now() + 10 * MINUTE),
    });
    expect(run.failed).toBe(0);
    for (const key of [hidden.key, later.key]) {
      // Ana hears of her own other changes, so she is here too, though not of her checklists.
      const about = sent.filter((e) => e.text.includes(key));
      expect(about.map((e) => e.to).sort()).toEqual(['ana@example.com', 'uma@example.com']);
      const toUma = about.find((e) => e.to === 'uma@example.com');
      expect(toUma?.text).toMatch(/checklist/);
      expect(about.find((e) => e.to === 'ana@example.com')?.text).not.toMatch(/checklist/);
    }
  });

  it('[NTF-015] offers its own row in each person’s settings, on for both channels to begin with', async () => {
    const res = await as('max', { method: 'GET', url: '/api/v1/account/notification-preferences' });
    expect(res.json().preferences.events[CHECKLIST_EVENT]).toEqual({ email: true, inbox: true });
    const events = await as('max', { method: 'GET', url: '/api/v1/notification-events' });
    expect(events.json().productEvents).toContain(CHECKLIST_EVENT);
    // Not a policy event: a policy cannot name it.
    expect(events.json().events).not.toContain(CHECKLIST_EVENT);
  });
});
