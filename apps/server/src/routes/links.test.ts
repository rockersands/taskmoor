import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { expectWithinBudget } from '@taskmoor/testkit/budget';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.69.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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
  followerCount: number;
  voteCount: number;
}
interface LinkJson {
  id: number;
  type: Named;
  direction: 'outward' | 'inward';
  phrase: string;
  ticket: { id: number; key: string; summary: string };
}
interface ChangeJson {
  field: string;
  from: { value: string | null; display: string | null };
  to: { value: string | null; display: string | null };
}

describe('ticket links, web links, followers and votes (M1-015)', () => {
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
  const put = (who: string, url: string, payload?: Record<string, unknown>) =>
    as(who, { method: 'PUT', url, ...(payload ? { payload } : {}) });
  const del = (who: string, url: string) => as(who, { method: 'DELETE', url });

  const ticketOf = (res: LightMyRequestResponse) => res.json().ticket as TicketJson;
  async function create(who: string, track: string, summary: string): Promise<TicketJson> {
    const res = await post(who, '/api/v1/tickets', { track, summary });
    expect(res.statusCode, res.body).toBe(201);
    return ticketOf(res);
  }
  const linksOf = async (who: string, ticket: TicketJson) => {
    const res = await get(who, `/api/v1/tickets/${ticket.id}/links`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { links: LinkJson[]; webLinks: { id: number; title: string }[] };
  };
  const readLinks = async (who: string, ticket: TicketJson) =>
    (await linksOf(who, ticket)).links.map((l) => `${l.phrase} ${l.ticket.key}`);
  const history = async (ticket: TicketJson, field: string) =>
    (
      (await get('alice', `/api/v1/tickets/${ticket.id}/history?order=asc`)).json()
        .changes as ChangeJson[]
    ).filter((c) => c.field === field);
  const linkTypes = async () =>
    (await get('alice', '/api/v1/link-types')).json().linkTypes as (Named & {
      outward: string;
      inward: string;
      isCopy: boolean;
    })[];
  const typeId = async (name: string) =>
    (await linkTypes()).find((t) => t.name === name)?.id as number;
  async function link(
    who: string,
    from: TicketJson,
    to: TicketJson,
    type: string,
    direction?: 'inward',
  ) {
    return post(who, `/api/v1/tickets/${from.id}/links`, {
      linkTypeId: await typeId(type),
      ticket: to.key,
      ...(direction ? { direction } : {}),
    });
  }

  async function newTrack(key: string) {
    const res = await post('admin', '/api/v1/tracks', { key, name: key, mode: 'shared' });
    expect(res.statusCode, res.body).toBe(201);
    tracks[key] = res.json().track.id;
    // Alice and Dave work in both tracks; Bob views ABC; Eve only browses ABC.
    const actors: [string, string][] = [
      ['alice', 'Members'],
      ['dave', 'Members'],
    ];
    if (key === 'ABC') actors.push(['bob', 'Viewers'], ['eve', 'Browsers']);
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
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
      ['dave', false],
      ['eve', false],
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
    // A role that only browses: no "View voters and followers", no "Manage followers".
    const policy = await database.db
      .selectFrom('access_policy')
      .select('id')
      .where('name', '=', 'Default access policy')
      .executeTakeFirstOrThrow();
    const browsers = await database.db
      .insertInto('role')
      .values({ workspace_id: 1, name: 'Browsers', description: 'Look only' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('access_grant')
      .values({
        workspace_id: 1,
        policy_id: policy.id,
        permission: 'browse_track',
        grantee: 'role',
        role_id: browsers.id,
      })
      .execute();
    for (const role of await database.db.selectFrom('role').select(['id', 'name']).execute()) {
      roles[role.name] = role.id;
    }
    await newTrack('ABC');
    await newTrack('XYZ');
  });
  afterAll(async () => {
    await app.close();
  });

  describe('link types', () => {
    it('[CORE-018] ships Relates, Duplicates, Blocks and Copies; administrators add more', async () => {
      const shipped = await linkTypes();
      expect(shipped.map((t) => [t.name, t.outward, t.inward, t.isCopy])).toEqual([
        ['Blocks', 'blocks', 'is blocked by', false],
        ['Copies', 'copies', 'is copied by', true],
        ['Duplicates', 'duplicates', 'is duplicated by', false],
        ['Relates', 'relates to', 'relates to', false],
      ]);
      const body = { name: 'Causes', outward: 'causes', inward: 'is caused by' };
      expect((await post('alice', '/api/v1/link-types', body)).statusCode).toBe(403);
      const created = await post('admin', '/api/v1/link-types', body);
      expect(created.statusCode, created.body).toBe(201);
      expect(
        (await post('admin', '/api/v1/link-types', { ...body, name: 'causes' })).json(),
      ).toEqual({ error: 'name_taken' });
      const edited = await patch('admin', `/api/v1/link-types/${created.json().linkType.id}`, {
        inward: 'is the result of',
      });
      expect(edited.json().linkType).toMatchObject({ name: 'Causes', inward: 'is the result of' });
    });
  });

  describe('ticket links', () => {
    it('[CORE-018] reads "blocks" on one ticket and "is blocked by" on the other', async () => {
      const api = await create('alice', 'ABC', 'Rate limiter');
      const ui = await create('alice', 'XYZ', 'Retry button');
      const res = await link('alice', api, ui, 'Blocks');
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().link).toMatchObject({
        direction: 'outward',
        phrase: 'blocks',
        ticket: { key: ui.key },
      });
      expect(await readLinks('alice', api)).toEqual([`blocks ${ui.key}`]);
      expect(await readLinks('alice', ui)).toEqual([`is blocked by ${api.key}`]);
      // From the other side, inward.
      const inward = await link('alice', ui, api, 'Relates', 'inward');
      expect(inward.statusCode, inward.body).toBe(201);
      expect(await readLinks('alice', api)).toEqual([`blocks ${ui.key}`, `relates to ${ui.key}`]);

      expect((await link('alice', api, ui, 'Blocks')).json()).toEqual({ error: 'link_exists' });
      expect((await link('alice', api, api, 'Blocks')).json().fields).toEqual({ ticket: 'self' });
      expect(
        (
          await post('alice', `/api/v1/tickets/${api.id}/links`, {
            linkTypeId: 999_999,
            ticket: ui.key,
          })
        ).json().fields,
      ).toEqual({ linkTypeId: 'not_found' });
      // Viewers do not link.
      expect((await link('bob', api, ui, 'Duplicates')).json()).toEqual({
        error: 'forbidden',
        permission: 'link_tickets',
      });

      // Both tickets record the link in their history.
      expect((await history(api, 'link')).map((c) => c.to.display)).toEqual([
        `blocks ${ui.key}`,
        `relates to ${ui.key}`,
      ]);
      expect((await history(ui, 'link')).map((c) => c.to.display)).toEqual([
        `is blocked by ${api.key}`,
        `relates to ${api.key}`,
      ]);
      const blocks = (await linksOf('alice', api)).links[0] as LinkJson;
      expect((await del('alice', `/api/v1/tickets/${ui.id}/links/${blocks.id}`)).statusCode).toBe(
        204,
      );
      expect(await readLinks('alice', api)).toEqual([`relates to ${ui.key}`]);
      expect((await history(ui, 'link')).at(-1)?.from.display).toBe(`is blocked by ${api.key}`);
    });

    it('[CORE-018] shows a link only when the viewer may see the other ticket', async () => {
      const here = await create('alice', 'ABC', 'Visible to Bob');
      const there = await create('alice', 'XYZ', 'Not visible to Bob');
      const near = await create('alice', 'ABC', 'Also visible');
      await link('alice', here, there, 'Relates');
      await link('alice', here, near, 'Relates');
      expect(await readLinks('alice', here)).toHaveLength(2);
      expect(await readLinks('bob', here)).toEqual([`relates to ${near.key}`]);
      // Bob cannot link to what he cannot see, nor open its links.
      expect((await get('bob', `/api/v1/tickets/${there.id}/links`)).statusCode).toBe(404);

      // A ticket in the trash leaves the list, and comes back with its links.
      expect((await del('alice', `/api/v1/tickets/${there.key}`)).statusCode).toBe(403);
      expect((await del('admin', `/api/v1/tickets/${near.key}`)).statusCode).toBe(204);
      expect(await readLinks('alice', here)).toEqual([`relates to ${there.key}`]);
      expect((await post('admin', `/api/v1/tickets/${near.key}/restore`)).statusCode).toBe(200);
      expect(await readLinks('alice', here)).toHaveLength(2);
    });

    it('[CORE-031] the picker query finds tickets of the track by number or name, and only what the person sees', async () => {
      const here = await create('alice', 'ABC', 'Picker home');
      const wanted = await create('alice', 'ABC', 'Quarterly invoice export');
      const elsewhere = await create('alice', 'XYZ', 'Quarterly invoice import');
      const pick = async (who: string, q: string) => {
        const res = await post(who, '/api/v1/search', {
          q,
          limit: 8,
          fields: 'summary,status',
          count: false,
        });
        expect(res.statusCode, res.body).toBe(200);
        return (res.json().tickets as { key: string }[]).map((t) => t.key);
      };
      const inTrack = (clause: string) =>
        `track = "ABC" AND key != "${here.key}" AND (${clause}) ORDER BY updated DESC`;
      // By name, the last word as it is being typed; not the same words in the other track.
      expect(await pick('alice', inTrack('summary ~ "quarterly inv*"'))).toEqual([wanted.key]);
      // By number or key.
      expect(await pick('alice', inTrack(`key = "${wanted.key}"`))).toEqual([wanted.key]);
      expect(await pick('alice', inTrack('key = "ABC-999999"'))).toEqual([]);
      // Without the track's condition the other track's ticket is there: the condition does it.
      expect(await pick('alice', 'summary ~ "quarterly inv*" ORDER BY key')).toEqual(
        expect.arrayContaining([wanted.key, elsewhere.key]),
      );
      // The permission filter is part of the statement: Bob only views ABC.
      expect(await pick('bob', 'summary ~ "quarterly inv*" ORDER BY key')).toEqual([wanted.key]);
    });

    it("[CORE-031] says whether the person may change a ticket's links", async () => {
      const here = await create('alice', 'ABC', 'May link?');
      expect((await get('alice', `/api/v1/tickets/${here.id}/links`)).json()).toMatchObject({
        mayLink: true,
        enabled: true,
      });
      expect((await get('bob', `/api/v1/tickets/${here.id}/links`)).json()).toMatchObject({
        mayLink: false,
      });
    });

    it('[CORE-031] removes a link to another track, as imports and the API can make', async () => {
      const here = await create('alice', 'ABC', 'Cross-track home');
      const there = await create('alice', 'XYZ', 'Cross-track other');
      const made = await link('alice', here, there, 'Relates');
      expect(made.statusCode, made.body).toBe(201);
      expect(await readLinks('alice', here)).toEqual([`relates to ${there.key}`]);
      expect(
        (await del('alice', `/api/v1/tickets/${here.id}/links/${made.json().link.id}`)).statusCode,
      ).toBe(204);
      expect(await readLinks('alice', here)).toEqual([]);
    });

    it('[CORE-018] remaps every link of a deleted link type to its replacement', async () => {
      const created = await post('admin', '/api/v1/link-types', {
        name: 'Precedes',
        outward: 'precedes',
        inward: 'follows',
      });
      const precedes = created.json().linkType.id as number;
      const a = await create('alice', 'ABC', 'First');
      const b = await create('alice', 'ABC', 'Second');
      const c = await create('alice', 'XYZ', 'Third');
      await link('alice', a, b, 'Precedes');
      await link('alice', a, c, 'Precedes');
      // This pair is already linked by the replacement: it keeps one link.
      await link('alice', a, c, 'Relates');

      const refused = await del('admin', `/api/v1/link-types/${precedes}`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'in_use', linkCount: 2 });
      const copies = await typeId('Copies');
      expect((await del('admin', `/api/v1/link-types/${copies}`)).json()).toEqual({
        error: 'copy_type',
      });
      const relates = await typeId('Relates');
      const res = await del('admin', `/api/v1/link-types/${precedes}?replacementId=${relates}`);
      expect(res.statusCode, res.body).toBe(204);
      expect(await readLinks('alice', a)).toEqual([`relates to ${b.key}`, `relates to ${c.key}`]);
      expect(await readLinks('alice', b)).toEqual([`relates to ${a.key}`]);
      expect((await history(b, 'link')).at(-1)).toMatchObject({
        from: { display: `follows ${a.key}` },
        to: { display: `relates to ${a.key}` },
      });
      expect((await linkTypes()).some((t) => t.name === 'Precedes')).toBe(false);
    });

    it('[CORE-018] turns ticket links off for the workspace and on again', async () => {
      const a = await create('alice', 'ABC', 'Linked before');
      const b = await create('alice', 'ABC', 'Linked after');
      await link('alice', a, b, 'Duplicates');
      expect((await put('alice', '/api/v1/link-policy', { enabled: false })).statusCode).toBe(403);
      expect((await put('admin', '/api/v1/link-policy', { enabled: false })).json()).toEqual({
        enabled: false,
      });
      expect((await get('alice', '/api/v1/link-types')).json().enabled).toBe(false);
      expect((await link('alice', b, a, 'Blocks')).json()).toEqual({ error: 'links_disabled' });
      // Existing links stay.
      expect(await readLinks('alice', a)).toEqual([`duplicates ${b.key}`]);
      await put('admin', '/api/v1/link-policy', { enabled: true });
      expect((await link('alice', b, a, 'Blocks')).statusCode).toBe(201);
    });

    it('[CORE-018] loads a ticket with 1,000 links in under 300 ms', async () => {
      await newTrack('BIG');
      const hub = await create('alice', 'BIG', 'Hub');
      const type = await database.db
        .selectFrom('track as t')
        .innerJoin('type_set as s', 's.id', 't.type_set_id')
        .select('s.default_type_id')
        .where('t.id', '=', tracks.BIG as number)
        .executeTakeFirstOrThrow();
      await database.db.executeQuery(
        sql`INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary,
              requester_id, creator_id, rank)
            SELECT 1, ${tracks.BIG}, g + 1, ${type.default_type_id}, 'Spoke ' || g,
                   ${users.alice?.id}, ${users.alice?.id}, 'zzzz' || lpad(g::text, 6, '0')
              FROM generate_series(1, 1000) g`.compile(database.db),
      );
      await database.db.executeQuery(
        sql`UPDATE ticket_counter SET last_number = 1001 WHERE track_id = ${tracks.BIG}`.compile(
          database.db,
        ),
      );
      const relates = await typeId('Relates');
      const blocks = await typeId('Blocks');
      // Half point out from the hub, half point in.
      await database.db.executeQuery(
        sql`INSERT INTO ticket_link (workspace_id, link_type_id, source_id, target_id)
            SELECT 1, CASE WHEN k.number % 2 = 0 THEN ${relates}::int ELSE ${blocks}::int END,
                   CASE WHEN k.number % 2 = 0 THEN ${hub.id}::int ELSE k.id END,
                   CASE WHEN k.number % 2 = 0 THEN k.id ELSE ${hub.id}::int END
              FROM ticket k WHERE k.track_id = ${tracks.BIG} AND k.id <> ${hub.id}`.compile(
          database.db,
        ),
      );
      await database.db.executeQuery(sql`ANALYZE ticket_link`.compile(database.db));
      await linksOf('alice', hub);
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        const { links } = await linksOf('alice', hub);
        times.push(performance.now() - started);
        expect(links).toHaveLength(1000);
      }
      times.sort((x, y) => x - y);
      expectWithinBudget(times[2] as number, 300, 'ticket with 1,000 links, median (ms)');
    }, 60_000);
  });

  describe('web links', () => {
    it('[CORE-018] keeps one web link per global id and finds tickets by it', async () => {
      const ticket = await create('alice', 'ABC', 'Has a pull request');
      const url = `/api/v1/tickets/${ticket.id}/web-links`;
      const added = await post('alice', url, {
        url: 'https://example.com/pr/7',
        title: 'Pull request 7',
        iconUrl: 'https://example.com/icon.svg',
        relationship: 'fixed by',
        globalId: 'example:pr:7',
      });
      expect(added.statusCode, added.body).toBe(201);
      // The same global id again updates that link.
      const again = await post('alice', url, {
        url: 'https://example.com/pr/7',
        title: 'Pull request 7 (merged)',
        globalId: 'example:pr:7',
      });
      expect(again.statusCode).toBe(200);
      expect(again.json().webLink).toMatchObject({
        id: added.json().webLink.id,
        title: 'Pull request 7 (merged)',
        iconUrl: null,
      });
      await post('alice', url, { url: 'http://example.com/docs', title: 'Design notes' });
      expect((await linksOf('bob', ticket)).webLinks.map((w) => w.title)).toEqual([
        'Pull request 7 (merged)',
        'Design notes',
      ]);
      for (const bad of ['javascript:alert(1)', 'ftp://example.com/x', 'not a url']) {
        expect((await post('alice', url, { url: bad, title: 'Bad' })).statusCode).toBe(400);
      }
      expect((await post('bob', url, { url: 'https://example.com', title: 'x' })).statusCode).toBe(
        403,
      );

      const found = await get('alice', '/api/v1/web-links?globalId=example:pr:7');
      expect(found.json().tickets).toEqual([
        expect.objectContaining({ id: ticket.id, key: ticket.key }),
      ]);
      expect(
        (await get('eve', '/api/v1/web-links?globalId=example:pr:7')).json().tickets,
      ).toHaveLength(1);
      const id = added.json().webLink.id;
      expect((await patch('alice', `${url}/${id}`, { relationship: 'closes' })).statusCode).toBe(
        200,
      );
      expect((await del('alice', `${url}/${id}`)).statusCode).toBe(204);
      expect(
        (await get('alice', '/api/v1/web-links?globalId=example:pr:7')).json().tickets,
      ).toEqual([]);
      expect((await history(ticket, 'webLink')).map((c) => [c.from.display, c.to.display])).toEqual(
        [
          [null, 'Pull request 7'],
          ['Pull request 7', 'Pull request 7 (merged)'],
          [null, 'Design notes'],
          ['Pull request 7 (merged)', null],
        ],
      );
      // Events name fields, never URLs, which can carry tokens.
      const events = await database.db
        .selectFrom('domain_event')
        .select('payload')
        .where('type', 'in', ['ticket.web_link_added', 'ticket.web_link_updated'])
        .execute();
      expect(JSON.stringify(events)).not.toContain('example.com');
    });
  });

  describe('followers and votes', () => {
    it('[CORE-019] toggles following and voting; lists need "View voters and followers"', async () => {
      const ticket = await create('alice', 'ABC', 'Popular');
      const followers = `/api/v1/tickets/${ticket.id}/followers`;
      // Creating followed it (auto-follow is on by default).
      expect((await get('alice', followers)).json()).toEqual({
        count: 1,
        mine: true,
        people: [{ id: users.alice?.id, name: 'alice' }],
      });
      expect((await put('bob', `${followers}/me`)).statusCode).toBe(204);
      expect((await put('bob', `${followers}/me`)).statusCode).toBe(204);
      expect((await put('eve', `${followers}/me`)).statusCode).toBe(204);
      // Eve sees the count, not the names.
      expect((await get('eve', followers)).json()).toEqual({ count: 3, mine: true, people: null });
      expect((await del('eve', `${followers}/me`)).statusCode).toBe(204);
      const toggled = await database.db
        .selectFrom('domain_event')
        .select('type')
        .where('type', 'in', ['ticket.followed', 'ticket.unfollowed'])
        .where('subject_id', '=', String(ticket.id))
        .orderBy('id')
        .execute();
      expect(toggled.map((e) => e.type)).toEqual([
        'ticket.followed',
        'ticket.followed',
        'ticket.unfollowed',
      ]);

      // Others' following needs "Manage followers", and someone who may see the ticket.
      expect((await put('eve', `${followers}/${users.dave?.id}`)).json()).toEqual({
        error: 'forbidden',
        permission: 'manage_followers',
      });
      expect((await put('alice', `${followers}/${users.dave?.id}`)).statusCode).toBe(204);
      expect((await put('alice', `${followers}/999999`)).statusCode).toBe(400);

      const votes = `/api/v1/tickets/${ticket.id}/votes`;
      for (const who of ['alice', 'bob', 'eve']) {
        expect((await put(who, votes)).statusCode).toBe(204);
      }
      await put('bob', votes);
      expect((await del('bob', votes)).statusCode).toBe(204);
      expect((await get('eve', votes)).json()).toEqual({ count: 2, mine: true, people: null });
      expect((await get('bob', votes)).json().people.map((p: Named) => p.name)).toEqual([
        'alice',
        'eve',
      ]);
      const view = ticketOf(await get('eve', `/api/v1/tickets/${ticket.id}`));
      expect([view.followerCount, view.voteCount]).toEqual([3, 2]);
    });

    it('[CORE-019] follows what one creates or edits, unless one turns it off', async () => {
      const ticket = await create('alice', 'ABC', 'Auto');
      const followers = `/api/v1/tickets/${ticket.id}/followers`;
      expect(
        (await patch('dave', `/api/v1/tickets/${ticket.id}`, { summary: 'Edited' })).statusCode,
      ).toBe(200);
      expect((await get('alice', followers)).json().people.map((p: Named) => p.name)).toEqual([
        'alice',
        'dave',
      ]);
      expect((await get('dave', '/api/v1/account/preferences')).json()).toEqual({
        preferences: { autoFollow: true, csvSeparator: null },
      });
      expect(
        (await patch('dave', '/api/v1/account/preferences', { autoFollow: false })).json(),
      ).toEqual({ preferences: { autoFollow: false, csvSeparator: null } });
      const other = await create('dave', 'ABC', 'Not followed');
      expect((await get('dave', `/api/v1/tickets/${other.id}/followers`)).json().count).toBe(0);
    });

    it('[IAM-008] [NFR-006] keeps how one’s CSV files are written, automatic until chosen (T-263)', async () => {
      const preferences = '/api/v1/account/preferences';
      const eventsOf = async (who: number) =>
        (
          await database.db
            .selectFrom('domain_event')
            .select('payload')
            .where('type', '=', 'user.preferences_updated')
            .where('subject_id', '=', String(who))
            .orderBy('id')
            .execute()
        ).map((e) => e.payload);
      expect((await get('eve', preferences)).json()).toEqual({
        preferences: { autoFollow: true, csvSeparator: null },
      });
      expect((await patch('eve', preferences, { csvSeparator: 'semicolon' })).json()).toEqual({
        preferences: { autoFollow: true, csvSeparator: 'semicolon' },
      });
      // Another setting leaves the choice as it is; null goes back to automatic.
      expect((await patch('eve', preferences, { autoFollow: false })).json()).toEqual({
        preferences: { autoFollow: false, csvSeparator: 'semicolon' },
      });
      expect((await patch('eve', preferences, { csvSeparator: null })).json()).toEqual({
        preferences: { autoFollow: false, csvSeparator: null },
      });
      // The same value again changes nothing and records nothing.
      await patch('eve', preferences, { csvSeparator: null });
      expect(await eventsOf(users.eve?.id as number)).toEqual([
        { changes: { csvSeparator: { from: null, to: 'semicolon' } } },
        { changes: { autoFollow: { from: true, to: false } } },
        { changes: { csvSeparator: { from: 'semicolon', to: null } } },
      ]);
      for (const wrong of [{ csvSeparator: 'tab' }, { csvSeparator: ';' }, { other: 1 }]) {
        expect((await patch('eve', preferences, wrong)).statusCode, JSON.stringify(wrong)).toBe(
          400,
        );
      }
    });

    it('[CORE-019] has no cap on followers or voters', async () => {
      const ticket = await create('alice', 'ABC', 'Crowded');
      await database.db.executeQuery(
        sql`INSERT INTO app_user (workspace_id, email, name)
            SELECT 1, 'crowd' || g || '@example.com', 'Crowd ' || g
              FROM generate_series(1, 2000) g`.compile(database.db),
      );
      for (const table of ['ticket_follower', 'ticket_vote']) {
        await database.db.executeQuery(
          sql`INSERT INTO ${sql.table(table)} (workspace_id, ticket_id, user_id)
              SELECT 1, ${ticket.id}, id FROM app_user WHERE email LIKE 'crowd%'`.compile(
            database.db,
          ),
        );
      }
      const view = ticketOf(await get('alice', `/api/v1/tickets/${ticket.id}`));
      expect([view.followerCount, view.voteCount]).toEqual([2001, 2000]);
      expect((await put('bob', `/api/v1/tickets/${ticket.id}/votes`)).statusCode).toBe(204);
      expect((await get('bob', `/api/v1/tickets/${ticket.id}/votes`)).json().count).toBe(2001);
    });
  });
});
