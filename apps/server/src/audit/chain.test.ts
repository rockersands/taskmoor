import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { type Kysely, sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type AuditEntry,
  appendAudit,
  auditHash,
  canonicalJson,
  GENESIS_HASH,
  partitionName,
  verifyChain,
} from './chain';

/**
 * The audit hash chain (M1-003 done-when: "Tamper test detects an edited row"). Each scenario
 * uses its own workspace, so its chain starts empty.
 */
describe('audit hash chain (M1-003, ADR-034)', () => {
  const database = useMigratedDatabase();
  let db: Kysely<Database>;
  let workspaces = 0;

  beforeAll(() => {
    db = database.db;
  });

  async function newWorkspace(): Promise<number> {
    const row = await db
      .insertInto('workspace')
      .values({ key: `chain-${++workspaces}`, name: `Chain ${workspaces}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  const entry = (workspaceId: number, n: number): AuditEntry => ({
    workspaceId,
    action: 'group.created',
    actorId: null,
    subjectType: 'group',
    subjectId: n,
    details: { name: `Group ${n}` },
    ip: '203.0.113.7',
  });

  async function chainOf(workspaceId: number, count: number): Promise<void> {
    await appendAudit(
      db,
      Array.from({ length: count }, (_, i) => entry(workspaceId, i + 1)),
    );
  }

  /** Changes rows the way a database superuser could: with the append-only trigger off. */
  async function tamper(statement: ReturnType<typeof sql>): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await statement.execute(trx);
    });
  }

  it('[IAM-013] links every record to the one before it and verifies the whole chain', async () => {
    const ws = await newWorkspace();
    const first = await appendAudit(db, [entry(ws, 1)]);
    await appendAudit(db, [entry(ws, 2), entry(ws, 3)]);
    const rows = await db
      .selectFrom('audit_event')
      .selectAll()
      .where('workspace_id', '=', ws)
      .orderBy('seq')
      .execute();
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3]);
    expect(rows[0]?.prev_hash).toBe(GENESIS_HASH);
    expect(rows[1]?.prev_hash).toBe(rows[0]?.hash);
    expect(rows[2]?.prev_hash).toBe(rows[1]?.hash);
    expect(first[0]?.hash).toBe(rows[0]?.hash);
    const head = await db
      .selectFrom('audit_chain')
      .selectAll()
      .where('workspace_id', '=', ws)
      .executeTakeFirstOrThrow();
    expect(Number(head.head_seq)).toBe(3);
    expect(head.head_hash).toBe(rows[2]?.hash);
    expect(await verifyChain(db, ws)).toMatchObject({ ok: true, checked: 3, firstBroken: null });
  });

  it('verifies an empty chain', async () => {
    const ws = await newWorkspace();
    expect(await verifyChain(db, ws)).toMatchObject({ ok: true, checked: 0, head: { seq: 0 } });
  });

  it('[IAM-013] hashes a canonical form, so details survive the jsonb round trip', async () => {
    const ws = await newWorkspace();
    const details = {
      zeta: { b: [3, 1, { y: null, x: 'é' }], a: 1.5 },
      alpha: 'line\nbreak "quoted" \u0000nul',
      broken: 'lone \uD800 surrogate',
      big: 2 ** 53 - 1,
      dropped: undefined,
    };
    await appendAudit(db, [{ ...entry(ws, 1), details }]);
    const row = await db
      .selectFrom('audit_event')
      .select('details')
      .where('workspace_id', '=', ws)
      .executeTakeFirstOrThrow();
    expect(row.details).toEqual({
      zeta: { b: [3, 1, { y: null, x: 'é' }], a: 1.5 },
      alpha: 'line\nbreak "quoted" nul',
      broken: 'lone � surrogate',
      big: 2 ** 53 - 1,
    });
    expect((await verifyChain(db, ws)).ok).toBe(true);
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 1 }] })).toBe('{"a":[{"c":1,"d":2}],"b":1}');
  });

  it('[IAM-013] refuses to update, delete or truncate a record, also through its partition', async () => {
    const ws = await newWorkspace();
    await chainOf(ws, 2);
    const partition = partitionName(new Date());
    const attempts = [
      sql`UPDATE audit_event SET action = 'edited' WHERE workspace_id = ${ws}`,
      sql`DELETE FROM audit_event WHERE workspace_id = ${ws}`,
      sql`TRUNCATE audit_event`,
      sql`UPDATE ${sql.table(partition)} SET action = 'edited' WHERE workspace_id = ${ws}`,
      sql`DELETE FROM ${sql.table(partition)} WHERE workspace_id = ${ws}`,
      sql`TRUNCATE ${sql.table(partition)}`,
    ];
    for (const attempt of attempts) {
      await expect(attempt.execute(db)).rejects.toThrow(/append-only/);
    }
    expect((await verifyChain(db, ws)).checked).toBe(2);
  });

  it('[IAM-013] reports an edited record as the first broken one (tamper test)', async () => {
    const ws = await newWorkspace();
    await chainOf(ws, 5);
    await tamper(
      sql`UPDATE audit_event SET details = '{"name": "Renamed"}'
           WHERE workspace_id = ${ws} AND seq = 3`,
    );
    expect(await verifyChain(db, ws)).toMatchObject({
      ok: false,
      checked: 2,
      firstBroken: { seq: 3, reason: 'hash' },
    });
  });

  it('[IAM-013] catches an edited record whose hash was recomputed at the next link', async () => {
    const ws = await newWorkspace();
    await chainOf(ws, 4);
    const row = await db
      .selectFrom('audit_event')
      .selectAll()
      .where('workspace_id', '=', ws)
      .where('seq', '=', '2')
      .executeTakeFirstOrThrow();
    const forged = {
      workspaceId: ws,
      seq: 2,
      recordedAt: row.recorded_at,
      occurredAt: row.occurred_at,
      actorId: 999,
      action: row.action,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      details: row.details,
      ip: row.ip,
      sourceEventId: null,
    };
    await tamper(
      sql`UPDATE audit_event SET actor_id = 999, hash = ${auditHash(row.prev_hash, forged)}
           WHERE workspace_id = ${ws} AND seq = 2`,
    );
    expect((await verifyChain(db, ws)).firstBroken).toEqual({ seq: 3, reason: 'link' });
  });

  it('[IAM-013] catches removed records, in the middle and at the end, and an added one', async () => {
    const middle = await newWorkspace();
    await chainOf(middle, 4);
    await tamper(sql`DELETE FROM audit_event WHERE workspace_id = ${middle} AND seq = 2`);
    expect((await verifyChain(db, middle)).firstBroken).toEqual({ seq: 2, reason: 'missing' });

    const end = await newWorkspace();
    await chainOf(end, 4);
    await tamper(sql`DELETE FROM audit_event WHERE workspace_id = ${end} AND seq = 4`);
    expect((await verifyChain(db, end)).firstBroken).toEqual({ seq: 4, reason: 'missing' });

    // A well-formed record appended behind the head's back.
    const added = await newWorkspace();
    await chainOf(added, 2);
    const last = await db
      .selectFrom('audit_event')
      .selectAll()
      .where('workspace_id', '=', added)
      .where('seq', '=', '2')
      .executeTakeFirstOrThrow();
    const extra = {
      workspaceId: added,
      seq: 3,
      recordedAt: last.recorded_at,
      occurredAt: last.occurred_at,
      actorId: null,
      action: 'forged',
      subjectType: null,
      subjectId: null,
      details: {},
      ip: null,
      sourceEventId: null,
    };
    await tamper(sql`
      INSERT INTO audit_event (workspace_id, seq, recorded_at, occurred_at, action, prev_hash, hash)
      VALUES (${added}, 3, ${last.recorded_at}, ${last.occurred_at}, 'forged', ${last.hash},
              ${auditHash(last.hash, extra)})`);
    expect((await verifyChain(db, added)).firstBroken).toEqual({ seq: 3, reason: 'head' });

    const duplicate = await newWorkspace();
    await chainOf(duplicate, 3);
    await tamper(sql`
      INSERT INTO audit_event (workspace_id, seq, recorded_at, occurred_at, action, prev_hash, hash)
      SELECT workspace_id, 2, recorded_at + interval '1 millisecond', occurred_at, 'forged',
             prev_hash, hash
        FROM audit_event WHERE workspace_id = ${duplicate} AND seq = 2`);
    expect((await verifyChain(db, duplicate)).firstBroken).toEqual({
      seq: 2,
      reason: 'duplicate',
    });
  });

  it('[IAM-013] keeps one unbroken chain when many appends race', async () => {
    const ws = await newWorkspace();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => appendAudit(db, [entry(ws, i + 1), entry(ws, i + 31)])),
    );
    const status = await verifyChain(db, ws);
    expect(status).toMatchObject({ ok: true, checked: 60, head: { seq: 60 } });
    const { rows } = await sql<{ n: string }>`
      SELECT count(DISTINCT prev_hash) AS n FROM audit_event WHERE workspace_id = ${ws}`.execute(
      db,
    );
    expect(Number(rows[0]?.n)).toBe(60);
  });

  it('records an event once however often it is delivered', async () => {
    const ws = await newWorkspace();
    const delivered = { ...entry(ws, 1), sourceEventId: '42' };
    expect(await appendAudit(db, [delivered, delivered])).toHaveLength(1);
    expect(await appendAudit(db, [delivered])).toHaveLength(0);
    expect((await verifyChain(db, ws)).checked).toBe(1);
  });

  it('never records a time earlier than the previous record, so partitions stay in chain order', async () => {
    const ws = await newWorkspace();
    const [later] = await appendAudit(db, [entry(ws, 1)]);
    const [earlier] = await appendAudit(db, [entry(ws, 2)], {
      now: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(earlier?.recordedAt.getTime()).toBe(later?.recordedAt.getTime());
    expect((await verifyChain(db, ws)).ok).toBe(true);
  });

  it('creates the month partition on demand and keeps a record time at or after what it records', async () => {
    const ws = await newWorkspace();
    const month = new Date(Date.UTC(2031, 4, 20));
    const [record] = await appendAudit(db, [{ ...entry(ws, 1), occurredAt: month }], {
      now: new Date(Date.UTC(2031, 4, 19)),
    });
    expect(record?.recordedAt.toISOString()).toBe(month.toISOString());
    const { rows } = await sql<{ ok: boolean }>`
      SELECT to_regclass(${partitionName(month)}) IS NOT NULL AS ok`.execute(db);
    expect(rows[0]?.ok).toBe(true);
    expect(partitionName(month)).toBe('audit_event_p203105');
    // A partition is a table too: scoped to a workspace like every other (ADR-006).
    const { rows: scope } = await sql<{ nullable: string; fk: string | null }>`
      SELECT c.is_nullable AS nullable,
             (SELECT confrelid::regclass::text FROM pg_constraint
               WHERE conrelid = 'audit_event_p203105'::regclass AND contype = 'f') AS fk
        FROM information_schema.columns c
       WHERE c.table_name = 'audit_event_p203105' AND c.column_name = 'workspace_id'`.execute(db);
    expect(scope).toEqual([{ nullable: 'NO', fk: 'workspace' }]);
  });
});
