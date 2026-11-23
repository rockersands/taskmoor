import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `ids-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.87.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

const H = 3_600_000;
const PEOPLE = ['admin', 'member'] as const;
type Person = (typeof PEOPLE)[number];

interface Group {
  id: string | null;
  name: string | null;
  kind: 'value' | 'none' | 'other';
  total: number;
  query: string | null;
  tickets: { id: number }[];
}

/**
 * Names that look like ids (T-359; QRY-002, RPT-002): a release or an area may be named like
 * another's id in another track, a team like another team's id, and a local-mode track's ticket
 * type like a shared one. A bare number is an id before a name, a quoted one a name before an id,
 * as `crossTrackRelease` reads them (PLN-007); so a grouped report's search for one of its groups,
 * which names a release, an area, a team or a type by id, finds that group and nothing else, and
 * lists it in the report's order. An option's text may be another option's id: an option is read
 * by its text before its id, and a group names its option so that the search finds it alone.
 */
describe('a bare number names one release, area, team or ticket type; an option is its text first', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  const tracks: Record<string, number> = {};
  const t: Record<string, number> = {};
  const ids = { release: 0, numbered: 0, area: 0, team: 0, sharedBug: 0, localBug: 0, local: 0 };
  let crew = 0;
  let severity = 0;
  /** The Severity field's options, in the order they were made. */
  let sev: number[] = [];
  let dashboard = 0;

  const as = (who: Person, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who].cookie },
    });
  const call = async (who: Person, options: InjectOptions, code = 200) => {
    const res = await as(who, options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body}`).toBe(code);
    return res.json();
  };
  /** The tickets a search finds as the member, by name, in the search's order. */
  const found = async (q: string) => {
    const res = await call('member', {
      method: 'GET',
      url: `/api/v1/search?q=${encodeURIComponent(q)}&limit=200&count=true`,
    });
    expect(res.total.exact, q).toBe(true);
    const byId = new Map(Object.entries(t).map(([name, id]) => [id, name]));
    return (res.tickets as { id: number }[]).map((x) => byId.get(x.id) ?? `#${x.id}`);
  };
  const groups = async (widget: string) =>
    (
      await call('member', {
        method: 'GET',
        url: `/api/v1/dashboards/${dashboard}/widgets/${widget}`,
      })
    ).data.values as Group[];

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
      const header = res.headers['set-cookie'];
      const list = Array.isArray(header) ? header : header ? [header] : [];
      users[name] = {
        id: row.id,
        cookie:
          (
            list.find(
              (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
            ) ?? ''
          ).split(';')[0] ?? '',
      };
    }
    const members = (
      await database.db
        .selectFrom('role')
        .select('id')
        .where('name', '=', 'Members')
        .executeTakeFirstOrThrow()
    ).id;
    // GA uses the shared ticket types; GB is a local-mode track with types of its own.
    for (const [key, mode] of [
      ['GA', 'shared'],
      ['GB', 'local'],
    ] as const) {
      tracks[key] = (
        await call(
          'admin',
          { method: 'POST', url: '/api/v1/tracks', payload: { key, name: key, mode } },
          201,
        )
      ).track.id;
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: tracks[key] as number,
          role_id: members,
          user_id: users.member.id,
        })
        .execute();
    }
    const release = async (track: string, name: string) =>
      (
        await call(
          'admin',
          { method: 'POST', url: `/api/v1/tracks/${tracks[track]}/releases`, payload: { name } },
          201,
        )
      ).release.id as number;
    const area = async (track: string, name: string) =>
      (
        await call(
          'admin',
          { method: 'POST', url: `/api/v1/tracks/${tracks[track]}/areas`, payload: { name } },
          201,
        )
      ).area.id as number;
    const team = async (name: string) =>
      (await call('admin', { method: 'POST', url: '/api/v1/teams', payload: { name } }, 201)).team
        .id as number;
    // Each of GB's is named after the id of GA's.
    ids.release = await release('GA', 'One');
    const shadowRelease = await release('GB', String(ids.release));
    ids.numbered = await release('GB', '900000007');
    ids.area = await area('GA', 'Core');
    const shadowArea = await area('GB', String(ids.area));
    ids.team = await team('Alpha');
    const shadowTeam = await team(String(ids.team));
    crew = (
      await call(
        'admin',
        { method: 'POST', url: '/api/v1/fields', payload: { name: 'Crew', type: 'team' } },
        201,
      )
    ).field.id;
    // A select whose texts are numbers, with options of its own in GB: the first and third are
    // named after each other's id, the second and fourth (GB's) differ only in case, and the
    // fifth is named after the fourth's id.
    type Context = { id: number; trackIds: number[] | null; options: { id: number }[] };
    severity = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/fields',
          payload: {
            name: 'Severity',
            type: 'select',
            context: { options: ['a', 'b', 'c'].map((value) => ({ value })) },
          },
        },
        201,
      )
    ).field.id;
    const contexts = (
      await call(
        'admin',
        {
          method: 'POST',
          url: `/api/v1/fields/${severity}/contexts`,
          payload: {
            name: 'GB',
            trackIds: [tracks.GB],
            options: ['d', 'e'].map((value) => ({ value })),
          },
        },
        201,
      )
    ).field.contexts as Context[];
    const everywhere = contexts.find((c) => c.trackIds === null);
    const inGB = contexts.find((c) => c.trackIds?.includes(tracks.GB as number));
    if (!everywhere || !inGB) throw new Error('no contexts');
    sev = [...everywhere.options, ...inGB.options].map((o) => o.id);
    const [s0, s1, s2, s3, s4] = sev as [number, number, number, number, number];
    for (const [context, option, value] of [
      [everywhere, s0, String(s2)],
      [everywhere, s1, 'Major'],
      [everywhere, s2, String(s0)],
      [inGB, s3, 'major'],
      [inGB, s4, String(s3)],
    ] as const) {
      await call('admin', {
        method: 'PATCH',
        url: `/api/v1/fields/${severity}/contexts/${context.id}/options/${option}`,
        payload: { value },
      });
    }
    const shared = (await call('admin', { method: 'GET', url: '/api/v1/tracks/GA/ticket-types' }))
      .ticketTypes as { id: number; name: string; level: { id: number; rank: number } }[];
    const bug = shared.find((x) => x.name === 'Bug');
    if (!bug) throw new Error('no shared Bug type');
    ids.sharedBug = bug.id;
    const localType = async (name: string) =>
      (
        await call(
          'admin',
          {
            method: 'POST',
            url: '/api/v1/ticket-types',
            payload: { name, levelId: bug.level.id, trackId: tracks.GB },
          },
          201,
        )
      ).ticketType.id as number;
    ids.localBug = await localType('Bug');
    ids.local = await localType(String(ids.sharedBug));

    const create = async (name: string, track: string, body: Record<string, unknown> = {}) => {
      t[name] = (
        await call(
          'admin',
          {
            method: 'POST',
            url: '/api/v1/tickets',
            payload: { track, summary: name, ticketTypeId: ids.sharedBug, ...body },
          },
          201,
        )
      ).ticket.id;
    };
    await create('ga1', 'GA', {
      targetReleaseIds: [ids.release],
      areaIds: [ids.area],
      fields: { [String(crew)]: ids.team, [String(severity)]: s0 },
    });
    await create('ga2', 'GA', { fields: { [String(severity)]: s2 } });
    await create('ga3', 'GA', { fields: { [String(severity)]: s1 } });
    await create('gb1', 'GB', {
      targetReleaseIds: [shadowRelease],
      areaIds: [shadowArea],
      fields: { [String(crew)]: shadowTeam, [String(severity)]: s3 },
    });
    await create('gb2', 'GB', {
      targetReleaseIds: [ids.numbered],
      fields: { [String(severity)]: s4 },
    });
    // GB's tickets take its own types; its type set is not what this test is about.
    await database.db
      .updateTable('ticket')
      .set({ ticket_type_id: ids.localBug })
      .where('id', '=', t.gb1 as number)
      .execute();
    await database.db
      .updateTable('ticket')
      .set({ ticket_type_id: ids.local })
      .where('id', '=', t.gb2 as number)
      .execute();
    // Made in name order, updated in another: ga1, then ga3, then ga2.
    const now = Date.now();
    for (const [name, hours] of [
      ['ga1', 1],
      ['ga3', 2],
      ['ga2', 3],
      ['gb1', 4],
      ['gb2', 5],
    ] as const) {
      await sql`UPDATE ticket SET updated_at = ${new Date(now - hours * H)}
                 WHERE id = ${t[name] as number}`.execute(database.db);
    }
    const query = 'track IN (GA, GB)';
    dashboard = (
      await call(
        'member',
        {
          method: 'POST',
          url: '/api/v1/dashboards',
          payload: {
            name: 'Groups',
            layout: 'three',
            widgets: [
              { id: 'type', kind: 'group-by', config: { query, field: 'type', limit: 2 } },
              { id: 'release', kind: 'group-by', config: { query, field: 'targetRelease' } },
              { id: 'area', kind: 'group-by', config: { query, field: 'area' } },
              { id: 'crew', kind: 'group-by', config: { query, field: `cf[${crew}]` } },
              { id: 'severity', kind: 'group-by', config: { query, field: `cf[${severity}]` } },
            ],
          },
        },
        201,
      )
    ).dashboard.id;
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('[QRY-002] reads a bare number as an id before a name, and a quoted one as a name before an id (T-359)', async () => {
    expect(await found(`targetRelease = ${ids.release}`)).toEqual(['ga1']);
    expect(await found(`targetRelease = "${ids.release}"`)).toEqual(['gb1']);
    expect(await found(`fixVersion IN (${ids.release})`)).toEqual(['ga1']);
    // A comparison names the release it starts from the same way: GA's One, or GB's releases
    // from the one named after One's id.
    expect(await found(`targetRelease >= ${ids.release}`)).toEqual(['ga1']);
    expect((await found(`targetRelease >= "${ids.release}"`)).sort()).toEqual(['gb1', 'gb2']);
    expect(await found(`area = ${ids.area}`)).toEqual(['ga1']);
    expect(await found(`component = "${ids.area}"`)).toEqual(['gb1']);
    expect(await found(`Crew = ${ids.team}`)).toEqual(['ga1']);
    expect(await found(`Crew = "${ids.team}"`)).toEqual(['gb1']);
    expect((await found(`type = ${ids.sharedBug}`)).sort()).toEqual(['ga1', 'ga2', 'ga3']);
    expect(await found(`issuetype = "${ids.sharedBug}"`)).toEqual(['gb2']);
    // A name still names every type called so, shared or local.
    expect((await found('type = Bug')).sort()).toEqual(['ga1', 'ga2', 'ga3', 'gb1']);
    // A bare number nobody has as an id is still read as a name, as before.
    expect(await found('targetRelease = 900000007')).toEqual(['gb2']);
  });

  it('[RPT-002] a grouped report’s search finds each group and nothing else, in the report’s order: a local type apart from the shared one of its name (T-359)', async () => {
    for (const widget of ['type', 'release', 'area', 'crew']) {
      const values = await groups(widget);
      const seen = new Set<string>();
      for (const v of values) {
        const listed = await found(v.query as string);
        expect(listed.length, `${widget} ${v.query}`).toBe(v.total);
        // Its first tickets are the ones the group lists, most recently updated first.
        const byId = new Map(Object.entries(t).map(([name, id]) => [id, name]));
        expect(listed.slice(0, v.tickets.length), `${widget} ${v.query}`).toEqual(
          v.tickets.map((x) => byId.get(x.id)),
        );
        // No ticket is in two groups of a field with one value per ticket.
        for (const name of listed) {
          expect(seen.has(name), `${widget}: ${name} twice`).toBe(false);
          seen.add(name);
        }
      }
    }
    const types = await groups('type');
    const shared = types.find((v) => v.id === String(ids.sharedBug));
    expect(shared?.query).toBe(
      `track IN (GA, GB) AND type = ${ids.sharedBug} ORDER BY updated DESC`,
    );
    expect(await found(shared?.query as string)).toEqual(['ga1', 'ga3', 'ga2']);
    expect(shared?.tickets.map((x) => x.id)).toEqual([t.ga1, t.ga3]);
    const local = types.find((v) => v.id === String(ids.localBug));
    expect(local?.name).toBe('Bug');
    expect(await found(local?.query as string)).toEqual(['gb1']);
  });

  it('[QRY-002] reads an option by its text before its id, so a text that is another option’s id names its own option (T-359)', async () => {
    const [s0, s1, s2, s3] = sev as [number, number, number, number];
    // s0's text is s2's id and s2's is s0's: each names its own option, bare or quoted.
    expect(await found(`Severity = ${s2}`)).toEqual(['ga1']);
    expect(await found(`cf[${severity}] = "${s0}"`)).toEqual(['ga2']);
    // A number no option has as its text is still an id.
    expect(await found(`Severity = ${s1}`)).toEqual(['ga3']);
    // A text names every option that has it, in any case.
    expect((await found('Severity = MAJOR')).sort()).toEqual(['ga3', 'gb1']);
    expect(await found(`Severity IN choiceOption(${s3})`)).toEqual(['gb2']);
  });

  it('[RPT-002] a grouped report’s search names an option so that it finds that group only, or no search where none can (S3-ST-2, T-359)', async () => {
    const [s0, s1, s2, s3, s4] = sev as [number, number, number, number, number];
    const values = await groups('severity');
    expect(values.map((v) => v.id).sort()).toEqual([s0, s1, s2, s3, s4].map(String).sort());
    const byOption = new Map(values.map((v) => [v.id, v]));
    const query = (option: number) => byOption.get(String(option))?.query;
    // By its text where that text is its own: s0's text is s2's id.
    expect(query(s0)).toBe(`track IN (GA, GB) AND cf[${severity}] = "${s2}" ORDER BY updated DESC`);
    // By its id where another option shares its text (Major and major).
    expect(query(s1)).toBe(`track IN (GA, GB) AND cf[${severity}] = ${s1} ORDER BY updated DESC`);
    // s3 shares its text with s1 and its id is s4's text: no search names it alone.
    expect(query(s3)).toBeNull();
    for (const [option, ticket] of [
      [s0, 'ga1'],
      [s1, 'ga3'],
      [s2, 'ga2'],
      [s4, 'gb2'],
    ] as const) {
      expect(await found(query(option) as string), `${option}: ${query(option)}`).toEqual([ticket]);
    }
  });
});
