import { useMigratedDatabase } from '@taskmoor/db/testing';
import { fc } from '@taskmoor/testkit/property';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { Authorizer, type Principal } from '../authz/authorizer';
import { TICKET_GRANTEES, type TicketAccessRow } from '../authz/visibility';
import { FieldCatalogs } from '../fields/catalog';
import { queryCatalogue } from './catalogue';
import { prepareSearch } from './run';

/**
 * The permission pre-filter in search statements against the per-ticket judgement (M1-037;
 * QRY-008): for random visibility-level members, ticket-level browse grants and tickets, every
 * form of statement the compiler writes (plain, driven from a side table, merged from value
 * branches, ordered by a subquery, counted) returns for each person exactly the tickets an
 * unrestricted run returns that `ticketPermissions` lets them browse, in the same order. The
 * world is the one of the M1-020 property test (`authz/visibility.test.ts`).
 */
const MEMBER_KINDS = [
  'anyone',
  'any_user',
  'user',
  'group',
  'track_owner',
  'role',
  'requester',
  'assignee',
  'user_field',
  'group_field',
] as const;
type Kind = (typeof MEMBER_KINDS)[number];
interface MemberSpec {
  grantee: Kind;
  index: number;
}
interface TicketSpec {
  track: number;
  level: number;
  requester: number | null;
  assignee: number | null;
  reviewers: number[];
  team: number | null;
  priority: number | null;
}

const memberArb: fc.Arbitrary<MemberSpec> = fc.record({
  grantee: fc.constantFrom(...MEMBER_KINDS),
  index: fc.integer({ min: 0, max: 3 }),
});
const personArb = fc.option(fc.integer({ min: 0, max: 3 }), { nil: null });
const ticketArb: fc.Arbitrary<TicketSpec> = fc.record({
  track: fc.integer({ min: 0, max: 1 }),
  level: fc.integer({ min: -1, max: 2 }),
  requester: personArb,
  assignee: personArb,
  reviewers: fc.uniqueArray(fc.integer({ min: 0, max: 3 }), { maxLength: 2 }),
  team: fc.option(fc.integer({ min: 0, max: 1 }), { nil: null }),
  priority: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
});

describe('search and the per-ticket judgement (M1-037)', () => {
  const database = useMigratedDatabase();
  const ws = 1;
  const users: number[] = [];
  const groups: number[] = [];
  const roles: number[] = [];
  const tracks: number[] = [];
  const levels: number[] = [];
  const priorities: number[] = [];
  let deskPolicy = 0;
  let userField = 0;
  let groupField = 0;
  let typeId = 0;

  beforeAll(async () => {
    const db = database.db;
    for (const name of ['u0', 'u1', 'u2', 'u3']) {
      const row = await db
        .insertInto('app_user')
        .values({ workspace_id: ws, email: `${name}@example.com`, name })
        .returning('id')
        .executeTakeFirstOrThrow();
      users.push(row.id);
    }
    await db
      .updateTable('app_user')
      .set({ deactivated_at: new Date() })
      .where('id', '=', users[3] as number)
      .execute();
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
    for (const r of await db.selectFrom('role').select('id').orderBy('id').execute()) {
      roles.push(r.id);
    }
    for (const p of await db.selectFrom('priority').select('id').orderBy('id').execute()) {
      priorities.push(p.id);
    }
    const shared = await db
      .selectFrom('access_policy')
      .select('id')
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    deskPolicy = (
      await db
        .insertInto('access_policy')
        .values({ workspace_id: ws, name: 'Desk' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('access_grant')
      .values({
        workspace_id: ws,
        policy_id: deskPolicy,
        permission: 'browse_track',
        grantee: 'role',
        role_id: roles[2] as number,
      })
      .execute();
    for (const [key, policy, owner] of [
      ['PA', shared.id, users[0]],
      ['PB', deskPolicy, users[2]],
    ] as const) {
      const row = await db
        .insertInto('track')
        .values({ workspace_id: ws, key, name: key, access_policy_id: policy, owner_id: owner })
        .returning('id')
        .executeTakeFirstOrThrow();
      tracks.push(row.id);
    }
    const [pa, pb] = tracks as [number, number];
    await db
      .insertInto('track_role_actor')
      .values([
        { workspace_id: ws, track_id: pa, role_id: roles[1] as number, user_id: users[0] },
        { workspace_id: ws, track_id: pa, role_id: roles[0] as number, user_id: users[2] },
        { workspace_id: ws, track_id: pb, role_id: roles[2] as number, group_id: g1 },
      ])
      .execute();
    for (const [name, type] of [
      ['Reviewers', 'user'],
      ['Team', 'group'],
    ] as const) {
      const row = await db
        .insertInto('field')
        .values({ workspace_id: ws, name, type, multiple: type === 'user', config: '{}' })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (type === 'user') userField = row.id;
      else groupField = row.id;
    }
    const policy = await db
      .insertInto('visibility_policy')
      .values({ workspace_id: ws, name: 'Levels' })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const position of [0, 1, 2]) {
      const row = await db
        .insertInto('visibility_level')
        .values({ workspace_id: ws, policy_id: policy.id, name: `L${position}`, position })
        .returning('id')
        .executeTakeFirstOrThrow();
      levels.push(row.id);
    }
    typeId = (await db.selectFrom('ticket_type').select('id').executeTakeFirstOrThrow()).id;
  });

  it('[QRY-008] [IAM-011] every statement form returns exactly the tickets each person may browse', async () => {
    const db = database.db;
    const catalogs = new FieldCatalogs(db);
    const queries = [
      // Plain, newest first.
      '',
      // Driven from the multiple user field's side table (one row per ticket kept).
      `cf[${userField}] IN (${users[0]}, ${users[1]})`,
      // Merged from one branch per priority, the empty one last.
      'ORDER BY priority DESC, key ASC',
      // Ordered by a subquery key, empties last, with OR and emptiness.
      'assignee IS EMPTY OR requester IS NOT EMPTY ORDER BY assignee ASC, updated ASC',
      // By the level itself: naming a level reveals nothing.
      `visibilityLevel = ${levels[0]} OR visibilityLevel IS EMPTY ORDER BY created ASC`,
    ];
    let number = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uniqueArray(memberArb, { selector: (m) => `${m.grantee}:${m.index}` }), {
          minLength: 3,
          maxLength: 3,
        }),
        fc.subarray([...TICKET_GRANTEES]),
        fc.array(ticketArb, { minLength: 8, maxLength: 8 }),
        async (memberSpecs, deskGrants, ticketSpecs) => {
          await db.deleteFrom('visibility_member').execute();
          for (const [i, specs] of memberSpecs.entries()) {
            const rows = new Map<string, Record<string, unknown>>();
            for (const m of specs) {
              const row = {
                workspace_id: ws,
                level_id: levels[i] as number,
                grantee: m.grantee,
                role_id: m.grantee === 'role' ? (roles[m.index % roles.length] as number) : null,
                group_id: m.grantee === 'group' ? (groups[m.index % 2] as number) : null,
                user_id: m.grantee === 'user' ? (users[m.index] as number) : null,
                field_key:
                  m.grantee === 'user_field'
                    ? `cf[${userField}]`
                    : m.grantee === 'group_field'
                      ? `cf[${groupField}]`
                      : null,
              };
              rows.set(JSON.stringify(row), row);
            }
            for (const row of rows.values()) {
              await db
                .insertInto('visibility_member')
                .values(row as never)
                .execute();
            }
          }
          await db
            .deleteFrom('access_grant')
            .where('policy_id', '=', deskPolicy)
            .where('grantee', 'in', [...TICKET_GRANTEES])
            .execute();
          for (const grantee of deskGrants) {
            await db
              .insertInto('access_grant')
              .values({
                workspace_id: ws,
                policy_id: deskPolicy,
                permission: 'browse_track',
                grantee,
                field_key:
                  grantee === 'user_field'
                    ? `cf[${userField}]`
                    : grantee === 'group_field'
                      ? `cf[${groupField}]`
                      : null,
              })
              .execute();
          }
          await db.deleteFrom('v_user').execute();
          await db.deleteFrom('ticket').execute();
          const ids: number[] = [];
          for (const [n, t] of ticketSpecs.entries()) {
            const fields: Record<string, unknown> = {};
            const reviewers = t.reviewers.map((r) => users[r] as number).sort((a, b) => a - b);
            if (reviewers.length > 0) fields[String(userField)] = reviewers;
            if (t.team !== null) fields[String(groupField)] = groups[t.team];
            const at = new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
            const { rows } = await sql<{ id: number }>`
              INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, rank,
                                  requester_id, assignee_id, fields, visibility_level_id,
                                  priority_id, created_at, updated_at)
              VALUES (${ws}, ${tracks[t.track]}, ${++number}, ${typeId}, 'Ticket',
                      ${`r${String(number).padStart(8, '0')}`},
                      ${t.requester === null ? null : users[t.requester]},
                      ${t.assignee === null ? null : users[t.assignee]},
                      ${JSON.stringify(fields)}::jsonb,
                      ${t.level < 0 ? null : levels[t.level]},
                      ${t.priority === null ? null : priorities[t.priority]},
                      ${at}::timestamptz, ${at}::timestamptz)
              RETURNING id`.execute(db);
            const id = rows[0]?.id as number;
            ids.push(id);
            // The side rows syncFieldValues writes for the user field (ADR-008).
            for (const reviewer of reviewers) {
              await db
                .insertInto('v_user')
                .values({
                  workspace_id: ws,
                  ticket_id: id,
                  track_id: tracks[t.track] as number,
                  field_id: userField,
                  value: reviewer,
                  created_at: at,
                })
                .execute();
            }
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
          const authorizer = new Authorizer(db);
          const catalog = await catalogs.get(ws);
          const run = async (
            q: string,
            filter: { sql: ReturnType<typeof sql<boolean>>; tracks: readonly number[] | 'all' },
            userId: number | null,
          ) => {
            const { compiled } = await prepareSearch({
              db,
              workspaceId: ws,
              catalog,
              catalogue: await queryCatalogue(db, ws, catalog, 'all'),
              filter,
              q,
              currentUserId: userId,
              now: new Date('2026-02-01T00:00:00Z'),
            });
            const page = (await compiled.page(100).execute(db)).rows.map((r) => r.id);
            const count = (await compiled.count(100).execute(db)).rows[0]?.n;
            return { page, count };
          };
          const everything = { sql: sql<boolean>`true`, tracks: 'all' as const };
          const principals: Principal[] = [
            { userId: null },
            ...users.map((userId) => ({ userId })),
          ];
          for (const principal of principals) {
            const judged = new Set<number>();
            for (const row of access) {
              if ((await authorizer.ticketPermissions(ws, principal, row)).has('browse_track')) {
                judged.add(row.id);
              }
            }
            const filter = await authorizer.ticketFilter(ws, principal);
            for (const q of queries) {
              const all = await run(q, everything, principal.userId);
              const expected = all.page.filter((id) => judged.has(id));
              const got = await run(q, filter, principal.userId);
              expect(got.page, `user ${principal.userId}: ${q}`).toEqual(expected);
              expect(got.count, `user ${principal.userId}: ${q} count`).toBe(expected.length);
            }
          }
        },
      ),
      { numRuns: 30 },
    );
    // Thirty worlds of eight tickets, five people and five queries: longer than the default.
  }, 180_000);
});
