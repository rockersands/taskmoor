import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { type Kysely, sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { JobRunner } from '../events/queue';
import { writeSetting } from '../setup';
import { appendAudit, verifyChain } from './chain';
import { AUDIT_ACTIONS } from './record';
import {
  applyRetention,
  listPartitions,
  RETENTION_SETTING,
  RETENTION_TASK,
  type RetentionReport,
  registerAuditJobs,
  retentionMonths,
  scheduleRetention,
} from './retention';

/**
 * Audit retention (M1-003 done-when: "retention job test green"). Partitions are shared by
 * every workspace, so the scenarios run in order and each uses its own months: the oldest
 * partitions belong to the scenario that runs last.
 */
describe('audit retention (M1-003, ADR-034)', () => {
  const database = useMigratedDatabase();
  let db: Kysely<Database>;
  let workspaces = 0;

  beforeAll(() => {
    db = database.db;
  });

  async function newWorkspace(): Promise<number> {
    const row = await db
      .insertInto('workspace')
      .values({ key: `retention-${++workspaces}`, name: `Retention ${workspaces}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Appends one record per date, in order, as if the log had been written then. */
  async function recordAt(workspaceId: number, ...dates: string[]): Promise<void> {
    for (const date of dates) {
      await appendAudit(
        db,
        [{ workspaceId, action: 'role.created', actorId: null, details: { at: date } }],
        { now: new Date(date) },
      );
    }
  }

  const exists = async (name: string) =>
    (await sql<{ ok: boolean }>`SELECT to_regclass(${name}) IS NOT NULL AS ok`.execute(db)).rows[0]
      ?.ok === true;

  it('[IAM-013] keeps 12 months by default and drops whole older months, moving the checkpoint', async () => {
    const ws = await newWorkspace();
    await recordAt(ws, '2024-01-15', '2024-01-20', '2024-02-15', '2024-02-16');
    await recordAt(ws, '2024-03-15', '2024-03-16', '2024-12-01');
    expect(await retentionMonths(db)).toBe(12);
    const fourth = await db
      .selectFrom('audit_event')
      .select('hash')
      .where('workspace_id', '=', ws)
      .where('seq', '=', '4')
      .executeTakeFirstOrThrow();

    const report = await applyRetention(db, { now: new Date('2025-03-20T12:00:00Z') });

    // March 2024 began twelve whole months before March 2025 did: it stays.
    expect(report).toEqual<RetentionReport>({
      created: ['2025-03', '2025-04'],
      dropped: [
        { partition: 'audit_event_p202401', records: 2 },
        { partition: 'audit_event_p202402', records: 2 },
      ],
      blocked: null,
    });
    expect(await exists('audit_event_p202401')).toBe(false);
    expect(await exists('audit_event_p202403')).toBe(true);
    const status = await verifyChain(db, ws);
    expect(status).toMatchObject({
      ok: true,
      checkpoint: { seq: 4, hash: fourth.hash },
      // The three kept records and one record per dropped month.
      checked: 5,
      head: { seq: 9 },
    });
    const drops = await db
      .selectFrom('audit_event')
      .select(['action', 'details'])
      .where('workspace_id', '=', ws)
      .where('action', '=', AUDIT_ACTIONS.partitionDropped)
      .orderBy('seq')
      .execute();
    expect(drops.map((d) => d.details)).toEqual([
      { month: '2024-01', records: 2, throughSeq: 2, retentionMonths: 12 },
      { month: '2024-02', records: 2, throughSeq: 4, retentionMonths: 12 },
    ]);
    // A second run finds nothing more to do.
    expect((await applyRetention(db, { now: new Date('2025-03-21T00:00:00Z') })).dropped).toEqual(
      [],
    );
  });

  it('[IAM-013] keeps records for seven years when retention is set to 84 months', async () => {
    const ws = await newWorkspace();
    await recordAt(ws, '2019-09-15', '2019-10-02', '2019-10-20', '2026-10-01');
    await writeSetting(db, RETENTION_SETTING, { months: 84 });

    const report = await applyRetention(db, { now: new Date('2026-10-12T08:00:00Z') });

    expect(report.dropped).toEqual([{ partition: 'audit_event_p201909', records: 1 }]);
    const kept = await db
      .selectFrom('audit_event')
      .select('occurred_at')
      .where('workspace_id', '=', ws)
      .where('action', '=', 'role.created')
      .orderBy('seq')
      .execute();
    // Everything from the last seven years, and a little more: months go whole.
    expect(kept.map((r) => r.occurred_at.toISOString().slice(0, 10))).toEqual([
      '2019-10-02',
      '2019-10-20',
      '2026-10-01',
    ]);
    expect((await verifyChain(db, ws)).ok).toBe(true);
  });

  it('[IAM-013] keeps everything when retention is 0', async () => {
    await writeSetting(db, RETENTION_SETTING, { months: 0 });
    const before = await listPartitions(db);
    const report = await applyRetention(db, { now: new Date('2040-01-05T00:00:00Z') });
    expect(report).toEqual({ created: ['2040-01', '2040-02'], dropped: [], blocked: null });
    const after = (await listPartitions(db)).map((p) => p.name);
    for (const p of before) expect(after).toContain(p.name);
  });

  it('[IAM-013] keeps a range that does not verify instead of dropping the evidence', async () => {
    const ws = await newWorkspace();
    await recordAt(ws, '2018-01-15', '2018-01-16', '2018-01-17', '2018-02-15');
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await sql`UPDATE audit_event SET details = '{"at": "never"}'
                 WHERE workspace_id = ${ws} AND seq = 2`.execute(trx);
    });
    await writeSetting(db, RETENTION_SETTING, { months: 12 });

    const report = await applyRetention(db, { now: new Date('2026-10-12T08:00:00Z') });

    expect(report.dropped).toEqual([]);
    expect(report.blocked).toMatchObject({
      partition: 'audit_event_p201801',
      status: { workspaceId: ws, ok: false, firstBroken: { seq: 2, reason: 'hash' } },
    });
    expect(await exists('audit_event_p201801')).toBe(true);
    // Later months wait behind it: the chain is checked from its start.
    expect(await exists('audit_event_p201909')).toBe(false);
    expect(await exists('audit_event_p201910')).toBe(true);
  });

  it('[IAM-013] runs as a queued job once a day across workers and reports a blocked range', async () => {
    const day = new Date('2026-10-12T03:00:00Z');
    expect(await scheduleRetention(db, day)).toBe(true);
    expect(await scheduleRetention(db, new Date('2026-10-12T22:00:00Z'))).toBe(false);
    const jobs = await db
      .selectFrom('job')
      .select(['task', 'key'])
      .where('task', '=', RETENTION_TASK)
      .execute();
    expect(jobs).toEqual([{ task: RETENTION_TASK, key: 'audit.retention:2026-10-12' }]);

    const blocked: string[] = [];
    const runner = new JobRunner(db, 'retention-test');
    registerAuditJobs(runner, db, (b) => blocked.push(b.partition));
    expect(await runner.runOnce()).toBe(1);
    expect(blocked).toEqual(['audit_event_p201801']);
  });
});
