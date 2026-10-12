import type pg from 'pg';

/**
 * The in-house sync candidate (ADR-013): every mutation appends rows to a change log with one
 * monotonic sequence, clients bootstrap from the tables and then follow the log for the spaces
 * they may see. A short advisory lock around the append makes the sequence commit-ordered, so
 * "everything after seq N" is complete; without it a slow transaction could commit a lower
 * sequence after a client already moved past it.
 */
export const SYNC_SQL = `
CREATE SCHEMA IF NOT EXISTS sync;
CREATE TABLE IF NOT EXISTS sync.change_log (
  seq bigint PRIMARY KEY,
  space_id int NOT NULL,
  entity text NOT NULL,
  entity_id bigint NOT NULL,
  op char(1) NOT NULL,
  data jsonb,
  at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX IF NOT EXISTS change_log_space_seq ON sync.change_log (space_id, seq);
CREATE SEQUENCE IF NOT EXISTS sync.change_seq;
-- Offline outbox replay: a client's mutation ids are applied at most once.
CREATE TABLE IF NOT EXISTS sync.applied (
  client_id text NOT NULL, mutation_id bigint NOT NULL, seq bigint NOT NULL,
  PRIMARY KEY (client_id, mutation_id));`;

export const ITEM_COLUMNS =
  'id, space_id, number, key, type, parent_id, status, status_category, priority, summary, ' +
  'description, reporter_id, assignee_id, labels, created_at, updated_at, resolved_at, fields';

export interface ItemRow {
  id: string;
  space_id: number;
  [column: string]: unknown;
}

/**
 * Streams every item of the allowed spaces in id order, in pages, to `emit` as JSON lines.
 * Returns bytes produced and the last sequence seen before the first page, which is where the
 * client's delta stream starts.
 */
export async function bootstrap(
  client: pg.ClientBase,
  spaceIds: readonly number[],
  emit: (jsonLines: string) => void,
  pageSize = 5_000,
): Promise<{ rows: number; bytes: number; startSeq: number }> {
  const seqRow = await client.query<{ seq: string }>(
    'SELECT coalesce(max(seq), 0) AS seq FROM sync.change_log',
  );
  const startSeq = Number(seqRow.rows[0]?.seq ?? 0);
  let last = '0';
  let rows = 0;
  let bytes = 0;
  for (;;) {
    const page = await client.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM gen.items WHERE space_id = ANY($1::int[]) AND id > $2::bigint ORDER BY id LIMIT $3`,
      [spaceIds, last, pageSize],
    );
    if (page.rows.length === 0) break;
    const text = `${page.rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
    bytes += Buffer.byteLength(text);
    rows += page.rows.length;
    emit(text);
    last = page.rows[page.rows.length - 1]?.id ?? last;
  }
  return { rows, bytes, startSeq };
}

export interface Mutation {
  itemId: string;
  spaceId: number;
  status: string;
}

/**
 * One mutation: update the row, append the change under the ordering lock, notify followers.
 * `clientId` and `mutationId` make a replay from an offline outbox idempotent.
 */
export async function mutate(
  client: pg.ClientBase,
  m: Mutation,
  outbox?: { clientId: string; mutationId: number },
): Promise<{ applied: boolean; seq: number }> {
  await client.query('BEGIN');
  try {
    if (outbox) {
      const seen = await client.query<{ seq: string }>(
        'SELECT seq FROM sync.applied WHERE client_id = $1 AND mutation_id = $2',
        [outbox.clientId, outbox.mutationId],
      );
      if (seen.rows[0]) {
        await client.query('COMMIT');
        return { applied: false, seq: Number(seen.rows[0].seq) };
      }
    }
    await client.query(
      'UPDATE gen.items SET status = $2, updated_at = now() WHERE id = $1::bigint',
      [m.itemId, m.status],
    );
    // Lock, take the next number, append and commit: the critical section is three statements.
    await client.query('SELECT pg_advisory_xact_lock(4242)');
    const seq = await client.query<{ seq: string }>(
      `INSERT INTO sync.change_log (seq, space_id, entity, entity_id, op, data)
       VALUES (nextval('sync.change_seq'), $1, 'item', $2::bigint, 'u', $3) RETURNING seq`,
      [m.spaceId, m.itemId, JSON.stringify({ status: m.status })],
    );
    const number = Number(seq.rows[0]?.seq);
    if (outbox) {
      await client.query(
        'INSERT INTO sync.applied (client_id, mutation_id, seq) VALUES ($1, $2, $3)',
        [outbox.clientId, outbox.mutationId, number],
      );
    }
    await client.query("SELECT pg_notify('sync_changes', $1)", [String(number)]);
    await client.query('COMMIT');
    return { applied: true, seq: number };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export interface Change {
  seq: string;
  space_id: number;
  entity: string;
  entity_id: string;
  op: string;
  data: unknown;
  at: Date;
}

/** Changes after `seq` in the allowed spaces, oldest first. */
export async function deltaSince(
  client: pg.ClientBase,
  seq: number,
  spaceIds: readonly number[],
  limit = 500,
): Promise<Change[]> {
  const { rows } = await client.query<Change>(
    `SELECT seq, space_id, entity, entity_id, op, data, at FROM sync.change_log
      WHERE seq > $1 AND space_id = ANY($2::int[]) ORDER BY seq LIMIT $3`,
    [seq, spaceIds, limit],
  );
  return rows;
}

/**
 * A follower: waits for NOTIFY, pulls the delta, measures how long each change took to reach
 * it (its `at` is the server clock at append time). Stops after `expected` changes.
 */
export async function follow(
  client: pg.Client,
  spaceIds: readonly number[],
  startSeq: number,
  expected: number,
  onLatency: (ms: number) => void,
): Promise<{ seen: number; gaps: number }> {
  await client.query('LISTEN sync_changes');
  let last = startSeq;
  let seen = 0;
  let gaps = 0;
  let previous = startSeq;
  const pull = async () => {
    for (;;) {
      const changes = await deltaSince(client, last, spaceIds);
      if (changes.length === 0) return;
      const now = Date.now();
      for (const c of changes) {
        const seq = Number(c.seq);
        // Sequences are global; a gap larger than the other spaces' share is counted later.
        if (seq <= previous) gaps++;
        previous = seq;
        onLatency(now - c.at.getTime());
      }
      last = Number(changes[changes.length - 1]?.seq ?? last);
      seen += changes.length;
      if (seen >= expected) return;
    }
  };
  await pull();
  if (seen >= expected) {
    await client.query('UNLISTEN sync_changes');
    return { seen, gaps };
  }
  await new Promise<void>((resolve, reject) => {
    let busy = false;
    let again = false;
    const onNotification = () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      const run = async () => {
        do {
          again = false;
          await pull();
        } while (again && seen < expected);
        busy = false;
        if (seen >= expected) {
          client.removeListener('notification', onNotification);
          resolve();
        }
      };
      run().catch(reject);
    };
    client.on('notification', onNotification);
  });
  await client.query('UNLISTEN sync_changes');
  return { seen, gaps };
}
