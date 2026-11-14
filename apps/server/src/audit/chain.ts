import { createHash } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';

/**
 * The audit log's hash chain (M1-003, ADR-034, IAM-013).
 *
 * Every workspace has one chain. A record's `hash` is SHA-256 over the previous record's hash,
 * a newline and the canonical JSON of the record's fields (`canonicalRecord`), so editing,
 * removing or inserting a record anywhere breaks the chain from that point on. Appends lock the
 * workspace's `audit_chain` row, which holds the head, so records get consecutive `seq` values
 * and the chain never forks, whichever process appends.
 *
 * Records live in monthly partitions of `audit_event` keyed by `recorded_at`: the time the
 * record joined the log, kept monotonic per workspace so that the oldest partitions always
 * hold the start of every chain and retention can drop them whole (retention.ts).
 */
type Db = Kysely<Database> | Transaction<Database>;

/** `prev_hash` of a chain's first record, and the checkpoint of a chain nothing was dropped from. */
export const GENESIS_HASH = '0'.repeat(64);

/** What a caller records. */
export interface AuditEntry {
  workspaceId: number;
  /** A domain event type, or one of AUDIT_ACTIONS for records that are not events. */
  action: string;
  /** Who did it; null for the system and for anonymous callers (a failed sign-in). */
  actorId: number | null;
  subjectType?: string | null;
  subjectId?: string | number | null;
  /** Never secrets: no password, hash, token or link. */
  details?: Record<string, unknown>;
  ip?: string | null;
  /** When it happened; defaults to the time it is recorded. */
  occurredAt?: Date;
  /** The domain event this records: a chain holds each event at most once. */
  sourceEventId?: string | null;
}

/** A record as stored; `hash` covers every other field. */
export interface AuditRecord {
  workspaceId: number;
  seq: number;
  recordedAt: Date;
  occurredAt: Date;
  actorId: number | null;
  action: string;
  subjectType: string | null;
  subjectId: string | null;
  details: unknown;
  ip: string | null;
  sourceEventId: string | null;
  prevHash: string;
  hash: string;
}

/** JSON with object keys sorted at every level and no whitespace: one text per value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${fields.join(',')}}`;
}

/**
 * The text a record's hash covers, version 1. Changing it means a new version that the
 * verifier recognises per record; records already written keep theirs.
 */
export function canonicalRecord(record: Omit<AuditRecord, 'prevHash' | 'hash'>): string {
  return canonicalJson({
    action: record.action,
    actorId: record.actorId,
    details: record.details,
    ip: record.ip,
    occurredAt: record.occurredAt.toISOString(),
    recordedAt: record.recordedAt.toISOString(),
    seq: record.seq,
    sourceEventId: record.sourceEventId,
    subjectId: record.subjectId,
    subjectType: record.subjectType,
    workspaceId: record.workspaceId,
  });
}

export function auditHash(
  prevHash: string,
  record: Omit<AuditRecord, 'prevHash' | 'hash'>,
): string {
  return createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(canonicalRecord(record))
    .digest('hex');
}

/**
 * Details as they read back from jsonb: plain JSON values only, strings without NUL and lone
 * surrogates (which jsonb refuses), so the hash written equals the hash recomputed later.
 */
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanDetails(details: Record<string, unknown> | undefined): unknown {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replaceAll('\u0000', '').replace(LONE_SURROGATE, REPLACEMENT_CHARACTER);
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [walk(k) as string, walk(v)]),
      );
    }
    return value;
  };
  return walk(JSON.parse(JSON.stringify(details ?? {})));
}

// Partitions -----------------------------------------------------------------------------------

/** The first instant of the month `offset` months from the one holding `at`, in UTC. */
export function monthStart(at: Date, offset = 0): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + offset, 1));
}

/** `audit_event_pYYYYMM` for the month holding `at` (UTC). */
export function partitionName(at: Date): string {
  const month = monthStart(at);
  return `audit_event_p${month.getUTCFullYear()}${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The month a partition name covers, or null for a name this code did not make. */
export function partitionMonth(name: string): Date | null {
  const match = /^audit_event_p(\d{4})(\d{2})$/.exec(name);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}

/** Serialises partition creation and dropping between processes (an advisory lock key). */
export const PARTITION_LOCK = 0x41_55_44_54; // "AUDT"

async function relationExists(db: Db, name: string): Promise<boolean> {
  const { rows } = await sql<{
    ok: boolean;
  }>`SELECT to_regclass(${name}) IS NOT NULL AS ok`.execute(db);
  return rows[0]?.ok === true;
}

/**
 * Creates the partition for the month holding `at` unless it exists. Returns whether it made
 * one. Inside a transaction the new partition commits with it.
 */
export async function ensurePartition(db: Db, at: Date): Promise<boolean> {
  const name = partitionName(at);
  if (await relationExists(db, name)) return false;
  const create = async (trx: Transaction<Database>) => {
    await sql`SELECT pg_advisory_xact_lock(${PARTITION_LOCK})`.execute(trx);
    if (await relationExists(trx, name)) return false;
    const from = monthStart(at).toISOString();
    const to = monthStart(at, 1).toISOString();
    await sql`
      CREATE TABLE ${sql.table(name)} PARTITION OF audit_event
        FOR VALUES FROM (${sql.lit(from)}) TO (${sql.lit(to)})`.execute(trx);
    // Statement triggers stay on the table they were made for, so each partition gets its own.
    await sql`
      CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON ${sql.table(name)}
        FOR EACH STATEMENT EXECUTE FUNCTION audit_event_refuse_change()`.execute(trx);
    return true;
  };
  return db.isTransaction
    ? create(db as Transaction<Database>)
    : (db as Kysely<Database>).transaction().execute(create);
}

// Appending ------------------------------------------------------------------------------------

interface HeadRow {
  head_seq: string;
  head_hash: string;
  head_recorded_at: Date | null;
  now: Date;
}

/**
 * Appends entries to their workspaces' chains, one transaction per workspace, and returns the
 * records written. Entries whose `sourceEventId` the chain already holds are skipped, which
 * makes the event subscriber idempotent. `now` replaces the database clock (tests).
 */
export async function appendAudit(
  db: Kysely<Database>,
  entries: readonly AuditEntry[],
  options: { now?: Date } = {},
): Promise<AuditRecord[]> {
  const byWorkspace = new Map<number, AuditEntry[]>();
  for (const entry of entries) {
    const list = byWorkspace.get(entry.workspaceId) ?? [];
    list.push(entry);
    byWorkspace.set(entry.workspaceId, list);
  }
  const written: AuditRecord[] = [];
  for (const [workspaceId, list] of byWorkspace) {
    written.push(
      ...(await db
        .transaction()
        .execute((trx) => appendToChain(trx, workspaceId, list, options.now))),
    );
  }
  return written;
}

async function appendToChain(
  trx: Transaction<Database>,
  workspaceId: number,
  entries: readonly AuditEntry[],
  now: Date | undefined,
): Promise<AuditRecord[]> {
  await sql`INSERT INTO audit_chain (workspace_id) VALUES (${workspaceId}) ON CONFLICT DO NOTHING`.execute(
    trx,
  );
  // The head's row lock orders every append to this chain.
  const { rows } = await sql<HeadRow>`
    SELECT head_seq, head_hash, head_recorded_at, clock_timestamp() AS now
      FROM audit_chain WHERE workspace_id = ${workspaceId} FOR UPDATE`.execute(trx);
  const head = rows[0];
  if (!head) throw new Error(`audit chain of site ${workspaceId} is missing`);

  // Never earlier than the previous record or than what it records: the oldest partitions
  // then hold the start of the chain, and recorded_at >= occurred_at bounds searches by time.
  const recordedAt = new Date(
    entries.reduce(
      (latest, e) => Math.max(latest, e.occurredAt?.getTime() ?? 0),
      Math.max((now ?? head.now).getTime(), head.head_recorded_at?.getTime() ?? 0),
    ),
  );
  // Before touching audit_event: creating a partition needs a lock no reader may hold here.
  await ensurePartition(trx, recordedAt);

  let fresh = [...entries];
  const sources = fresh.map((e) => e.sourceEventId).filter((id): id is string => Boolean(id));
  if (sources.length > 0) {
    const seen = await trx
      .selectFrom('audit_event')
      .select('source_event_id')
      .where('workspace_id', '=', workspaceId)
      .where('source_event_id', 'in', sources)
      .execute();
    const done = new Set(seen.map((r) => String(r.source_event_id)));
    fresh = fresh.filter((e) => {
      if (!e.sourceEventId) return true;
      if (done.has(e.sourceEventId)) return false;
      done.add(e.sourceEventId);
      return true;
    });
  }
  if (fresh.length === 0) return [];

  let seq = Number(head.head_seq);
  let prevHash = head.head_hash;
  const records = fresh.map((entry): AuditRecord => {
    seq += 1;
    const record = {
      workspaceId,
      seq,
      recordedAt,
      occurredAt: entry.occurredAt ?? recordedAt,
      actorId: entry.actorId,
      action: entry.action,
      subjectType: entry.subjectType ?? null,
      subjectId: entry.subjectId == null ? null : String(entry.subjectId),
      details: cleanDetails(entry.details),
      ip: entry.ip ?? null,
      sourceEventId: entry.sourceEventId ?? null,
    };
    const hash = auditHash(prevHash, record);
    const stored = { ...record, prevHash, hash };
    prevHash = hash;
    return stored;
  });

  await trx
    .insertInto('audit_event')
    .values(
      records.map((r) => ({
        workspace_id: r.workspaceId,
        seq: r.seq,
        recorded_at: r.recordedAt,
        occurred_at: r.occurredAt,
        actor_id: r.actorId,
        action: r.action,
        subject_type: r.subjectType,
        subject_id: r.subjectId,
        details: JSON.stringify(r.details),
        ip: r.ip,
        source_event_id: r.sourceEventId,
        prev_hash: r.prevHash,
        hash: r.hash,
      })),
    )
    .execute();
  await trx
    .updateTable('audit_chain')
    .set({ head_seq: seq, head_hash: prevHash, head_recorded_at: recordedAt })
    .where('workspace_id', '=', workspaceId)
    .execute();
  return records;
}

// Verifying ------------------------------------------------------------------------------------

/**
 * Why a chain is broken at a record:
 * - `hash`: the record's fields no longer match its hash (it was edited);
 * - `link`: its prev_hash is not the previous record's hash (a record before it was replaced);
 * - `missing`: the record with this seq is gone (removed, or the chain ends early);
 * - `duplicate`: a second record claims this seq (one was inserted);
 * - `head`: the log goes past the chain's head or ends on a different hash.
 */
export type BreakReason = 'hash' | 'link' | 'missing' | 'duplicate' | 'head';

export interface ChainStatus {
  workspaceId: number;
  ok: boolean;
  /** Records checked, from the checkpoint on. */
  checked: number;
  /** Where verification starts: what retention left (seq 0 and the genesis hash if nothing). */
  checkpoint: { seq: number; hash: string; at: string | null };
  head: { seq: number; hash: string };
  /** The first record that does not verify. */
  firstBroken: { seq: number; reason: BreakReason } | null;
}

interface StoredRow {
  workspace_id: number;
  seq: string;
  recorded_at: Date;
  occurred_at: Date;
  actor_id: number | null;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  details: unknown;
  ip: string | null;
  source_event_id: string | null;
  prev_hash: string;
  hash: string;
}

export function toRecord(row: StoredRow): AuditRecord {
  return {
    workspaceId: row.workspace_id,
    seq: Number(row.seq),
    recordedAt: row.recorded_at,
    occurredAt: row.occurred_at,
    actorId: row.actor_id,
    action: row.action,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    details: row.details,
    ip: row.ip,
    sourceEventId: row.source_event_id === null ? null : String(row.source_event_id),
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

/**
 * Walks a workspace's chain from its checkpoint and reports the first record that does not
 * verify. It reads one snapshot (REPEATABLE READ), so appends during the walk are not seen and
 * retention cannot drop a partition under it. `through` stops after that seq (retention checks
 * the range it is about to drop) and skips the comparison with the head.
 */
export async function verifyChain(
  db: Kysely<Database>,
  workspaceId: number,
  options: { through?: number; batch?: number } = {},
): Promise<ChainStatus> {
  const batch = options.batch ?? 5000;
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const chain = await trx
        .selectFrom('audit_chain')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      const checkpoint = {
        seq: Number(chain?.checkpoint_seq ?? 0),
        hash: chain?.checkpoint_hash ?? GENESIS_HASH,
        at: chain?.checkpoint_at?.toISOString() ?? null,
      };
      const head = { seq: Number(chain?.head_seq ?? 0), hash: chain?.head_hash ?? GENESIS_HASH };
      const status = (checked: number, broken: ChainStatus['firstBroken']): ChainStatus => ({
        workspaceId,
        ok: broken === null,
        checked,
        checkpoint,
        head,
        firstBroken: broken,
      });

      let expected = checkpoint.seq + 1;
      let prevHash = checkpoint.hash;
      let checked = 0;
      let after: { seq: string; recordedAt: Date } | null = null;
      for (;;) {
        let query = trx
          .selectFrom('audit_event')
          .selectAll()
          .where('workspace_id', '=', workspaceId)
          .orderBy('seq')
          .orderBy('recorded_at')
          .limit(batch);
        if (after) {
          const last = after;
          query = query.where((eb) =>
            eb(eb.refTuple('seq', 'recorded_at'), '>', eb.tuple(last.seq, last.recordedAt)),
          );
        } else {
          query = query.where('seq', '>', String(checkpoint.seq));
        }
        const rows = (await query.execute()) as unknown as StoredRow[];
        for (const row of rows) {
          const record = toRecord(row);
          if (record.seq < expected)
            return status(checked, { seq: record.seq, reason: 'duplicate' });
          if (record.seq > expected) return status(checked, { seq: expected, reason: 'missing' });
          if (record.prevHash !== prevHash)
            return status(checked, { seq: record.seq, reason: 'link' });
          if (auditHash(prevHash, record) !== record.hash) {
            return status(checked, { seq: record.seq, reason: 'hash' });
          }
          checked++;
          prevHash = record.hash;
          expected++;
          if (options.through !== undefined && record.seq >= options.through) {
            return status(checked, null);
          }
        }
        const last = rows[rows.length - 1];
        if (!last) break;
        after = { seq: last.seq, recordedAt: last.recorded_at };
      }
      if (options.through !== undefined) {
        return status(checked, { seq: expected, reason: 'missing' });
      }
      const end = expected - 1;
      if (end < head.seq) return status(checked, { seq: expected, reason: 'missing' });
      if (end > head.seq) return status(checked, { seq: head.seq + 1, reason: 'head' });
      if (prevHash !== head.hash) return status(checked, { seq: end, reason: 'head' });
      return status(checked, null);
    });
}
