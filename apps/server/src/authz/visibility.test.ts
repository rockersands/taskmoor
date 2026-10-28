import { useMigratedDatabase } from '@taskmoor/db/testing';
import { fc } from '@taskmoor/testkit/property';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { Authorizer, type Principal } from './authorizer';
import { TICKET_GRANTEES, type TicketAccessRow } from './visibility';

/**
 * The two readings of who sees a ticket (M1-020): `ticketPermissions`, which judges one row in
 * memory, and the predicate lists put in their statement. For random level members, ticket-level
 * browse grants and tickets, both name the same tickets for every person, anonymous included.
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
});

describe('visibility predicate and per-ticket check (M1-020)', () => {
  const database = useMigratedDatabase();
  const ws = 1;
  const users: number[] = [];
  const groups: number[] = [];
  const roles: number[] = [];
  const tracks: number[] = [];
  const levels: number[] = [];
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
    // u3 is deactivated: like an anonymous visitor, only "anyone" opens anything to them.
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
    const shared = await db
      .selectFrom('access_policy')
      .select('id')
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    // The desk's policy: Viewers browse, and the run decides which ticket grantees do too.
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

  it('[IAM-011] [QRY-008] the list predicate and the per-ticket check name the same tickets', async () => {
    const db = database.db;
    let number = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uniqueArray(memberArb, { selector: (m) => `${m.grantee}:${m.index}` }), {
          minLength: 3,
          maxLength: 3,
        }),
        fc.subarray([...TICKET_GRANTEES]),
        fc.array(ticketArb, { minLength: 6, maxLength: 6 }),
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
          await db.deleteFrom('ticket').execute();
          const ids: number[] = [];
          for (const t of ticketSpecs) {
            const fields: Record<string, unknown> = {};
            if (t.reviewers.length > 0) {
              fields[String(userField)] = t.reviewers.map((r) => users[r]).sort();
            }
            if (t.team !== null) fields[String(groupField)] = groups[t.team];
            const { rows } = await sql<{ id: number }>`
              INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, rank,
                                  requester_id, assignee_id, fields, visibility_level_id)
              VALUES (${ws}, ${tracks[t.track]}, ${++number}, ${typeId}, 'Ticket',
                      ${`r${String(number).padStart(8, '0')}`},
                      ${t.requester === null ? null : users[t.requester]},
                      ${t.assignee === null ? null : users[t.assignee]},
                      ${JSON.stringify(fields)}::jsonb,
                      ${t.level < 0 ? null : levels[t.level]})
              RETURNING id`.execute(db);
            ids.push(rows[0]?.id as number);
          }
          const rows: TicketAccessRow[] = await db
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
          const principals: Principal[] = [
            { userId: null },
            ...users.map((userId) => ({ userId })),
          ];
          for (const principal of principals) {
            const listed = await authorizer.visibleTicketIds(ws, principal, ids);
            const judged = new Set<number>();
            for (const row of rows) {
              if ((await authorizer.ticketPermissions(ws, principal, row)).has('browse_track')) {
                judged.add(row.id);
              }
            }
            expect([...listed].sort(), `user ${principal.userId}`).toEqual([...judged].sort());
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
