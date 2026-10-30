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
 * History operators at size (M1-039; QRY-005): 200,000 tickets over 20 tracks (another size with
 * TASKMOOR_LARGE_HISTORY_TICKETS), 2,000 people, a member who works in half the tracks. Every
 * ticket starts as New with an assignee and a priority (its first values are history); four in
 * five start work, two in five go to review, three in five close, one in three is reassigned,
 * one in ten has its points changed twice, one in a thousand was Blocked once; one ticket has
 * 12,000 status changes. About 9 history rows a ticket.
 *
 * Each query is timed as the search route runs it on a first page: binding, the page of 50 and
 * the capped count (10,001), with the member's permission filter; p95 of 20. Spec budget (M1-039
 * done-when): p95 under 800 ms at 10M tickets, which this machine cannot hold; the measurements
 * of 2026-10-30 are in the progress row of M1-039. Run with (the report goes to
 * TASKMOOR_SEARCH_REPORT)
 *   TASKMOOR_LARGE_HISTORY=1 pnpm verify --only=tests -- apps/server/src/search/history.large.test.ts
 */
const TICKETS = Number(process.env.TASKMOOR_LARGE_HISTORY_TICKETS ?? 200_000);
const TRACKS = 20;
const USERS = 2_000;
const RUNS = 20;
/** The 10M budget, held here at a smaller size so a regression shows long before 10M. */
const BUDGET_MS = 800;
const p95 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] as number;

describe.skipIf(!process.env.TASKMOOR_LARGE_HISTORY)('history operators at size (M1-039)', () => {
  const database = useMigratedDatabase();
  let db: Kysely<Database>;
  let member = 0;
  let other = 0;
  let manyKey = '';
  let pointsBy = 0;
  let statusBy = 0;
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
    await sql`INSERT INTO status (workspace_id, name, stage, sort_order)
      VALUES (1, 'Blocked', 'active', 99)`.execute(db);
    await sql`INSERT INTO field (workspace_id, name, type) VALUES (1, 'Points', 'number')`.execute(
      db,
    );
    // Statuses as the history writes them: ids as text.
    const s = (name: string) => sql`(SELECT id::text FROM status WHERE name = ${name})`;
    await sql`
      WITH t AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM track WHERE key LIKE 'T%'),
           ty AS (SELECT id FROM ticket_type WHERE owner_track_id IS NULL AND name = 'Bug')
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, assignee_id,
        requester_id, creator_id, rank, created_at, updated_at)
      SELECT 1, t.id, g / ${TRACKS} + 1, (SELECT id FROM ty), 'Ticket ' || g,
             ${member} + (g * 31) % ${USERS}, ${member} + (g * 17) % ${USERS},
             ${member} + (g * 17) % ${USERS}, 'r' || lpad(g::text, 8, '0'),
             timestamptz '2024-01-01' + g * interval '5 minutes',
             timestamptz '2024-01-01' + g * interval '5 minutes' + ((g * 7919) % 2000) * interval '1 hour'
        FROM generate_series(0, ${TICKETS - 1}) AS g
        JOIN t ON t.n = g % ${TRACKS}`.execute(db);
    // First values, by the creator when the ticket was created.
    await sql`
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, at, actor_id, field, to_value, to_display)
      SELECT 1, k.id, k.id, k.created_at, k.creator_id, f.field,
             CASE f.field WHEN 'status' THEN ${s('New')} WHEN 'assignee' THEN k.assignee_id::text
                          ELSE (SELECT id::text FROM priority WHERE name = 'Normal') END,
             CASE f.field WHEN 'status' THEN 'New' WHEN 'assignee' THEN 'Person' ELSE 'Normal' END
        FROM ticket k, (VALUES ('status'), ('assignee'), ('priority')) AS f (field)`.execute(db);
    // Work: started a day later, reviewed after two, closed after three (by people in turn).
    const step = (
      condition: string,
      hours: number,
      from: ReturnType<typeof s>,
      to: ReturnType<typeof s>,
    ) =>
      sql`
        INSERT INTO ticket_change (workspace_id, ticket_id, change_set, at, actor_id, field,
                                   from_value, to_value)
        SELECT 1, k.id, nextval('ticket_change_set_seq'), k.created_at + ${hours} * interval '1 hour',
               ${member} + (k.id * 7 + ${hours}) % ${USERS}, 'status', ${from}, ${to}
          FROM ticket k WHERE ${sql.raw(condition)}`.execute(db);
    await step('k.id % 5 <> 0', 24, s('New'), s('Active'));
    await step('k.id % 5 IN (1, 2)', 48, s('Active'), s('In Review'));
    await step('k.id % 5 = 1', 60, s('In Review'), s('Active'));
    await step('k.id % 1000 = 9', 66, s('Active'), s('Blocked'));
    await step('k.id % 1000 = 9', 70, s('Blocked'), s('Active'));
    await step('k.id % 5 IN (1, 3, 4)', 72, s('Active'), s('Closed'));
    await step('k.id % 5 = 2', 72, s('In Review'), s('Closed'));
    // Reassignments, emptied once in a while; points set and changed for one in ten.
    await sql`
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, at, actor_id, field,
                                 from_value, to_value)
      SELECT 1, k.id, nextval('ticket_change_set_seq'), k.created_at + interval '30 hours',
             ${member} + (k.id * 11) % ${USERS}, 'assignee', k.assignee_id::text,
             CASE WHEN k.id % 9 = 0 THEN NULL ELSE (${member} + (k.id * 13) % ${USERS})::text END
        FROM ticket k WHERE k.id % 3 = 0`.execute(db);
    await sql`
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, at, actor_id, field,
                                 from_value, to_value)
      SELECT 1, k.id, nextval('ticket_change_set_seq'), k.created_at + c * interval '10 hours',
             ${member} + (k.id + c) % ${USERS}, 'cf[' || f.id || ']',
             CASE WHEN c = 1 THEN NULL ELSE '3' END, CASE WHEN c = 1 THEN '3' ELSE '5' END
        FROM ticket k, field f, generate_series(1, 2) AS c
       WHERE f.name = 'Points' AND k.id % 20 IN (3, 4)`.execute(db);
    // One ticket with 12,000 status changes after its review (QRY-005 (3)).
    const many = (
      await sql<{ id: number; key: string }>`SELECT k.id, t.key || '-' || k.number AS key
        FROM ticket k JOIN track t ON t.id = k.track_id
       WHERE substr(t.key, 2)::int % 2 = 1 AND k.id % 5 = 2 ORDER BY k.id LIMIT 1`.execute(db)
    ).rows[0] as { id: number; key: string };
    manyKey = many.key;
    await sql`
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, at, actor_id, field,
                                 from_value, to_value)
      SELECT 1, ${many.id}, nextval('ticket_change_set_seq'),
             timestamptz '2025-06-01' + g * interval '1 minute', ${other}, 'status',
             CASE WHEN g = 1 THEN ${s('Closed')} WHEN g % 2 = 0 THEN ${s('Active')} ELSE ${s('New')} END,
             CASE WHEN g % 2 = 1 THEN ${s('Active')} ELSE ${s('New')} END
        FROM generate_series(1, 12000) AS g`.execute(db);
    // People who made changes the member may see, so the BY queries find some.
    const actor = async (where: string) => {
      const { rows } = await sql<{ actor_id: number }>`SELECT h.actor_id FROM ticket_change h
          JOIN ticket k ON k.id = h.ticket_id JOIN track t ON t.id = k.track_id
         WHERE ${sql.raw(where)} ORDER BY h.ticket_id LIMIT 1`.execute(db);
      expect(rows, where).toHaveLength(1);
      return rows[0]?.actor_id as number;
    };
    pointsBy = await actor(
      "h.field LIKE 'cf[%' AND h.to_value = '5' AND substr(t.key, 2)::int % 2 = 1",
    );
    statusBy = await actor("h.field = 'status' AND h.from_value IS NOT NULL AND t.key = 'T01'");
    for (const table of ['ticket', 'ticket_change', 'app_user', 'track', 'status']) {
      await sql`VACUUM ANALYZE ${sql.table(table)}`.execute(db);
    }
    filter = await new Authorizer(db).ticketFilter(1, { userId: member });
  }, 1_800_000);

  it('[QRY-005] answers history queries on the first page within budget', async () => {
    const catalogs = new FieldCatalogs(db);
    const catalog = await catalogs.get(1);
    const catalogue = await queryCatalogue(db, 1, catalog, filter.tracks);
    const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM ticket_change`.execute(db);
    const queries = [
      'status WAS "In Review" ORDER BY updated DESC',
      'status WAS Blocked ORDER BY updated DESC',
      'status WAS NOT Active ORDER BY created DESC',
      'status WAS Closed DURING ("2024-06-01", "2024-06-30") ORDER BY created DESC',
      'status WAS "In Review" AFTER "2025-01-01" BEFORE "2025-02-01" ORDER BY created DESC',
      'status CHANGED TO Closed AFTER "2025-10-01" ORDER BY updated DESC',
      `assignee CHANGED BY ${other} DURING ("2024-01-01", "2026-01-01") ORDER BY created DESC`,
      'status CHANGED FROM Blocked TO Active',
      'status CHANGED AFTER "2025-11-01" ORDER BY created DESC',
      'assignee WAS EMPTY AFTER "2025-01-01" ORDER BY created DESC',
      `Points CHANGED FROM 3 TO 5 BY ${pointsBy} DURING ("2024-01-01", "2026-01-01")`,
      `track = T01 AND priority WAS Normal AND status CHANGED BY ${statusBy}`,
      `key = ${manyKey} AND status WAS Closed BEFORE "2025-06-02"`,
      'status WAS "Never called this" ORDER BY created DESC',
    ];
    // TASKMOOR_LARGE_HISTORY_ONLY=<text> times only the queries holding it.
    const only = process.env.TASKMOOR_LARGE_HISTORY_ONLY;
    if (only) queries.splice(0, queries.length, ...queries.filter((q) => q.includes(only)));
    const report: string[] = [
      `${TICKETS} tickets, ${rows[0]?.n} history rows; p95 of ${RUNS} in ms: page of 50 (binding included), count to 10,001, both`,
    ];
    const over: string[] = [];
    for (const q of queries) {
      const pages: number[] = [];
      const counts: number[] = [];
      const both: number[] = [];
      let found = 0;
      let counted = 0;
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
        const paged = performance.now();
        counted = (await compiled.count(10_001).execute(db)).rows[0]?.n ?? 0;
        const done = performance.now();
        pages.push(paged - started);
        counts.push(done - paged);
        both.push(done - started);
      }
      const ms = (samples: number[]) => p95(samples).toFixed(1).padStart(8);
      report.push(
        `${ms(pages)} ${ms(counts)} ${ms(both)}  ${String(found).padStart(3)} ${String(counted).padStart(6)}  ${q}`,
      );
      if (p95(both) >= BUDGET_MS) over.push(`${q}: ${p95(both).toFixed(0)} ms`);
    }
    const file = process.env.TASKMOOR_SEARCH_REPORT;
    if (file) appendFileSync(file, `${report.join('\n')}\n`);
    // A search's first page and its count, as the route answers them.
    expect(over).toEqual([]);
  }, 1_800_000);
});
