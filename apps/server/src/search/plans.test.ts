import { randomBytes } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { stableJson } from '@taskmoor/testkit';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import type { TicketFilter } from '../authz/visibility';
import { FieldCatalogs } from '../fields/catalog';
import { queryCatalogue } from './catalogue';
import type { Cursor, PageRow } from './compile';
import { prepareSearch } from './run';

/**
 * Query plan regression (M1-037; QRY-008, QRY-010; ADR-010): a fixed set of representative
 * queries over 20,000 synthetic tickets, planned as an ordinary member sees them (half the
 * tracks, a visibility level in play). Each plan's shape (node types, index names, scan
 * direction; never costs) is a golden file per Postgres major version, so a change that loses
 * an index or brings back a sort fails here. On a major version without a golden file, the
 * indexes each query must use are checked instead.
 *
 * The data is generated in SQL from arithmetic (no randomness), stays under ANALYZE's sample of
 * 30,000 rows so its statistics are exact, and is vacuumed so visibility is settled; planner
 * settings are fixed for the run. Together these make the plans the same on every machine.
 */
const TICKETS = 20_000;
const TRACKS = 20;
const USERS = 200;
const WORDS = [
  'login',
  'export',
  'payment',
  'search',
  'report',
  'mobile',
  'cache',
  'session',
  'upload',
  'billing',
];

interface PlanCase {
  q: string;
  /** Indexes the plan must use, on any Postgres version (`a|b`: one of them). */
  uses: string[];
}

/** The representative set; `{me}` and `{other}` are people, `{parent}` a ticket key. */
const CASES: PlanCase[] = [
  { q: '', uses: ['ticket_created_idx'] },
  { q: 'track = T01 ORDER BY created DESC', uses: ['ticket_track_created_idx'] },
  { q: 'track = T01 AND status = Active ORDER BY updated DESC', uses: [] },
  {
    q: 'assignee = currentUser() AND stage != closed ORDER BY priority DESC, created DESC',
    uses: ['ticket_assignee_idx'],
  },
  { q: 'status IN (New, Active) AND priority IN (High, Urgent) ORDER BY created DESC', uses: [] },
  { q: 'labels IN (l1, l2) ORDER BY created DESC', uses: [] },
  { q: 'summary ~ payment ORDER BY created DESC', uses: [] },
  { q: 'summary ~ "payment cache" ORDER BY created DESC', uses: ['ticket_summary_words_idx'] },
  {
    q: 'created >= "2024-06-01" AND type = Bug ORDER BY created DESC',
    uses: ['ticket_created_idx'],
  },
  {
    q: 'closed IS EMPTY AND updated < "2024-01-20" ORDER BY updated ASC',
    uses: ['ticket_updated_idx|ticket_track_updated_idx'],
  },
  {
    q: 'Points > 90 AND track = T01 ORDER BY Points DESC',
    uses: ['v_number_track_field_value_idx'],
  },
  { q: 'Team = O3 AND stage = new ORDER BY created DESC', uses: ['v_option_field_value_idx'] },
  {
    q: 'Deadline >= "2024-03-01" AND Deadline <= "2024-03-31" ORDER BY Deadline ASC',
    uses: ['v_date_field_value_idx'],
  },
  { q: 'Reviewer = {other} ORDER BY updated DESC', uses: ['v_user_field_value_idx'] },
  {
    q: 'Tags IN (A, B) AND status != Closed ORDER BY created DESC',
    uses: ['v_option_field_created_idx'],
  },
  {
    q: 'Points IS EMPTY AND type IN (Bug, Feature) AND track = T01 ORDER BY created DESC',
    uses: ['ticket_track_created_idx'],
  },
  { q: 'parent = {parent} ORDER BY created ASC', uses: ['ticket_parent_idx'] },
  { q: 'requester = currentUser() ORDER BY created DESC', uses: ['ticket_requester_idx'] },
  { q: 'key = T01-5', uses: ['ticket_pkey'] },
  { q: 'due < "2024-02-01" ORDER BY due ASC', uses: ['ticket_due_idx'] },
  { q: 'closed >= "2024-12-01" ORDER BY closed DESC', uses: ['ticket_closed_idx'] },
  { q: 'watcher = currentUser() ORDER BY created DESC', uses: ['ticket_follower_user_idx'] },
  {
    q: 'NOT (labels IN (l3) OR type = Subticket) AND track IN (T01, T03) ORDER BY created DESC',
    uses: ['ticket_track_created_idx|ticket_track_updated_idx|ticket_track_number_key'],
  },
  // Value branches: one per priority or track, each walking an index in the remaining order.
  { q: 'track = T03 ORDER BY key ASC', uses: ['ticket_track_number_key'] },
  {
    q: 'priority IN (High, Urgent) AND type = Bug ORDER BY priority DESC, created ASC',
    uses: ['ticket_priority_created_idx'],
  },
  {
    q: 'track = T01 AND priority > Normal ORDER BY priority DESC, updated DESC',
    uses: ['ticket_track_updated_idx'],
  },
  // Words in documents and in the comments the viewer reads.
  { q: 'description ~ billing AND track = T01', uses: ['ticket_description_words_idx'] },
  { q: 'comment ~ export ORDER BY created DESC', uses: ['ticket_comment_words_idx'] },
];

/** A plan as node types, scan directions, indexes and relations, one line per node. */
function shape(node: Record<string, unknown>, depth = 0, out: string[] = []): string[] {
  const parts = [node['Node Type'] as string];
  if (node['Parent Relationship'] === 'SubPlan' || node['Parent Relationship'] === 'InitPlan') {
    parts.unshift(`[${node['Parent Relationship']}]`);
  }
  if (node['Scan Direction'] === 'Backward') parts.push('backward');
  if (node['Join Type'] && node['Node Type'] !== 'Hash') parts.push(`(${node['Join Type']})`);
  if (node['Index Name']) parts.push(`using ${node['Index Name']}`);
  if (node['Relation Name']) parts.push(`on ${node['Relation Name']} ${node.Alias ?? ''}`.trim());
  out.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
  for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) {
    shape(child, depth + 1, out);
  }
  return out;
}

function indexesOf(lines: readonly string[]): Set<string> {
  return new Set(lines.flatMap((l) => /using (\S+)/.exec(l)?.[1] ?? []));
}

describe('query plans (M1-037)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let db: Kysely<Database>;
  let catalogs: FieldCatalogs;
  let member = 0;
  let other = 0;
  let parentKey = '';
  let filter: TicketFilter;

  const prepare = async (q: string, anchor = true, branches = true) => {
    const catalog = await catalogs.get(1);
    const catalogue = await queryCatalogue(db, 1, catalog, filter.tracks);
    return prepareSearch({
      db,
      workspaceId: 1,
      catalog,
      catalogue,
      filter,
      q: q.replace('{other}', String(other)).replace('{parent}', parentKey),
      currentUserId: member,
      now: new Date('2025-01-01T00:00:00Z'),
      anchor,
      branches,
    });
  };

  beforeAll(async () => {
    db = database.db;
    app = await buildApp({ db, version: 'test', roles: ['api'] });
    catalogs = new FieldCatalogs(db);
    const password = randomBytes(18).toString('base64url');
    await db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'Admin',
        password_hash: await hashPassword(password),
        is_site_admin: true,
      })
      .execute();
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password },
      remoteAddress: '100.79.0.1',
    });
    const cookie =
      [session.headers['set-cookie']]
        .flat()
        .find((c) => c?.startsWith(`${SESSION_COOKIE}=`))
        ?.split(';')[0] ?? '';
    const post = async (url: string, payload: Record<string, unknown>) => {
      const res = await app.inject({
        method: 'POST',
        url,
        payload,
        headers: { cookie },
        remoteAddress: '100.79.0.2',
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json();
    };
    const opts = (values: string[]) => values.map((value) => ({ value }));
    const fieldIds: Record<string, number> = {};
    for (const [name, payload] of Object.entries({
      Points: { type: 'number' },
      Deadline: { type: 'date' },
      Team: { type: 'select', context: { options: opts(['O1', 'O2', 'O3', 'O4', 'O5']) } },
      Tags: { type: 'select', multiple: true, context: { options: opts(['A', 'B', 'C', 'D']) } },
      Reviewer: { type: 'user' },
    })) {
      fieldIds[name] = (await post('/api/v1/fields', { name, ...payload })).field.id;
    }

    // People, tracks (the member works in the odd ones), and their tickets.
    await sql`INSERT INTO app_user (workspace_id, email, name)
      SELECT 1, 'p' || g || '@example.com', 'Person ' || lpad(g::text, 3, '0')
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
    // Deterministic spreads: i * a prime, modulo the size of what is chosen from.
    await sql`
      WITH t AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM track WHERE key LIKE 'T%'),
           s AS (SELECT id, row_number() OVER (ORDER BY sort_order) - 1 AS n FROM status),
           p AS (SELECT id, row_number() OVER (ORDER BY sort_order) - 1 AS n FROM priority),
           ty AS (SELECT id, row_number() OVER (ORDER BY name) - 1 AS n FROM ticket_type
                   WHERE owner_track_id IS NULL AND name IN ('Bug', 'Feature', 'Chore', 'Subticket')),
           words AS (SELECT * FROM unnest(${WORDS}::text[]) WITH ORDINALITY AS w(word, n))
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, priority_id,
        summary, assignee_id, requester_id, creator_id, labels, rank, created_at, updated_at,
        due_date, closed_at)
      SELECT 1, t.id, g / ${TRACKS} + 1, ty.id, s.id, p.id,
             'Ticket ' || g || ' about ' || w1.word || ' and ' || w2.word,
             CASE WHEN g % 7 = 0 THEN NULL ELSE ${member} + (g * 31) % ${USERS} END,
             ${member} + (g * 17) % ${USERS}, ${member},
             CASE WHEN g % 3 = 0 THEN '{}'::text[] ELSE ARRAY['l' || (g % 10), 'l' || ((g * 7) % 13)] END,
             'r' || lpad(g::text, 8, '0'),
             timestamptz '2024-01-01' + g * interval '25 minutes',
             timestamptz '2024-01-01' + g * interval '25 minutes' + ((g * 7919) % 2000) * interval '1 hour',
             CASE WHEN g % 4 = 0 THEN date '2024-01-01' + (g * 13) % 400 END,
             NULL
        FROM generate_series(0, ${TICKETS - 1}) AS g
        JOIN t ON t.n = g % ${TRACKS}
        JOIN s ON s.n = (g * 7) % 13
        JOIN ty ON ty.n = (g * 3) % 4
        LEFT JOIN p ON p.n = g % 5
        JOIN words w1 ON w1.n = 1 + (g * 3) % 10
        JOIN words w2 ON w2.n = 1 + (g * 7 + 1) % 10`.execute(db);
    await sql`UPDATE ticket SET description = jsonb_build_object('type', 'doc', 'content',
        jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
          jsonb_build_object('type', 'text', 'text', 'Steps for ' || split_part(summary, ' ', 4))))))
      WHERE id % 50 = 0`.execute(db);
    await sql`INSERT INTO ticket_comment (workspace_id, ticket_id, author_id, body, visible_role_id)
      SELECT 1, k.id, ${member}, jsonb_build_object('type', 'doc', 'content',
          jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
            jsonb_build_object('type', 'text', 'text', 'Seen with ' || split_part(k.summary, ' ', 6)))))),
        CASE WHEN k.id % 3 = 0 THEN (SELECT id FROM role WHERE name = 'Administrators') END
        FROM ticket k WHERE k.id % 40 = 0`.execute(db);
    await sql`UPDATE ticket k SET closed_at = k.updated_at FROM status s
      WHERE s.id = k.status_id AND s.stage = 'closed'`.execute(db);
    // Every tenth ticket is a subticket of the one before.
    await sql`UPDATE ticket k SET parent_id = k.id - 1 WHERE k.id % 10 = 0
      AND EXISTS (SELECT 1 FROM ticket p WHERE p.id = k.id - 1)`.execute(db);
    parentKey = (
      await sql<{ key: string }>`SELECT t.key || '-' || p.number AS key FROM ticket k
        JOIN ticket p ON p.id = k.parent_id JOIN track t ON t.id = p.track_id
         WHERE substr(t.key, 2)::int % 2 = 1 ORDER BY k.id LIMIT 1`.execute(db)
    ).rows[0]?.key as string;
    await sql`INSERT INTO ticket_follower (workspace_id, ticket_id, user_id)
      SELECT 1, id, ${member} + (id * 11) % ${USERS} FROM ticket WHERE id % 2 = 0`.execute(db);
    // Custom values in their side tables, as syncFieldValues writes them.
    const side = (table: string, select: string, where: string) =>
      sql`INSERT INTO ${sql.table(table)} (workspace_id, ticket_id, track_id, field_id, value, created_at)
        SELECT 1, k.id, k.track_id, ${sql.raw(select)}, k.created_at FROM ticket k WHERE ${sql.raw(where)}`.execute(
        db,
      );
    const option = async (field: string, value: string) =>
      (
        await db
          .selectFrom('field_option')
          .select('id')
          .where('field_id', '=', fieldIds[field] as number)
          .where('value', '=', value)
          .executeTakeFirstOrThrow()
      ).id;
    await side('v_number', `${fieldIds.Points}, (k.id * 37) % 100`, 'k.id % 5 < 3');
    await side(
      'v_date',
      `${fieldIds.Deadline}, date '2024-01-01' + (k.id * 7) % 365`,
      'k.id % 5 < 2',
    );
    const team = await Promise.all(['O1', 'O2', 'O3', 'O4', 'O5'].map((v) => option('Team', v)));
    await side(
      'v_option',
      `${fieldIds.Team}, (ARRAY[${team.join(',')}])[1 + k.id % 5]`,
      'k.id % 2 = 0',
    );
    const tags = await Promise.all(['A', 'B', 'C', 'D'].map((v) => option('Tags', v)));
    await side(
      'v_option',
      `${fieldIds.Tags}, (ARRAY[${tags.join(',')}])[1 + k.id % 4]`,
      'k.id % 5 < 2',
    );
    await side(
      'v_option',
      `${fieldIds.Tags}, (ARRAY[${tags.join(',')}])[1 + (k.id + 1) % 4]`,
      'k.id % 10 = 0',
    );
    await side(
      'v_user',
      `${fieldIds.Reviewer}, ${member} + (k.id * 13) % ${USERS}`,
      'k.id % 3 = 0',
    );
    // A visibility level on the first track: one ticket in a hundred, for Administrators only.
    await sql`INSERT INTO visibility_policy (workspace_id, name) VALUES (1, 'Plans')`.execute(db);
    await sql`INSERT INTO visibility_level (workspace_id, policy_id, name, position)
      SELECT 1, id, 'Secret', 0 FROM visibility_policy WHERE name = 'Plans'`.execute(db);
    await sql`INSERT INTO visibility_member (workspace_id, level_id, grantee, role_id)
      SELECT 1, l.id, 'role', r.id FROM visibility_level l, role r
       WHERE l.name = 'Secret' AND r.name = 'Administrators'`.execute(db);
    await sql`UPDATE track SET visibility_policy_id = (SELECT id FROM visibility_policy WHERE name = 'Plans')
      WHERE key = 'T01'`.execute(db);
    await sql`UPDATE ticket SET visibility_level_id = (SELECT id FROM visibility_level WHERE name = 'Secret')
      WHERE track_id = (SELECT id FROM track WHERE key = 'T01') AND id % 100 = 1`.execute(db);
    for (const table of [
      'ticket',
      'v_number',
      'v_date',
      'v_option',
      'v_user',
      'ticket_follower',
      'ticket_comment',
      'app_user',
      'track',
      'status',
      'priority',
      'ticket_type',
    ]) {
      await sql`VACUUM ANALYZE ${sql.table(table)}`.execute(db);
    }
    filter = await new Authorizer(db).ticketFilter(1, { userId: member });
  });
  afterAll(async () => {
    await app.close();
  });

  /** Plans a page as the server would run it, with fixed planner settings. */
  const explain = async (q: string) => {
    const { compiled } = await prepare(q);
    const statement = compiled.page(51);
    return db.transaction().execute(async (trx) => {
      for (const [name, value] of [
        ['random_page_cost', '1.1'],
        ['seq_page_cost', '1'],
        ['effective_cache_size', '4GB'],
        ['work_mem', '16MB'],
        ['max_parallel_workers_per_gather', '0'],
        ['jit', 'off'],
      ]) {
        await sql`SELECT set_config(${name}, ${value}, true)`.execute(trx);
      }
      const { rows } = await sql<{
        'QUERY PLAN': { Plan: Record<string, unknown> }[];
      }>`EXPLAIN (FORMAT JSON, COSTS OFF) ${statement}`.execute(trx);
      return shape(rows[0]?.['QUERY PLAN'][0]?.Plan ?? {});
    });
  };

  it('[QRY-010] keeps the reviewed plan of every representative query', async () => {
    const version = await sql<{
      v: string;
    }>`SELECT current_setting('server_version_num') AS v`.execute(db);
    const major = Math.floor(Number(version.rows[0]?.v ?? 0) / 10_000);
    const plans: Record<string, string[]> = {};
    for (const c of CASES) {
      const lines = await explain(c.q);

      plans[c.q === '' ? '(empty)' : c.q] = lines;
      const used = indexesOf(lines);
      for (const index of c.uses) {
        const anyOf = index.split('|');
        expect(
          anyOf.some((i) => used.has(i)),
          `${c.q} uses ${index}: ${[...used].join(', ')}`,
        ).toBe(true);
      }
      // The ticket table is never read whole.
      expect(lines.join('\n'), c.q).not.toMatch(/Seq Scan on ticket k$/m);
    }
    if (major === 16) {
      await expect(stableJson(plans)).toMatchFileSnapshot('./__golden__/plans-pg16.json');
    }
  });

  it('[QRY-009] returns the same rows in the same order whether or not it walks a side table', async () => {
    const anchored = CASES.filter((c) => /Points|Team|Deadline|Tags|Reviewer/.test(c.q)).map(
      (c) => c.q,
    );
    expect(anchored.length).toBeGreaterThan(3);
    for (const q of [
      ...anchored,
      'Tags = C ORDER BY created ASC',
      'Points >= 50 AND Points < 60 AND track IN (T01, T03) ORDER BY Points ASC',
      'Team IN (O1, O2) AND labels = l1 ORDER BY created DESC',
    ]) {
      const a = await prepare(q, true);
      const b = await prepare(q, false);
      const rows = async (
        p: typeof a,
        after?: { values: (string | number | null)[]; id: number },
      ) => (await p.compiled.page(120, after).execute(db)).rows;
      const first = await rows(a);
      expect(
        first.map((r) => r.id),
        q,
      ).toEqual((await rows(b)).map((r) => r.id));
      expect(first.length, q).toBeGreaterThan(0);
      // And the page after the 60th row.
      const at = first[59];
      if (at) {
        const after = { values: [at.c0 ?? null], id: at.id };
        expect(
          (await rows(a, after)).map((r) => r.id),
          `${q} page 2`,
        ).toEqual((await rows(b, after)).map((r) => r.id));
      }
    }
  });

  it('[QRY-009] returns the same pages whether or not it merges value branches', async () => {
    const queries = [
      'ORDER BY priority DESC, updated DESC',
      'track = T01 AND priority IN (High, Urgent) ORDER BY priority DESC, created ASC',
      'stage != closed AND type = Bug ORDER BY priority ASC, created DESC',
      'track = T03 ORDER BY key ASC',
      'track IN (T01, T03, T05) ORDER BY key DESC',
      'ORDER BY status ASC, assignee ASC, created DESC',
      'labels = l1 ORDER BY type ASC, due ASC',
      'priority IS EMPTY OR priority = Low ORDER BY priority DESC, key ASC',
    ];
    for (const q of queries) {
      const a = await prepare(q, true, true);
      const b = await prepare(q, true, false);
      expect(a.compiled.branched, q).toBe(true);
      const rows = async (p: typeof a, after?: Cursor) =>
        (await p.compiled.page(250, after).execute(db)).rows;
      const cursor = (row: PageRow): Cursor => ({
        values: a.compiled.keys.map((_, i) => row[`c${i}`] ?? null),
        id: row.id,
      });
      const all = await rows(b);
      expect(
        (await rows(a)).map((r) => r.id),
        q,
      ).toEqual(all.map((r) => r.id));
      expect(all.length, q).toBeGreaterThan(20);
      // Pages after rows anywhere in the order, a row of the empty branch included.
      for (const at of [0, 7, Math.floor(all.length / 2), all.length - 2]) {
        const row = all[at];
        if (!row) continue;
        expect(
          (await rows(a, cursor(row))).map((r) => r.id),
          `${q} after row ${at}`,
        ).toEqual((await rows(b, cursor(row))).map((r) => r.id));
      }
    }
  });
});
