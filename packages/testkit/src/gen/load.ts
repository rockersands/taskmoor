import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type pg from 'pg';
import * as copyStreams from 'pg-copy-streams';
import type { Dataset } from './generate';
import type { GenConfig } from './model';

/** Bump when generator output changes, so stored datasets are rebuilt. */
export const GENERATOR_VERSION = 1;

/** Identifies a dataset: same fingerprint, same rows. */
export function datasetFingerprint(config: GenConfig): string {
  return createHash('sha256')
    .update(JSON.stringify({ v: GENERATOR_VERSION, ...config }))
    .digest('hex')
    .slice(0, 16);
}

/** The fingerprint of the dataset already loaded into `gen`, if any. */
export async function loadedFingerprint(pool: pg.Pool): Promise<string | undefined> {
  const exists = await pool.query(`SELECT to_regclass('gen.meta') IS NOT NULL AS ok`);
  if (!exists.rows[0]?.ok) return undefined;
  const { rows } = await pool.query<{ fingerprint: string }>('SELECT fingerprint FROM gen.meta');
  return rows[0]?.fingerprint;
}

/**
 * Loads a synthetic dataset into neutral staging tables in schema `gen` with COPY. Spikes then
 * reshape the staging data into their candidate schemas with INSERT ... SELECT inside Postgres.
 */
export const STAGING_SQL = `
DROP SCHEMA IF EXISTS gen CASCADE;
CREATE SCHEMA gen;
CREATE UNLOGGED TABLE gen.users (id int NOT NULL, name text NOT NULL, email text NOT NULL, active boolean NOT NULL);
CREATE UNLOGGED TABLE gen.spaces (id int NOT NULL, key text NOT NULL, name text NOT NULL, type text NOT NULL, lead_id int NOT NULL);
CREATE UNLOGGED TABLE gen.fields (id int NOT NULL, name text NOT NULL, type text NOT NULL, options jsonb NOT NULL, space_id int);
CREATE UNLOGGED TABLE gen.items (
  id bigint NOT NULL, space_id int NOT NULL, number int NOT NULL, key text NOT NULL, type text NOT NULL,
  parent_id bigint, status text NOT NULL, status_category text NOT NULL, priority text NOT NULL,
  summary text NOT NULL, description text, reporter_id int NOT NULL, assignee_id int,
  labels text[] NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  resolved_at timestamptz, fields jsonb NOT NULL
);
CREATE UNLOGGED TABLE gen.history (
  item_id bigint NOT NULL, at timestamptz NOT NULL, actor_id int NOT NULL, field text NOT NULL,
  from_value text, to_value text
);
CREATE TABLE gen.meta (
  fingerprint text NOT NULL, config jsonb NOT NULL, counts jsonb NOT NULL, seconds numeric NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now()
);`;

/** Keys and foreign keys are added after the load: faster, and adding them checks integrity. */
export const CONSTRAINTS_SQL = `
ALTER TABLE gen.users ADD PRIMARY KEY (id);
ALTER TABLE gen.spaces ADD PRIMARY KEY (id), ADD UNIQUE (key),
  ADD FOREIGN KEY (lead_id) REFERENCES gen.users (id);
ALTER TABLE gen.fields ADD PRIMARY KEY (id), ADD FOREIGN KEY (space_id) REFERENCES gen.spaces (id);
ALTER TABLE gen.items ADD PRIMARY KEY (id), ADD UNIQUE (space_id, number), ADD UNIQUE (key),
  ADD FOREIGN KEY (space_id) REFERENCES gen.spaces (id),
  ADD FOREIGN KEY (parent_id) REFERENCES gen.items (id),
  ADD FOREIGN KEY (reporter_id) REFERENCES gen.users (id),
  ADD FOREIGN KEY (assignee_id) REFERENCES gen.users (id);
CREATE INDEX ON gen.history (item_id);
ALTER TABLE gen.history ADD FOREIGN KEY (item_id) REFERENCES gen.items (id),
  ADD FOREIGN KEY (actor_id) REFERENCES gen.users (id);
ANALYZE gen.users, gen.spaces, gen.fields, gen.items, gen.history;`;

/** Escapes one value for COPY's text format; null becomes \N. */
export function copyValue(value: string | number | boolean | null): string {
  if (value === null) return '\\N';
  if (typeof value !== 'string') return String(value);
  return value.replace(/[\\\n\r\t]/g, (c) =>
    c === '\\' ? '\\\\' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\t',
  );
}

/** A Postgres text[] literal, e.g. {"a","b \\"c\\""}. */
export function arrayLiteral(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/["\\]/g, (c) => `\\${c}`)}"`).join(',')}}`;
}

const row = (values: (string | number | boolean | null)[]) =>
  `${values.map(copyValue).join('\t')}\n`;

class CopyWriter {
  private buffer = '';
  private readonly stream: copyStreams.CopyStreamQuery;
  private readonly done: Promise<unknown>;

  constructor(client: pg.PoolClient | pg.Client, table: string) {
    this.stream = client.query(copyStreams.from(`COPY ${table} FROM STDIN`));
    this.done = once(this.stream, 'finish');
  }

  async write(line: string): Promise<void> {
    this.buffer += line;
    if (this.buffer.length < 1 << 16) return;
    const chunk = this.buffer;
    this.buffer = '';
    if (!this.stream.write(chunk)) await once(this.stream, 'drain');
  }

  async end(): Promise<void> {
    if (this.buffer) this.stream.write(this.buffer);
    this.buffer = '';
    this.stream.end();
    await this.done;
  }
}

export interface LoadResult {
  users: number;
  spaces: number;
  fields: number;
  items: number;
  history: number;
  seconds: number;
}

export interface LoadOptions {
  /** Called every `progressEvery` items with the number loaded so far. */
  onProgress?: (items: number) => void;
  progressEvery?: number;
}

/**
 * Creates the staging tables, streams the dataset in with COPY, adds keys and foreign keys, and
 * verifies the row counts. Needs two connections from `pool` (items and history stream in
 * parallel).
 */
export async function loadDataset(
  pool: pg.Pool,
  dataset: Dataset,
  options: LoadOptions = {},
): Promise<LoadResult> {
  const t0 = Date.now();
  await pool.query(STAGING_SQL);

  const a = await pool.connect();
  const b = await pool.connect();
  let items = 0;
  let history = 0;
  try {
    const users = new CopyWriter(a, 'gen.users');
    for (const u of dataset.users) await users.write(row([u.id, u.name, u.email, u.active]));
    await users.end();

    const spaces = new CopyWriter(a, 'gen.spaces');
    for (const s of dataset.spaces)
      await spaces.write(row([s.id, s.key, s.name, s.type, s.leadId]));
    await spaces.end();

    const fields = new CopyWriter(a, 'gen.fields');
    for (const f of dataset.fields) {
      await fields.write(row([f.id, f.name, f.type, JSON.stringify(f.options), f.spaceId]));
    }
    await fields.end();

    const itemWriter = new CopyWriter(a, 'gen.items');
    const historyWriter = new CopyWriter(b, 'gen.history');
    const every = options.progressEvery ?? 100_000;
    for (const { item: it, history: hist } of dataset.items()) {
      await itemWriter.write(
        row([
          it.id,
          it.spaceId,
          it.number,
          it.key,
          it.type,
          it.parentId,
          it.status,
          it.statusCategory,
          it.priority,
          it.summary,
          it.description,
          it.reporterId,
          it.assigneeId,
          arrayLiteral(it.labels),
          it.createdAt.toISOString(),
          it.updatedAt.toISOString(),
          it.resolvedAt ? it.resolvedAt.toISOString() : null,
          JSON.stringify(it.fields),
        ]),
      );
      for (const h of hist) {
        await historyWriter.write(
          row([h.itemId, h.at.toISOString(), h.actorId, h.field, h.from, h.to]),
        );
      }
      items++;
      history += hist.length;
      if (items % every === 0) options.onProgress?.(items);
    }
    await Promise.all([itemWriter.end(), historyWriter.end()]);
  } finally {
    a.release();
    b.release();
  }

  await pool.query(CONSTRAINTS_SQL);

  const counts = await pool.query<{ t: string; n: string }>(
    `SELECT 'users' AS t, count(*) AS n FROM gen.users UNION ALL
     SELECT 'spaces', count(*) FROM gen.spaces UNION ALL
     SELECT 'fields', count(*) FROM gen.fields UNION ALL
     SELECT 'items', count(*) FROM gen.items UNION ALL
     SELECT 'history', count(*) FROM gen.history`,
  );
  const actual = Object.fromEntries(counts.rows.map((r) => [r.t, Number(r.n)]));
  const expected = {
    users: dataset.users.length,
    spaces: dataset.spaces.length,
    fields: dataset.fields.length,
    items,
    history,
  };
  for (const [table, n] of Object.entries(expected)) {
    if (actual[table] !== n) {
      throw new Error(`gen.${table} has ${actual[table]} rows; expected ${n}`);
    }
  }
  const seconds = (Date.now() - t0) / 1000;
  await pool.query(
    'INSERT INTO gen.meta (fingerprint, config, counts, seconds) VALUES ($1, $2, $3, $4)',
    [
      datasetFingerprint(dataset.config),
      JSON.stringify(dataset.config),
      JSON.stringify(expected),
      seconds,
    ],
  );
  return { ...expected, seconds };
}
