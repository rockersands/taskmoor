import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { EventBus } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';

const PASSWORD = 'ladder violet harbour';
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

const PEOPLE = [
  'admin',
  'actor',
  'ann',
  'rex',
  'fay',
  'owen',
  'gus',
  'rob',
  'ula',
  'cid',
  'dee',
  'ivy',
] as const;
type Person = (typeof PEOPLE)[number];

/**
 * Notification rules and preferences (M1-056; NTF-001, NTF-004): the recipient matrix. A policy
 * names every kind of recipient; one change notifies exactly the people it names who are
 * active, may see the ticket at its visibility level, did not make the change themselves, and
 * keep the channel on.
 */
describe('notification rules (M1-056)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  const nameOf = new Map<number, Person>();
  let trackId = 0;
  let reviewerField = 0;
  let leads = 0;

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
    const runner = new JobRunner(database.db, 'notification-test');
    bus.attach(runner);
    while ((await bus.relayOnce()) > 0) {}
    while ((await runner.runOnce()) > 0) {}
  }

  /** Who got a notification of an event about a ticket, per channel. */
  async function recipients(ticketId: number, event: string) {
    const rows = await database.db
      .selectFrom('notification')
      .select(['user_id', 'channel'])
      .where('ticket_id', '=', ticketId)
      .where('event', '=', event)
      .execute();
    const of = (channel: string) =>
      [
        ...new Set(rows.filter((r) => r.channel === channel).map((r) => nameOf.get(r.user_id))),
      ].sort();
    return { email: of('email'), inbox: of('inbox') };
  }

  const create = async (payload: Record<string, unknown>) => {
    const res = await as('actor', { method: 'POST', url: '/api/v1/tickets', payload });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as { id: number; key: string };
  };

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
    // Gus is a release manager through a nested group.
    const [managers, oncall] = await Promise.all(
      ['Release managers', 'On call'].map(
        async (name) =>
          (
            await database.db
              .insertInto('user_group')
              .values({ workspace_id: 1, name })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id,
      ),
    );
    await database.db
      .insertInto('group_nesting')
      .values({ workspace_id: 1, parent_id: managers as number, child_id: oncall as number })
      .execute();
    await database.db
      .insertInto('group_member')
      .values({ workspace_id: 1, group_id: oncall as number, user_id: users.gus.id })
      .execute();

    const track = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'NTF', name: 'Notified', mode: 'shared', ownerId: users.owen.id },
    });
    expect(track.statusCode, track.body).toBe(201);
    trackId = track.json().track.id;
    const members = await roleId('Members');
    for (const who of PEOPLE.filter((p) => p !== 'admin' && p !== 'rob')) {
      await database.db
        .insertInto('track_role_actor')
        .values({ workspace_id: 1, track_id: trackId, role_id: members, user_id: users[who].id })
        .execute();
    }
    // Rob acts as a viewer only.
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: trackId,
        role_id: await roleId('Viewers'),
        user_id: users.rob.id,
      })
      .execute();
    const field = await as('admin', {
      method: 'POST',
      url: '/api/v1/fields',
      payload: { name: 'Reviewer', type: 'user' },
    });
    reviewerField = field.json().field.id;

    // Every kind of recipient for an update; closing tells the assignee only.
    const named = [
      { recipient: 'assignee' },
      { recipient: 'requester' },
      { recipient: 'follower' },
      { recipient: 'track_owner' },
      { recipient: 'current_user' },
      { recipient: 'group', groupId: managers },
      { recipient: 'role', roleId: await roleId('Viewers') },
      { recipient: 'user', userId: users.ula.id },
      { recipient: 'user_field', fieldKey: `cf[${reviewerField}]` },
    ];
    const policy = await as('admin', {
      method: 'POST',
      url: '/api/v1/notification-policies',
      payload: {
        name: 'Everyone',
        rules: [
          ...named.map((r) => ({ event: 'ticket_updated', ...r })),
          { event: 'ticket_closed', recipient: 'assignee' },
          { event: 'time_entry_added', recipient: 'follower' },
        ],
      },
    });
    expect(policy.statusCode, policy.body).toBe(201);
    const used = await as('admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${trackId}`,
      payload: { notificationPolicyId: policy.json().notificationPolicy.id },
    });
    expect(used.statusCode, used.body).toBe(200);

    // Only Ann and requesters see tickets at the level Leads.
    const visibility = await as('admin', {
      method: 'POST',
      url: '/api/v1/visibility-policies',
      payload: {
        name: 'Leads only',
        levels: [
          {
            name: 'Leads',
            members: [{ grantee: 'user', userId: users.ann.id }, { grantee: 'requester' }],
          },
        ],
      },
    });
    leads = visibility.json().visibilityPolicy.levels[0].id;
    await as('admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${trackId}`,
      payload: { visibilityPolicyId: visibility.json().visibilityPolicy.id },
    });
  });
  afterAll(async () => {
    await app.close();
  });

  /**
   * A ticket with someone in every role a rule names: Fay, the actor and Dee follow it (Dee
   * was deactivated after she started following). With a level, Ann gives it the level last.
   */
  async function busyTicket(summary: string, levelId?: number) {
    const ticket = await create({
      track: 'NTF',
      summary,
      assigneeId: users.ann.id,
      requesterId: users.rex.id,
      fields: { [reviewerField]: users.cid.id },
    });
    for (const who of ['fay', 'actor'] as const) {
      const res = await as(who, {
        method: 'PUT',
        url: `/api/v1/tickets/${ticket.key}/followers/me`,
      });
      expect(res.statusCode, `${who} follows`).toBeLessThan(300);
    }
    await database.db
      .insertInto('ticket_follower')
      .values({ workspace_id: 1, ticket_id: ticket.id, user_id: users.dee.id })
      .onConflict((oc) => oc.doNothing())
      .execute();
    if (levelId) {
      const levelled = await as('ann', {
        method: 'PATCH',
        url: `/api/v1/tickets/${ticket.key}`,
        payload: { visibilityLevelId: levelId },
      });
      expect(levelled.statusCode, levelled.body).toBe(200);
    }
    return ticket;
  }

  it('[NTF-001] an update reaches exactly the active people its rules name, not the one who made it', async () => {
    await database.db
      .updateTable('app_user')
      .set({ deactivated_at: new Date() })
      .where('id', '=', users.dee.id)
      .execute();
    const ticket = await busyTicket('Everyone hears');
    await deliver();
    await as('actor', {
      method: 'PATCH',
      url: `/api/v1/tickets/${ticket.key}`,
      payload: { summary: 'Everyone hears of this' },
    });
    await deliver();
    const expected = ['ann', 'cid', 'fay', 'gus', 'owen', 'rex', 'rob', 'ula'];
    expect(await recipients(ticket.id, 'ticket_updated')).toEqual({
      email: expected,
      inbox: expected,
    });
    // Delivering again writes nothing twice.
    await deliver();
    const all = await database.db
      .selectFrom('notification')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('ticket_id', '=', ticket.id)
      .where('event', '=', 'ticket_updated')
      .executeTakeFirstOrThrow();
    expect(Number(all.n)).toBe(expected.length * 2);
  });

  it('[NTF-001] nobody hears of a ticket they cannot see at its visibility level', async () => {
    const ticket = await busyTicket('Leads hear', leads);
    await as('ann', {
      method: 'PATCH',
      url: `/api/v1/tickets/${ticket.key}`,
      payload: { summary: 'Only leads hear of this' },
    });
    await deliver();
    // Ann made both changes (the level, then the summary); Rex is the requester and so a
    // member of the level. Everyone else the rules name is left out (NTF-001 (3)).
    expect(await recipients(ticket.id, 'ticket_updated')).toEqual({
      email: ['rex'],
      inbox: ['rex'],
    });
  });

  it('[NTF-004] each person chooses channels per event, and whether to hear of their own changes', async () => {
    const fay = await as('fay', {
      method: 'PATCH',
      url: '/api/v1/account/notification-preferences',
      payload: { events: { ticket_updated: { email: false } } },
    });
    expect(fay.statusCode, fay.body).toBe(200);
    expect(fay.json().preferences.events.ticket_updated).toEqual({ email: false, inbox: true });
    expect(fay.json().preferences.events.ticket_created).toEqual({ email: true, inbox: true });
    const own = await as('actor', {
      method: 'PATCH',
      url: '/api/v1/account/notification-preferences',
      payload: { ownChanges: true },
    });
    expect(own.json().preferences.ownChanges).toBe(true);
    const ticket = await busyTicket('Preferences');
    await deliver();
    await as('actor', {
      method: 'PATCH',
      url: `/api/v1/tickets/${ticket.key}`,
      payload: { summary: 'Preferences apply' },
    });
    await deliver();
    const got = await recipients(ticket.id, 'ticket_updated');
    expect(got.inbox).toContain('fay');
    expect(got.email).not.toContain('fay');
    expect(got.inbox).toContain('actor');
    await as('actor', {
      method: 'PATCH',
      url: '/api/v1/account/notification-preferences',
      payload: { ownChanges: false },
    });
  });

  it('[NTF-001] closing a ticket and logging restricted time notify as their own events', async () => {
    const ticket = await busyTicket('Closed and logged');
    const transitions = await as('actor', {
      method: 'GET',
      url: `/api/v1/tickets/${ticket.key}/transitions`,
    });
    const statuses = await database.db.selectFrom('status').select(['id', 'stage']).execute();
    const closing = (transitions.json().transitions as { id: number; to: { id: number } }[]).find(
      (t) => statuses.find((s) => s.id === t.to.id)?.stage === 'closed',
    );
    expect(closing).toBeDefined();
    const closed = await as('actor', {
      method: 'POST',
      url: `/api/v1/tickets/${ticket.key}/transitions`,
      payload: { transitionId: closing?.id },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    // Time only Administrators of the track may see: followers who are not are left out.
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: trackId,
        role_id: await roleId('Administrators'),
        user_id: users.fay.id,
      })
      .execute();
    const logged = await as('ann', {
      method: 'POST',
      url: `/api/v1/tickets/${ticket.key}/time-entries`,
      payload: { duration: '1h', visibility: { roleId: await roleId('Administrators') } },
    });
    expect(logged.statusCode, logged.body).toBe(201);
    await deliver();
    expect(await recipients(ticket.id, 'ticket_closed')).toEqual({
      email: ['ann'],
      inbox: ['ann'],
    });
    // Followers: Fay (now an administrator of the track) and the actor; Dee is deactivated.
    expect((await recipients(ticket.id, 'time_entry_added')).inbox).toEqual(['fay']);
  });

  it('[NTF-001] policies are administrators’ to change; the default and policies in use stay', async () => {
    const list = await as('admin', { method: 'GET', url: '/api/v1/notification-policies' });
    const policies = list.json().notificationPolicies as {
      id: number;
      isDefault: boolean;
      usedBy: { key: string }[];
    }[];
    const fallback = policies.find((p) => p.isDefault);
    expect(fallback?.usedBy.map((t) => t.key)).not.toContain('NTF');
    expect(
      (
        await as('admin', {
          method: 'DELETE',
          url: `/api/v1/notification-policies/${fallback?.id}`,
        })
      ).json(),
    ).toEqual({ error: 'default_policy' });
    const everyone = policies.find((p) => !p.isDefault);
    expect(
      (
        await as('admin', {
          method: 'DELETE',
          url: `/api/v1/notification-policies/${everyone?.id}`,
        })
      ).json(),
    ).toMatchObject({ error: 'in_use', usedBy: [{ key: 'NTF' }] });
    expect(
      (await as('ann', { method: 'GET', url: '/api/v1/notification-policies' })).statusCode,
    ).toBe(403);
    const bad = await as('admin', {
      method: 'POST',
      url: '/api/v1/notification-policies',
      payload: {
        name: 'Bad',
        rules: [{ event: 'ticket_updated', recipient: 'user_field', fieldKey: 'cf[999999]' }],
      },
    });
    expect(bad.statusCode).toBe(400);
    // An id above the integer range names no field either: refused, not a server error.
    const huge = await as('admin', {
      method: 'POST',
      url: '/api/v1/notification-policies',
      payload: {
        name: 'Huge',
        rules: [{ event: 'ticket_updated', recipient: 'user_field', fieldKey: 'cf[2147483648]' }],
      },
    });
    expect(huge.statusCode, huge.body).toBe(400);
    expect(huge.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('[NTF-001] a policy names what each rule points at, for the web page (T-155)', async () => {
    const list = await as('admin', { method: 'GET', url: '/api/v1/notification-policies' });
    const everyone = (
      list.json().notificationPolicies as {
        name: string;
        rules: {
          event: string;
          recipient: string;
          userName: string | null;
          groupName: string | null;
          roleName: string | null;
          fieldName: string | null;
        }[];
      }[]
    ).find((p) => p.name === 'Everyone');
    const named = (recipient: string) =>
      everyone?.rules.find((r) => r.event === 'ticket_updated' && r.recipient === recipient);
    expect(named('group')).toMatchObject({ groupName: 'Release managers', userName: null });
    expect(named('role')).toMatchObject({ roleName: 'Viewers', groupName: null });
    expect(named('user')).toMatchObject({ userName: 'ula', roleName: null });
    expect(named('user_field')).toMatchObject({ fieldName: 'Reviewer', userName: null });
    expect(named('assignee')).toMatchObject({
      userName: null,
      groupName: null,
      roleName: null,
      fieldName: null,
    });
  });

  it('[NTF-001] lists the events transitions fire to those who make policies (T-155)', async () => {
    const statuses = (await as('admin', { method: 'GET', url: '/api/v1/statuses' })).json()
      .statuses as { id: number; stage: string }[];
    const start = statuses.find((s) => s.stage === 'new')?.id as number;
    const working = statuses.find((s) => s.stage === 'active')?.id as number;
    const workflow = (name: string, event: string, trackId?: number) =>
      as('admin', {
        method: 'POST',
        url: '/api/v1/workflows',
        payload: {
          name,
          ...(trackId ? { trackId } : {}),
          definition: {
            initialStatusId: start,
            statuses: [{ statusId: start }, { statusId: working }],
            transitions: [
              { id: 1, name: 'Hand over', from: [start], to: working, event },
              { id: 2, name: 'Back', from: [working], to: start },
            ],
          },
        },
      });
    expect((await workflow('Reviewed', 'ready-for-review')).statusCode).toBe(201);
    // Owen runs a local-mode track with a workflow of its own.
    const local = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'NTFL', name: 'Night shift', mode: 'local', ownerId: users.owen.id },
    });
    expect(local.statusCode, local.body).toBe(201);
    const localId = local.json().track.id as number;
    const own = await workflow('Night shift flow', 'handed-to-night', localId);
    expect(own.statusCode, own.body).toBe(201);

    const events = async (who: Person, query = '') =>
      (await as(who, { method: 'GET', url: `/api/v1/notification-events${query}` })).json()
        .customEvents as string[];
    expect(await events('admin')).toContain('custom:ready-for-review');
    expect(await events('admin')).not.toContain('custom:handed-to-night');
    expect(await events('admin', `?trackId=${localId}`)).toEqual(
      expect.arrayContaining(['custom:ready-for-review', 'custom:handed-to-night']),
    );
    // The track's administrator sees them for their track only; anyone else sees none.
    expect(await events('owen', `?trackId=${localId}`)).toContain('custom:handed-to-night');
    expect(await events('owen')).toEqual([]);
    expect(await events('ann', `?trackId=${localId}`)).toEqual([]);
    expect(
      (await as('ann', { method: 'GET', url: '/api/v1/notification-events?trackId=x' })).statusCode,
    ).toBe(400);
  });
});
