import type pg from 'pg';

/**
 * Transactional outbox: a business row and its event are written in one transaction, so an
 * event exists exactly when the change does. A relay later moves unpublished events to the
 * queue. The relay may crash after publishing and before marking the event, so publishing
 * must be idempotent: the job key is the event ID.
 */
export const OUTBOX_SQL = `
DROP SCHEMA IF EXISTS ob CASCADE;
CREATE SCHEMA ob;
CREATE TABLE ob.item (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, title text NOT NULL);
CREATE TABLE ob.event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz
);
CREATE INDEX event_unpublished ON ob.event (id) WHERE published_at IS NULL;`;

export interface OutboxEvent {
  id: number;
  topic: string;
  payload: unknown;
}

/** Creates an item and records its event atomically. */
export async function createItemWithEvent(pool: pg.Pool, title: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const item = await client.query<{ id: number }>(
      'INSERT INTO ob.item (title) VALUES ($1) RETURNING id',
      [title],
    );
    const itemId = item.rows[0]?.id;
    await client.query('INSERT INTO ob.event (topic, payload) VALUES ($1, $2)', [
      'item.created',
      JSON.stringify({ itemId }),
    ]);
    await client.query('COMMIT');
    return Number(itemId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface RelayOptions {
  batch?: number;
  /** Test hook: throw after publishing, before the events are marked, like a crash would. */
  crashAfterPublish?: boolean;
}

/**
 * Publishes one batch of unpublished events through `publish` and marks them. Several relays
 * may run at once: SKIP LOCKED hands each event to one of them. Returns how many were marked.
 */
export async function relayOnce(
  pool: pg.Pool,
  publish: (events: OutboxEvent[], client: pg.ClientBase) => Promise<void>,
  options: RelayOptions = {},
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<OutboxEvent>(
      `SELECT id, topic, payload FROM ob.event WHERE published_at IS NULL
        ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [options.batch ?? 100],
    );
    if (rows.length === 0) {
      await client.query('COMMIT');
      return 0;
    }
    await publish(rows, client);
    if (options.crashAfterPublish) throw new Error('relay crashed after publishing');
    await client.query('UPDATE ob.event SET published_at = clock_timestamp() WHERE id = ANY($1)', [
      rows.map((r) => r.id),
    ]);
    await client.query('COMMIT');
    return rows.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
