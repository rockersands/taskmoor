import { cpus } from 'node:os';
import { Rng } from '@tracksmith/testkit/gen';
import type pg from 'pg';
import { summarize, type Timing } from '../bench/stats';
import {
  compileTemplate,
  datasetContext,
  prepareQueryIndexes,
  TEMPLATES,
} from '../query-bench/run';
import { allowedSpaces, loadAuthz, PermissionCache, permissionsFor } from './evaluator';
import { type AuthzConfig, type AuthzModel, createAuthzModel, PERMISSIONS } from './model';
import { openFgaAvailable, prepareOpenFga, startOpenFga } from './openfga';

export interface AuthzBenchOptions {
  config: AuthzConfig;
  /** Random (user, space, permission) checks per candidate. */
  checks: number;
  /** Users whose allowed-space list is computed. */
  listUsers: number;
  /** Datastore URI for the OpenFGA co-process; undefined skips it. */
  openFgaDatastore?: string;
  log?: (m: string) => void;
}

export interface AuthzCandidateResult {
  id: 'inprocess-cold' | 'inprocess-cached' | 'openfga';
  check: Timing;
  /** Allowed-space list for one user (the search pre-filter). */
  list: Timing & { medianSpaces: number };
  loadSeconds: number;
  /** Disagreements with the reference reading of the model over the sampled checks. */
  mismatches: number;
}

export interface AuthzBenchResult {
  spike: 'authz';
  at: string;
  config: AuthzConfig;
  counts: { memberships: number; grants: number; roleActors: number; tuples?: number };
  checks: number;
  machine: { cpu: string; cores: number; postgres: string };
  candidates: AuthzCandidateResult[];
}

interface Sample {
  user: number;
  space: number;
  permission: string;
}

function samples(model: AuthzModel, count: number, seed: number): Sample[] {
  const rng = new Rng(seed);
  // Half the checks pick a user who acts in the space, so "allowed" and "denied" both occur.
  return Array.from({ length: count }, (_, i) => {
    const space = rng.int(1, model.config.spaces);
    const permission = rng.pick(PERMISSIONS);
    if (i % 2 === 0) {
      const actors = model.roleActors.filter((a) => a.spaceId === space && a.kind === 'user');
      const actor = actors.length > 0 ? rng.pick(actors) : undefined;
      if (actor) return { user: actor.id, space, permission };
    }
    return { user: rng.int(1, model.config.users), space, permission };
  });
}

export async function runAuthzSpike(
  pool: pg.Pool,
  o: AuthzBenchOptions,
): Promise<AuthzBenchResult> {
  const log = o.log ?? (() => {});
  log(
    `Generating ${o.config.users.toLocaleString('en')} users, ${o.config.spaces.toLocaleString('en')} spaces`,
  );
  const model = createAuthzModel(o.config);
  const { ReferenceEvaluator } = await import('./model');
  const reference = new ReferenceEvaluator(model);
  const checks = samples(model, o.checks, o.config.seed + 1);
  const listUsers = Array.from({ length: o.listUsers }, (_, i) =>
    Rng.derive(o.config.seed, 'list', i).int(1, o.config.users),
  );
  const candidates: AuthzCandidateResult[] = [];

  log('Loading the in-process tables');
  let t0 = Date.now();
  await loadAuthz(pool, model);
  const loadSeconds = (Date.now() - t0) / 1000;
  log(`  loaded in ${loadSeconds}s`);

  const client = await pool.connect();
  try {
    // Cold: one SQL round trip per check.
    const cold: number[] = [];
    let mismatches = 0;
    for (const c of checks) {
      const start = process.hrtime.bigint();
      const set = await permissionsFor(client, c.user, c.space);
      cold.push(Number(process.hrtime.bigint() - start) / 1e6);
      if (set.has(c.permission) !== reference.check(c.user, c.space, c.permission)) mismatches++;
    }
    const list = await timeLists(listUsers, (u) => allowedSpaces(client, u, 'browse'), reference);
    candidates.push({
      id: 'inprocess-cold',
      check: summarize('inprocess-cold', cold),
      list: list.timing,
      loadSeconds,
      mismatches: mismatches + list.mismatches,
    });
    log(`  cold check p95 ${candidates[0]?.check.p95} ms; list p95 ${list.timing.p95} ms`);

    // Cached: the first pass fills the cache, the second is what a warm server sees.
    const cache = new PermissionCache(client);
    for (const c of checks) await cache.check(c.user, c.space, c.permission);
    const warm: number[] = [];
    let cachedMismatches = 0;
    for (const c of checks) {
      const start = process.hrtime.bigint();
      const allowed = await cache.check(c.user, c.space, c.permission);
      warm.push(Number(process.hrtime.bigint() - start) / 1e6);
      if (allowed !== reference.check(c.user, c.space, c.permission)) cachedMismatches++;
    }
    candidates.push({
      id: 'inprocess-cached',
      check: summarize('inprocess-cached', warm),
      list: list.timing,
      loadSeconds,
      mismatches: cachedMismatches,
    });
    log(`  cached check p95 ${candidates[1]?.check.p95} ms (${cache.hits} hits)`);
  } finally {
    client.release();
  }

  let tuples: number | undefined;
  if (o.openFgaDatastore) {
    if (!openFgaAvailable()) {
      log('OpenFGA binary not found; skipping the co-process candidate');
    } else {
      log('Starting OpenFGA');
      const server = await startOpenFga(o.openFgaDatastore);
      try {
        t0 = Date.now();
        const fga = await prepareOpenFga(server.url, model, log);
        tuples = fga.tuples;
        log(`  ${fga.tuples.toLocaleString('en')} tuples written in ${fga.writeSeconds}s`);
        const times: number[] = [];
        let mismatches = 0;
        for (const c of checks) {
          const start = process.hrtime.bigint();
          const { allowed } = await fga.client.check({
            user: `user:${c.user}`,
            relation: c.permission.replace(/-/g, '_'),
            object: `space:${c.space}`,
          });
          times.push(Number(process.hrtime.bigint() - start) / 1e6);
          if (Boolean(allowed) !== reference.check(c.user, c.space, c.permission)) mismatches++;
        }
        const list = await timeLists(
          listUsers,
          async (u) => {
            const { objects } = await fga.client.listObjects({
              user: `user:${u}`,
              relation: 'browse',
              type: 'space',
            });
            return objects.map((id) => Number(id.slice('space:'.length))).sort((a, b) => a - b);
          },
          reference,
        );
        candidates.push({
          id: 'openfga',
          check: summarize('openfga', times),
          list: list.timing,
          loadSeconds: (Date.now() - t0) / 1000,
          mismatches: mismatches + list.mismatches,
        });
        log(`  openfga check p95 ${candidates[2]?.check.p95} ms; list p95 ${list.timing.p95} ms`);
      } finally {
        await server.stop();
      }
    }
  }

  const version = await pool.query<{ v: string }>(`SELECT current_setting('server_version') AS v`);
  return {
    spike: 'authz',
    at: new Date().toISOString(),
    config: o.config,
    counts: {
      memberships: model.memberships.length,
      grants: model.grants.length,
      roleActors: model.roleActors.length,
      ...(tuples === undefined ? {} : { tuples }),
    },
    checks: o.checks,
    machine: {
      cpu: cpus()[0]?.model.trim() ?? 'unknown',
      cores: cpus().length,
      postgres: version.rows[0]?.v ?? 'unknown',
    },
    candidates,
  };
}

async function timeLists(
  users: readonly number[],
  list: (user: number) => Promise<number[]>,
  reference: { allowedSpaces(user: number, permission: string): number[] },
): Promise<{ timing: Timing & { medianSpaces: number }; mismatches: number }> {
  const times: number[] = [];
  const sizes: number[] = [];
  let mismatches = 0;
  for (const u of users) {
    const start = process.hrtime.bigint();
    const spaces = await list(u);
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
    sizes.push(spaces.length);
    const expected = reference.allowedSpaces(u, 'browse');
    if (expected.length !== spaces.length || expected.some((id, i) => id !== spaces[i])) {
      mismatches++;
    }
  }
  sizes.sort((a, b) => a - b);
  return {
    timing: { ...summarize('list', times), medianSpaces: sizes[Math.floor(sizes.length / 2)] ?? 0 },
    mismatches,
  };
}

/* ---------- Search pre-filter overhead (QRY-008) ---------- */

export interface OverheadResult {
  spike: 'authz-overhead';
  at: string;
  items: number;
  runs: number;
  rows: {
    query: string;
    allowedShare: number;
    unfilteredP95: number;
    filteredP95: number;
    overhead: number;
  }[];
}

const OVERHEAD_QUERIES = ['space-newest', 'mine-open', 'status-priority-in', 'recent-bugs'];

/**
 * Runs a few benchmark queries with and without `space_id = ANY(allowed)` for allowed lists of
 * three sizes, on the dataset the query spike uses. The budget is 20% overhead.
 */
export async function runFilterOverhead(
  pool: pg.Pool,
  options: { runs?: number; log?: (m: string) => void } = {},
): Promise<OverheadResult> {
  const { timeQuery } = await import('../bench/stats');
  const log = options.log ?? (() => {});
  const runs = options.runs ?? 20;
  await prepareQueryIndexes(pool, log);
  const ctx = await datasetContext(pool);
  const spaceIds = Object.values(ctx.catalogue.spaceKeys).sort((a, b) => a - b);
  const rng = new Rng(11);
  const subset = (share: number) =>
    spaceIds.filter(() => rng.chance(share)).concat(spaceIds[0] ?? 1);
  const client = await pool.connect();
  const rows: OverheadResult['rows'] = [];
  try {
    for (const id of OVERHEAD_QUERIES) {
      const template = TEMPLATES.find((t) => t.id === id);
      if (!template) throw new Error(`No template ${id}`);
      const plain = compileTemplate(template.text, ctx, { allowedSpaceIds: null });
      const base = await timeQuery(
        client,
        { name: id, sql: plain.sql.text, params: () => plain.sql.params },
        { runs },
      );
      for (const share of [0.1, 0.5, 0.9]) {
        const allowed = subset(share);
        const filtered = compileTemplate(template.text, ctx, { allowedSpaceIds: allowed });
        const timed = await timeQuery(
          client,
          { name: id, sql: filtered.sql.text, params: () => filtered.sql.params },
          { runs },
        );
        const overhead =
          Math.round(((timed.p95 - base.p95) / Math.max(base.p95, 0.01)) * 100) / 100;
        rows.push({
          query: id,
          allowedShare: share,
          unfilteredP95: base.p95,
          filteredP95: timed.p95,
          overhead,
        });
        log(
          `  ${id} @ ${share}: ${base.p95} ms -> ${timed.p95} ms (${Math.round(overhead * 100)}%)`,
        );
      }
    }
  } finally {
    client.release();
  }
  const count = await pool.query<{ n: string }>('SELECT count(*) AS n FROM fs_side.item');
  return {
    spike: 'authz-overhead',
    at: new Date().toISOString(),
    items: Number(count.rows[0]?.n),
    runs,
    rows,
  };
}

export function renderAuthzReport(result: AuthzBenchResult): string {
  const c = result.config;
  const lines = [
    `# Permission engine spike: ${c.users.toLocaleString('en')} users, ${c.spaces.toLocaleString('en')} spaces`,
    '',
    `Generated ${result.at.slice(0, 16).replace('T', ' ')} UTC on ${result.machine.cpu} (${result.machine.cores} threads), ` +
      `PostgreSQL ${result.machine.postgres}. ${result.checks.toLocaleString('en')} random (user, space, permission) checks per candidate, ` +
      `one at a time, latency from the caller. ${c.groups.toLocaleString('en')} groups, ${c.policies} policies, ` +
      `${result.counts.memberships.toLocaleString('en')} memberships, ${result.counts.roleActors.toLocaleString('en')} role actors, ` +
      `${result.counts.grants.toLocaleString('en')} grants${result.counts.tuples ? `, ${result.counts.tuples.toLocaleString('en')} OpenFGA tuples` : ''}.`,
    '',
    'Budget: check p95 under 10 ms (IAM-012).',
    '',
    '| Candidate | Check p50 ms | Check p95 ms | Check max ms | Allowed-spaces p50 ms | p95 ms | Median spaces | Load s | Mismatches |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...result.candidates.map(
      (r) =>
        `| ${r.id} | ${r.check.p50} | ${r.check.p95} | ${r.check.max} | ${r.list.p50} | ${r.list.p95} | ${r.list.medianSpaces} | ${r.loadSeconds} | ${r.mismatches} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

export function renderOverheadReport(result: OverheadResult): string {
  const worst = Math.max(...result.rows.map((r) => r.overhead));
  const lines = [
    `# Search pre-filter overhead: ${result.items.toLocaleString('en')} items`,
    '',
    `Generated ${result.at.slice(0, 16).replace('T', ' ')} UTC, ${result.runs} timed runs per query, ` +
      'p95 with `space_id = ANY(allowed)` against the same query without it. Budget: 20% overhead.',
    `Worst case: ${Math.round(worst * 100)}%.`,
    '',
    '| Query | Allowed share | Unfiltered p95 ms | Filtered p95 ms | Overhead |',
    '|---|---:|---:|---:|---:|',
    ...result.rows.map(
      (r) =>
        `| ${r.query} | ${r.allowedShare} | ${r.unfilteredP95} | ${r.filteredP95} | ${Math.round(r.overhead * 100)}% |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
