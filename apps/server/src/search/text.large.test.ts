import { appendFileSync } from 'node:fs';
import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { type Kysely, sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { Authorizer } from '../authz/authorizer';
import type { TicketFilter } from '../authz/visibility';
import { FieldCatalogs } from '../fields/catalog';
import { queryCatalogue } from './catalogue';
import { clearCountCache, countMatches, type Total } from './count';
import { prepareSearch } from './run';

/**
 * Full-text search and counts at size (M1-040; QRY-007, QRY-009): 200,000 tickets over 20
 * tracks (another size with TASKMOOR_LARGE_TEXT_TICKETS), 2,000 people, a member who works in
 * half the tracks. Text is drawn from 6,000 made-up words with a long tail (a word's share falls
 * with its rank, as in real text): every summary has 8 words, three tickets in five a
 * description of 60, one in three a comment of 25 (one comment in ten for a role only), one in
 * four a Notes value of 6.
 *
 * Each query is timed as the search route runs it on a first page, binding included, with the
 * member's permission filter: the page of 50, and the count (exact up to 10,000, then an
 * estimate; the cache emptied before each run). p95 of TASKMOOR_LARGE_TEXT_RUNS (default 10).
 * Each estimate is compared with the exact count. Spec budget (M1-040 done-when): p95 under
 * 300 ms at 10M tickets and counts within 10%; this machine cannot hold 10M, so the budget is
 * held at the size run. Run with (the report goes to TASKMOOR_SEARCH_REPORT)
 *   TASKMOOR_LARGE_TEXT=1 pnpm verify --only=tests -- apps/server/src/search/text.large.test.ts
 */
const TICKETS = Number(process.env.TASKMOOR_LARGE_TEXT_TICKETS ?? 200_000);
const TRACKS = 20;
const USERS = 2_000;
const VOCABULARY = 6_000;
const RUNS = Number(process.env.TASKMOOR_LARGE_TEXT_RUNS ?? 10);
/** The 10M budget, held here at a smaller size so a regression shows long before 10M. */
const BUDGET_MS = 300;
const p95 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] as number;

const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'ru', 'sa', 'te', 'vo', 'zi', 'po'];
/** The made-up word of rank n: three syllables, then more as the ranks run out. */
const word = (n: number) => {
  let out = '';
  let rest = n;
  do {
    out += SYLLABLES[rest % 10];
    rest = Math.floor(rest / 10);
  } while (rest > 0 || out.length < 6);
  return out;
};

describe.skipIf(!process.env.TASKMOOR_LARGE_TEXT)('full-text search at size (M1-040)', () => {
  const database = useMigratedDatabase();
  let db: Kysely<Database>;
  let member = 0;
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
    await sql`INSERT INTO track (workspace_id, key, name, access_policy_id, type_set_id)
      SELECT 1, 'T' || lpad(g::text, 2, '0'), 'Track ' || g,
             (SELECT id FROM access_policy WHERE workspace_id = 1 AND is_default),
             (SELECT type_set_id FROM type_set_default WHERE workspace_id = 1 AND track_type = 'software')
        FROM generate_series(1, ${TRACKS}) AS g`.execute(db);
    await sql`INSERT INTO track_role_actor (workspace_id, track_id, role_id, user_id)
      SELECT 1, t.id, (SELECT id FROM role WHERE name = 'Members'), ${member}
        FROM track t WHERE t.key LIKE 'T%' AND substr(t.key, 2)::int % 2 = 1`.execute(db);
    await sql`INSERT INTO field (workspace_id, name, type) VALUES (1, 'Notes', 'text')`.execute(db);
    // The vocabulary, and a word for a seed: rank e^(u·ln V) for u uniform, a long tail.
    await sql`CREATE TABLE vocab (n int PRIMARY KEY, word text NOT NULL)`.execute(db);
    const words = Array.from({ length: VOCABULARY }, (_, n) => word(n));
    await sql`INSERT INTO vocab (n, word) SELECT n - 1, w FROM unnest(${words}::text[]) WITH ORDINALITY AS x (w, n)`.execute(
      db,
    );
    await sql`
      CREATE FUNCTION text_of(seed bigint, n int) RETURNS text LANGUAGE sql IMMUTABLE AS $$
        SELECT string_agg(v.word, ' ' ORDER BY i)
          FROM generate_series(1, n) AS i
          JOIN vocab v ON v.n = least(${sql.lit(VOCABULARY - 1)},
            floor(exp(((seed * 7919 + i * 104729) % 100003) / 100003.0 * ln(${sql.lit(VOCABULARY)})))::int - 1)
      $$`.execute(db);
    const doc = (text: string) =>
      sql.raw(`jsonb_build_object('type', 'doc', 'content', jsonb_build_array(jsonb_build_object(
        'type', 'paragraph', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', ${text})))))`);
    await sql`
      WITH t AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM track WHERE key LIKE 'T%'),
           ty AS (SELECT id FROM ticket_type WHERE owner_track_id IS NULL AND name = 'Bug'),
           s AS (SELECT id, row_number() OVER (ORDER BY sort_order) - 1 AS n FROM status)
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
        description, assignee_id, requester_id, creator_id, rank, created_at, updated_at)
      SELECT 1, t.id, g / ${TRACKS} + 1, (SELECT id FROM ty), s.id, text_of(g, 8),
             CASE WHEN g % 5 < 3 THEN ${doc('text_of(g * 31 + 7, 60)')} END,
             ${member} + (g * 31) % ${USERS}, ${member} + (g * 17) % ${USERS},
             ${member} + (g * 17) % ${USERS}, 'r' || lpad(g::text, 8, '0'),
             timestamptz '2024-01-01' + g * interval '2 minutes',
             timestamptz '2024-01-01' + g * interval '2 minutes' + ((g * 7919) % 2000) * interval '1 hour'
        FROM generate_series(0, ${TICKETS - 1}) AS g
        JOIN t ON t.n = g % ${TRACKS}
        JOIN s ON s.n = (g * 7) % 5`.execute(db);
    await sql`INSERT INTO ticket_comment (workspace_id, ticket_id, author_id, body, visible_role_id)
      SELECT 1, k.id, k.creator_id, ${doc('text_of(k.id * 13 + 5, 25)')},
             CASE WHEN k.id % 30 = 0 THEN (SELECT id FROM role WHERE name = 'Administrators') END
        FROM ticket k WHERE k.id % 3 = 0`.execute(db);
    await sql`INSERT INTO v_text (workspace_id, ticket_id, track_id, field_id, value, sort_key, created_at)
      SELECT 1, k.id, k.track_id, f.id, text_of(k.id * 17 + 3, 6), text_of(k.id * 17 + 3, 6), k.created_at
        FROM ticket k, field f WHERE f.name = 'Notes' AND k.id % 4 = 0`.execute(db);
    for (const table of ['ticket', 'ticket_comment', 'v_text', 'app_user', 'track', 'status']) {
      await sql`VACUUM ANALYZE ${sql.table(table)}`.execute(db);
    }
    filter = await new Authorizer(db).ticketFilter(1, { userId: member });
  }, 3_600_000);

  it('[QRY-007] [QRY-009] answers text searches and counts within budget at size', async () => {
    const catalog = await new FieldCatalogs(db).get(1);
    const catalogue = await queryCatalogue(db, 1, catalog, filter.tracks);
    // Words by how many summaries hold them: common, middling, rare, absent.
    const share = async (w: string) =>
      (
        await sql<{ n: number }>`SELECT count(*)::int AS n FROM ticket
          WHERE summary_words @@ to_tsquery('taskmoor_search', ${`'${w}'`})`.execute(db)
      ).rows[0]?.n ?? 0;
    const pick = async (from: number, to: number) => {
      for (let n = from; n < to; n++) {
        const w = word(n);
        if ((await share(w)) > 0) return w;
      }
      return word(from);
    };
    const common = word(0);
    const mid = await pick(60, 80);
    const mid2 = await pick(90, 110);
    const rare = await pick(VOCABULARY - 200, VOCABULARY);
    const none = 'zzqqxxnotaword';
    // Two neighbouring words of a summary, for a phrase that occurs.
    const phrase = (
      await sql<{
        p: string;
      }>`SELECT split_part(summary, ' ', 2) || ' ' || split_part(summary, ' ', 3) AS p
        FROM ticket ORDER BY id LIMIT 1 OFFSET 1000`.execute(db)
    ).rows[0]?.p as string;
    // The newest 15% of tickets.
    const recent = new Date(Date.UTC(2024, 0, 1) + Math.floor(TICKETS * 0.85) * 120_000)
      .toISOString()
      .slice(0, 10);
    const { rows: sizes } = await sql<{ table: string; mb: number }>`
      SELECT c.relname AS table, round(pg_total_relation_size(c.oid) / 1048576.0)::int AS mb
        FROM pg_class c WHERE c.relname IN ('ticket', 'ticket_comment', 'v_text')`.execute(db);
    const queries = [
      `text ~ ${common} ORDER BY updated DESC`,
      `text ~ ${mid} ORDER BY updated DESC`,
      `text ~ ${rare} ORDER BY updated DESC`,
      `text ~ ${none} ORDER BY updated DESC`,
      `summary ~ "${common} ${mid}" ORDER BY created DESC`,
      `summary ~ "${mid} ${mid2}" ORDER BY created DESC`,
      `summary ~ "\\"${phrase}\\"" ORDER BY created DESC`,
      `description ~ ${mid} AND track = T01`,
      `comment ~ ${mid} ORDER BY created DESC`,
      `text ~ "${mid.slice(0, 4)}*" ORDER BY created DESC`,
      `summary ~ "${rare.slice(0, 2)}?${rare.slice(3)}" ORDER BY created DESC`,
      `summary ~ "${rare.slice(0, -1)}~" ORDER BY created DESC`,
      `summary ~ "*${rare.slice(1, -1)}*" ORDER BY created DESC`,
      `Notes ~ ${mid} ORDER BY created DESC`,
      `text ~ ${common} ORDER BY relevance`,
      `text ~ ${mid} ORDER BY relevance`,
      `text ~ ${common} AND status = New ORDER BY created DESC`,
      // Counts of everyday queries, beyond the cap.
      'ORDER BY created DESC',
      'track IN (T01, T03) ORDER BY updated DESC',
      'status = New ORDER BY created DESC',
      `created >= "${recent}" ORDER BY created DESC`,
    ];
    // TASKMOOR_LARGE_TEXT_ONLY=<text> times only the queries holding it.
    const only = process.env.TASKMOOR_LARGE_TEXT_ONLY;
    if (only) queries.splice(0, queries.length, ...queries.filter((q) => q.includes(only)));
    const report: string[] = [
      `${TICKETS} tickets (${sizes.map((s) => `${s.table} ${s.mb} MB`).join(', ')}); p95 of ${RUNS} in ms: page of 50 (binding included), count, both; matches; count given (exact true count, error)`,
    ];
    const over: string[] = [];
    const wrong: string[] = [];
    for (const q of queries) {
      const pages: number[] = [];
      const counts: number[] = [];
      const both: number[] = [];
      let found = 0;
      let total: Total = { count: 0, exact: true };
      let truth = 0;
      for (let i = 0; i < RUNS; i++) {
        clearCountCache();
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
        total = await countMatches(db, compiled);
        const done = performance.now();
        pages.push(paged - started);
        counts.push(done - paged);
        both.push(done - started);
        if (i === 0) truth = (await compiled.count(TICKETS + 1).execute(db)).rows[0]?.n ?? 0;
      }
      const error = truth > 0 ? Math.abs(total.count - truth) / truth : 0;
      const kind = total.exact ? 'exact' : total.approximate ? 'about' : 'more than';
      const ms = (samples: number[]) => p95(samples).toFixed(1).padStart(8);
      report.push(
        `${ms(pages)} ${ms(counts)} ${ms(both)}  ${String(found).padStart(3)}  ${kind} ${total.count} (${truth}, ${(error * 100).toFixed(1)}%)  ${q}`,
      );
      if (p95(pages) >= BUDGET_MS) over.push(`${q}: page ${p95(pages).toFixed(0)} ms`);
      if (total.approximate && error > 0.1) wrong.push(`${q}: ${total.count} for ${truth}`);
      if (total.exact && total.count !== truth)
        wrong.push(`${q}: exact ${total.count} for ${truth}`);
    }
    const file = process.env.TASKMOOR_SEARCH_REPORT;
    if (file) appendFileSync(file, `${report.join('\n')}\n`);
    expect(wrong).toEqual([]);
    expect(over).toEqual([]);
  }, 3_600_000);
});
