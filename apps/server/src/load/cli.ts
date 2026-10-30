// pnpm load [--items 100000] [--users 2000] [--tiers 50,500,2000] [--hold 2m] [--port 18090]
//
// Load tests with k6 (M1-104; NFR-003; ADR-082): a generated dataset in the product schema (the
// search bench's loader), a person per virtual user with an API token and membership of the 40
// largest tracks, the server started as it runs in production (rate limits on), and k6 at each
// tier of users. Each person opens tickets, searches, reads a board and the history, edits,
// comments and creates (a quarter of requests write), resting 5 to 15 seconds between steps.
// Writes docs/ops/data/load-<label>.json and docs/ops/load-tests.md with the sizing table.
//
// Benchmark tooling: the server never imports it. Needs k6 on the PATH.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDb, migrateToLatest } from '@taskmoor/db';
import {
  createDataset,
  datasetFingerprint,
  loadDataset,
  loadedFingerprint,
  scaleConfig,
} from '@taskmoor/testkit/gen';
import { openBenchDatabase } from '@taskmoor/testkit/server';
import { sql } from 'kysely';
import { loaded, loadFromGen } from '../search/bench/load';
import { issueApiToken } from '../tokens/api-tokens';
import { renderReport, type TierResult } from './report';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const { values } = parseArgs({
  options: {
    items: { type: 'string', default: '100000' },
    users: { type: 'string' },
    tiers: { type: 'string', default: '50,500,2000' },
    hold: { type: 'string', default: '2m' },
    ramp: { type: 'string', default: '30s' },
    port: { type: 'string', default: '18090' },
    label: { type: 'string' },
  },
});
const items = Number(values.items.replaceAll('_', ''));
const tiers = values.tiers.split(',').map(Number);
const users = Number(values.users ?? Math.max(...tiers));
const port = Number(values.port);
const label = values.label ?? `${Math.round(items / 1000)}k`;
const log = (m: string) => process.stdout.write(`${m}\n`);

if (spawnSync('k6', ['version']).status !== 0) {
  process.stderr.write('k6 is not on the PATH (brew install k6, or see docs/ops/load-tests.md)\n');
  process.exit(2);
}

const bench = await openBenchDatabase(`load_${items}`, { maxConnections: 4 });
let server: ChildProcess | undefined;
try {
  // The dataset, once per size.
  const config = scaleConfig(items, {});
  if ((await loadedFingerprint(bench.pool)) !== datasetFingerprint(config)) {
    log(`Generating ${items.toLocaleString('en')} tickets...`);
    await loadDataset(bench.pool, createDataset(config));
  }
  const db = createDb({ connectionString: bench.url, maxConnections: 4 });
  try {
    await migrateToLatest(db);
    if (!(await loaded(db))) {
      log('Loading the dataset into the product schema...');
      await loadFromGen(db, log);
    }
    const fixtures = await prepare(db);
    const fixturesPath = join(ROOT, '.cache/load/fixtures.json');
    mkdirSync(join(ROOT, '.cache/load'), { recursive: true });
    writeFileSync(fixturesPath, JSON.stringify(fixtures));

    server = await startServer(bench.url);
    const results: TierResult[] = [];
    for (const tier of tiers) {
      log(`== ${tier} users`);
      results.push(await runTier(tier, fixturesPath, server.pid as number));
    }
    const machine = {
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model ?? '',
      memoryGb: Math.round(totalmem() / 2 ** 30),
      platform: `${process.platform}/${process.arch}`,
    };
    const data = {
      label,
      at: new Date().toISOString(),
      items,
      hold: values.hold,
      ramp: values.ramp,
      machine,
      tiers: results,
    };
    mkdirSync(join(ROOT, 'docs/ops/data'), { recursive: true });
    writeFileSync(
      join(ROOT, `docs/ops/data/load-${label}.json`),
      `${JSON.stringify(data, null, 2)}\n`,
    );
    writeFileSync(join(ROOT, 'docs/ops/load-tests.md'), renderReport(data));
    log('Wrote docs/ops/load-tests.md');
  } finally {
    await db.destroy();
  }
} finally {
  server?.kill('SIGTERM');
  await bench.close();
}

/** People, tokens, tracks, a board and tickets for the scenario. */
async function prepare(db: ReturnType<typeof createDb>) {
  // The bench loader writes with triggers off, so the key histories a lookup by key reads are
  // empty: fill them as the triggers would have, once.
  await sql`INSERT INTO track_key_history (workspace_id, track_id, key)
    SELECT t.workspace_id, t.id, t.key FROM track t
     WHERE NOT EXISTS (SELECT 1 FROM track_key_history h WHERE h.track_id = t.id)`.execute(db);
  await sql`INSERT INTO ticket_key_history (workspace_id, ticket_id, track_id, number)
    SELECT k.workspace_id, k.id, k.track_id, k.number FROM ticket k
     WHERE NOT EXISTS (SELECT 1 FROM ticket_key_history h WHERE h.ticket_id = k.id)`.execute(db);
  const members = (
    await sql<{
      id: number;
    }>`SELECT id FROM role WHERE workspace_id = 1 AND name = 'Members'`.execute(db)
  ).rows[0]?.id as number;
  await sql`INSERT INTO app_user (workspace_id, email, name)
    SELECT 1, 'load-' || g || '@load.test', 'Load ' || g FROM generate_series(1, ${users}) g
    ON CONFLICT DO NOTHING`.execute(db);
  const people = (
    await sql<{ id: number }>`SELECT id FROM app_user WHERE email LIKE 'load-%@load.test'
      ORDER BY id LIMIT ${users}`.execute(db)
  ).rows.map((r) => r.id);
  const tracks = (
    await sql<{ id: number; key: string }>`
      SELECT t.id, t.key FROM track t JOIN ticket k ON k.track_id = t.id
       GROUP BY t.id ORDER BY count(*) DESC LIMIT 40`.execute(db)
  ).rows;
  await sql`INSERT INTO track_role_actor (workspace_id, track_id, role_id, user_id)
    SELECT 1, t, ${members}, u FROM unnest(${tracks.map((t) => t.id)}::int[]) t,
           unnest(${people}::int[]) u
    WHERE NOT EXISTS (SELECT 1 FROM track_role_actor a WHERE a.track_id = t AND a.user_id = u)`.execute(
    db,
  );
  // A token per person, made each run: no credential is kept anywhere but .cache.
  await sql`DELETE FROM api_token WHERE name = 'load test'`.execute(db);
  const expiresAt = new Date(Date.now() + 2 * 24 * 3600 * 1000);
  const tokens: string[] = [];
  for (const userId of people) {
    const { token } = await issueApiToken(db, {
      workspaceId: 1,
      userId,
      name: 'load test',
      scopes: ['read', 'write'],
      expiresAt,
      createdBy: null,
    });
    tokens.push(token);
  }
  // A board on a mid-sized track (the tenth largest): one column per stage.
  const boardTrack = tracks[Math.min(9, tracks.length - 1)] as { id: number; key: string };
  const stages = (
    await sql<{ stage: string; ids: number[] }>`
      SELECT s.stage, array_agg(DISTINCT s.id ORDER BY s.id) AS ids
        FROM ticket k JOIN status s ON s.id = k.status_id
       WHERE k.track_id = ${boardTrack.id} GROUP BY s.stage`.execute(db)
  ).rows;
  const order = ['new', 'active', 'closed'];
  const columns = order
    .map((stage, i) => ({
      id: `c${i + 1}`,
      name: stage,
      statusIds: stages.find((s) => s.stage === stage)?.ids ?? [],
      min: null,
      max: null,
    }))
    .filter((c) => c.statusIds.length > 0);
  const board = (
    await sql<{ id: number }>`INSERT INTO board (workspace_id, name, kind, location_track_id,
        filter_query, columns, swimlanes, card_rules)
      VALUES (1, ${`Load ${boardTrack.key} ${Date.now()}`}, 'kanban', ${boardTrack.id},
        ${`track = ${boardTrack.key}`}, ${JSON.stringify(columns)}::jsonb,
        '{"mode": "none", "lanes": [], "unassigned": "last", "otherName": "Everything else"}'::jsonb,
        '{"colourBy": "type", "colours": [], "fields": [], "daysInColumn": true}'::jsonb)
      RETURNING id`.execute(db)
  ).rows[0]?.id as number;
  const keys = (
    await sql<{ key: string }>`
      SELECT t.key || '-' || k.number AS key FROM ticket k JOIN track t ON t.id = k.track_id
       WHERE k.track_id = ANY(${tracks.map((t) => t.id)}::int[]) AND k.deleted_at IS NULL
         AND k.visibility_level_id IS NULL
       ORDER BY random() LIMIT 5000`.execute(db)
  ).rows.map((r) => r.key);
  const statuses = (
    await sql<{
      name: string;
    }>`SELECT DISTINCT s.name FROM ticket k JOIN status s ON s.id = k.status_id
       WHERE k.track_id = ANY(${tracks.map((t) => t.id)}::int[])`.execute(db)
  ).rows.map((r) => r.name);
  const boardTickets = Number(
    (
      await sql<{
        n: string;
      }>`SELECT count(*) AS n FROM ticket WHERE track_id = ${boardTrack.id}`.execute(db)
    ).rows[0]?.n,
  );
  log(
    `Prepared ${tokens.length} people in ${tracks.length} tracks, board ${board} (${boardTickets} tickets), ${keys.length} tickets to open`,
  );
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    tokens,
    tracks: tracks.map((t) => t.key),
    statuses,
    board,
    boardTickets,
    keys,
  };
}

/** The server as it runs in production, API and worker roles, waiting until it is ready. */
async function startServer(databaseUrl: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'apps/server/src/main.ts')],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        HOST: '127.0.0.1',
        TASKMOOR_ROLE: 'api,worker',
        PUBLIC_URL: `http://127.0.0.1:${port}`,
        LOG_LEVEL: 'warn',
        METRICS_PORT: '0',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ready`);
      if (res.ok) return child;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill('SIGTERM');
  throw new Error('the server did not become ready');
}

/** CPU seconds a process and its children have used, from ps. */
function cpuSeconds(pids: number[]): number {
  const out = spawnSync('ps', ['-o', 'cputime=', '-p', pids.join(',')], { encoding: 'utf8' });
  return out.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .reduce((sum, t) => {
      const parts = t.split(/[:.]/).map(Number);
      // [[dd-]hh:]mm:ss.cc
      const [m = 0, s = 0, cs = 0] = parts.slice(-3);
      const h = parts.length > 3 ? (parts[parts.length - 4] as number) : 0;
      return sum + h * 3600 + m * 60 + s + cs / 100;
    }, 0);
}

/** A process and all its descendants: the server runs under tsx, PostgreSQL under its postmaster. */
function processTree(root: number): number[] {
  const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  const children = new Map<number, number[]>();
  for (const line of out.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const all = [root];
  for (let i = 0; i < all.length; i++) all.push(...(children.get(all[i] as number) ?? []));
  return all;
}

/** The bench cluster's postmaster, found by its data folder. */
function postgresPids(): number[] {
  const out = spawnSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  const line = out.stdout.split('\n').find((l) => /bin\/postgres -D \S*pg-test\/bench/.test(l));
  return line ? processTree(Number(line.trim().split(/\s+/)[0])) : [];
}

function rssMb(pids: number[]): number {
  const out = spawnSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
  const kb = out.stdout
    .split('\n')
    .map((l) => Number(l.trim() || 0))
    .reduce((a, b) => a + b, 0);
  return Math.round(kb / 1024);
}

async function runTier(tier: number, fixturesPath: string, serverPid: number): Promise<TierResult> {
  const summaryPath = join(ROOT, `.cache/load/summary-${tier}.json`);
  const pg = postgresPids();
  const server = processTree(serverPid);
  const serverCpu0 = cpuSeconds(server);
  const pgCpu0 = cpuSeconds(pg);
  let peakRss = rssMb(server);
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, rssMb(processTree(serverPid)));
  }, 2000);
  const t0 = Date.now();
  const run = spawnSync(
    'k6',
    [
      'run',
      '--quiet',
      '--summary-export',
      summaryPath,
      '-e',
      `FIXTURES=${fixturesPath}`,
      '-e',
      `USERS=${tier}`,
      '-e',
      `HOLD=${values.hold}`,
      '-e',
      `RAMP=${values.ramp}`,
      join(ROOT, 'tools/load/scenario.js'),
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  clearInterval(sampler);
  const seconds = (Date.now() - t0) / 1000;
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
    metrics: Record<string, Record<string, number>>;
  };
  const metric = (name: string) => summary.metrics[name] ?? {};
  const actions = ['open_ticket', 'search', 'board', 'history', 'edit', 'comment', 'create'];
  return {
    users: tier,
    seconds: Math.round(seconds),
    k6Exit: run.status ?? -1,
    requests: Math.round(metric('http_reqs').count ?? 0),
    requestsPerSecond: Math.round((metric('http_reqs').rate ?? 0) * 10) / 10,
    errorRate: Math.round((metric('http_req_failed').value ?? 0) * 10_000) / 10_000,
    p95: Object.fromEntries(
      actions.map((a) => [a, Math.round((metric(a)['p(95)'] ?? 0) * 10) / 10]),
    ),
    p50: Object.fromEntries(
      actions.map((a) => [a, Math.round((metric(a).med ?? metric(a)['p(50)'] ?? 0) * 10) / 10]),
    ),
    serverCpuSeconds: Math.round((cpuSeconds(processTree(serverPid)) - serverCpu0) * 10) / 10,
    postgresCpuSeconds: Math.round((cpuSeconds(postgresPids()) - pgCpu0) * 10) / 10,
    serverPeakRssMb: peakRss,
  };
}
