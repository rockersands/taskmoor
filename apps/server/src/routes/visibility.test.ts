import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.75.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

const PEOPLE = ['admin', 'alice', 'bob', 'dave', 'erin', 'frank', 'olga'] as const;
type Person = (typeof PEOPLE)[number];

/**
 * Visibility levels and policies (M1-020; IAM-011, QRY-008): the visibility matrix. Five
 * levels, each opened by another kind of member, and a ticket at each; every person reads every
 * ticket through every read path, and sees exactly the tickets of the levels they belong to.
 */
describe('visibility levels (M1-020)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  const tickets: Record<string, string> = {};
  const levels: Record<string, number> = {};
  let policyId = 0;
  let trackId = 0;
  let userField = 0;

  const as = (who: Person | null, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: who ? users[who].cookie : '' },
    });
  const roleId = async (name: string) =>
    (
      await database.db
        .selectFrom('role')
        .select('id')
        .where('name', '=', name)
        .executeTakeFirstOrThrow()
    ).id;
  const create = async (who: Person, payload: Record<string, unknown>) => {
    const res = await as(who, { method: 'POST', url: '/api/v1/tickets', payload });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as { id: number; key: string; visibilityLevel: unknown };
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
    }
    // Bob is in Support through Tier 2, a group nested in it.
    const groups: Record<string, number> = {};
    for (const name of ['Support', 'Tier 2']) {
      groups[name] = (
        await database.db
          .insertInto('user_group')
          .values({ workspace_id: 1, name })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    await database.db
      .insertInto('group_nesting')
      .values({
        workspace_id: 1,
        parent_id: groups.Support as number,
        child_id: groups['Tier 2'] as number,
      })
      .execute();
    await database.db
      .insertInto('group_member')
      .values({ workspace_id: 1, group_id: groups['Tier 2'] as number, user_id: users.bob.id })
      .execute();

    const track = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'VIS', name: 'Visibility', mode: 'shared' },
    });
    trackId = track.json().track.id;
    // Everyone works in the track; Dave also administers it.
    const members = await roleId('Members');
    for (const who of PEOPLE.filter((p) => p !== 'admin')) {
      await database.db
        .insertInto('track_role_actor')
        .values({ workspace_id: 1, track_id: trackId, role_id: members, user_id: users[who].id })
        .execute();
    }
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: trackId,
        role_id: await roleId('Administrators'),
        user_id: users.dave.id,
      })
      .execute();
    const field = await as('admin', {
      method: 'POST',
      url: '/api/v1/fields',
      payload: { name: 'Reviewer', type: 'user' },
    });
    expect(field.statusCode, field.body).toBe(201);
    userField = field.json().field.id;

    const policy = await as('admin', {
      method: 'POST',
      url: '/api/v1/visibility-policies',
      payload: {
        name: 'Sensitive work',
        levels: [
          { name: 'Alice only', members: [{ grantee: 'user', userId: users.alice.id }] },
          { name: 'Support', members: [{ grantee: 'group', groupId: groups.Support }] },
          {
            name: 'Administrators',
            members: [{ grantee: 'role', roleId: await roleId('Administrators') }],
          },
          { name: 'Requester', members: [{ grantee: 'requester' }] },
          {
            name: 'Reviewer',
            members: [{ grantee: 'user_field', fieldKey: `cf[${userField}]` }],
          },
        ],
      },
    });
    expect(policy.statusCode, policy.body).toBe(201);
    policyId = policy.json().visibilityPolicy.id;
    for (const l of policy.json().visibilityPolicy.levels as { id: number; name: string }[]) {
      levels[l.name] = l.id;
    }
    const used = await as('admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${trackId}`,
      payload: { visibilityPolicyId: policyId },
    });
    expect(used.statusCode, used.body).toBe(200);

    // A release every ticket targets, a web link every ticket carries, and an open ticket
    // linked to all the others; then each ticket takes its level, out of Dave's sight for most.
    const release = await as('dave', {
      method: 'POST',
      url: `/api/v1/tracks/${trackId}/releases`,
      payload: { name: '1.0' },
    });
    expect(release.statusCode, release.body).toBe(201);
    const releaseId = release.json().release.id;
    const plain = { track: 'VIS', targetReleaseIds: [releaseId] };
    tickets.open = (await create('dave', { ...plain, summary: 'Open to the track' })).key;
    for (const name of ['Alice only', 'Support', 'Administrators']) {
      tickets[name] = (await create('dave', { ...plain, summary: name })).key;
    }
    tickets.Requester = (
      await create('dave', { ...plain, summary: 'Raised by Erin', requesterId: users.erin.id })
    ).key;
    tickets.Reviewer = (
      await create('dave', {
        ...plain,
        summary: 'Reviewed by Frank',
        fields: { [userField]: users.frank.id },
      })
    ).key;
    const linkType = await database.db
      .selectFrom('link_type')
      .select('id')
      .orderBy('id')
      .executeTakeFirstOrThrow();
    for (const [name, key] of Object.entries(tickets)) {
      const web = await as('dave', {
        method: 'POST',
        url: `/api/v1/tickets/${key}/web-links`,
        payload: { url: 'https://example.com/incident/7', title: 'Incident 7', globalId: 'inc-7' },
      });
      expect(web.statusCode, web.body).toBe(201);
      if (name === 'open') continue;
      const link = await as('dave', {
        method: 'POST',
        url: `/api/v1/tickets/${tickets.open}/links`,
        payload: { linkTypeId: linkType.id, ticket: key },
      });
      expect(link.statusCode, link.body).toBe(201);
      const levelled = await as('dave', {
        method: 'PATCH',
        url: `/api/v1/tickets/${key}`,
        payload: { visibilityLevelId: levels[name] },
      });
      expect(levelled.statusCode, levelled.body).toBe(200);
    }
  });
  afterAll(async () => {
    await app.close();
  });

  /**
   * Who sees what: the matrix every read path is held to. The site administrator created the
   * track and so acts in its Administrators role; beyond that, administrators are not exempt.
   */
  const EXPECTED: Record<Person, string[]> = {
    admin: ['open', 'Administrators'],
    alice: ['open', 'Alice only'],
    bob: ['open', 'Support'],
    dave: ['open', 'Administrators'],
    erin: ['open', 'Requester'],
    frank: ['open', 'Reviewer'],
    olga: ['open'],
  };
  const LEVELLED = ['open', 'Alice only', 'Support', 'Administrators', 'Requester', 'Reviewer'];

  it('[IAM-011] [QRY-008] hidden tickets are absent from every read path, for every person', async () => {
    for (const who of PEOPLE) {
      const sees = new Set(EXPECTED[who]);
      // The list, filtered in its statement.
      const list = await as(who, { method: 'GET', url: '/api/v1/tickets?track=VIS' });
      expect(list.statusCode, `${who} list`).toBe(200);
      const listed = (list.json().tickets as { key: string }[]).map((t) => t.key).sort();
      expect(listed, `${who} list`).toEqual(EXPECTED[who].map((n) => tickets[n]).sort());
      // Every read path of one ticket: there or absent (404, as for a ticket that never was).
      for (const name of LEVELLED) {
        const key = tickets[name] as string;
        for (const path of [
          '',
          '/history',
          '/links',
          '/time-entries',
          '/comments',
          '/comment-audiences',
          '/attachments',
          '/followers',
          '/votes',
          '/layout',
          '/transitions',
          '/visibility-levels',
        ]) {
          const res = await as(who, { method: 'GET', url: `/api/v1/tickets/${key}${path}` });
          if (sees.has(name)) expect(res.statusCode, `${who} ${name}${path}`).not.toBe(404);
          else expect(res.statusCode, `${who} ${name}${path}`).toBe(404);
        }
        // Writes find nothing either.
        const edit = await as(who, {
          method: 'PATCH',
          url: `/api/v1/tickets/${key}`,
          payload: { summary: 'Renamed' },
        });
        if (!sees.has(name)) expect(edit.statusCode, `${who} edits ${name}`).toBe(404);
      }
      // The open ticket's links name only the tickets the person sees.
      const links = await as(who, { method: 'GET', url: `/api/v1/tickets/${tickets.open}/links` });
      expect(
        (links.json().links as { ticket: { key: string } }[]).map((l) => l.ticket.key).sort(),
        `${who} links`,
      ).toEqual(
        EXPECTED[who]
          .filter((n) => n !== 'open')
          .map((n) => tickets[n])
          .sort(),
      );
      // Tickets by web link global id.
      const web = await as(who, { method: 'GET', url: '/api/v1/web-links?globalId=inc-7' });
      expect(
        (web.json().tickets as { key: string }[]).map((t) => t.key).sort(),
        `${who} web links`,
      ).toEqual(EXPECTED[who].map((n) => tickets[n]).sort());
      // Counts: a release counts only the tickets the person sees (QRY-008 (1)).
      const releases = await as(who, { method: 'GET', url: `/api/v1/tracks/${trackId}/releases` });
      expect(releases.json().releases[0]?.progress.tickets, `${who} release count`).toBe(
        EXPECTED[who].length,
      );
    }
    // Anonymous visitors see nothing in a track they may not browse.
    const anonymous = await as(null, { method: 'GET', url: `/api/v1/tickets/${tickets.open}` });
    expect([401, 404]).toContain(anonymous.statusCode);
  });

  it('[IAM-012] the explainer names the visibility level that decided a ticket', async () => {
    const explain = async (who: Person, name: string) =>
      (
        await as('admin', {
          method: 'GET',
          url: `/api/v1/permissions/explain?userId=${users[who].id}&ticket=${tickets[name]}&permission=browse_track`,
        })
      ).json();
    const alice = await explain('alice', 'Alice only');
    expect(alice).toMatchObject({
      allowed: true,
      ticket: {
        key: tickets['Alice only'],
        visibilityLevel: { name: 'Alice only', member: true, matched: [{ grantee: 'user' }] },
      },
    });
    // Olga browses the track, but the level keeps the ticket from her.
    const olga = await explain('olga', 'Alice only');
    expect(olga).toMatchObject({
      allowed: false,
      reasons: [{ kind: 'grant', grantee: 'role' }],
      ticket: { visibilityLevel: { name: 'Alice only', member: false, matched: [] } },
    });
    expect((await explain('erin', 'Requester')).ticket.visibilityLevel).toMatchObject({
      member: true,
      matched: [{ grantee: 'requester' }],
    });
  });

  it('[IAM-011] a ticket takes the track default; levels need Set visibility level and the track', async () => {
    // The default level: new tickets take it unless they say otherwise.
    await as('admin', {
      method: 'PATCH',
      url: `/api/v1/visibility-policies/${policyId}`,
      payload: { defaultLevelId: levels.Support },
    });
    const defaulted = await create('bob', { track: 'VIS', summary: 'Takes the default' });
    expect(defaulted.visibilityLevel).toEqual({ id: levels.Support, name: 'Support' });
    const none = await create('bob', {
      track: 'VIS',
      summary: 'No level',
      visibilityLevelId: null,
    });
    expect(none.visibilityLevel).toBeNull();
    // A level of no policy the track uses.
    const other = await as('admin', {
      method: 'POST',
      url: '/api/v1/visibility-policies',
      payload: { name: 'Elsewhere', levels: [{ name: 'Secret' }] },
    });
    const secret = other.json().visibilityPolicy.levels[0].id;
    const wrong = await as('bob', {
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track: 'VIS', summary: 'Wrong level', visibilityLevelId: secret },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().fields).toEqual({ visibilityLevelId: 'not_in_track' });
    // Without the permission, nothing is set.
    const members = await roleId('Members');
    const grant = await database.db
      .deleteFrom('access_grant')
      .where('permission', '=', 'set_visibility_level')
      .where('role_id', '=', members)
      .returningAll()
      .execute();
    const refused = await as('bob', {
      method: 'PATCH',
      url: `/api/v1/tickets/${defaulted.key}`,
      payload: { visibilityLevelId: null },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ permission: 'set_visibility_level' });
    const offered = await as('bob', {
      method: 'GET',
      url: `/api/v1/tickets/${defaulted.key}/visibility-levels`,
    });
    expect(offered.json()).toMatchObject({ mayChoose: false, levels: [] });
    await database.db.insertInto('access_grant').values(grant).execute();
    // With it, the change is recorded in history under the query language's name.
    const edited = await as('bob', {
      method: 'PATCH',
      url: `/api/v1/tickets/${defaulted.key}`,
      payload: { visibilityLevelId: null },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const history = await as('bob', {
      method: 'GET',
      url: `/api/v1/tickets/${defaulted.key}/history`,
    });
    expect(
      (history.json().changes as { field: string; from: { display: string } }[]).find(
        (c) => c.field === 'visibilityLevel',
      )?.from.display,
    ).toBe('Support');
  });

  it('[IAM-011] moving a ticket applies the target track default level', async () => {
    const target = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'VIT', name: 'Target', mode: 'shared' },
    });
    const targetId = target.json().track.id;
    const members = await roleId('Members');
    await database.db
      .insertInto('track_role_actor')
      .values({ workspace_id: 1, track_id: targetId, role_id: members, user_id: users.bob.id })
      .execute();
    const policy = await as('admin', {
      method: 'POST',
      url: '/api/v1/visibility-policies',
      payload: {
        name: 'Target policy',
        levels: [{ name: 'Team', members: [{ grantee: 'any_user' }] }],
        defaultLevel: 'Team',
      },
    });
    expect(policy.statusCode, policy.body).toBe(201);
    const team = policy.json().visibilityPolicy.levels[0].id;
    await as('admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${targetId}`,
      payload: { visibilityPolicyId: policy.json().visibilityPolicy.id },
    });
    const ticket = await create('bob', {
      track: 'VIS',
      summary: 'Moves to VIT',
      visibilityLevelId: levels.Support,
    });
    const moved = await as('bob', {
      method: 'POST',
      url: `/api/v1/tickets/${ticket.key}/move`,
      payload: { track: 'VIT' },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().ticket.visibilityLevel).toEqual({ id: team, name: 'Team' });
    // A level the target lacks is refused, and nothing moves.
    const back = await as('bob', {
      method: 'POST',
      url: `/api/v1/tickets/${moved.json().ticket.key}/move`,
      payload: { track: 'VIS', visibilityLevelId: team },
    });
    expect(back.statusCode).toBe(400);
    const still = await as('bob', { method: 'GET', url: `/api/v1/tickets/${ticket.id}` });
    expect(still.json().ticket.track.key).toBe('VIT');
  });

  it('[IAM-011] a level in use is deleted only with a replacement; a policy in use not at all', async () => {
    const level = await as('admin', {
      method: 'POST',
      url: `/api/v1/visibility-policies/${policyId}/levels`,
      payload: { name: 'Short-lived', members: [{ grantee: 'any_user' }] },
    });
    expect(level.statusCode, level.body).toBe(201);
    const levelId = (level.json().visibilityPolicy.levels as { id: number; name: string }[]).find(
      (l) => l.name === 'Short-lived',
    )?.id as number;
    const ticket = await create('bob', {
      track: 'VIS',
      summary: 'At a short-lived level',
      visibilityLevelId: levelId,
    });
    const url = `/api/v1/visibility-policies/${policyId}/levels/${levelId}`;
    const refused = await as('admin', { method: 'DELETE', url });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'in_use', ticketCount: 1 });
    const deleted = await as('admin', {
      method: 'DELETE',
      url: `${url}?replaceWith=${levels.Support}`,
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const after = await as('bob', { method: 'GET', url: `/api/v1/tickets/${ticket.key}` });
    expect(after.json().ticket.visibilityLevel).toEqual({ id: levels.Support, name: 'Support' });
    const policy = await as('admin', {
      method: 'DELETE',
      url: `/api/v1/visibility-policies/${policyId}`,
    });
    expect(policy.statusCode).toBe(409);
    expect(policy.json()).toMatchObject({ error: 'in_use', usedBy: [{ key: 'VIS' }] });
    // Only administrators read and change policies; members name people and groups.
    expect(
      (await as('bob', { method: 'GET', url: `/api/v1/visibility-policies/${policyId}` }))
        .statusCode,
    ).toBe(403);
  });

  it('[IAM-010] a policy that lets requesters browse shows each requester their own tickets only', async () => {
    const track = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'DESK', name: 'Desk', mode: 'local' },
    });
    const deskId = track.json().track.id;
    const policy = await database.db
      .selectFrom('track')
      .select('access_policy_id')
      .where('id', '=', deskId)
      .executeTakeFirstOrThrow();
    // Agents (Members) browse all; anyone signed in creates; requesters browse their own.
    await database.db
      .insertInto('access_grant')
      .values([
        {
          workspace_id: 1,
          policy_id: policy.access_policy_id,
          permission: 'browse_track',
          grantee: 'requester',
        },
      ])
      .execute();
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: deskId,
        role_id: await roleId('Members'),
        user_id: users.dave.id,
      })
      .execute();
    const mine = await create('dave', {
      track: 'DESK',
      summary: 'For Olga',
      requesterId: users.olga.id,
    });
    const theirs = await create('dave', {
      track: 'DESK',
      summary: 'For Erin',
      requesterId: users.erin.id,
    });
    const list = await as('olga', { method: 'GET', url: '/api/v1/tickets?track=DESK' });
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json().tickets as { key: string }[]).map((t) => t.key)).toEqual([mine.key]);
    expect(
      (await as('olga', { method: 'GET', url: `/api/v1/tickets/${mine.key}` })).statusCode,
    ).toBe(200);
    expect(
      (await as('olga', { method: 'GET', url: `/api/v1/tickets/${theirs.key}` })).statusCode,
    ).toBe(404);
    // Browsing their own ticket lets them do nothing else there.
    const edit = await as('olga', {
      method: 'PATCH',
      url: `/api/v1/tickets/${mine.key}`,
      payload: { summary: 'Changed by Olga' },
    });
    expect(edit.statusCode).toBe(403);
  });
});
