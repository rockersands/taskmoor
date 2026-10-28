import { useMigratedDatabase } from '@taskmoor/db/testing';
import { fc } from '@taskmoor/testkit/property';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { Authorizer } from '../authz/authorizer';
import { bootstrapTrack, changesSince, logPosition, syncTracks, trimChangeLog } from './log';

/**
 * The change log of ADR-013 (M1-031). Random writes (creates, edits, level changes, moves,
 * trash, membership changes) interleave with three replicas that bootstrap and follow; at the
 * end each replica holds exactly the tickets its person may see, as they are, and no replica
 * ever received a ticket its person may not see. Who may see what comes from a plain model of
 * the test's memberships, not from the authorization service.
 */
type Op =
  | { kind: 'create'; track: number; private: boolean }
  | { kind: 'edit'; ticket: number }
  | { kind: 'level'; ticket: number; private: boolean }
  | { kind: 'move'; ticket: number }
  | { kind: 'trash'; ticket: number; deleted: boolean }
  | { kind: 'member'; on: boolean }
  | { kind: 'sync'; person: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('create' as const),
    track: fc.integer({ min: 0, max: 1 }),
    private: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('edit' as const), ticket: fc.nat() }),
  fc.record({ kind: fc.constant('level' as const), ticket: fc.nat(), private: fc.boolean() }),
  fc.record({ kind: fc.constant('move' as const), ticket: fc.nat() }),
  fc.record({ kind: fc.constant('trash' as const), ticket: fc.nat(), deleted: fc.boolean() }),
  fc.record({ kind: fc.constant('member' as const), on: fc.boolean() }),
  fc.record({ kind: fc.constant('sync' as const), person: fc.integer({ min: 0, max: 2 }) }),
);

interface Replica {
  tickets: Map<number, Record<string, unknown>>;
  position: string;
}

describe('change log and sync groups (M1-031)', () => {
  const database = useMigratedDatabase();
  const ws = 1;
  const people: number[] = [];
  let policyId = 0;
  let membersRole = 0;
  let viewersRole = 0;
  let typeId = 0;
  let level = 0;
  let round = 0;

  beforeAll(async () => {
    const db = database.db;
    for (const name of ['sync-u1', 'sync-u2', 'sync-u3']) {
      const row = await db
        .insertInto('app_user')
        .values({ workspace_id: ws, email: `${name}@example.com`, name })
        .returning('id')
        .executeTakeFirstOrThrow();
      people.push(row.id);
    }
    policyId = (
      await db
        .selectFrom('access_policy')
        .select('id')
        .where('is_default', '=', true)
        .executeTakeFirstOrThrow()
    ).id;
    const roles = await db.selectFrom('role').select(['id', 'name']).execute();
    membersRole = roles.find((r) => r.name === 'Members')?.id as number;
    viewersRole = roles.find((r) => r.name === 'Viewers')?.id as number;
    typeId = (await db.selectFrom('ticket_type').select('id').executeTakeFirstOrThrow()).id;
    // One level, seen by u1 only.
    const vp = await db
      .insertInto('visibility_policy')
      .values({ workspace_id: ws, name: 'Sync private' })
      .returning('id')
      .executeTakeFirstOrThrow();
    level = (
      await db
        .insertInto('visibility_level')
        .values({ workspace_id: ws, policy_id: vp.id, name: 'Private', position: 0 })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('visibility_member')
      .values({ workspace_id: ws, level_id: level, grantee: 'user', user_id: people[0] as number })
      .execute();
  });

  it('[NTF-008] replicas converge and never receive a ticket their person may not see', async () => {
    const db = database.db;
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 5, maxLength: 30 }), async (ops) => {
        round++;
        // Two fresh tracks: u1 works in both, u2 in A (and in B when the run says so), u3
        // views B.
        const tracks: number[] = [];
        for (const key of [`SA${round}`, `SB${round}`]) {
          const row = await db
            .insertInto('track')
            .values({ workspace_id: ws, key, name: key, access_policy_id: policyId })
            .returning('id')
            .executeTakeFirstOrThrow();
          tracks.push(row.id);
        }
        const [a, b] = tracks as [number, number];
        const [u1, u2, u3] = people as [number, number, number];
        await db
          .insertInto('track_role_actor')
          .values([
            { workspace_id: ws, track_id: a, role_id: membersRole, user_id: u1 },
            { workspace_id: ws, track_id: b, role_id: membersRole, user_id: u1 },
            { workspace_id: ws, track_id: a, role_id: membersRole, user_id: u2 },
            { workspace_id: ws, track_id: b, role_id: viewersRole, user_id: u3 },
          ])
          .execute();
        let u2InB = false;

        /** The reference: who may see a ticket, from the test's own memberships. */
        const browses = (person: number, track: number) =>
          (track === a && (person === u1 || person === u2)) ||
          (track === b && (person === u1 || person === u3 || (person === u2 && u2InB)));
        const mine = (person: number, data: Record<string, unknown>) =>
          !tracks.includes(Number(data.track_id)) ||
          (browses(person, Number(data.track_id)) &&
            data.deleted_at == null &&
            (data.visibility_level_id == null || person === u1));

        const authorizer = new Authorizer(db);
        const created: number[] = [];
        const replicas: Replica[] = [];

        async function bootstrap(person: number): Promise<Replica> {
          const replica: Replica = { tickets: new Map(), position: '' };
          for (const track of await syncTracks(db, authorizer, ws, { userId: person })) {
            let after = 0;
            for (;;) {
              const page = await bootstrapTrack(db, authorizer, ws, { userId: person }, track.id, {
                after,
                limit: 7,
              });
              if (!page) break;
              if (replica.position === '' || BigInt(page.position) < BigInt(replica.position)) {
                replica.position = page.position;
              }
              for (const t of page.tickets) replica.tickets.set(Number(t.id), t);
              if (page.next === null) break;
              after = page.next;
            }
          }
          if (replica.position === '') replica.position = await logPosition(db, ws);
          return replica;
        }

        async function follow(index: number): Promise<void> {
          const person = people[index] as number;
          let replica = replicas[index] as Replica;
          for (;;) {
            const got = await changesSince(
              db,
              authorizer,
              ws,
              { userId: person },
              {
                after: replica.position,
                limit: 5,
              },
            );
            let rebootstrap = got.resync;
            for (const change of got.changes) {
              if (change.entity === 'authz') rebootstrap = true;
              if (change.entity !== 'ticket') continue;
              if (change.op === 'upsert') {
                const data = change.data as Record<string, unknown>;
                // Never a ticket the person may not see (the reference decides).
                if (tracks.includes(Number(data.track_id))) {
                  expect(
                    browses(person, Number(data.track_id)) &&
                      (data.visibility_level_id == null || person === u1),
                    `person ${person} got ticket ${change.id}`,
                  ).toBe(true);
                }
                if (data.deleted_at == null) replica.tickets.set(change.id, data);
                else replica.tickets.delete(change.id);
              } else {
                replica.tickets.delete(change.id);
              }
            }
            if (rebootstrap) {
              replica = await bootstrap(person);
              replicas[index] = replica;
              continue;
            }
            const done = got.position === replica.position;
            replica.position = got.position;
            if (done || got.changes.length === 0) return;
          }
        }

        for (const [i] of people.entries()) replicas[i] = await bootstrap(people[i] as number);

        /** The next number in a track, from its counter, as the application takes it. */
        const nextNumber = async (track: number) => {
          const { rows } = await sql<{ n: number }>`
            INSERT INTO ticket_counter (track_id, workspace_id, last_number)
            VALUES (${track}, ${ws}, 1)
            ON CONFLICT (track_id) DO UPDATE SET last_number = ticket_counter.last_number + 1
            RETURNING last_number AS n`.execute(db);
          return rows[0]?.n as number;
        };
        const pick = (n: number) =>
          created.length === 0 ? null : (created[n % created.length] as number);
        for (const op of ops) {
          switch (op.kind) {
            case 'create': {
              const track = tracks[op.track] as number;
              const { rows } = await sql<{ id: number }>`
                INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, rank,
                                    visibility_level_id)
                VALUES (${ws}, ${track}, ${await nextNumber(track)}, ${typeId}, 'New',
                        'r' || nextval('ticket_rank_seq'), ${op.private ? level : null})
                RETURNING id`.execute(db);
              created.push(rows[0]?.id as number);
              break;
            }
            case 'edit': {
              const id = pick(op.ticket);
              if (id !== null) {
                await sql`UPDATE ticket SET summary = 'Edited ' || ${String(op.ticket)}
                  WHERE id = ${id}`.execute(db);
              }
              break;
            }
            case 'level': {
              const id = pick(op.ticket);
              if (id !== null) {
                await sql`UPDATE ticket SET visibility_level_id = ${op.private ? level : null}
                  WHERE id = ${id}`.execute(db);
              }
              break;
            }
            case 'move': {
              const id = pick(op.ticket);
              if (id !== null) {
                const now = await db
                  .selectFrom('ticket')
                  .select('track_id')
                  .where('id', '=', id)
                  .executeTakeFirstOrThrow();
                const to = now.track_id === a ? b : a;
                await sql`UPDATE ticket SET track_id = ${to}, number = ${await nextNumber(to)}
                  WHERE id = ${id}`.execute(db);
              }
              break;
            }
            case 'trash': {
              const id = pick(op.ticket);
              if (id !== null) {
                await sql`UPDATE ticket SET deleted_at = ${op.deleted ? new Date() : null}
                  WHERE id = ${id}`.execute(db);
              }
              break;
            }
            case 'member':
              if (op.on && !u2InB) {
                await db
                  .insertInto('track_role_actor')
                  .values({ workspace_id: ws, track_id: b, role_id: membersRole, user_id: u2 })
                  .execute();
                u2InB = true;
              } else if (!op.on && u2InB) {
                await db
                  .deleteFrom('track_role_actor')
                  .where('track_id', '=', b)
                  .where('user_id', '=', u2)
                  .execute();
                u2InB = false;
              }
              break;
            case 'sync':
              await follow(op.person);
              break;
          }
        }

        // Caught up, every replica equals the truth for its person.
        for (const [i, person] of people.entries()) {
          await follow(i);
          const truth = await bootstrap(person);
          const replica = replicas[i] as Replica;
          const view = (r: Replica) =>
            [...r.tickets.entries()]
              .filter(([, t]) => tracks.includes(Number(t.track_id)))
              .map(([id, t]) => `${id}:${t.track_id}:${t.summary}:${t.visibility_level_id}`)
              .sort();
          expect(view(replica), `person ${person}`).toEqual(view(truth));
          for (const t of replica.tickets.values()) expect(mine(person, t)).toBe(true);
        }
        // Nobody works in this round's tracks any more: the next round starts clean.
        await db.deleteFrom('track_role_actor').where('track_id', 'in', tracks).execute();
      }),
      { numRuns: 15 },
    );
    // Fifteen rounds of up to thirty writes and three replicas: more than the default timeout.
  }, 300_000);

  it('[NTF-008] numbers rows in commit order and trims the log, asking old positions to resync', async () => {
    const db = database.db;
    const before = await logPosition(db, ws);
    // A transaction that writes first but commits last still gets the higher number.
    let releaseSlow: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slow = db.transaction().execute(async (trx) => {
      await sql`UPDATE track SET name = name || '.' WHERE id = (SELECT min(id) FROM track)`.execute(
        trx,
      );
      await gate;
    });
    await sql`UPDATE track SET name = name || ',' WHERE id = (SELECT max(id) FROM track)`.execute(
      db,
    );
    releaseSlow();
    await slow;
    const rows = await db
      .selectFrom('change_log')
      .select(['seq', 'entity_id', 'id'])
      .where('entity', '=', 'track')
      .where('seq', '>', before)
      .orderBy('seq')
      .execute();
    expect(rows).toHaveLength(2);
    // The row written first (lower id) committed last, so it has the higher sequence.
    expect(BigInt(rows[0]?.id as string) > BigInt(rows[1]?.id as string)).toBe(true);
    // Trimming everything older than the retention moves the floor.
    const removed = await trimChangeLog(db, ws, new Date(Date.now() + 400 * 24 * 3600 * 1000));
    expect(removed).toBeGreaterThan(0);
    const stale = await changesSince(
      db,
      new Authorizer(db),
      ws,
      { userId: people[0] as number },
      {
        after: '0',
        limit: 10,
      },
    );
    expect(stale.resync).toBe(true);
  });
});
