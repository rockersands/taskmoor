import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { deliverEmail } from '../email/deliver';
import type { OutgoingEmail } from '../email/transport';
import { EventBus } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { commentReadableSql } from '../tickets/comments';

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
  version: number;
  updatedAt: string;
}
interface CommentJson {
  id: number;
  author: { id: number; name: string } | null;
  body: unknown;
  visibility: { roleId: number; name: string } | { groupId: number; name: string } | null;
  version: number;
  edited: { at: string; by: { id: number; name: string } | null } | null;
  reactions: { emoji: string; count: number; mine: boolean }[];
  can: { edit: boolean; delete: boolean };
}

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('comments (M1-018)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const roles: Record<string, number> = {};
  const status: Record<string, number> = {};
  let trackId = 0;
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
  const put = (who: string, url: string) => as(who, { method: 'PUT', url });
  const del = (who: string, url: string) => as(who, { method: 'DELETE', url });

  async function create(who = 'alice', track = 'CMT'): Promise<TicketJson> {
    const res = await post(who, '/api/v1/tickets', { track, summary: 'Work' });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as TicketJson;
  }
  const url = (ticket: TicketJson, rest = '') => `/api/v1/tickets/${ticket.id}/comments${rest}`;
  async function comment(
    who: string,
    ticket: TicketJson,
    body: unknown,
    extra: Record<string, unknown> = {},
  ): Promise<CommentJson> {
    const res = await post(who, url(ticket), { body, ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().comment as CommentJson;
  }
  const comments = async (who: string, ticket: TicketJson, query = '') => {
    const res = await get(who, url(ticket, query));
    expect(res.statusCode, res.body).toBe(200);
    return res.json().comments as CommentJson[];
  };
  const texts = async (who: string, ticket: TicketJson) =>
    (await comments(who, ticket, '?format=markdown')).map((c) => String(c.body).trim());
  const commentRows = async (who: string, ticket: TicketJson) =>
    (
      (await get(who, `/api/v1/tickets/${ticket.id}/history`)).json().changes as {
        field: string;
        from: { value: string | null };
        to: { value: string | null };
      }[]
    ).filter((c) => c.field === 'comment');
  const events = async (type: string) =>
    database.db
      .selectFrom('domain_event')
      .select(['subject_id', 'payload'])
      .where('type', '=', type)
      .orderBy('id')
      .execute();

  async function member(who: string, role: string, track = trackId) {
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: track,
        role_id: roles[role] as number,
        user_id: users[who]?.id as number,
      })
      .execute();
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
    const res = await post('admin', '/api/v1/tracks', {
      key: 'CMT',
      name: 'Comments',
      mode: 'shared',
    });
    trackId = res.json().track.id;
    // Alice and Dave do the work; Bob views and comments; Carol administers; Erin is outside.
    await member('alice', 'Members');
    await member('dave', 'Members');
    await member('bob', 'Viewers');
    await member('carol', 'Administrators');
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-020] writes a comment in Markdown and reads it in every format, at its own address', async () => {
    const ticket = await create();
    const before = await get('alice', `/api/v1/tickets/${ticket.id}`);
    const written = await post('bob', `${url(ticket)}?format=markdown`, {
      body: 'Looks **good** to me',
    });
    expect(written.statusCode, written.body).toBe(201);
    const view = written.json().comment as CommentJson;
    expect(view).toMatchObject({
      author: { id: users.bob?.id, name: 'bob' },
      body: 'Looks **good** to me\n',
      visibility: null,
      version: 1,
      edited: null,
      reactions: [],
      can: { edit: true, delete: true },
    });
    const [listed] = await comments('alice', ticket);
    expect(listed?.body).toMatchObject({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Looks ' },
            { type: 'text', text: 'good', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' to me' },
          ],
        },
      ],
    });
    // Alice reads it but may not change Bob's comment.
    expect(listed?.can).toEqual({ edit: false, delete: false });
    const adf = await get('alice', `${url(ticket, `/${view.id}`)}?format=adf`);
    expect(adf.json().comment.body).toMatchObject({ type: 'doc', version: 1 });
    // A new comment is ticket activity: a history row naming it, the ticket's updated time, and
    // Bob now follows the ticket; the ticket's version is the same.
    expect(await commentRows('alice', ticket)).toMatchObject([
      { from: { value: null }, to: { value: String(view.id) } },
    ]);
    const after = (await get('alice', `/api/v1/tickets/${ticket.id}`)).json().ticket;
    expect(after.version).toBe(before.json().ticket.version);
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.json().ticket.updatedAt));
    const followers = (await get('alice', `/api/v1/tickets/${ticket.id}/followers`)).json();
    expect(JSON.stringify(followers)).toContain('"bob"');
    // Nothing to say is no comment; a document outside the schema is refused.
    expect(
      (
        await post('bob', url(ticket), { body: { type: 'doc', content: [{ type: 'paragraph' }] } })
      ).json().fields,
    ).toEqual({
      body: 'required',
    });
    expect(
      (
        await post('bob', url(ticket), { body: { type: 'doc', content: [{ type: 'nope' }] } })
      ).json().fields,
    ).toEqual({ body: 'invalid' });
    // Outside the track, the comments are not there.
    expect((await get('erin', url(ticket))).statusCode).toBe(404);
    expect((await post('erin', url(ticket), { body: paragraph('Hi') })).statusCode).toBe(404);
  });

  it('[CORE-020] edits and deletes by own and all permissions', async () => {
    const ticket = await create();
    const bobs = await comment('bob', ticket, paragraph('First thoughts'));
    const one = url(ticket, `/${bobs.id}`);
    expect((await patch('alice', one, { body: paragraph('Mine now') })).json()).toEqual({
      error: 'forbidden',
      permission: 'edit_all_comments',
    });
    expect((await del('alice', one)).json()).toEqual({
      error: 'forbidden',
      permission: 'delete_all_comments',
    });
    const edited = await patch('bob', one, { body: paragraph('Second thoughts') });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().comment).toMatchObject({
      version: 2,
      edited: { by: { id: users.bob?.id, name: 'bob' } },
    });
    // Carol administers the track: she may change and delete anyone's comment.
    expect((await patch('carol', one, { body: paragraph('Moderated') })).statusCode).toBe(200);
    expect((await del('carol', one)).statusCode).toBe(204);
    expect(await comments('bob', ticket)).toEqual([]);
    expect((await get('bob', one)).statusCode).toBe(404);
    expect((await patch('bob', one, { body: paragraph('Back') })).statusCode).toBe(404);
    expect((await del('bob', one)).statusCode).toBe(404);
    // The deletion is a history row too (newest first).
    expect(await commentRows('alice', ticket)).toMatchObject([
      { from: { value: String(bobs.id) }, to: { value: null } },
      { from: { value: null }, to: { value: String(bobs.id) } },
    ]);
    // A Viewer comments and keeps their own comments in order; nobody else's.
    const viewers = await comment('bob', ticket, paragraph('Again'));
    expect((await del('bob', url(ticket, `/${viewers.id}`))).statusCode).toBe(204);
  });

  it('[CORE-020] marks an edited comment and keeps its earlier versions for administrators', async () => {
    const ticket = await create();
    const first = await comment('alice', ticket, paragraph('Draft one'));
    const one = url(ticket, `/${first.id}`);
    await patch('alice', one, { body: paragraph('Draft two') });
    const third = await patch('alice', one, {
      body: paragraph('Draft three'),
      visibility: { roleId: roles.Members },
    });
    expect(third.json().comment).toMatchObject({
      version: 3,
      visibility: { roleId: roles.Members, name: 'Members' },
      edited: { by: { name: 'alice' } },
    });
    // The same text again changes nothing and keeps no version.
    const same = await patch('alice', one, { body: paragraph('Draft three') });
    expect(same.json().comment.version).toBe(3);
    // Only site administrators read the earlier versions.
    expect((await get('alice', `${one}/versions`)).statusCode).toBe(403);
    expect((await get('carol', `${one}/versions`)).statusCode).toBe(403);
    const versions = await get('admin', `${one}/versions?format=markdown`);
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json()).toMatchObject({
      comment: { id: first.id, deletedAt: null },
      versions: [
        { version: 3, body: 'Draft three\n', visibility: { roleId: roles.Members } },
        { version: 2, body: 'Draft two\n', visibility: null, replacedBy: { name: 'alice' } },
        { version: 1, body: 'Draft one\n', writtenBy: { name: 'alice' } },
      ],
    });
    // A deleted comment keeps them, for administrators only.
    expect((await del('alice', one)).statusCode).toBe(204);
    const kept = await get('admin', `${one}/versions`);
    expect(kept.json().comment.deletedAt).not.toBeNull();
    expect(kept.json().versions).toHaveLength(3);
  });

  it('[CORE-020] [NTF-001] a comment restricted to a role or group is absent for everyone else on every read path', async () => {
    const ticket = await create();
    await comment('dave', ticket, paragraph('Open to all'));
    const secret = await comment('alice', ticket, paragraph('For administrators'), {
      visibility: { roleId: roles.Administrators },
    });
    const one = url(ticket, `/${secret.id}`);
    // Alice wrote it; Carol is an administrator of the track, and so is the site administrator,
    // who created it. Bob and Dave are not.
    const readers = ['alice', 'carol', 'admin'];
    for (const who of ['alice', 'bob', 'carol', 'dave', 'admin']) {
      const reads = readers.includes(who);
      expect(await texts(who, ticket), who).toEqual(
        reads ? ['Open to all', 'For administrators'] : ['Open to all'],
      );
      expect((await get(who, one)).statusCode, `${who} permalink`).toBe(reads ? 200 : 404);
      expect((await commentRows(who, ticket)).length, `${who} history`).toBe(reads ? 2 : 1);
      if (!reads) {
        expect((await put(who, `${one}/reactions/${encodeURIComponent('👍')}`)).statusCode).toBe(
          404,
        );
        expect((await patch(who, one, { body: paragraph('Seen') })).statusCode).toBe(404);
        expect((await del(who, one)).statusCode).toBe(404);
      }
    }
    expect((await get('carol', one)).json().comment.visibility).toEqual({
      roleId: roles.Administrators,
      name: 'Administrators',
    });

    // A group: only one the writer is in, nested groups' members included.
    const group = async (name: string) =>
      (
        await database.db
          .insertInto('user_group')
          .values({ workspace_id: 1, name })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const auditors = await group('Auditors');
    const inner = await group('Inner auditors');
    await database.db
      .insertInto('group_nesting')
      .values({ workspace_id: 1, parent_id: auditors, child_id: inner })
      .execute();
    const refused = await post('alice', url(ticket), {
      body: paragraph('Audit'),
      visibility: { groupId: auditors },
    });
    expect(refused.json().fields).toEqual({ visibility: 'not_a_member' });
    await database.db
      .insertInto('group_member')
      .values([
        { workspace_id: 1, group_id: auditors, user_id: users.alice?.id as number },
        { workspace_id: 1, group_id: inner, user_id: users.dave?.id as number },
      ])
      .execute();
    await comment('alice', ticket, paragraph('For auditors'), {
      visibility: { groupId: auditors },
    });
    expect(await texts('dave', ticket)).toEqual(['Open to all', 'For auditors']);
    expect(await texts('carol', ticket)).toEqual(['Open to all', 'For administrators']);
    expect(await texts('bob', ticket)).toEqual(['Open to all']);
    // Site administrators are not exempt: outside the group, the comment is not theirs to read.
    expect(await texts('admin', ticket)).toEqual(['Open to all', 'For administrators']);
    // The rule's SQL form, for search and export, agrees with the API for everyone.
    const ids = async (who: string) => (await comments(who, ticket)).map((c) => c.id);
    for (const who of ['alice', 'bob', 'carol', 'dave', 'admin', null]) {
      const rows = await database.db
        .selectFrom('ticket_comment as c')
        .innerJoin('ticket as k', 'k.id', 'c.ticket_id')
        .select('c.id')
        .where('c.ticket_id', '=', ticket.id)
        .where(commentReadableSql(1, who === null ? null : (users[who]?.id as number)))
        .orderBy('c.id')
        .execute();
      const open = (await comments('dave', ticket))
        .filter((c) => c.visibility === null)
        .map((c) => c.id);
      expect(
        rows.map((r) => r.id),
        String(who),
      ).toEqual(who === null ? open : await ids(who));
    }
    // Where a comment may be restricted, for the writer: roles, and the groups they are in.
    const audiences = (await get('dave', `/api/v1/tickets/${ticket.id}/comment-audiences`)).json();
    expect(audiences.groups.map((g: { name: string }) => g.name)).toEqual([
      'Auditors',
      'Inner auditors',
    ]);
    expect(audiences.roles[0]).toMatchObject({ name: 'Members', held: true });
    // A role that does not exist is refused.
    expect(
      (
        await post('alice', url(ticket), { body: paragraph('x'), visibility: { roleId: 999_999 } })
      ).json().fields,
    ).toEqual({ visibility: 'not_found' });
  });

  it('[CORE-020] adds and removes reactions and shows their counts', async () => {
    const ticket = await create();
    const said = await comment('alice', ticket, paragraph('Shipped'));
    const reactions = (who: string, emoji: string, method: 'PUT' | 'DELETE' = 'PUT') =>
      as(who, {
        method,
        url: url(ticket, `/${said.id}/reactions/${encodeURIComponent(emoji)}`),
      });
    const reacted = (await events('comment.reacted')).length;
    expect((await reactions('bob', '👍')).json().reactions).toEqual([
      { emoji: '👍', count: 1, mine: true },
    ]);
    await reactions('carol', '👍');
    await reactions('carol', '🎉');
    expect((await comments('alice', ticket))[0]?.reactions).toEqual([
      { emoji: '👍', count: 2, mine: false },
      { emoji: '🎉', count: 1, mine: false },
    ]);
    // Twice is once: no second reaction, no second event.
    expect((await reactions('bob', '👍')).json().reactions[0]).toEqual({
      emoji: '👍',
      count: 2,
      mine: true,
    });
    expect((await events('comment.reacted')).length).toBe(reacted + 3);
    expect((await reactions('bob', '👍', 'DELETE')).json().reactions[0]).toEqual({
      emoji: '👍',
      count: 1,
      mine: false,
    });
    const unreacted = (await events('comment.unreacted')).length;
    expect((await reactions('bob', '👍', 'DELETE')).statusCode).toBe(200);
    expect((await events('comment.unreacted')).length).toBe(unreacted);
    // One emoji, skin tones and joined sequences included; nothing else.
    expect((await reactions('dave', '👍🏽')).statusCode).toBe(200);
    expect((await reactions('dave', '👨‍👩‍👧')).statusCode).toBe(200);
    for (const bad of ['ok', '👍🎉', '1', '<b>']) {
      expect((await reactions('dave', bad)).json().fields, bad).toEqual({ emoji: 'invalid' });
    }
  });

  it('[NTF-001] a restricted comment notifies and quotes only those who may read it', async () => {
    const ticket = await create();
    // Bob, Carol and Dave follow the ticket; Alice created it.
    await database.db
      .insertInto('ticket_follower')
      .values(
        ['bob', 'carol', 'dave'].map((who) => ({
          workspace_id: 1,
          ticket_id: ticket.id,
          user_id: users[who]?.id as number,
        })),
      )
      .execute();
    await database.db.deleteFrom('notification').execute();
    await comment('alice', ticket, paragraph('Hello all'));
    await comment('alice', ticket, paragraph('Secret plan'), {
      visibility: { roleId: roles.Administrators },
    });
    const gone = await comment('alice', ticket, paragraph('Oops, wrong ticket'));
    // A comment with no text in it (a rule) is still a comment to hear of.
    await comment('alice', ticket, { type: 'doc', content: [{ type: 'horizontalRule' }] });
    const bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    const runner = new JobRunner(database.db, 'comment-test');
    bus.attach(runner);
    while ((await bus.relayOnce()) > 0) {}
    while ((await runner.runOnce()) > 0) {}
    const told = await database.db
      .selectFrom('notification')
      .innerJoin('app_user', 'app_user.id', 'notification.user_id')
      .select(['app_user.name', 'notification.payload'])
      .where('notification.ticket_id', '=', ticket.id)
      .where('notification.event', '=', 'ticket_commented')
      .where('notification.channel', '=', 'email')
      .execute();
    const count = (who: string) => told.filter((n) => n.name === who).length;
    expect([count('alice'), count('bob'), count('carol'), count('dave')]).toEqual([0, 3, 4, 3]);
    expect(
      told.every((n) => typeof (n.payload as { commentId?: number }).commentId === 'number'),
    ).toBe(true);

    // Sent later: each reader gets the comments they may read, quoted; a deleted one is not.
    expect((await del('alice', url(ticket, `/${gone.id}`))).statusCode).toBe(204);
    const sent: OutgoingEmail[] = [];
    await deliverEmail(database.db, new Authorizer(database.db), {
      transport: {
        send: async (email) => {
          sent.push(email);
          return { messageId: null };
        },
      },
      from: 'taskmoor@example.com',
      publicUrl: 'https://taskmoor.example.com',
      now: new Date(Date.now() + 10 * 60_000),
    });
    const mailTo = (who: string) =>
      sent
        .filter((e) => e.to === `${who}@example.com`)
        .map((e) => e.text)
        .join('\n');
    expect(mailTo('bob')).toContain('> Hello all');
    expect(mailTo('bob')).not.toContain('Secret plan');
    expect(mailTo('carol')).toContain('> Secret plan');
    for (const who of ['bob', 'carol', 'dave']) expect(mailTo(who)).not.toContain('Oops');
    // Bob hears of the open comment and the rule, not of the restricted or the deleted one.
    expect(mailTo('bob').match(/alice commented/g)).toHaveLength(2);
  });

  it('[WF-006] a transition takes a comment as part of it', async () => {
    const ticket = await create();
    const offered = (await get('alice', `/api/v1/tickets/${ticket.id}/transitions`)).json()
      .transitions as { id: number }[];
    const transitionId = offered[0]?.id as number;
    const created = (await events('comment.created')).length;
    const res = await post('alice', `/api/v1/tickets/${ticket.id}/transitions?format=markdown`, {
      transitionId,
      comment: 'Starting on this',
      commentVisibility: { roleId: roles.Members },
    });
    expect(res.statusCode, res.body).toBe(200);
    const [written] = await comments('dave', ticket, '?format=markdown');
    expect(written).toMatchObject({
      body: 'Starting on this\n',
      visibility: { roleId: roles.Members },
    });
    // One event: the transition, naming its comment.
    expect((await events('comment.created')).length).toBe(created);
    const transitioned = (await events('ticket.transitioned')).at(-1);
    expect(transitioned?.payload).toMatchObject({ commentId: written?.id });
    expect(await texts('bob', ticket)).toEqual([]);
    // A restriction without a comment, or a comment that is not text, is refused.
    const back = (await get('alice', `/api/v1/tickets/${ticket.id}/transitions`)).json()
      .transitions as { id: number }[];
    expect(
      (
        await post('alice', `/api/v1/tickets/${ticket.id}/transitions`, {
          transitionId: back[0]?.id,
          commentVisibility: null,
        })
      ).json().fields,
    ).toEqual({ commentVisibility: 'without_comment' });
    expect(
      (
        await post('alice', `/api/v1/tickets/${ticket.id}/transitions`, {
          transitionId: back[0]?.id,
          comment: 42,
        })
      ).json().fields,
    ).toEqual({ comment: 'invalid' });
  });

  it('[WF-007] a status that reserves commenting refuses everyone else, as a lock', async () => {
    const S = (name: string) => status[name] as number;
    const definition = {
      initialStatusId: S('New'),
      statuses: [{ statusId: S('New') }, { statusId: S('Approved') }],
      transitions: [{ id: 1, name: 'Approve', from: [S('New')], to: S('Approved') }],
      statusPermissions: {
        [String(S('Approved'))]: { comment: [{ role: String(roles.Administrators) }] },
      },
    };
    const workflow = await post('admin', '/api/v1/workflows', { name: 'Reserved', definition });
    expect(workflow.statusCode, workflow.body).toBe(201);
    const key = `CL${++trackCount}`;
    const track = await post('admin', '/api/v1/tracks', { key, name: key, mode: 'shared' });
    const lockedTrack = track.json().track.id as number;
    await member('alice', 'Members', lockedTrack);
    await member('carol', 'Administrators', lockedTrack);
    const map = await post('admin', '/api/v1/workflow-maps', {
      name: 'Reserved map',
      defaultWorkflowId: workflow.json().workflow.id,
    });
    expect(map.statusCode, map.body).toBe(201);
    const set = await as('admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${lockedTrack}`,
      payload: { workflowMapId: map.json().workflowMap.id },
    });
    expect(set.statusCode, set.body).toBe(200);
    const ticket = await create('alice', key);
    const early = await comment('alice', ticket, paragraph('Before approval'));
    expect(
      (await post('carol', `/api/v1/tickets/${ticket.id}/transitions`, { transitionId: 1 }))
        .statusCode,
    ).toBe(200);
    const lock = {
      by: 'status',
      statusId: S('Approved'),
      statusName: 'Approved',
      allowed: [{ type: 'role', id: roles.Administrators, name: 'Administrators' }],
    };
    const refused = { error: 'forbidden', permission: 'comment', locks: [lock] };
    expect((await post('alice', url(ticket), { body: paragraph('After') })).json()).toEqual(
      refused,
    );
    expect(
      (await patch('alice', url(ticket, `/${early.id}`), { body: paragraph('Changed') })).json(),
    ).toEqual(refused);
    expect((await del('alice', url(ticket, `/${early.id}`))).json()).toEqual(refused);
    // The list says so, for the page to explain; reactions are not comments.
    const listed = (await get('alice', url(ticket))).json();
    expect(listed.can).toEqual({ add: false, react: true });
    expect(listed.lock).toEqual(lock);
    expect(listed.comments[0].can).toEqual({ edit: false, delete: false });
    expect(
      (await put('alice', url(ticket, `/${early.id}/reactions/${encodeURIComponent('👀')}`)))
        .statusCode,
    ).toBe(200);
    // Carol holds the role.
    expect(
      (await post('carol', url(ticket), { body: paragraph('Approved, noted') })).statusCode,
    ).toBe(201);
  });

  it('[CORE-025] an archived track keeps its comments readable and refuses new ones', async () => {
    const key = `CA${++trackCount}`;
    const track = await post('admin', '/api/v1/tracks', { key, name: key, mode: 'shared' });
    const archivedTrack = track.json().track.id as number;
    await member('alice', 'Members', archivedTrack);
    const ticket = await create('alice', key);
    const said = await comment('alice', ticket, paragraph('Last words'));
    expect((await post('admin', `/api/v1/tracks/${archivedTrack}/archive`)).statusCode).toBe(200);
    expect(await texts('alice', ticket)).toEqual(['Last words']);
    expect((await post('alice', url(ticket), { body: paragraph('More') })).statusCode).toBe(409);
    expect(
      (await patch('alice', url(ticket, `/${said.id}`), { body: paragraph('Edit') })).statusCode,
    ).toBe(409);
    const listed = (await get('alice', url(ticket))).json();
    expect(listed.can).toEqual({ add: false, react: false });
  });
});
