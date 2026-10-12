import { cpus } from 'node:os';
import {
  createDataset,
  loadDataset,
  loadedFingerprint,
  Rng,
  scaleConfig,
} from '@tracksmith/testkit/gen';
import pg from 'pg';
import { summarize, type Timing } from '../bench/stats';
import { bootstrap, follow, mutate, SYNC_SQL } from './changelog';

export interface SyncBenchOptions {
  items: number;
  writers: number;
  mutations: number;
  log?: (m: string) => void;
}

export interface SyncBenchResult {
  spike: 'sync';
  at: string;
  items: number;
  machine: { cpu: string; cores: number; postgres: string };
  bootstrap: {
    spaces: number;
    rows: number;
    bytes: number;
    seconds: number;
    rowsPerSecond: number;
  };
  mutations: { count: number; writers: number; seconds: number; perSecond: number; gaps: number };
  /** Append to follower, while the writers run flat out. */
  deltaUnderLoad: Timing;
  /** Append to follower, one change at a time with idle writers. */
  deltaIdle: Timing;
  outbox: { queued: number; firstRunSeconds: number; replaySeconds: number; appliedTwice: number };
}

/** Picks the fewest newest spaces that hold about `target` items. */
async function spacesHolding(pool: pg.Pool, target: number): Promise<number[]> {
  const { rows } = await pool.query<{ space_id: number; n: string }>(
    'SELECT space_id, count(*) AS n FROM gen.items GROUP BY space_id ORDER BY n DESC',
  );
  const chosen: number[] = [];
  let total = 0;
  for (const r of rows) {
    if (total >= target) break;
    chosen.push(r.space_id);
    total += Number(r.n);
  }
  return chosen;
}

export async function runSyncSpike(pool: pg.Pool, o: SyncBenchOptions): Promise<SyncBenchResult> {
  const log = o.log ?? (() => {});
  const config = scaleConfig(o.items, { seed: 5 });
  if (!(await loadedFingerprint(pool))) {
    log(`Loading ${o.items.toLocaleString('en')} items`);
    await loadDataset(pool, createDataset(config));
  }
  await pool.query('DROP SCHEMA IF EXISTS sync CASCADE');
  await pool.query(SYNC_SQL);
  const url = (pool as unknown as { options: { connectionString: string } }).options
    .connectionString;

  // Bootstrap: a client that may see enough spaces to hold 50k items.
  const spaces = await spacesHolding(pool, 50_000);
  log(`Bootstrapping ${spaces.length} spaces`);
  const bootClient = await pool.connect();
  let t0 = Date.now();
  let boot: Awaited<ReturnType<typeof bootstrap>>;
  try {
    boot = await bootstrap(bootClient, spaces, () => {});
  } finally {
    bootClient.release();
  }
  const bootSeconds = (Date.now() - t0) / 1000;
  log(
    `  ${boot.rows.toLocaleString('en')} rows, ${(boot.bytes / 1e6).toFixed(1)} MB in ${bootSeconds}s`,
  );

  // Mutations from several writers, a follower measuring delta latency meanwhile.
  const ids = await pool.query<{ id: string; space_id: number }>(
    'SELECT id, space_id FROM gen.items WHERE space_id = ANY($1::int[]) ORDER BY random() LIMIT $2',
    [spaces, o.mutations],
  );
  const targets = ids.rows;
  const follower = new pg.Client({ connectionString: url });
  await follower.connect();
  const underLoad: number[] = [];
  const following = follow(follower, spaces, boot.startSeq, targets.length, (ms) =>
    underLoad.push(ms),
  );
  log(`Applying ${targets.length.toLocaleString('en')} mutations from ${o.writers} writers`);
  t0 = Date.now();
  let next = 0;
  const statuses = ['To Do', 'In Progress', 'Done'];
  const rng = new Rng(9);
  const writer = async () => {
    const client = await pool.connect();
    try {
      for (;;) {
        const i = next++;
        const target = targets[i];
        if (!target) return;
        await mutate(client, {
          itemId: target.id,
          spaceId: target.space_id,
          status: statuses[rng.int(0, 2)] ?? 'Done',
        });
      }
    } finally {
      client.release();
    }
  };
  await Promise.all(Array.from({ length: o.writers }, writer));
  const mutationSeconds = (Date.now() - t0) / 1000;
  const followed = await following;
  log(
    `  ${Math.round(targets.length / mutationSeconds)} mutations/s; follower saw ${followed.seen}`,
  );

  // Sequence check: commit-ordered and gap-free.
  const seqs = await pool.query<{ n: string; lo: string; hi: string }>(
    'SELECT count(*) AS n, min(seq) AS lo, max(seq) AS hi FROM sync.change_log',
  );
  const n = Number(seqs.rows[0]?.n);
  const gaps = Number(seqs.rows[0]?.hi) - Number(seqs.rows[0]?.lo) + 1 - n;

  // Idle delta latency: one change at a time.
  const idle: number[] = [];
  const idleStart = await pool.query<{ seq: string }>(
    'SELECT max(seq) AS seq FROM sync.change_log',
  );
  const idleFollow = follow(follower, spaces, Number(idleStart.rows[0]?.seq), 200, (ms) =>
    idle.push(ms),
  );
  const idleClient = await pool.connect();
  try {
    for (let i = 0; i < 200; i++) {
      const target = targets[i % targets.length];
      if (!target) break;
      await mutate(idleClient, { itemId: target.id, spaceId: target.space_id, status: 'Done' });
      await new Promise((r) => setTimeout(r, 5));
    }
  } finally {
    idleClient.release();
  }
  await idleFollow;
  await follower.end();

  // Offline outbox: 1,000 queued mutations replayed twice.
  const queued = targets.slice(0, 1_000).map((t, i) => ({
    clientId: 'laptop-1',
    mutationId: i + 1,
    itemId: t.id,
    spaceId: t.space_id,
  }));
  const replay = async () => {
    const client = await pool.connect();
    let applied = 0;
    try {
      for (const q of queued) {
        const r = await mutate(client, { itemId: q.itemId, spaceId: q.spaceId, status: 'Done' }, q);
        if (r.applied) applied++;
      }
    } finally {
      client.release();
    }
    return applied;
  };
  t0 = Date.now();
  await replay();
  const firstRunSeconds = (Date.now() - t0) / 1000;
  t0 = Date.now();
  const appliedTwice = await replay();
  const replaySeconds = (Date.now() - t0) / 1000;
  log(
    `  outbox: ${queued.length} queued, first run ${firstRunSeconds}s, replay applied ${appliedTwice}`,
  );

  const version = await pool.query<{ v: string }>(`SELECT current_setting('server_version') AS v`);
  return {
    spike: 'sync',
    at: new Date().toISOString(),
    items: o.items,
    machine: {
      cpu: cpus()[0]?.model.trim() ?? 'unknown',
      cores: cpus().length,
      postgres: version.rows[0]?.v ?? 'unknown',
    },
    bootstrap: {
      spaces: spaces.length,
      rows: boot.rows,
      bytes: boot.bytes,
      seconds: bootSeconds,
      rowsPerSecond: Math.round(boot.rows / bootSeconds),
    },
    mutations: {
      count: targets.length,
      writers: o.writers,
      seconds: mutationSeconds,
      perSecond: Math.round(targets.length / mutationSeconds),
      gaps,
    },
    deltaUnderLoad: summarize('delta-under-load', underLoad),
    deltaIdle: summarize('delta-idle', idle),
    outbox: { queued: queued.length, firstRunSeconds, replaySeconds, appliedTwice },
  };
}

export function renderSyncReport(r: SyncBenchResult): string {
  const lines = [
    `# Sync engine spike, in-house change log: ${r.items.toLocaleString('en')} items`,
    '',
    `Generated ${r.at.slice(0, 16).replace('T', ' ')} UTC on ${r.machine.cpu} (${r.machine.cores} threads), PostgreSQL ${r.machine.postgres}.`,
    '',
    'Budget (M0-019): bootstrap of 50k items and delta p95 measured; NTF-008 wants a change on another screen within 1 s (p95).',
    '',
    '| Measure | Value |',
    '|---|---:|',
    `| Bootstrap: spaces / rows / MB | ${r.bootstrap.spaces} / ${r.bootstrap.rows.toLocaleString('en')} / ${(r.bootstrap.bytes / 1e6).toFixed(1)} |`,
    `| Bootstrap time | ${r.bootstrap.seconds}s (${r.bootstrap.rowsPerSecond.toLocaleString('en')} rows/s) |`,
    `| Mutations | ${r.mutations.count.toLocaleString('en')} from ${r.mutations.writers} writers in ${r.mutations.seconds}s (${r.mutations.perSecond.toLocaleString('en')}/s) |`,
    `| Sequence gaps | ${r.mutations.gaps} |`,
    `| Delta latency under load p50 / p95 / max ms | ${r.deltaUnderLoad.p50} / ${r.deltaUnderLoad.p95} / ${r.deltaUnderLoad.max} |`,
    `| Delta latency idle p50 / p95 / max ms | ${r.deltaIdle.p50} / ${r.deltaIdle.p95} / ${r.deltaIdle.max} |`,
    `| Outbox replay: queued / first run s / second run s / applied twice | ${r.outbox.queued} / ${r.outbox.firstRunSeconds} / ${r.outbox.replaySeconds} / ${r.outbox.appliedTwice} |`,
  ];
  return `${lines.join('\n')}\n`;
}
