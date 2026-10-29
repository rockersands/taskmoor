import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

/** Generated per run: no credential is kept in the repository. */
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.78.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

/** Four people, each let into one or two levels by a different kind of member; and the admin. */
const PEOPLE = ['admin', 'alice', 'bob', 'dave', 'erin'] as const;
type Person = (typeof PEOPLE)[number];
const LEVELS = ['Alice only', 'Support', 'Administrators', 'Requester', 'Reviewer'] as const;

/**
 * The visibility matrix of QRY-008 (2) through search (M1-037): five visibility levels (a user,
 * a nested group, a track role, the requester, a user field) and four people, every query form
 * the compiler has (plain, driven from a side table, counted, paged, ordered by a subquery),
 * and the level predicate in the statement an administrator is shown.
 */
describe('search and visibility levels (M1-037, QRY-008)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  const tickets: Record<string, number> = {};

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
    const trackId = track.json().track.id as number;
    const members = await roleId('Members');
    for (const who of ['alice', 'bob', 'dave', 'erin'] as const) {
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
    const reviewer = await as('admin', {
      method: 'POST',
      url: '/api/v1/fields',
      payload: { name: 'Reviewer', type: 'user' },
    });
    const reviewerId = reviewer.json().field.id as number;
    const kind = await as('admin', {
      method: 'POST',
      url: '/api/v1/fields',
      payload: { name: 'Kind', type: 'select', context: { options: [{ value: 'Matrix' }] } },
    });
    expect(kind.statusCode, kind.body).toBe(201);
    const kindId = kind.json().field.id as number;
    const matrix = (
      await database.db
        .selectFrom('field_option')
        .select('id')
        .where('field_id', '=', kindId)
        .executeTakeFirstOrThrow()
    ).id;
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
          { name: 'Reviewer', members: [{ grantee: 'user_field', fieldKey: `cf[${reviewerId}]` }] },
        ],
      },
    });
    expect(policy.statusCode, policy.body).toBe(201);
    const levels = Object.fromEntries(
      (policy.json().visibilityPolicy.levels as { id: number; name: string }[]).map((l) => [
        l.name,
        l.id,
      ]),
    );
    const used = await as('admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${trackId}`,
      payload: { visibilityPolicyId: policy.json().visibilityPolicy.id },
    });
    expect(used.statusCode, used.body).toBe(200);
    const create = async (name: string, extra: Record<string, unknown> = {}) => {
      const res = await as('dave', {
        method: 'POST',
        url: '/api/v1/tickets',
        payload: {
          track: 'VIS',
          summary: `Matrix ${name}`,
          labels: ['matrix'],
          ...extra,
          fields: { [kindId]: matrix, ...((extra.fields as object) ?? {}) },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      tickets[name] = res.json().ticket.id;
    };
    await create('open');
    for (const name of LEVELS) {
      if (name === 'Requester') await create(name, { requesterId: users.erin.id });
      else if (name === 'Reviewer') await create(name, { fields: { [reviewerId]: users.bob.id } });
      else await create(name);
      const levelled = await as('dave', {
        method: 'PATCH',
        url: `/api/v1/tickets/${tickets[name]}`,
        payload: { visibilityLevelId: levels[name] },
      });
      expect(levelled.statusCode, levelled.body).toBe(200);
    }
  });
  afterAll(async () => {
    await app.close();
  });

  /** The matrix: the site administrator created the track, so holds its Administrators role. */
  const EXPECTED: Record<Person, string[]> = {
    admin: ['open', 'Administrators'],
    alice: ['open', 'Alice only'],
    bob: ['open', 'Support', 'Reviewer'],
    dave: ['open', 'Administrators'],
    erin: ['open', 'Requester'],
  };

  const found = async (who: Person | null, q: string, extra = '&limit=50') => {
    const res = await as(who, {
      method: 'GET',
      url: `/api/v1/search?q=${encodeURIComponent(q)}${extra}`,
    });
    expect(res.statusCode, `${who} ${q}: ${res.body}`).toBe(200);
    const body = res.json() as {
      tickets: { id: number }[];
      total?: { count: number };
      next: string | null;
    };
    const byId = new Map(Object.entries(tickets).map(([name, id]) => [id, name]));
    return {
      names: body.tickets.map((t) => byId.get(t.id) ?? `#${t.id}`).sort(),
      total: body.total?.count,
      next: body.next,
    };
  };

  it('[QRY-008] five levels and four people: every query form returns exactly what each sees', async () => {
    const queries = [
      '',
      'track = VIS ORDER BY created ASC',
      'labels = matrix',
      'summary ~ matrix ORDER BY priority DESC, key ASC',
      // Driven from the Kind field's side table.
      'Kind = Matrix ORDER BY created DESC',
      'NOT summary ~ nothing AND visibilityLevel IS NOT EMPTY OR visibilityLevel IS EMPTY',
    ];
    for (const who of PEOPLE) {
      const expected = [...EXPECTED[who]].sort();
      for (const q of queries) {
        const { names, total } = await found(who, q);
        expect(names, `${who}: ${q}`).toEqual(expected);
        // Counts see no more than the results (QRY-008 (1)).
        expect(total, `${who}: ${q} count`).toBe(expected.length);
      }
      // A page at a time, the cursor never reaches a hidden ticket.
      const paged: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await found(
          who,
          'Kind = Matrix',
          `&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        );
        paged.push(...page.names);
        cursor = page.next;
      } while (cursor);
      expect(paged.sort(), `${who} paged`).toEqual(expected);
    }
    // Naming a hidden level or a hidden ticket's reviewer reveals nothing.
    expect((await found('alice', 'visibilityLevel = Support')).names).toEqual([]);
    expect((await found('alice', `Reviewer = ${users.bob.id}`)).names).toEqual([]);
    expect((await found('bob', `Reviewer = ${users.bob.id}`)).names).toEqual(['Reviewer']);
    expect((await found('erin', `requester = ${users.erin.id}`)).names).toEqual(['Requester']);
    expect((await found('alice', `requester = ${users.erin.id}`)).names).toEqual([]);
    // Visitors who are not signed in see nothing here.
    expect((await found(null, '')).names).toEqual([]);
  });

  it('[QRY-008] a hidden ticket named by key or id reads like one that does not exist', async () => {
    // A visible child of the ticket only Alice sees, and a visible ticket linked to it.
    const hidden = tickets['Alice only'] as number;
    const { key } = await database.db
      .selectFrom('ticket')
      .innerJoin('track', 'track.id', 'ticket.track_id')
      .select(sql<string>`track.key || '-' || ticket.number`.as('key'))
      .where('ticket.id', '=', hidden)
      .executeTakeFirstOrThrow();
    for (const name of ['child', 'linked']) {
      const res = await as('dave', {
        method: 'POST',
        url: '/api/v1/tickets',
        payload: { track: 'VIS', summary: `Hidden-key ${name}` },
      });
      expect(res.statusCode, res.body).toBe(201);
      tickets[name] = res.json().ticket.id;
    }
    await database.db
      .updateTable('ticket')
      .set({ parent_id: hidden })
      .where('id', '=', tickets.child as number)
      .execute();
    const relates = await database.db
      .selectFrom('link_type')
      .select('id')
      .where('workspace_id', '=', 1)
      .orderBy('id')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('ticket_link')
      .values({
        workspace_id: 1,
        link_type_id: relates.id,
        source_id: tickets.linked as number,
        target_id: hidden,
      })
      .execute();

    const search = async (who: Person, q: string) => {
      const res = await as(who, {
        method: 'GET',
        url: `/api/v1/search?q=${encodeURIComponent(q)}&limit=50`,
      });
      expect(res.statusCode, `${who} ${q}: ${res.body}`).toBe(200);
      const body = res.json() as { tickets: { id: number }[]; warnings?: string[] };
      const byId = new Map(Object.entries(tickets).map(([name, id]) => [id, name]));
      return {
        names: body.tickets.map((t) => byId.get(t.id) ?? `#${t.id}`).sort(),
        warnings: (body.warnings ?? []).map((w) =>
          w.replace(key, '<key>').replace('VIS-99999', '<key>'),
        ),
      };
    };
    // Alice sees the ticket, so she sees what hangs off it.
    expect((await search('alice', `parent = ${key}`)).names).toEqual(['child']);
    expect((await search('alice', `ticketLink = ${key}`)).names).toEqual(['linked']);
    expect((await search('alice', `parent = ${hidden}`)).names).toEqual(['child']);
    // To Bob it is as absent as a key that was never used: no match and the same warning.
    for (const field of ['key', 'parent', 'ticketLink']) {
      const named = await search('bob', `${field} = ${key}`);
      const unknown = await search('bob', `${field} = VIS-99999`);
      expect(named.names, `bob ${field}`).toEqual([]);
      expect(named.warnings, `bob ${field} warnings`).toEqual(unknown.warnings);
      expect(named.warnings.length, `bob ${field} warns`).toBe(1);
    }
    expect((await search('bob', `parent = ${hidden}`)).names).toEqual([]);
    expect((await search('bob', `parent in (${key}, VIS-99999)`)).names).toEqual([]);
  });

  it('[QRY-008] shows the permission and level predicate in the statement', async () => {
    const res = await as('admin', {
      method: 'GET',
      url: `/api/v1/admin/search/explain?q=${encodeURIComponent('Kind = Matrix')}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { sql: string; anchored: boolean };
    expect(body.anchored).toBe(true);
    expect(body.sql).toContain('k.visibility_level_id IS NULL');
    expect(body.sql).toContain('k.visibility_level_id = ANY(');
    expect(body.sql).toContain('FROM v_option a JOIN ticket k ON k.id = a.ticket_id');
  });
});
