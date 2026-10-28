import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import { queueRun, runSync, type SyncDeps } from './sync';

/**
 * Directory syncs in the worker role (M1-082, IAM-005): due directories get a queued run, and
 * workers claim queued runs, at most one running per directory (a partial unique index) and a
 * few per worker. Runs are long, so they live in `ldap_sync_run` rather than the job queue,
 * whose jobs are released after ten minutes: a running run's heartbeat moves every 30 seconds,
 * and a run whose heartbeat stopped for five minutes belonged to a worker that died.
 */
const STALE_MS = 5 * 60 * 1000;
const POLL_MS = 15_000;
const KEEP_RUNS = 100;

/** Queues an incremental run for every enabled directory whose time has come. */
export async function scheduleDirectories(db: Kysely<Database>): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const { rows } = await sql<{ id: number; workspace_id: number }>`
      WITH due AS (
        SELECT id FROM ldap_directory
         WHERE enabled AND (next_sync_at IS NULL OR next_sync_at <= now())
         ORDER BY id
         FOR UPDATE SKIP LOCKED)
      UPDATE ldap_directory d
         SET next_sync_at = now() + make_interval(mins => d.sync_interval_minutes)
        FROM due WHERE d.id = due.id
      RETURNING d.id, d.workspace_id`.execute(trx);
    for (const row of rows) {
      await queueRun(trx, {
        workspaceId: row.workspace_id,
        directoryId: row.id,
        mode: 'incremental',
        trigger: 'schedule',
        requestedBy: null,
        confirmRemovals: false,
      });
    }
    return rows.length;
  });
}

/** Ends runs whose worker stopped beating. */
export async function failStaleRuns(db: Kysely<Database>, olderThanMs = STALE_MS): Promise<number> {
  const result = await db
    .updateTable('ldap_sync_run')
    .set({ status: 'failed', error: 'worker_lost', finished_at: new Date() })
    .where('status', '=', 'running')
    .where('heartbeat_at', '<', new Date(Date.now() - olderThanMs))
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/** Claims the oldest queued run of a directory that has none running. */
export async function claimRun(db: Kysely<Database>, worker: string): Promise<number | null> {
  try {
    const { rows } = await sql<{ id: number }>`
      UPDATE ldap_sync_run r
         SET status = 'running', worker = ${worker}, started_at = now(), heartbeat_at = now()
       WHERE r.id = (
         SELECT q.id FROM ldap_sync_run q
          WHERE q.status = 'queued'
            AND NOT EXISTS (SELECT 1 FROM ldap_sync_run x
                             WHERE x.directory_id = q.directory_id AND x.status = 'running')
          ORDER BY q.id
          LIMIT 1
          FOR UPDATE SKIP LOCKED)
      RETURNING r.id`.execute(db);
    return rows[0]?.id ?? null;
  } catch (error) {
    // Another worker started a run of the same directory in the meantime.
    if ((error as { code?: string }).code === '23505') return null;
    throw error;
  }
}

/** Keeps the latest runs of each directory. */
export async function pruneRuns(db: Kysely<Database>, keep = KEEP_RUNS): Promise<void> {
  await sql`
    DELETE FROM ldap_sync_run r
     USING (SELECT id, row_number() OVER (PARTITION BY directory_id ORDER BY id DESC) AS n
              FROM ldap_sync_run WHERE status IN ('succeeded', 'failed')) old
     WHERE r.id = old.id AND old.n > ${keep}`.execute(db);
}

/**
 * The worker's directory loop: every 15 seconds, end stale runs, queue due ones and start
 * queued ones up to `maxConcurrent`. `stop` ends running syncs at their next chunk.
 */
export function startDirectorySync(
  db: Kysely<Database>,
  options: { worker: string; maxConcurrent?: number; pollMs?: number } & SyncDeps,
): { stop: () => Promise<void>; tick: () => Promise<void> } {
  const running = new Set<Promise<unknown>>();
  const abort = new AbortController();
  const max = options.maxConcurrent ?? 2;
  let ticking: Promise<void> | null = null;
  let lastPrune = 0;
  const once = async () => {
    await failStaleRuns(db);
    await scheduleDirectories(db);
    if (Date.now() - lastPrune > 60 * 60 * 1000) {
      lastPrune = Date.now();
      await pruneRuns(db);
    }
    while (running.size < max && !abort.signal.aborted) {
      const id = await claimRun(db, options.worker);
      if (id === null) break;
      const work: Promise<unknown> = runSync(db, id, { ...options, signal: abort.signal })
        .catch((error) =>
          options.log?.('directory sync crashed', { runId: id, error: String(error) }),
        )
        .finally(() => running.delete(work));
      running.add(work);
    }
  };
  const tick = () => {
    if (!ticking) {
      ticking = once()
        .catch((error) => options.log?.('directory scheduling failed', { error: String(error) }))
        .finally(() => {
          ticking = null;
        });
    }
    return ticking;
  };
  const timer = setInterval(() => void tick(), options.pollMs ?? POLL_MS);
  timer.unref();
  void tick();
  return {
    tick: async () => {
      await tick();
      await Promise.allSettled([...running]);
    },
    stop: async () => {
      clearInterval(timer);
      abort.abort();
      await ticking;
      await Promise.allSettled([...running]);
    },
  };
}
