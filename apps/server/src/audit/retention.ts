import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import { enqueue, type JobRunner } from '../events/queue';
import { readSetting } from '../setup';
import { defaultWorkspaceId } from '../workspace';
import {
  appendAudit,
  type ChainStatus,
  ensurePartition,
  monthStart,
  PARTITION_LOCK,
  partitionMonth,
  verifyChain,
} from './chain';
import { AUDIT_ACTIONS } from './record';

/**
 * Audit retention (M1-003, ADR-034, IAM-013): an administrator sets how many months the log
 * keeps (default 12, 0 keeps it forever, no upper limit below 100 years). The retention job
 * drops every monthly partition whose month ended at least that many whole months before the
 * current month began, so a record is kept for at least the configured time. Partitions are
 * shared by all workspaces, so the setting is instance-wide.
 *
 * Before a partition goes, the part of each chain it holds is verified; a broken range is kept
 * as evidence and reported instead. The last dropped record's seq and hash become the chain's
 * checkpoint, where verification starts from then on, and a record of the drop is appended.
 */
export const RETENTION_SETTING = 'audit_retention';
export const DEFAULT_RETENTION_MONTHS = 12;
export const MAX_RETENTION_MONTHS = 1200;

export async function retentionMonths(db: Kysely<Database>): Promise<number> {
  const stored = await readSetting<{ months?: unknown }>(db, RETENTION_SETTING);
  const months = stored?.months;
  return typeof months === 'number' && Number.isInteger(months) && months >= 0
    ? months
    : DEFAULT_RETENTION_MONTHS;
}

export interface RetentionReport {
  /** Partitions made ahead (this month and the next). */
  created: string[];
  dropped: { partition: string; records: number }[];
  /** A range that failed verification: kept, and the partitions after it too. */
  blocked: { partition: string; status: ChainStatus } | null;
}

/** Every partition this code made, oldest first. */
export async function listPartitions(
  db: Kysely<Database>,
): Promise<{ name: string; month: Date }[]> {
  const { rows } = await sql<{ name: string }>`
    SELECT c.relname AS name FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'audit_event'::regclass`.execute(db);
  return rows
    .map((r) => ({ name: r.name, month: partitionMonth(r.name) }))
    .filter((p): p is { name: string; month: Date } => p.month !== null)
    .sort((a, b) => a.month.getTime() - b.month.getTime());
}

/**
 * Makes this month's and next month's partitions, then drops the partitions retention no
 * longer keeps. Safe to run from several workers at once.
 */
export async function applyRetention(
  db: Kysely<Database>,
  options: { now?: Date } = {},
): Promise<RetentionReport> {
  const now = options.now ?? new Date();
  const report: RetentionReport = { created: [], dropped: [], blocked: null };
  for (const at of [monthStart(now), monthStart(now, 1)]) {
    if (await ensurePartition(db, at)) report.created.push(at.toISOString().slice(0, 7));
  }
  const months = await retentionMonths(db);
  if (months === 0) return report;
  // A partition goes when its month ended on or before the start of the month `months` back.
  const keepFrom = monthStart(now, -months);

  for (const partition of await listPartitions(db)) {
    if (monthStart(partition.month, 1) > keepFrom) break;
    const { rows: tails } = await sql<{ workspace_id: number; last: string; n: string }>`
      SELECT workspace_id, max(seq) AS last, count(*) AS n
        FROM ${sql.table(partition.name)} GROUP BY workspace_id ORDER BY workspace_id`.execute(db);
    for (const tail of tails) {
      const status = await verifyChain(db, tail.workspace_id, { through: Number(tail.last) });
      if (!status.ok) {
        report.blocked = { partition: partition.name, status };
        return report;
      }
    }
    const dropped = await db.transaction().execute(async (trx) => {
      // Lock order as in appends: chain heads first, then the partition lock.
      await sql`
        SELECT 1 FROM audit_chain WHERE workspace_id = ANY(${tails.map((t) => t.workspace_id)}::int[])
         ORDER BY workspace_id FOR UPDATE`.execute(trx);
      await sql`SELECT pg_advisory_xact_lock(${PARTITION_LOCK})`.execute(trx);
      const { rows } = await sql<{ ok: boolean }>`
        SELECT to_regclass(${partition.name}) IS NOT NULL AS ok`.execute(trx);
      if (!rows[0]?.ok) return false; // another worker dropped it
      for (const tail of tails) {
        await sql`
          UPDATE audit_chain c
             SET checkpoint_seq = e.seq, checkpoint_hash = e.hash, checkpoint_at = ${now}
            FROM ${sql.table(partition.name)} e
           WHERE c.workspace_id = ${tail.workspace_id}
             AND e.workspace_id = ${tail.workspace_id} AND e.seq = ${tail.last}
             AND c.checkpoint_seq < e.seq`.execute(trx);
      }
      await sql`DROP TABLE ${sql.table(partition.name)}`.execute(trx);
      return true;
    });
    if (!dropped) continue;
    const records = tails.reduce((n, t) => n + Number(t.n), 0);
    report.dropped.push({ partition: partition.name, records });
    await appendAudit(
      db,
      tails.map((tail) => ({
        workspaceId: tail.workspace_id,
        action: AUDIT_ACTIONS.partitionDropped,
        actorId: null,
        details: {
          month: partition.month.toISOString().slice(0, 7),
          records: Number(tail.n),
          throughSeq: Number(tail.last),
          retentionMonths: months,
        },
      })),
      options.now ? { now: options.now } : {},
    );
  }
  return report;
}

/** The queued job that runs retention; its key makes it run once a day across all workers. */
export const RETENTION_TASK = 'audit.retention';

export async function scheduleRetention(db: Kysely<Database>, now = new Date()): Promise<boolean> {
  const workspaceId = await defaultWorkspaceId(db);
  const added = await enqueue(db, [
    {
      workspaceId,
      task: RETENTION_TASK,
      key: `${RETENTION_TASK}:${now.toISOString().slice(0, 10)}`,
    },
  ]);
  return added > 0;
}

export function registerAuditJobs(
  runner: JobRunner,
  db: Kysely<Database>,
  onBlocked: (blocked: NonNullable<RetentionReport['blocked']>) => void = () => {},
): void {
  runner.handle(RETENTION_TASK, async () => {
    const report = await applyRetention(db);
    if (report.blocked) onBlocked(report.blocked);
  });
}
