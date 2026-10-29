import { appendFileSync } from 'node:fs';
import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { type Kysely, sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { Authorizer } from '../authz/authorizer';
import type { TicketFilter } from '../authz/visibility';
import { FieldCatalogs } from '../fields/catalog';
import { queryCatalogue } from './catalogue';
import { prepareSearch } from './run';

/**
 * Query functions at size (M1-038; QRY-004): 200,000 tickets over 20 tracks, 2,000 people, a
 * member who works in half the tracks and follows 20,000 tickets, 120,000 follows, 400,000
 * changes, 100,000 links, 20,000 web links and a group of 667 people. Each function query's
 * first page (with the member's permission filter) is timed, binding included; a ticket set is
 * a semi-join, so a person's 20,000 follows cost no list of ids. Measured on 2026-10-29, p95 of
 * 20: see the progress row of M1-038. Run with (the report goes to TASKMOOR_SEARCH_REPORT)
 *   TASKMOOR_LARGE_FUNCTIONS=1 pnpm verify --only=tests -- apps/server/src/search/functions.large.test.ts
 */
const TICKETS = 200_000;
const TRACKS = 20;
const USERS = 2_000;
const RUNS = 20;
/** Each first page, at p95; ten times the slowest measured, so a busy machine does not decide. */
const BUDGET_MS = 1_000;
const p95 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] as number;

describe.skipIf(!process.env.TASKMOOR_LARGE_FUNCTIONS)('query functions at size (M1-038)', () => {
  const database = useMigratedDatabase();
  let db: Kysely<Database>;
  let member = 0;
  let other = 0;
  let linkedKey = '';
  let filter: TicketFilter;

  beforeAll(async () => {
    db = database.db;
    await sql`INSERT INTO app_user (workspace_id, email, name)
      SELECT 1, 'p' || g || '@example.com', 'Person ' || lpad(g::text, 4, '0')
        FROM generate_series(1, ${USERS}) AS g`.execute(db);
    member = (
      await db
        .selectFrom('app_user')
        .select('id')
        .where('email', '=', 'p1@example.com')
        .executeTakeFirstOrThrow()
    ).id;
    other = member + 1;
    await sql`INSERT INTO track (workspace_id, key, name, access_policy_id, type_set_id)
      SELECT 1, 'T' || lpad(g::text, 2, '0'), 'Track ' || g,
             (SELECT id FROM access_policy WHERE workspace_id = 1 AND is_default),
             (SELECT type_set_id FROM type_set_default WHERE workspace_id = 1 AND track_type = 'software')
        FROM generate_series(1, ${TRACKS}) AS g`.execute(db);
    await sql`INSERT INTO track_role_actor (workspace_id, track_id, role_id, user_id)
      SELECT 1, t.id, (SELECT id FROM role WHERE name = 'Members'), ${member}
        FROM track t WHERE t.key LIKE 'T%' AND substr(t.key, 2)::int % 2 = 1`.execute(db);
    await sql`
      WITH t AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM track WHERE key LIKE 'T%'),
           ty AS (SELECT id FROM ticket_type WHERE owner_track_id IS NULL AND name = 'Bug')
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, assignee_id,
        creator_id, rank, created_at, updated_at)
      SELECT 1, t.id, g / ${TRACKS} + 1, (SELECT id FROM ty), 'Ticket ' || g,
             ${member} + (g * 31) % ${USERS}, ${member} + (g * 17) % ${USERS},
             'r' || lpad(g::text, 8, '0'),
             timestamptz '2024-01-01' + g * interval '5 minutes',
             timestamptz '2024-01-01' + g * interval '5 minutes' + ((g * 7919) % 2000) * interval '1 hour'
        FROM generate_series(0, ${TICKETS - 1}) AS g
        JOIN t ON t.n = g % ${TRACKS}`.execute(db);
    await sql`UPDATE ticket k SET parent_id = k.id - 1 WHERE k.id % 10 = 0
      AND EXISTS (SELECT 1 FROM ticket p WHERE p.id = k.id - 1)`.execute(db);
    // Others follow every even ticket; the member every tenth ticket of each track.
    await sql`INSERT INTO ticket_follower (workspace_id, ticket_id, user_id)
      SELECT 1, id, ${member} + 1 + (id * 11) % (${USERS} - 1) FROM ticket WHERE id % 2 = 0`.execute(
      db,
    );
    await sql`INSERT INTO ticket_follower (workspace_id, ticket_id, user_id)
      SELECT 1, id, ${member} FROM ticket WHERE number % 10 = 0`.execute(db);
    await sql`INSERT INTO ticket_vote (workspace_id, ticket_id, user_id)
      SELECT 1, id, ${member} FROM ticket WHERE id % 100 = 3`.execute(db);
    await sql`INSERT INTO ticket_visit (workspace_id, user_id, ticket_id, visited_at)
      SELECT 1, ${member}, id, now() - id * interval '1 minute' FROM ticket WHERE id % 4000 = 7`.execute(
      db,
    );
    await sql`INSERT INTO ticket_change (workspace_id, ticket_id, change_set, at, actor_id, field)
      SELECT 1, k.id, k.id * 2 + c, k.updated_at - c * interval '1 hour',
             ${member} + (k.id * 7 + c * 13) % ${USERS}, 'summary'
        FROM ticket k, generate_series(0, 1) AS c`.execute(db);
    await sql`INSERT INTO ticket_link (workspace_id, link_type_id, source_id, target_id)
      SELECT 1, (SELECT id FROM link_type WHERE name = 'Blocks'), k.id, n.id
        FROM ticket k JOIN ticket n ON n.track_id = k.track_id AND n.number = k.number + 1
       WHERE k.number % 2 = 1`.execute(db);
    await sql`INSERT INTO ticket_web_link (workspace_id, ticket_id, url, title, global_id)
      SELECT 1, id, 'https://ci.example.com/' || id, 'Build', 'g-' || id % 1000
        FROM ticket WHERE id % 10 = 5`.execute(db);
    await sql`INSERT INTO user_group (workspace_id, name) VALUES (1, 'Thousand')`.execute(db);
    await sql`INSERT INTO group_member (workspace_id, group_id, user_id)
      SELECT 1, (SELECT id FROM user_group WHERE name = 'Thousand'), id
        FROM app_user WHERE email LIKE 'p%@example.com' AND id % 3 = 0`.execute(db);
    linkedKey = (
      await sql<{ key: string }>`SELECT t.key || '-' || k.number AS key FROM ticket k
        JOIN track t ON t.id = k.track_id
       WHERE substr(t.key, 2)::int % 2 = 1 AND k.number % 2 = 0 ORDER BY k.id LIMIT 1`.execute(db)
    ).rows[0]?.key as string;
    for (const table of [
      'ticket',
      'ticket_follower',
      'ticket_vote',
      'ticket_visit',
      'ticket_change',
      'ticket_link',
      'ticket_web_link',
      'group_member',
      'app_user',
    ]) {
      await sql`VACUUM ANALYZE ${sql.table(table)}`.execute(db);
    }
    filter = await new Authorizer(db).ticketFilter(1, { userId: member });
  }, 600_000);

  it('[QRY-004] answers each function on the first page within budget', async () => {
    const catalogs = new FieldCatalogs(db);
    const catalog = await catalogs.get(1);
    const catalogue = await queryCatalogue(db, 1, catalog, filter.tracks);
    const queries = [
      'key IN followedTickets() ORDER BY created DESC',
      'key IN votedTickets() ORDER BY updated DESC',
      'key IN ticketHistory()',
      'parent IN watchedIssues() ORDER BY created DESC',
      'key NOT IN followedTickets() ORDER BY created DESC',
      `key IN updatedBy(${other})`,
      `key IN updatedBy(${other}, "2024-06-01", "2024-09-01")`,
      `key IN linkedTickets(${linkedKey})`,
      `key IN linkedTickets(${linkedKey}, "blocks")`,
      'assignee IN membersOf(Thousand) ORDER BY updated DESC',
      'key IN ticketsWithWebLinksByGlobalId("g-15")',
      'track IN tracksWhereUserHasRole(Members) ORDER BY created DESC',
      'created >= startOfMonth(-1M) AND key IN followedTickets()',
    ];
    const report: string[] = [];
    for (const q of queries) {
      const samples: number[] = [];
      let found = 0;
      for (let i = 0; i < RUNS; i++) {
        const started = performance.now();
        const { compiled } = await prepareSearch({
          db,
          workspaceId: 1,
          catalog,
          catalogue,
          filter,
          q,
          currentUserId: member,
          now: new Date('2026-01-01T00:00:00Z'),
        });
        found = (await compiled.page(50).execute(db)).rows.length;
        samples.push(performance.now() - started);
      }
      report.push(`${p95(samples).toFixed(1).padStart(8)} ms  ${String(found).padStart(3)}  ${q}`);
      expect(p95(samples), q).toBeLessThan(BUDGET_MS);
    }
    const file = process.env.TASKMOOR_SEARCH_REPORT;
    if (file) appendFileSync(file, `p95 of ${RUNS}\n${report.join('\n')}\n`);
  }, 600_000);
});
