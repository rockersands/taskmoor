// pnpm bench:search --database-url <url> [--runs 20] [--label 1m] [--endpoint-runs 10]
//
// The search perf set (M1-037) against a database that holds `pnpm gen`'s dataset in schema
// `gen` (pnpm gen --items <n> --database-url <url>): migrates the product schema there, loads
// the dataset into it once (search/bench/load.ts), then times the 50 queries of the perf set as
// an ordinary member (half the tracks, a visibility level in play) and as a site administrator:
// the compiled statement alone, and the whole GET /api/v1/search through the app. Writes
// docs/spikes/data/search-<label>.json and docs/spikes/search-<label>.md.
//
// Benchmark tooling: the server never imports it. Credentials come from the URL you pass.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDb, migrateToLatest } from '@taskmoor/db';
import { hashPassword } from '@taskmoor/iam';
import { sql } from 'kysely';
import { buildApp } from '../../app';
import { SESSION_COOKIE } from '../../auth';
import { Authorizer } from '../../authz/authorizer';
import { FieldCatalogs } from '../../fields/catalog';
import { queryCatalogue } from '../catalogue';
import type { PageRow } from '../compile';
import { prepareSearch } from '../run';
import { loaded, loadFromGen } from './load';
import { benchNames, instantiate, PERF_QUERIES, type Timed, timed } from './perf';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const { values } = parseArgs({
  options: {
    'database-url': { type: 'string' },
    runs: { type: 'string', default: '20' },
    'endpoint-runs': { type: 'string', default: '10' },
    label: { type: 'string' },
  },
});
const url = values['database-url'] ?? process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('Usage: pnpm bench:search --database-url <url> [--runs 20] [--label 1m]\n');
  process.exit(2);
}
const runs = Number(values.runs);
const endpointRuns = Number(values['endpoint-runs']);
/** Generated per run: no credential is kept in the repository. */
const PASSWORD = randomBytes(18).toString('base64url');

const log = (m: string) => process.stdout.write(`${m}\n`);
{
  // Planner settings for SSD storage and this machine's memory, as deploy/README.md tells
  // operators to set them; set on the database, so every connection opened after has them.
  const setup = createDb({ connectionString: url, maxConnections: 1 });
  try {
    await migrateToLatest(setup);
    const name = (await sql<{ d: string }>`SELECT current_database() AS d`.execute(setup)).rows[0]
      ?.d as string;
    const cache = `${Math.max(1, Math.round((totalmem() * 0.75) / 2 ** 30))}GB`;
    await sql`ALTER DATABASE ${sql.id(name)} SET random_page_cost = 1.1`.execute(setup);
    await sql`ALTER DATABASE ${sql.id(name)} SET effective_cache_size = ${sql.lit(cache)}`.execute(
      setup,
    );
  } finally {
    await setup.destroy();
  }
}
const db = createDb({ connectionString: url, maxConnections: 6 });
try {
  if (!(await loaded(db))) {
    log('Loading the gen dataset into the product schema...');
    const report = await loadFromGen(db, log);
    log(
      `Loaded ${report.tickets.toLocaleString('en')} tickets: ${JSON.stringify(report.sideRows)}`,
    );
  }
  const tickets = Number(
    (
      await sql<{
        n: string;
      }>`SELECT reltuples::bigint AS n FROM pg_class WHERE relname = 'ticket'`.execute(db)
    ).rows[0]?.n ?? 0,
  );
  const label = values.label ?? `${Math.round(tickets / 1_000_000)}m`;

  // The member: the person at the tenth percentile of assignments, in every other track.
  const member = (
    await sql<{ id: number }>`SELECT assignee_id AS id FROM ticket TABLESAMPLE SYSTEM (5)
      WHERE assignee_id IS NOT NULL GROUP BY assignee_id ORDER BY count(*) DESC
      OFFSET (SELECT count(DISTINCT assignee_id) / 10 FROM ticket TABLESAMPLE SYSTEM (5)) LIMIT 1`.execute(
      db,
    )
  ).rows[0]?.id as number;
  const hash = await hashPassword(PASSWORD);
  await sql`UPDATE app_user SET password_hash = ${hash}, deactivated_at = NULL WHERE id = ${member}`.execute(
    db,
  );
  await sql`INSERT INTO track_role_actor (workspace_id, track_id, role_id, user_id)
    SELECT 1, t.id, (SELECT id FROM role WHERE workspace_id = 1 AND name = 'Members'), ${member}
      FROM track t WHERE t.id % 2 = 1
       AND NOT EXISTS (SELECT 1 FROM track_role_actor a WHERE a.track_id = t.id AND a.user_id = ${member})`.execute(
    db,
  );
  const admin = (
    await sql<{
      id: number;
    }>`INSERT INTO app_user (workspace_id, email, name, password_hash, is_site_admin)
      VALUES (1, 'bench-admin@example.com', 'Bench admin', ${hash}, true)
      ON CONFLICT (workspace_id, lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash
      RETURNING id`.execute(db)
  ).rows[0]?.id as number;
  await sql`ANALYZE track_role_actor`.execute(db);

  const authorizer = new Authorizer(db);
  const catalogs = new FieldCatalogs(db);
  const memberFilter = await authorizer.ticketFilter(1, { userId: member });
  const adminFilter = await authorizer.ticketFilter(1, { userId: admin });
  const browse = memberFilter.tracks === 'all' ? [] : memberFilter.tracks;
  const names = await benchNames(db, browse);
  const now = (await sql<{ at: Date }>`SELECT max(created_at) AS at FROM ticket`.execute(db))
    .rows[0]?.at as Date;
  log(`Viewer ${member} browses ${browse.length} tracks; names ${JSON.stringify(names)}`);

  const app = await buildApp({ db, version: 'bench', roles: ['api'] });
  const cookie = async (email: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password: PASSWORD },
      remoteAddress: '127.0.0.1',
    });
    return (
      [res.headers['set-cookie']]
        .flat()
        .find((c) => c?.startsWith(`${SESSION_COOKIE}=`))
        ?.split(';')[0] ?? ''
    );
  };
  const memberEmail = (
    await sql<{ email: string }>`SELECT email FROM app_user WHERE id = ${member}`.execute(db)
  ).rows[0]?.email as string;
  const viewers = [
    { id: 'member', userId: member, filter: memberFilter, cookie: await cookie(memberEmail) },
    {
      id: 'admin',
      userId: admin,
      filter: adminFilter,
      cookie: await cookie('bench-admin@example.com'),
    },
  ];

  interface Row {
    id: string;
    text: string;
    viewer: string;
    rows: number;
    anchored: boolean;
    statement: Timed;
    endpoint?: Timed;
    countMs?: number;
    count?: number;
    plan: string[];
  }
  const results: Row[] = [];
  const conn = await db.connection().execute(async (c) => {
    for (const viewer of viewers) {
      const catalog = await catalogs.get(1);
      const catalogue = await queryCatalogue(c, 1, catalog, viewer.filter.tracks);
      let last: { values: (string | number | null)[]; id: number } | undefined;
      let lastCursor: string | null = null;
      for (const q of PERF_QUERIES) {
        const text = instantiate(q.text, names);
        const { compiled } = await prepareSearch({
          db: c,
          workspaceId: 1,
          catalog,
          catalogue,
          filter: viewer.filter,
          q: text,
          currentUserId: viewer.userId,
          now,
        });
        const after = q.page === 2 ? last : undefined;
        const statement = compiled.page(51, after);
        const samples: number[] = [];
        let rows: PageRow[] = [];
        for (let i = 0; i < runs + 2; i++) {
          const t0 = performance.now();
          rows = (await statement.execute(c)).rows;
          if (i >= 2) samples.push(performance.now() - t0);
        }
        const t0 = performance.now();
        const counted = await compiled.count(10_001).execute(c);
        const countMs = Math.round((performance.now() - t0) * 100) / 100;
        const plan = (
          await sql<{ 'QUERY PLAN': string }>`EXPLAIN (COSTS OFF) ${statement}`.execute(c)
        ).rows
          .map((r) => r['QUERY PLAN'])
          .filter((l) => /Scan|Join|Nested|Sort|Limit|Aggregate/.test(l))
          .map((l) => l.replace(/\s+\(.*$/, '').trimEnd());
        // The endpoint: everything a person waits for, views included.
        const endpoint: number[] = [];
        const cursor: string | null = q.page === 2 ? lastCursor : null;
        for (let i = 0; i < endpointRuns + 1; i++) {
          const t1 = performance.now();
          const res: Awaited<ReturnType<typeof app.inject>> = await app.inject({
            method: 'GET',
            url: `/api/v1/search?q=${encodeURIComponent(text)}&limit=50&count=false${cursor ? `&cursor=${cursor}` : ''}`,
            headers: { cookie: viewer.cookie },
            remoteAddress: '127.0.0.1',
          });
          if (res.statusCode !== 200) throw new Error(`${q.id}: ${res.statusCode} ${res.body}`);
          if (i > 0) endpoint.push(performance.now() - t1);
          if (i === 0 && q.page !== 2) lastCursor = (res.json() as { next: string | null }).next;
        }
        const tail = rows[49];
        if (q.page !== 2) {
          last = tail
            ? { values: compiled.keys.map((_, k) => tail[`c${k}`] ?? null), id: tail.id }
            : undefined;
        }
        const row: Row = {
          id: q.id,
          text,
          viewer: viewer.id,
          rows: Math.min(rows.length, 50),
          anchored: compiled.anchored,
          statement: timed(samples),
          endpoint: timed(endpoint),
          countMs,
          count: counted.rows[0]?.n ?? 0,
          plan,
        };
        results.push(row);
        log(
          `  ${viewer.id} ${q.id}: ${row.rows} rows, p95 ${row.statement.p95} ms (endpoint ${row.endpoint?.p95} ms, count ${row.count} in ${countMs} ms)`,
        );
      }
    }
    return true;
  });
  void conn;

  // Opening a ticket (NFR budget: under 100 ms p95 warm, server response plus render): the
  // ticket and the requests the ticket page sends with it, in parallel as the browser does, as
  // the member, for tickets they may see. Each ticket is opened once to warm, then timed.
  const openRuns = Math.max(20, endpointRuns * 2);
  const visible =
    browse.length === 0
      ? sql`TRUE`
      : sql`k.track_id IN (${sql.join(browse.map((t) => sql`${t}`))})`;
  const sample = (
    await sql<{ key: string }>`SELECT t.key || '-' || k.number AS key
      FROM ticket k TABLESAMPLE SYSTEM (1) JOIN track t ON t.id = k.track_id
      WHERE ${visible} AND k.deleted_at IS NULL LIMIT ${openRuns}`.execute(db)
  ).rows.map((r) => r.key);
  const parts = ['', '/info', '/comments', '/history?limit=20', '/transitions', '/links'];
  const get = async (url: string) => {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: viewers[0]?.cookie ?? '' },
      remoteAddress: '127.0.0.1',
    });
    if (res.statusCode !== 200) throw new Error(`${url}: ${res.statusCode} ${res.body}`);
  };
  const single: number[] = [];
  const page: number[] = [];
  for (const key of sample) {
    const base = `/api/v1/tickets/${encodeURIComponent(key)}`;
    await Promise.all(parts.map((p) => get(`${base}${p}`)));
    const t0 = performance.now();
    await get(base);
    single.push(performance.now() - t0);
    const t1 = performance.now();
    await Promise.all(parts.map((p) => get(`${base}${p}`)));
    page.push(performance.now() - t1);
  }
  const open = {
    tickets: sample.length,
    requests: parts.length,
    ticket: timed(single),
    page: timed(page),
  };
  log(
    `  open a ticket: ${open.ticket.p95} ms p95; with the page's ${parts.length} requests ${open.page.p95} ms p95`,
  );
  await app.close();

  const server = (await sql<{ v: string }>`SELECT version() AS v`.execute(db)).rows[0]?.v ?? '';
  const out = {
    spike: 'search',
    at: new Date().toISOString(),
    tickets,
    runs,
    endpointRuns,
    machine: {
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 2 ** 30),
      postgres: server.split(' on ')[0] ?? server,
    },
    names,
    queries: results,
    open,
  };
  const dataDir = join(ROOT, 'docs', 'spikes', 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, `search-${label}.json`), `${JSON.stringify(out, null, 2)}\n`);
  writeFileSync(join(ROOT, 'docs', 'spikes', `search-${label}.md`), renderReport(out));
  log(`Report: docs/spikes/search-${label}.md`);
} finally {
  await db.destroy();
}

function renderReport(r: {
  at: string;
  tickets: number;
  runs: number;
  endpointRuns: number;
  machine: { cpu: string; cores: number; memoryGb: number; postgres: string };
  queries: {
    id: string;
    text: string;
    viewer: string;
    rows: number;
    anchored: boolean;
    statement: Timed;
    endpoint?: Timed;
    countMs?: number;
    count?: number;
    plan: string[];
  }[];
  open?: { tickets: number; requests: number; ticket: Timed; page: Timed };
}): string {
  const member = r.queries.filter((q) => q.viewer === 'member');
  const admin = new Map(r.queries.filter((q) => q.viewer === 'admin').map((q) => [q.id, q]));
  const worst = (list: typeof member, pick: (q: (typeof member)[number]) => number) =>
    Math.max(...list.map(pick));
  const lines = [
    `# Search perf set: ${r.tickets.toLocaleString('en')} tickets`,
    '',
    `Generated ${r.at.slice(0, 16).replace('T', ' ')} UTC on ${r.machine.cpu} (${r.machine.cores} cores, ${r.machine.memoryGb} GB), ${r.machine.postgres}. ${r.runs} timed runs of each statement after 2 warm-up runs, ${r.endpointRuns} of each request; latency from the client. The 50 queries of \`apps/server/src/search/bench/perf.ts\`, compiled by the production compiler (M1-037) and run as an ordinary member (the person at the tenth percentile of assignments, a member of every other track, one ticket in a hundred at a visibility level they are not in) and as a site administrator.`,
    '',
    `Budget: p95 under 300 ms at 1M tickets (10M is an estimate from these runs: decisions.csv, 2026-11-01). Slowest statement p95 here: ${worst(member, (q) => q.statement.p95)} ms (member), ${Math.max(...[...admin.values()].map((q) => q.statement.p95))} ms (administrator); slowest request p95: ${worst(member, (q) => q.endpoint?.p95 ?? 0)} ms.`,
    '',
    '| Query | Text | Rows | Walk | Member p50 | Member p95 | Admin p95 | Request p95 | Count (capped 10,000) |',
    '|---|---|---:|---|---:|---:|---:|---:|---:|',
    ...member.map((q) => {
      const a = admin.get(q.id);
      return `| ${q.id} | \`${q.text.replace(/\|/g, '\\|') || '(all)'}\` | ${q.rows} | ${q.anchored ? 'side table' : 'ticket'} | ${q.statement.p50} | ${q.statement.p95} | ${a?.statement.p95 ?? ''} | ${q.endpoint?.p95 ?? ''} | ${q.count} in ${q.countMs} ms |`;
    }),
    '',
    ...(r.open
      ? [
          '## Opening a ticket (member)',
          '',
          `Budget: under 100 ms p95, warm. ${r.open.tickets} tickets the member may see, each opened once to warm and then timed: the ticket alone, and the ticket with the ${r.open.requests - 1} requests the ticket page sends with it (info, comments, history, transitions, links), in parallel.`,
          '',
          '| Request | p50 | p95 | Max |',
          '|---|---:|---:|---:|',
          `| The ticket | ${r.open.ticket.p50} | ${r.open.ticket.p95} | ${r.open.ticket.max} |`,
          `| The ticket page's ${r.open.requests} requests | ${r.open.page.p50} | ${r.open.page.p95} | ${r.open.page.max} |`,
          '',
        ]
      : []),
    '## Plans (member)',
    '',
    ...member.flatMap((q) => [`- **${q.id}**: ${q.plan.map((l) => l.trim()).join(' / ')}`]),
    '',
  ];
  return lines.join('\n');
}
