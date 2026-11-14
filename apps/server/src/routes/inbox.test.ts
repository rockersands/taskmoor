import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { expectWithinBudget } from '@taskmoor/testkit/budget';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { EventBus } from '../events/bus';
import type { DomainEvent, EventType } from '../events/catalogue';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { notify } from '../notifications/subscriber';

/**
 * The in-app inbox, mentions and activity streams (M1-058; NTF-003, NTF-005, CORE-022).
 * Alice, Bob and Erin are Members of the INB track, Carol a Viewer, Gus an Administrator; Dave
 * has no role there and sees none of it. Erin and Dave are the Reviewers team.
 */
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

type Part = string | { type: 'mention'; attrs: { id: string; label: string } };
const doc = (...parts: Part[]) => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: parts.map((p) => (typeof p === 'string' ? { type: 'text', text: p } : p)),
    },
  ],
});

interface Item {
  id: string;
  event: string;
  direct: boolean;
  ticket: { id: number; key: string; summary: string; track: { id: number; key: string } };
  actor: { id: number; name: string } | null;
  comment: { id: number; excerpt: string } | null;
  mentionedIn?: string[];
  read: boolean;
  snoozedUntil: string | null;
}
interface Inbox {
  items: Item[];
  unread: { all: number; priority: number };
  next: string | null;
}

describe('inbox, mentions and activity (M1-058)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let bus: EventBus;
  let runner: JobRunner;
  const users: Record<string, { id: number; cookie: string }> = {};
  const roles: Record<string, number> = {};
  let trackId = 0;
  let otherTrackId = 0;
  let reviewers = 0;
  /** A visibility level Bob is not in (set up by the inbox visibility test). */
  let notBob = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const get = (who: string, url: string) => as(who, { method: 'GET', url });
  const post = (who: string, url: string, payload?: unknown) =>
    as(who, {
      method: 'POST',
      url,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const patch = (who: string, url: string, payload: unknown) =>
    as(who, { method: 'PATCH', url, payload: payload as object });
  const id = (who: string) => users[who]?.id as number;
  const mention = (who: string): Part => ({
    type: 'mention',
    attrs: { id: String(id(who)), label: who },
  });

  /** Runs the event bus to the end, as the worker would. */
  async function drain() {
    while ((await bus.relayOnce()) > 0) {}
    while ((await runner.runOnce()) > 0) {}
  }
  async function ticket(who = 'alice', body: Record<string, unknown> = {}, track = 'INB') {
    const res = await post(who, '/api/v1/tickets', { track, summary: 'Work', ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as { id: number; key: string };
  }
  async function comment(who: string, t: { id: number }, body: unknown, extra = {}) {
    const res = await post(who, `/api/v1/tickets/${t.id}/comments`, { body, ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { comment: { id: number }; mentionWarnings?: unknown[] };
  }
  /** The notifications a person got about a ticket, per channel and event. */
  const told = async (who: string, ticketId: number) =>
    database.db
      .selectFrom('notification')
      .select(['channel', 'event', 'direct', 'payload', 'domain_event_id'])
      .where('user_id', '=', id(who))
      .where('ticket_id', '=', ticketId)
      .orderBy('id')
      .execute();
  const inbox = async (who: string, query = '') => {
    const res = await get(who, `/api/v1/inbox${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Inbox;
  };
  async function member(who: string, role: string, track = trackId) {
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: track,
        role_id: roles[role] as number,
        user_id: id(who),
      })
      .execute();
  }
  async function follow(who: string, ticketId: number) {
    await database.db
      .insertInto('ticket_follower')
      .values({ workspace_id: 1, ticket_id: ticketId, user_id: id(who) })
      .execute();
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api', 'realtime'] });
    bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    runner = new JobRunner(database.db, 'inbox-test');
    bus.attach(runner);
    // Made per run: no password is written down.
    const password = `inbox-${randomBytes(18).toString('base64url')}`;
    const hash = await hashPassword(password);
    for (const name of ['admin', 'alice', 'bob', 'carol', 'dave', 'erin', 'gus']) {
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
        payload: { email: `${name}@example.com`, password },
        remoteAddress: nextAddress(),
      });
      users[name] = { id: row.id, cookie: sessionCookie(res.headers['set-cookie']) };
    }
    for (const role of await database.db.selectFrom('role').select(['id', 'name']).execute()) {
      roles[role.name] = role.id;
    }
    for (const [key, name] of [
      ['INB', 'Inbox'],
      ['OTH', 'Other'],
    ]) {
      const res = await post('admin', '/api/v1/tracks', { key, name, mode: 'shared' });
      expect(res.statusCode, res.body).toBe(201);
      if (key === 'INB') trackId = res.json().track.id;
      else otherTrackId = res.json().track.id;
    }
    for (const track of [trackId, otherTrackId]) {
      await member('alice', 'Members', track);
      await member('bob', 'Members', track);
    }
    await member('erin', 'Members');
    await member('carol', 'Viewers');
    await member('gus', 'Administrators');
    const group = await post('admin', '/api/v1/groups', { name: 'Reviewers' });
    expect(group.statusCode, group.body).toBe(201);
    reviewers = group.json().group.id;
    await database.db
      .insertInto('group_member')
      .values(
        ['erin', 'dave'].map((who) => ({ workspace_id: 1, group_id: reviewers, user_id: id(who) })),
      )
      .execute();
    await drain();
  });
  afterAll(async () => {
    await app.close();
  });

  it('[NTF-005] tells each mentioned person once, a direct ask, never the writer, also when they follow', async () => {
    // Created with a description that mentions Bob: he hears of it as a mention.
    const t = await ticket('alice', { description: doc('For ', mention('bob')) });
    await follow('bob', t.id);
    await follow('carol', t.id);
    await drain();
    expect((await told('bob', t.id)).map((n) => [n.channel, n.event, n.direct])).toEqual([
      ['email', 'mentioned', true],
      ['inbox', 'mentioned', true],
    ]);

    // A comment naming Bob twice, Carol and Alice herself: one notification each per channel.
    const written = await comment(
      'alice',
      t,
      doc(
        mention('bob'),
        ' and ',
        mention('carol'),
        ', ',
        mention('bob'),
        ' again; ',
        mention('alice'),
      ),
    );
    expect(written.mentionWarnings).toBeUndefined();
    await drain();
    const bob = (await told('bob', t.id)).filter((n) => n.payload.type === 'comment.created');
    // Following the ticket, Bob would hear of the comment anyway: the mention stands for it.
    expect(bob.map((n) => [n.channel, n.event, n.direct, n.payload.commentId])).toEqual([
      ['email', 'mentioned', true, written.comment.id],
      ['inbox', 'mentioned', true, written.comment.id],
    ]);
    const carol = (await told('carol', t.id)).filter((n) => n.payload.type === 'comment.created');
    expect(carol.map((n) => n.event)).toEqual(['mentioned', 'mentioned']);
    expect((await told('alice', t.id)).filter((n) => n.event === 'mentioned')).toEqual([]);

    // Delivered again (at least once): nothing more is written.
    const event = await database.db
      .selectFrom('domain_event')
      .selectAll()
      .where('type', '=', 'comment.created')
      .where('subject_id', '=', String(written.comment.id))
      .executeTakeFirstOrThrow();
    const again = await notify(database.db, new Authorizer(database.db), {
      id: String(event.id),
      workspaceId: event.workspace_id,
      type: event.type as EventType,
      version: event.version,
      actorId: event.actor_id,
      subjectType: event.subject_type,
      subjectId: event.subject_id,
      payload: event.payload,
      occurredAt: event.occurred_at,
      ip: null,
    } as DomainEvent);
    expect(again).toBe(0);

    // An edit tells only whom it adds: Erin, not Bob or Carol again.
    const edited = await patch('alice', `/api/v1/tickets/${t.id}/comments/${written.comment.id}`, {
      body: doc(mention('bob'), ' and ', mention('carol'), ', also ', mention('erin')),
    });
    expect(edited.statusCode, edited.body).toBe(200);
    await drain();
    const mentions = async (who: string) =>
      (await told(who, t.id)).filter((n) => n.event === 'mentioned' && n.channel === 'inbox');
    expect((await mentions('bob')).length).toBe(2);
    expect((await mentions('carol')).length).toBe(1);
    expect((await mentions('erin')).map((n) => n.payload.mentionedIn)).toEqual([['comment']]);

    // The description: only the mentions an edit adds (Carol), whatever stays (Bob).
    const described = await patch('alice', `/api/v1/tickets/${t.id}`, {
      description: doc('For ', mention('bob'), ' and ', mention('carol')),
    });
    expect(described.statusCode, described.body).toBe(200);
    await drain();
    expect((await mentions('bob')).length).toBe(2);
    expect((await mentions('carol')).map((n) => n.payload.mentionedIn)).toEqual([
      ['comment'],
      ['description'],
    ]);
  });

  it('[NTF-005] warns about mentioned people who cannot see the ticket or read the comment, and tells them nothing', async () => {
    const t = await ticket();
    // Dave cannot see the track at all.
    const outside = await comment('alice', t, doc('Ask ', mention('dave')));
    expect(outside.mentionWarnings).toEqual([
      { kind: 'user', id: id('dave'), name: 'dave', reason: 'cannot_view' },
    ]);
    // A comment kept to Administrators: Bob sees the ticket but may not read it; Gus may.
    const restricted = await comment('alice', t, doc(mention('bob'), ' ', mention('gus')), {
      visibility: { roleId: roles.Administrators },
    });
    expect(restricted.mentionWarnings).toEqual([
      { kind: 'user', id: id('bob'), name: 'bob', reason: 'cannot_read' },
    ]);
    // A team: Erin hears of it, Dave does not; the warning counts him.
    const team = await comment(
      'alice',
      t,
      doc('Over to ', {
        type: 'mention',
        attrs: { id: `group:${reviewers}`, label: 'Reviewers' },
      }),
    );
    expect(team.mentionWarnings).toEqual([
      { kind: 'group', id: reviewers, name: 'Reviewers', reason: 'cannot_view', count: 1 },
    ]);
    // The ticket answer warns the same way.
    const described = await patch('alice', `/api/v1/tickets/${t.id}`, {
      description: doc(mention('dave')),
    });
    expect(described.json().mentionWarnings).toEqual([
      { kind: 'user', id: id('dave'), name: 'dave', reason: 'cannot_view' },
    ]);
    // A writer who may not browse people learns no names from the warning.
    const grants = await database.db
      .deleteFrom('global_grant')
      .where('permission', '=', 'browse_users')
      .returningAll()
      .execute();
    expect(grants.length).toBeGreaterThan(0);
    const nameless = await comment('alice', t, doc('Ask ', mention('dave'), ' again'));
    expect(nameless.mentionWarnings).toEqual([
      { kind: 'user', id: id('dave'), name: '', reason: 'cannot_view' },
    ]);
    await database.db
      .insertInto('global_grant')
      .values(grants.map(({ id: _id, ...grant }) => grant))
      .execute();
    await drain();
    expect(await told('dave', t.id)).toEqual([]);
    expect((await told('bob', t.id)).filter((n) => n.event === 'mentioned')).toEqual([]);
    expect((await told('gus', t.id)).map((n) => n.event)).toEqual(['mentioned', 'mentioned']);
    expect(
      (await told('erin', t.id)).map((n) => [n.event, n.payload.commentId === team.comment.id]),
    ).toEqual([
      ['mentioned', true],
      ['mentioned', true],
    ]);
  });

  it('[NTF-005] does not notify a person named in a People field', async () => {
    const field = await post('admin', '/api/v1/fields', { name: 'Reviewer', type: 'user' });
    expect(field.statusCode, field.body).toBe(201);
    const t = await ticket('alice', { fields: { [field.json().field.id]: id('carol') } });
    const changed = await patch('alice', `/api/v1/tickets/${t.id}`, { summary: 'Reviewed work' });
    expect(changed.statusCode, changed.body).toBe(200);
    await drain();
    expect(await told('carol', t.id)).toEqual([]);
  });

  it('[NTF-003] lists the inbox newest first, with unread counts, a Priority tab, filters and pages', async () => {
    const t = await ticket();
    const other = await ticket('alice', {}, 'OTH');
    await drain();
    await database.db.deleteFrom('notification').where('user_id', '=', id('bob')).execute();
    await follow('bob', t.id);
    await follow('bob', other.id);
    expect((await patch('alice', `/api/v1/tickets/${t.id}`, { summary: 'One' })).statusCode).toBe(
      200,
    );
    await comment('alice', t, doc('Have a look, ', mention('bob')));
    expect(
      (await patch('alice', `/api/v1/tickets/${t.id}`, { assigneeId: id('bob') })).statusCode,
    ).toBe(200);
    expect(
      (await patch('alice', `/api/v1/tickets/${other.id}`, { summary: 'Two' })).statusCode,
    ).toBe(200);
    // Erin's assignment is no ask of Bob's, though he follows the ticket.
    expect(
      (await patch('alice', `/api/v1/tickets/${t.id}`, { assigneeId: id('erin') })).statusCode,
    ).toBe(200);
    await drain();

    const all = await inbox('bob');
    expect(all.items.map((i) => [i.event, i.ticket.key, i.direct])).toEqual([
      ['ticket_assigned', t.key, false],
      ['ticket_updated', other.key, false],
      ['ticket_assigned', t.key, true],
      ['mentioned', t.key, true],
      ['ticket_updated', t.key, false],
    ]);
    expect(all.unread).toEqual({ all: 5, priority: 2 });
    expect(all.items[3]?.comment?.excerpt).toBe('Have a look, @bob');
    expect(all.items[3]?.actor).toEqual({ id: id('alice'), name: 'alice' });
    expect((await inbox('bob', '?view=priority')).items.map((i) => i.event)).toEqual([
      'ticket_assigned',
      'mentioned',
    ]);
    expect((await inbox('bob', '?event=ticket_updated')).items.length).toBe(2);
    expect((await inbox('bob', '?track=OTH')).items.map((i) => i.ticket.key)).toEqual([other.key]);
    expect((await get('bob', '/api/v1/inbox?track=NOPE')).statusCode).toBe(404);
    expect((await get('bob', '/api/v1/inbox?event=nonsense')).statusCode).toBe(400);
    expect((await get('bob', '/api/v1/inbox?cursor=bad')).statusCode).toBe(400);

    // Pages of two walk the same items in the same order, none twice.
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Inbox = await inbox('bob', `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      walked.push(...page.items.map((i) => i.id));
      cursor = page.next;
    } while (cursor);
    expect(walked).toEqual(all.items.map((i) => i.id));
    expect((await get('bob', '/api/v1/inbox/count')).json()).toEqual({
      unread: { all: 5, priority: 2 },
    });
    // Nobody else's inbox shows them.
    expect((await inbox('carol')).items.filter((i) => i.ticket.id === other.id)).toEqual([]);
  });

  it('[NTF-003] reads, unreads, snoozes and marks all read; reading marks the email read too', async () => {
    const first = (await inbox('bob')).items;
    const target = first[1] as Item;
    const read = await patch('bob', `/api/v1/inbox/${target.id}`, { read: true });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().item.read).toBe(true);
    expect(read.json().unread.all).toBe(first.filter((i) => !i.read).length - 1);
    // The same notification's email is read too (NTF-003 (2)): a digest leaves it out.
    const twin = await database.db
      .selectFrom('notification as i')
      .innerJoin('notification as e', (j) =>
        j.onRef('e.domain_event_id', '=', 'i.domain_event_id').onRef('e.user_id', '=', 'i.user_id'),
      )
      .select(['e.read_at'])
      .where('i.id', '=', target.id)
      .where('e.channel', '=', 'email')
      .executeTakeFirstOrThrow();
    expect(twin.read_at).not.toBeNull();
    const unread = await patch('bob', `/api/v1/inbox/${target.id}`, { read: false });
    expect(unread.json().item.read).toBe(false);
    // Nobody else's item, and nonsense, are refused.
    expect((await patch('carol', `/api/v1/inbox/${target.id}`, { read: true })).statusCode).toBe(
      404,
    );
    expect((await patch('bob', `/api/v1/inbox/${target.id}`, {})).statusCode).toBe(400);
    expect(
      (
        await patch('bob', `/api/v1/inbox/${target.id}`, {
          snoozedUntil: new Date(Date.now() - 60_000).toISOString(),
        })
      ).statusCode,
    ).toBe(400);

    // Snoozed: out of the inbox, in the Snoozed view, unread; back at the top when it ends.
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await patch('bob', `/api/v1/inbox/${target.id}`, { read: true });
    const snoozed = await patch('bob', `/api/v1/inbox/${target.id}`, { snoozedUntil: until });
    expect(snoozed.json().item).toMatchObject({ read: false, snoozedUntil: until });
    expect((await inbox('bob')).items.map((i) => i.id)).not.toContain(target.id);
    expect((await inbox('bob', '?view=snoozed')).items.map((i) => i.id)).toEqual([target.id]);
    await database.db
      .updateTable('notification')
      .set({ snoozed_until: sql`clock_timestamp() - interval '1 millisecond'` })
      .where('id', '=', target.id)
      .execute();
    const back = await inbox('bob');
    expect(back.items[0]).toMatchObject({ id: target.id, read: false, snoozedUntil: null });
    // Unsnoozed by hand: back in its place.
    await patch('bob', `/api/v1/inbox/${target.id}`, { snoozedUntil: until });
    await patch('bob', `/api/v1/inbox/${target.id}`, { snoozedUntil: null });
    expect((await inbox('bob')).items.map((i) => i.id)).toEqual(first.map((i) => i.id));

    // Mark all read, up to the newest item seen: one arriving meanwhile stays unread.
    const seen = (await inbox('bob')).items;
    const t = await ticket();
    await drain();
    await follow('bob', t.id);
    await patch('alice', `/api/v1/tickets/${t.id}`, { summary: 'Late' });
    await drain();
    const upTo = seen.map((i) => BigInt(i.id)).reduce((a, b) => (a > b ? a : b));
    const marked = await post('bob', '/api/v1/inbox/read', { upTo: String(upTo) });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json()).toMatchObject({ marked: seen.length, unread: { all: 1, priority: 0 } });
    const events = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload'])
      .where('type', 'in', ['inbox.item_updated', 'inbox.marked_read'])
      .orderBy('id', 'desc')
      .execute();
    expect(events[0]).toMatchObject({
      type: 'inbox.marked_read',
      payload: { count: seen.length, view: 'all', event: null, trackId: null },
    });
    expect((await post('bob', '/api/v1/inbox/read', {})).json().marked).toBe(1);
    expect((await post('bob', '/api/v1/inbox/read', {})).json().marked).toBe(0);
  });

  it('[NTF-003] shows an item only while its reader may still see the ticket and read the comment', async () => {
    await database.db.deleteFrom('notification').where('user_id', '=', id('bob')).execute();
    const insiders = await post('admin', '/api/v1/groups', { name: 'Insiders' });
    const groupId = insiders.json().group.id as number;
    for (const who of ['alice', 'bob']) {
      await database.db
        .insertInto('group_member')
        .values({ workspace_id: 1, group_id: groupId, user_id: id(who) })
        .execute();
    }
    const t = await ticket();
    await comment('alice', t, doc('Just us, ', mention('bob')), { visibility: { groupId } });
    await comment('alice', t, doc('Everyone, ', mention('bob')));
    await drain();
    expect((await inbox('bob')).items.map((i) => i.comment?.excerpt)).toEqual([
      'Everyone, @bob',
      'Just us, @bob',
    ]);
    // Out of the group: the restricted comment's item goes, from the count too.
    await database.db
      .deleteFrom('group_member')
      .where('group_id', '=', groupId)
      .where('user_id', '=', id('bob'))
      .execute();
    const after = await inbox('bob');
    expect(after.items.map((i) => i.comment?.excerpt)).toEqual(['Everyone, @bob']);
    expect(after.unread.all).toBe(1);
    // A ticket at a visibility level Bob is not in: its items go too.
    const policy = await post('admin', '/api/v1/visibility-policies', {
      name: 'Inbox secrets',
      levels: [
        {
          name: 'Not Bob',
          members: [
            { grantee: 'user', userId: id('alice') },
            { grantee: 'user', userId: id('admin') },
          ],
        },
      ],
    });
    expect(policy.statusCode, policy.body).toBe(201);
    const level = policy.json().visibilityPolicy.levels[0].id as number;
    notBob = level;
    expect(
      (
        await patch('admin', `/api/v1/tracks/${trackId}`, {
          visibilityPolicyId: policy.json().visibilityPolicy.id,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await patch('admin', `/api/v1/tickets/${t.id}`, { visibilityLevelId: level })).statusCode,
    ).toBe(200);
    expect((await inbox('bob')).items).toEqual([]);
    expect((await get('bob', '/api/v1/inbox/count')).json().unread.all).toBe(0);
    // Back to everyone: the item is there again.
    expect(
      (await patch('admin', `/api/v1/tickets/${t.id}`, { visibilityLevelId: null })).statusCode,
    ).toBe(200);
    expect((await inbox('bob')).items.length).toBe(1);
  });

  it('[NTF-003] pushes an inbox change to an open socket within a second', async () => {
    const socket = await app.injectWS('/api/v1/sync/socket', {
      headers: { cookie: users.erin?.cookie ?? '' },
    });
    const messages: Record<string, unknown>[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(String(data))));
    const inboxMessage = (after: number, timeoutMs = 3000) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const started = Date.now();
        const look = () => {
          const found = messages.slice(after).find((m) => m.type === 'inbox');
          if (found) return resolve(found);
          if (Date.now() - started > timeoutMs) return reject(new Error('no inbox message'));
          setTimeout(look, 10);
        };
        look();
      });
    const initial = await inboxMessage(0);
    const t = await ticket();
    const seen = messages.length;
    const started = Date.now();
    await comment('alice', t, doc('Ping ', mention('erin')));
    await drain();
    const pushed = await inboxMessage(seen);
    expectWithinBudget(Date.now() - started, 1000, 'inbox push (ms)');
    expect(BigInt(pushed.version as string) > BigInt(initial.version as string)).toBe(true);
    // Reading elsewhere moves it too, so other open inboxes follow.
    const item = (await inbox('erin')).items[0] as Item;
    const before = messages.length;
    await patch('erin', `/api/v1/inbox/${item.id}`, { read: true });
    expect(await inboxMessage(before)).toMatchObject({ type: 'inbox' });
    (socket as WebSocket).terminate();
  });

  it('[CORE-022] gives a ticket activity newest first, one entry per change, without unreadable comments', async () => {
    const t = await ticket();
    expect(
      (await patch('alice', `/api/v1/tickets/${t.id}`, { summary: 'Renamed', labels: ['ux'] }))
        .statusCode,
    ).toBe(200);
    await comment('alice', t, doc('Open to all'));
    await comment('alice', t, doc('Admins only'), { visibility: { roleId: roles.Administrators } });
    const res = await get('bob', `/api/v1/tickets/${t.id}/activity`);
    expect(res.statusCode, res.body).toBe(200);
    const activity = res.json().activity as {
      comment: { excerpt: string } | null;
      changes: { field: string; to: { value: string | null } }[];
      actor: { name: string };
    }[];
    expect(
      activity.map((a) =>
        a.changes
          .map((c) => c.field)
          .sort()
          .join(','),
      ),
    ).toEqual(['comment', 'labels,summary', expect.stringContaining('summary')]);
    expect(activity[0]?.comment?.excerpt).toBe('Open to all');
    expect(activity[0]?.actor.name).toBe('alice');
    // Gus, an Administrator, reads the restricted one.
    const gus = (await get('gus', `/api/v1/tickets/${t.id}/activity?kind=comments`)).json();
    expect(gus.activity.map((a: { comment: { excerpt: string } }) => a.comment.excerpt)).toEqual([
      'Admins only',
      'Open to all',
    ]);
    // Pages never split a change.
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const page: { activity: unknown; next: string | null } = (
        await get(
          'bob',
          `/api/v1/tickets/${t.id}/activity?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        )
      ).json();
      pages.push(
        (page.activity as { changes: { field: string }[] }[]).flatMap((a) =>
          a.changes.map((c) => c.field),
        ),
      );
      cursor = page.next;
    } while (cursor);
    expect(pages.flat().length).toBe(activity.flatMap((a) => a.changes).length);
    expect(pages.some((p) => p.includes('labels') && p.includes('summary'))).toBe(true);
    expect((await get('dave', `/api/v1/tickets/${t.id}/activity`)).statusCode).toBe(404);
  });

  // The All feed words each change from the activity: a description's must say whether it was
  // set, changed or cleared, by a line of its text and never the document.
  it('[CORE-022] says how a description changed in the activity, by a line of its text', async () => {
    const t = await ticket('alice', { description: doc('First draft') });
    const twoParagraphs = {
      type: 'doc',
      content: ['Second', 'draft'].map((text) => ({
        type: 'paragraph',
        content: [{ type: 'text', text }],
      })),
    };
    for (const description of [twoParagraphs, null]) {
      const res = await patch('alice', `/api/v1/tickets/${t.id}`, { description });
      expect(res.statusCode, res.body).toBe(200);
    }
    const res = await get('bob', `/api/v1/tickets/${t.id}/activity?kind=history`);
    expect(res.statusCode, res.body).toBe(200);
    type Side = { value: string | null; display: string | null };
    const sides = (res.json().activity as { changes: { field: string; from: Side; to: Side }[] }[])
      .flatMap((a) => a.changes)
      .filter((c) => c.field === 'description')
      .map((c) => [c.from, c.to]);
    const shown = (display: string | null) => ({ value: null, display });
    expect(sides).toEqual([
      [shown('Second draft'), shown(null)],
      [shown('First draft'), shown('Second draft')],
      [shown(null), shown('First draft')],
    ]);
  });

  it("[CORE-022] gives a track's activity over the tickets the reader may see, newest first", async () => {
    const seen = await ticket('alice', { summary: 'Seen by Bob' });
    const hidden = await ticket('alice', { summary: 'Kept from Bob' });
    expect(notBob).toBeGreaterThan(0);
    expect(
      (await patch('admin', `/api/v1/tickets/${hidden.id}`, { visibilityLevelId: notBob }))
        .statusCode,
    ).toBe(200);
    await patch('alice', `/api/v1/tickets/${seen.id}`, { summary: 'Seen by Bob, edited' });
    const bob = (await get('bob', `/api/v1/tracks/${trackId}/activity?limit=200`)).json();
    const keys = new Set(bob.activity.map((a: { ticket: { key: string } }) => a.ticket.key));
    expect(keys.has(seen.key)).toBe(true);
    expect(keys.has(hidden.key)).toBe(false);
    expect(bob.activity[0].ticket.key).toBe(seen.key);
    const alice = (await get('alice', `/api/v1/tracks/INB/activity?limit=200`)).json();
    expect(
      alice.activity.some((a: { ticket: { key: string } }) => a.ticket.key === hidden.key),
    ).toBe(true);
    // Newest first: change set ids only go down.
    const sets = alice.activity.map((a: { changeSet: string }) => BigInt(a.changeSet));
    expect(sets.every((s: bigint, i: number) => i === 0 || s <= sets[i - 1])).toBe(true);
    expect((await get('dave', `/api/v1/tracks/${trackId}/activity`)).statusCode).toBe(404);
  });

  it("[CORE-022] names a custom field's change in both activity streams and says how its values read (T-282)", async () => {
    const made: Record<string, { id: number; contexts: { id: number }[] }> = {};
    for (const [name, type] of [
      ['Go-live day', 'date'],
      ['Cut-over', 'datetime'],
      ['Rollout note', 'text'],
      ['Audit day', 'date'],
    ] as const) {
      const res = await post('admin', '/api/v1/fields', { name, type });
      expect(res.statusCode, res.body).toBe(201);
      made[name] = res.json().field;
    }
    const f = (name: string) => made[name] as { id: number; contexts: { id: number }[] };
    const t = await ticket('alice', {
      summary: 'Custom values',
      fields: {
        [f('Go-live day').id]: '2026-10-13',
        [f('Cut-over').id]: '2026-10-13T09:00:00Z',
        [f('Rollout note').id]: 'Soon',
        [f('Audit day').id]: '2026-11-01',
      },
    });
    // Audit day stops applying to the ticket's track: its rows keep how they read, not the name.
    const narrowed = await patch(
      'admin',
      `/api/v1/fields/${f('Audit day').id}/contexts/${f('Audit day').contexts[0]?.id}`,
      { trackIds: [otherTrackId] },
    );
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    type Change = { field: string; fieldName?: string | null; valueType?: string | null };
    const changesOf = (body: {
      activity: { ticket: { id: number }; changes: Change[] }[];
    }): Change[] => body.activity.filter((a) => a.ticket.id === t.id).flatMap((a) => a.changes);
    for (const url of [
      `/api/v1/tickets/${t.id}/activity`,
      `/api/v1/tracks/${trackId}/activity?limit=200`,
    ]) {
      const res = await get('bob', url);
      expect(res.statusCode, res.body).toBe(200);
      const changes = changesOf(res.json());
      const row = (name: string) => changes.find((c) => c.field === `cf[${f(name).id}]`);
      expect(row('Go-live day'), url).toMatchObject({
        fieldName: 'Go-live day',
        valueType: 'date',
      });
      expect(row('Cut-over'), url).toMatchObject({ fieldName: 'Cut-over', valueType: 'datetime' });
      expect(row('Rollout note'), url).toMatchObject({
        fieldName: 'Rollout note',
        valueType: null,
      });
      expect(row('Audit day'), url).toMatchObject({ fieldName: null, valueType: 'date' });
      // A system field's change carries neither.
      const summary = changes.find((c) => c.field === 'summary');
      expect(summary, url).toBeDefined();
      expect(summary).not.toHaveProperty('fieldName');
      expect(summary).not.toHaveProperty('valueType');
    }
  });
});
