import { useMigratedDatabase } from '@taskmoor/db/testing';
import { fc } from '@taskmoor/testkit/property';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { Authorizer, type Principal } from '../authz/authorizer';
import type { TicketAccessRow } from '../authz/visibility';
import { FieldCatalogs } from '../fields/catalog';
import { SearchError } from './bind';
import { queryCatalogue } from './catalogue';
import { prepareSearch } from './run';

/**
 * Query functions against the per-ticket judgement (M1-038; QRY-004, QRY-008): in random
 * worlds of tickets with visibility levels, parents, follows, votes, visits, links, changes,
 * comments (some shown to a group only) and web links, each function returns for each person
 * exactly the tickets a model of the world says it names, among those `ticketPermissions` lets
 * the person browse. A function never widens what a person sees: a ticket given as an argument
 * (`linkedTickets(X)`) or reached as a parent counts only when the person may see it, and a
 * comment only when they may read it.
 */
interface TicketSpec {
  track: number;
  level: number;
  assignee: number | null;
  creator: number | null;
  parent: number | null;
  followers: number[];
  voters: number[];
  visitors: number[];
  webLink: number | null;
}
interface LinkSpec {
  from: number;
  to: number;
  type: 0 | 1;
}
interface ChangeSpec {
  ticket: number;
  actor: number;
  day: number;
}
interface CommentSpec {
  ticket: number;
  author: number;
  day: number;
  group: number | null;
}
interface MemberSpec {
  level: number;
  grantee: 'user' | 'group' | 'any_user';
  index: number;
}

const someUsers = fc.uniqueArray(fc.integer({ min: 0, max: 2 }), { maxLength: 3 });
const ticketArb = (n: number): fc.Arbitrary<TicketSpec> =>
  fc.record({
    track: fc.integer({ min: 0, max: 1 }),
    level: fc.integer({ min: -1, max: 1 }),
    assignee: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
    creator: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
    parent:
      n === 0 ? fc.constant(null) : fc.option(fc.integer({ min: 0, max: n - 1 }), { nil: null }),
    followers: someUsers,
    voters: someUsers,
    visitors: someUsers,
    webLink: fc.option(fc.integer({ min: 1, max: 2 }), { nil: null }),
  });
const TICKETS = 8;
const worldArb = fc.record({
  tickets: fc.tuple(...Array.from({ length: TICKETS }, (_, i) => ticketArb(i))),
  links: fc
    .uniqueArray(
      fc.record({
        from: fc.integer({ min: 0, max: TICKETS - 1 }),
        to: fc.integer({ min: 0, max: TICKETS - 1 }),
        type: fc.constantFrom(0 as const, 1 as const),
      }),
      { maxLength: 8, selector: (l) => `${l.from}:${l.to}:${l.type}` },
    )
    .map((links) => links.filter((l) => l.from !== l.to)),
  changes: fc.array(
    fc.record({
      ticket: fc.integer({ min: 0, max: TICKETS - 1 }),
      actor: fc.integer({ min: 0, max: 2 }),
      day: fc.integer({ min: 1, max: 20 }),
    }),
    { maxLength: 6 },
  ),
  comments: fc.array(
    fc.record({
      ticket: fc.integer({ min: 0, max: TICKETS - 1 }),
      author: fc.integer({ min: 0, max: 2 }),
      day: fc.integer({ min: 1, max: 20 }),
      group: fc.option(fc.integer({ min: 0, max: 1 }), { nil: null }),
    }),
    { maxLength: 6 },
  ),
  members: fc.uniqueArray(
    fc.record({
      level: fc.integer({ min: 0, max: 1 }),
      grantee: fc.constantFrom('user' as const, 'group' as const, 'any_user' as const),
      index: fc.integer({ min: 0, max: 2 }),
    }),
    {
      maxLength: 4,
      selector: (m) =>
        `${m.level}:${m.grantee}:${m.grantee === 'any_user' ? 0 : m.index % (m.grantee === 'group' ? 2 : 3)}`,
    },
  ),
});

describe('query functions and the per-ticket judgement (M1-038)', () => {
  const database = useMigratedDatabase();
  const ws = 1;
  const users: number[] = [];
  const groups: number[] = [];
  const tracks: number[] = [];
  const levels: number[] = [];
  const linkTypes: number[] = [];
  let typeId = 0;

  beforeAll(async () => {
    const db = database.db;
    for (const name of ['u0', 'u1', 'u2']) {
      const row = await db
        .insertInto('app_user')
        .values({ workspace_id: ws, email: `${name}@example.com`, name })
        .returning('id')
        .executeTakeFirstOrThrow();
      users.push(row.id);
    }
    // g1 sits inside g0: u1 (in g1) is a member of both, u2 of g0 only.
    for (const name of ['g0', 'g1']) {
      const row = await db
        .insertInto('user_group')
        .values({ workspace_id: ws, name })
        .returning('id')
        .executeTakeFirstOrThrow();
      groups.push(row.id);
    }
    const [g0, g1] = groups as [number, number];
    await db
      .insertInto('group_nesting')
      .values({ workspace_id: ws, parent_id: g0, child_id: g1 })
      .execute();
    await db
      .insertInto('group_member')
      .values([
        { workspace_id: ws, group_id: g1, user_id: users[1] as number },
        { workspace_id: ws, group_id: g0, user_id: users[2] as number },
      ])
      .execute();
    // PA: the default policy (anyone signed in browses). PB: browsed only by group g1.
    const shared = await db
      .selectFrom('access_policy')
      .select('id')
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    const desk = await db
      .insertInto('access_policy')
      .values({ workspace_id: ws, name: 'Desk' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('access_grant')
      .values({
        workspace_id: ws,
        policy_id: desk.id,
        permission: 'browse_track',
        grantee: 'group',
        group_id: g1,
      })
      .execute();
    for (const [key, policy, owner] of [
      ['PA', shared.id, users[0]],
      ['PB', desk.id, users[2]],
    ] as const) {
      const row = await db
        .insertInto('track')
        .values({ workspace_id: ws, key, name: key, access_policy_id: policy, owner_id: owner })
        .returning('id')
        .executeTakeFirstOrThrow();
      tracks.push(row.id);
    }
    const policy = await db
      .insertInto('visibility_policy')
      .values({ workspace_id: ws, name: 'Levels' })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const position of [0, 1]) {
      const row = await db
        .insertInto('visibility_level')
        .values({ workspace_id: ws, policy_id: policy.id, name: `L${position}`, position })
        .returning('id')
        .executeTakeFirstOrThrow();
      levels.push(row.id);
    }
    for (const name of ['Blocks', 'Relates']) {
      const row = await db
        .selectFrom('link_type')
        .select('id')
        .where('workspace_id', '=', ws)
        .where('name', '=', name)
        .executeTakeFirstOrThrow();
      linkTypes.push(row.id);
    }
    typeId = (await db.selectFrom('ticket_type').select('id').executeTakeFirstOrThrow()).id;
  });

  it('[QRY-004] [QRY-008] every function returns exactly what it names among the tickets each person may browse', async () => {
    const db = database.db;
    const catalogs = new FieldCatalogs(db);
    const authorizer = new Authorizer(db);
    let number = 0;
    await fc.assert(
      fc.asyncProperty(worldArb, async (world) => {
        for (const table of [
          'ticket_follower',
          'ticket_vote',
          'ticket_visit',
          'ticket_link',
          'ticket_change',
          'ticket_comment',
          'ticket_web_link',
          'visibility_member',
        ] as const) {
          await db.deleteFrom(table).execute();
        }
        await db.updateTable('ticket').set({ parent_id: null }).execute();
        await db.deleteFrom('ticket').execute();
        for (const m of world.members) {
          await db
            .insertInto('visibility_member')
            .values({
              workspace_id: ws,
              level_id: levels[m.level] as number,
              grantee: m.grantee,
              user_id: m.grantee === 'user' ? (users[m.index] as number) : null,
              group_id: m.grantee === 'group' ? (groups[m.index % 2] as number) : null,
            })
            .execute();
        }
        const ids: number[] = [];
        const keys: string[] = [];
        for (const [n, t] of world.tickets.entries()) {
          const at = new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
          const { rows } = await sql<{ id: number; number: number }>`
            INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, rank,
                                assignee_id, creator_id, parent_id, visibility_level_id,
                                created_at, updated_at)
            VALUES (${ws}, ${tracks[t.track]}, ${++number}, ${typeId}, 'Ticket',
                    ${`r${String(number).padStart(8, '0')}`},
                    ${t.assignee === null ? null : users[t.assignee]},
                    ${t.creator === null ? null : users[t.creator]},
                    ${t.parent === null ? null : ids[t.parent]},
                    ${t.level < 0 ? null : levels[t.level]},
                    ${at}::timestamptz, ${at}::timestamptz)
            RETURNING id, number`.execute(db);
          const row = rows[0] as { id: number; number: number };
          ids.push(row.id);
          keys.push(`${t.track === 0 ? 'PA' : 'PB'}-${row.number}`);
          const people = (list: number[]) =>
            list.map((u) => ({ workspace_id: ws, ticket_id: row.id, user_id: users[u] as number }));
          if (t.followers.length > 0)
            await db.insertInto('ticket_follower').values(people(t.followers)).execute();
          if (t.voters.length > 0)
            await db.insertInto('ticket_vote').values(people(t.voters)).execute();
          if (t.visitors.length > 0)
            await db.insertInto('ticket_visit').values(people(t.visitors)).execute();
          if (t.webLink !== null) {
            await db
              .insertInto('ticket_web_link')
              .values({
                workspace_id: ws,
                ticket_id: row.id,
                url: `https://example.com/${t.webLink}`,
                title: 'Link',
                global_id: `g-${t.webLink}`,
              })
              .execute();
          }
        }
        for (const l of world.links) {
          await db
            .insertInto('ticket_link')
            .values({
              workspace_id: ws,
              link_type_id: linkTypes[l.type] as number,
              source_id: ids[l.from] as number,
              target_id: ids[l.to] as number,
            })
            .execute();
        }
        for (const [i, c] of world.changes.entries()) {
          await db
            .insertInto('ticket_change')
            .values({
              workspace_id: ws,
              ticket_id: ids[c.ticket] as number,
              change_set: String(i + 1),
              at: new Date(Date.UTC(2026, 0, c.day, 12)),
              actor_id: users[c.actor] as number,
              field: 'summary',
            })
            .execute();
        }
        for (const c of world.comments) {
          await db
            .insertInto('ticket_comment')
            .values({
              workspace_id: ws,
              ticket_id: ids[c.ticket] as number,
              author_id: users[c.author] as number,
              body: JSON.stringify({ type: 'doc', content: [] }),
              visible_group_id: c.group === null ? null : (groups[c.group] as number),
              created_at: new Date(Date.UTC(2026, 0, c.day, 12)),
            })
            .execute();
        }

        const access: TicketAccessRow[] = await db
          .selectFrom('ticket')
          .select([
            'id',
            'track_id',
            'requester_id',
            'assignee_id',
            'visibility_level_id',
            'fields',
          ])
          .where('id', 'in', ids)
          .execute();
        const catalog = await catalogs.get(ws);
        const catalogue = await queryCatalogue(db, ws, catalog, 'all');
        const x = 0;
        const linked = (a: number, b: number, type?: 0 | 1) =>
          world.links.some(
            (l) =>
              (type === undefined || l.type === type) &&
              ((l.from === a && l.to === b) || (l.from === b && l.to === a)),
          );
        const inDays = (day: number, from?: number, to?: number) =>
          (from === undefined || day >= from) && (to === undefined || day <= to);

        for (const userIndex of [null, 0, 1, 2]) {
          const principal: Principal = {
            userId: userIndex === null ? null : (users[userIndex] as number),
          };
          const sees = new Set<number>();
          for (const row of access) {
            if ((await authorizer.ticketPermissions(ws, principal, row)).has('browse_track')) {
              sees.add(row.id);
            }
          }
          const seen = (i: number) => sees.has(ids[i] as number);
          // Comments the person reads: open ones, their own, and those shown to a group they
          // are in (u1 is in g1 and, through it, g0; u2 in g0).
          const reads = (c: CommentSpec) =>
            c.group === null ||
            (userIndex !== null &&
              (c.author === userIndex || userIndex === 1 || (userIndex === 2 && c.group === 0)));
          // Changes (a ticket's creation is among them: its history holds every first value,
          // by its creator; these tickets are inserted without one) and comments it reads.
          const updatedBy = (i: number, actor: number, from?: number, to?: number) =>
            world.changes.some(
              (c) => c.ticket === i && c.actor === actor && inDays(c.day, from, to),
            ) ||
            world.comments.some(
              (c) => c.ticket === i && c.author === actor && inDays(c.day, from, to) && reads(c),
            );
          const me = userIndex as number;
          const filter = await authorizer.ticketFilter(ws, principal);
          const cases: [string, (i: number, t: TicketSpec) => boolean][] = [
            [`key IN linkedTickets(${keys[x]})`, (i) => seen(x) && linked(i, x)],
            [
              `key IN linkedIssues(${keys[x]}, "blocks")`,
              (i) => seen(x) && world.links.some((l) => l.type === 0 && l.from === x && l.to === i),
            ],
            [
              `key IN linkedTickets(${keys[x]}, "is blocked by", "relates to")`,
              (i) =>
                seen(x) &&
                (world.links.some((l) => l.type === 0 && l.from === i && l.to === x) ||
                  linked(i, x, 1)),
            ],
            ['key IN updatedBy(u1)', (i) => updatedBy(i, 1)],
            [
              'key IN updatedBy(membersOf(g0), "2026-01-03", "2026-01-10 23:59")',
              (i) => updatedBy(i, 1, 3, 10) || updatedBy(i, 2, 3, 10),
            ],
            ['assignee IN membersOf(g0)', (_, t) => t.assignee === 1 || t.assignee === 2],
            ['assignee NOT IN membersOf(g1)', (_, t) => t.assignee !== null && t.assignee !== 1],
            ['track IN tracksOwnedByUser(u2)', (_, t) => t.track === 1],
            ['key IN ticketsWithWebLinksByGlobalId("g-1")', (_, t) => t.webLink === 1],
          ];
          if (userIndex !== null) {
            cases.push(
              ['key IN followedTickets()', (_, t) => t.followers.includes(me)],
              ['key IN votedTickets()', (_, t) => t.voters.includes(me)],
              ['key NOT IN votedTickets()', (_, t) => !t.voters.includes(me)],
              ['issue IN issueHistory()', (_, t) => t.visitors.includes(me)],
              [
                'parent IN watchedIssues()',
                (_, t) =>
                  t.parent !== null &&
                  seen(t.parent) &&
                  (world.tickets[t.parent] as TicketSpec).followers.includes(me),
              ],
              [
                'parent NOT IN followedTickets()',
                (_, t) =>
                  t.parent !== null &&
                  !(
                    seen(t.parent) && (world.tickets[t.parent] as TicketSpec).followers.includes(me)
                  ),
              ],
              [
                `key IN (${keys[1]}, followedTickets()) OR key IN linkedTickets(${keys[x]})`,
                (i, t) => i === 1 || t.followers.includes(me) || (seen(x) && linked(i, x)),
              ],
              [
                'track IN tracksOwnedByUser()',
                (_, t) => (me === 0 ? t.track === 0 : me === 2 && t.track === 1),
              ],
            );
          }
          for (const [q, names] of cases) {
            const { compiled } = await prepareSearch({
              db,
              workspaceId: ws,
              catalog,
              catalogue,
              filter,
              q,
              currentUserId: principal.userId,
              now: new Date('2026-02-01T00:00:00Z'),
            });
            const got = (await compiled.page(100).execute(db)).rows.map((r) => r.id).sort();
            const count = (await compiled.count(100).execute(db)).rows[0]?.n;
            const expected = world.tickets
              .map((t, i) => (seen(i) && names(i, t) ? (ids[i] as number) : null))
              .filter((id): id is number => id !== null)
              .sort();
            expect(got, `user ${userIndex}: ${q}`).toEqual(expected);
            expect(count, `user ${userIndex}: ${q} (count)`).toBe(expected.length);
          }
        }
      }),
      { numRuns: Number(process.env.SEARCH_FUNCTION_RUNS ?? 20) },
    );
    // Twenty worlds of eight tickets, four people and up to seventeen queries.
  }, 180_000);

  it('[QRY-004] runs membersOf() on a group of 50,000 people', async () => {
    const db = database.db;
    const big = await db
      .insertInto('user_group')
      .values({ workspace_id: ws, name: 'Everyone else' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`
      INSERT INTO app_user (workspace_id, email, name)
      SELECT ${ws}, 'member' || n || '@example.com', 'Member ' || n FROM generate_series(1, 50000) n`.execute(
      db,
    );
    await sql`
      INSERT INTO group_member (workspace_id, group_id, user_id)
      SELECT ${ws}, ${big.id}, id FROM app_user WHERE email LIKE 'member%@example.com'`.execute(db);
    // A ticket assigned to one of them and one assigned to someone outside the group.
    await db.deleteFrom('ticket').execute();
    const member = await db
      .selectFrom('app_user')
      .select('id')
      .where('email', '=', 'member49999@example.com')
      .executeTakeFirstOrThrow();
    for (const [n, assignee] of [
      [1, member.id],
      [2, users[0] as number],
    ] as const) {
      await sql`
        INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, rank, assignee_id)
        VALUES (${ws}, ${tracks[0]}, ${100_000 + n}, ${typeId}, 'Ticket', ${`z${n}`}, ${assignee})`.execute(
        db,
      );
    }
    const catalog = await new FieldCatalogs(db).get(ws);
    const catalogue = await queryCatalogue(db, ws, catalog, 'all');
    const started = performance.now();
    const { compiled } = await prepareSearch({
      db,
      workspaceId: ws,
      catalog,
      catalogue,
      filter: { sql: sql<boolean>`true`, tracks: 'all' },
      q: '"assignee" IN membersOf("Everyone else") ORDER BY created DESC',
      currentUserId: users[0] as number,
    });
    const rows = (await compiled.page(50).execute(db)).rows;
    const ms = performance.now() - started;
    expect(rows).toHaveLength(1);
    const negated = await prepareSearch({
      db,
      workspaceId: ws,
      catalog,
      catalogue,
      filter: { sql: sql<boolean>`true`, tracks: 'all' },
      q: 'assignee NOT IN membersOf("Everyone else")',
      currentUserId: users[0] as number,
    });
    expect((await negated.compiled.page(50).execute(db)).rows).toHaveLength(1);
    if (process.env.TASKMOOR_SEARCH_MEASURE) console.info(`membersOf 50,000: ${ms.toFixed(0)} ms`);
  });

  it('[QRY-004] needs a signed-in person for the functions about them', async () => {
    const db = database.db;
    const catalog = await new FieldCatalogs(db).get(ws);
    const catalogue = await queryCatalogue(db, ws, catalog, 'all');
    const prepare = (q: string) =>
      prepareSearch({
        db,
        workspaceId: ws,
        catalog,
        catalogue,
        filter: { sql: sql<boolean>`true`, tracks: 'all' },
        q,
        currentUserId: null,
      });
    for (const q of [
      'key IN followedTickets()',
      'key IN ticketHistory()',
      'track IN tracksOwnedByUser()',
    ]) {
      await expect(prepare(q), q).rejects.toThrow(SearchError);
    }
  });
});
