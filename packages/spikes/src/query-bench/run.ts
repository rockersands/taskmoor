import { cpus } from 'node:os';
import {
  type Catalogue,
  type CompiledQuery,
  type CustomField,
  compilePlan,
  makeCatalogue,
  parseQuery,
  resolveQuery,
} from '@tracksmith/query';
import type pg from 'pg';
import { type TimedResult, timeQuery } from '../bench/stats';

/**
 * M0-017: the 20 representative queries, written against placeholders that are filled with
 * names from the loaded dataset. The same strings with fixed names are the compiler's golden.
 */
export const TEMPLATES: readonly { id: string; text: string }[] = [
  { id: 'space-newest', text: 'space = {spaceA} ORDER BY created DESC' },
  { id: 'space-status', text: 'space = {spaceA} AND status = "In Progress" ORDER BY updated DESC' },
  {
    id: 'mine-open',
    text: 'assignee = currentUser() AND statusCategory != done ORDER BY priority DESC, created DESC',
  },
  {
    id: 'status-priority-in',
    text: 'status IN (Backlog, "To Do") AND priority IN (High, Highest) ORDER BY created DESC',
  },
  { id: 'labels-in', text: 'labels IN (security, regression) ORDER BY created DESC' },
  { id: 'summary-contains', text: 'summary ~ "login" ORDER BY created DESC' },
  { id: 'recent-bugs', text: 'created >= -30d AND type = Bug ORDER BY created DESC' },
  { id: 'stale-unresolved', text: 'resolved IS EMPTY AND updated < -90d ORDER BY updated ASC' },
  {
    id: 'number-gt-sorted',
    text: '"{number}" > 500 AND space = {spaceA} ORDER BY "{number}" DESC',
  },
  {
    id: 'option-eq',
    text: '"{option}" = "{optionValue}" AND statusCategory = todo ORDER BY created DESC',
  },
  {
    id: 'date-window',
    text: '"{date}" <= endOfMonth() AND "{date}" >= startOfMonth() ORDER BY "{date}" ASC',
  },
  { id: 'user-field-mine', text: '"{user}" = currentUser() ORDER BY updated DESC' },
  {
    id: 'multi-in',
    text: '"{multi}" IN ("{multiA}", "{multiB}") AND status != Done ORDER BY created DESC',
  },
  {
    id: 'number-empty',
    text: '"{number}" IS EMPTY AND type IN (Story, Task) AND space = {spaceA} ORDER BY created DESC',
  },
  { id: 'children', text: 'parent = {parentId} ORDER BY created ASC' },
  {
    id: 'mine-or-reported',
    text: '(assignee = currentUser() OR reporter = currentUser()) AND statusCategory != done ORDER BY updated DESC',
  },
  { id: 'was-status', text: 'status WAS "In Review" ORDER BY updated DESC' },
  { id: 'changed-to-after', text: 'status CHANGED TO Done AFTER -7d ORDER BY updated DESC' },
  {
    id: 'changed-by-during',
    text: 'assignee CHANGED BY {userId} DURING (2024-01-01, 2024-02-01) ORDER BY created DESC',
  },
  {
    id: 'not-or-spaces',
    text: 'NOT (labels IN (infra) OR type = Subtask) AND space IN ({spaceA}, {spaceB}) ORDER BY created DESC',
  },
  // No item was ever Cancelled: the worst case for a newest-first scan, which must not walk
  // the whole table looking for a match.
  { id: 'was-rare', text: 'status WAS Cancelled AND status = Done ORDER BY updated DESC' },
];

/**
 * Indexes the product schema will carry (ADR-008, ADR-010, ADR-011) beyond the side-table ones
 * the field-storage spike builds: newest-first lists, reporter, labels, word search and the
 * change history by item, by value and by actor. Idempotent, so reruns skip them.
 */
export const QUERY_INDEXES: readonly { name: string; sql: string }[] = [
  { name: 'item_updated', sql: 'ON fs_side.item (updated_at DESC)' },
  { name: 'item_reporter', sql: 'ON fs_side.item (reporter_id)' },
  { name: 'item_labels', sql: 'ON fs_side.item USING GIN (labels)' },
  {
    name: 'item_summary_fts',
    sql: "ON fs_side.item USING GIN (to_tsvector('simple', summary))",
  },
  { name: 'history_item_field', sql: 'ON gen.history (item_id, field)' },
  { name: 'history_field_to', sql: 'ON gen.history (field, to_value, at) INCLUDE (item_id)' },
  {
    name: 'history_field_from',
    sql: 'ON gen.history (field, from_value, at) INCLUDE (item_id)',
  },
  { name: 'history_actor_at', sql: 'ON gen.history (actor_id, at) INCLUDE (item_id)' },
];

/** Seconds per statement before the benchmark gives up on a query and records a timeout. */
export const STATEMENT_TIMEOUT_S = 60;

export async function prepareQueryIndexes(
  pool: pg.Pool,
  log: (m: string) => void = () => {},
): Promise<{ step: string; seconds: number }[]> {
  const steps: { step: string; seconds: number }[] = [];
  const timed = async (step: string, sql: string) => {
    const t0 = Date.now();
    await pool.query(sql);
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    steps.push({ step, seconds });
    log(`  ${step}: ${seconds}s`);
  };
  for (const index of QUERY_INDEXES) {
    await timed(`index ${index.name}`, `CREATE INDEX IF NOT EXISTS ${index.name} ${index.sql}`);
  }
  await timed('analyze', 'ANALYZE fs_side.item, gen.history');
  return steps;
}

export interface DatasetNames {
  spaceA: string;
  spaceB: string;
  number: string;
  option: string;
  optionValue: string;
  date: string;
  user: string;
  multi: string;
  multiA: string;
  multiB: string;
  parentId: string;
  userId: string;
}

export interface DatasetContext {
  catalogue: Catalogue;
  names: DatasetNames;
  currentUserId: number;
  now: Date;
}

/** Reads the custom fields, spaces and a few sample values from the `gen` schema. */
export async function datasetContext(pool: pg.Pool): Promise<DatasetContext> {
  const fields = await pool.query<{
    id: number;
    name: string;
    type: string;
    options: string[];
    space_id: number | null;
  }>('SELECT id, name, type, options, space_id FROM gen.fields ORDER BY id');
  const spaces = await pool.query<{ id: number; key: string }>(
    'SELECT id, key FROM gen.spaces ORDER BY id',
  );
  const epic = await pool.query<{ id: string }>(
    `SELECT id FROM gen.items WHERE type = 'Epic' ORDER BY id LIMIT 1`,
  );
  const newest = await pool.query<{ at: Date }>('SELECT max(created_at) AS at FROM gen.items');

  const toType = (t: string): CustomField['type'] | undefined =>
    t === 'text' || t === 'number' || t === 'date' || t === 'user' || t === 'labels'
      ? t
      : t === 'select'
        ? 'option'
        : t === 'multiselect'
          ? 'multi'
          : undefined;
  const customs: CustomField[] = [];
  for (const f of fields.rows) {
    const type = toType(f.type);
    if (type) customs.push({ kind: 'custom', id: f.id, name: f.name, type });
  }
  const spaceKeys = Object.fromEntries(spaces.rows.map((s) => [s.key, s.id]));
  const siteWide = (type: string) =>
    fields.rows.find((f) => f.type === type && f.space_id === null);
  const select = siteWide('select');
  const multi = siteWide('multiselect');
  const pick = (f: { name: string } | undefined, what: string) => {
    if (!f) throw new Error(`Dataset has no ${what} field`);
    return f.name;
  };
  return {
    catalogue: makeCatalogue(customs, spaceKeys),
    names: {
      spaceA: spaces.rows[0]?.key ?? 'AA',
      spaceB: spaces.rows[1]?.key ?? 'AB',
      number: pick(siteWide('number'), 'number'),
      option: pick(select, 'select'),
      optionValue: select?.options[2] ?? select?.options[0] ?? '',
      date: pick(siteWide('date'), 'date'),
      user: pick(siteWide('user'), 'user'),
      multi: pick(multi, 'multiselect'),
      multiA: multi?.options[0] ?? '',
      multiB: multi?.options[1] ?? '',
      parentId: epic.rows[0]?.id ?? '1',
      userId: '1',
    },
    currentUserId: 1,
    // Relative dates are measured from the newest item, so "-30d" means something.
    now: newest.rows[0]?.at ?? new Date(),
  };
}

export function instantiate(template: string, names: DatasetNames): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => names[key as keyof DatasetNames]);
}

export function compileTemplate(
  template: string,
  ctx: DatasetContext,
  options: { schema?: string; allowedSpaceIds?: number[] | null; limit?: number } = {},
): { text: string; sql: CompiledQuery } {
  const text = instantiate(template, ctx.names);
  const plan = resolveQuery(parseQuery(text), ctx.catalogue, {
    currentUserId: ctx.currentUserId,
    now: ctx.now,
  });
  const sql = compilePlan(plan, {
    schema: options.schema ?? 'fs_side',
    historyTable: 'gen.history',
    allowedSpaceIds: options.allowedSpaceIds ?? null,
    limit: options.limit ?? 50,
  });
  return { text, sql };
}

export interface QueryBenchResult {
  spike: 'query-compiler';
  at: string;
  items: number;
  runs: number;
  machine: { cpu: string; cores: number; postgres: string };
  prepare: { step: string; seconds: number }[];
  queries: (TimedResult & { id: string; text: string; timedOut?: boolean })[];
}

/** Times every template on the side schema; `permitted` adds a space pre-filter variant. */
export async function runQueryBench(
  pool: pg.Pool,
  options: { runs?: number; warmup?: number; log?: (m: string) => void } = {},
): Promise<QueryBenchResult> {
  const log = options.log ?? (() => {});
  log('Preparing indexes');
  const prepare = await prepareQueryIndexes(pool, log);
  const ctx = await datasetContext(pool);
  const client = await pool.connect();
  const queries: QueryBenchResult['queries'] = [];
  try {
    await client.query(`SET statement_timeout = '${STATEMENT_TIMEOUT_S}s'`);
    const permitted = Object.values(ctx.catalogue.spaceKeys).slice(
      0,
      Math.max(1, Math.floor(Object.keys(ctx.catalogue.spaceKeys).length / 2)),
    );
    const cases: { id: string; text: string; allowed: number[] | null }[] = [
      ...TEMPLATES.map((t) => ({ ...t, allowed: null })),
      { id: 'permitted-half', text: 'status = Done ORDER BY created DESC', allowed: permitted },
    ];
    log(`Timing ${cases.length} queries`);
    for (const c of cases) {
      const { text, sql } = compileTemplate(c.text, ctx, { allowedSpaceIds: c.allowed });
      try {
        const timed = await timeQuery(
          client,
          { name: c.id, sql: sql.text, params: () => sql.params },
          { runs: options.runs ?? 20, warmup: options.warmup ?? 3 },
        );
        log(`  ${c.id}: p50 ${timed.p50} ms, p95 ${timed.p95} ms (${timed.rows} rows)`);
        queries.push({ ...timed, id: c.id, text });
      } catch (error) {
        // 57014 is query_canceled: the statement timeout fired. Record it and move on.
        if ((error as { code?: string }).code !== '57014') throw error;
        const ms = STATEMENT_TIMEOUT_S * 1000;
        log(`  ${c.id}: timed out after ${STATEMENT_TIMEOUT_S}s`);
        queries.push({
          name: c.id,
          id: c.id,
          text,
          runs: 0,
          p50: ms,
          p95: ms,
          max: ms,
          mean: ms,
          rows: 0,
          timedOut: true,
        });
      }
    }
  } finally {
    client.release();
  }
  const count = await pool.query<{ n: string }>('SELECT count(*) AS n FROM fs_side.item');
  const version = await pool.query<{ v: string }>(`SELECT current_setting('server_version') AS v`);
  return {
    spike: 'query-compiler',
    at: new Date().toISOString(),
    items: Number(count.rows[0]?.n),
    runs: options.runs ?? 20,
    machine: {
      cpu: cpus()[0]?.model.trim() ?? 'unknown',
      cores: cpus().length,
      postgres: version.rows[0]?.v ?? 'unknown',
    },
    prepare,
    queries,
  };
}

export function renderQueryReport(result: QueryBenchResult): string {
  const over = result.queries.filter((q) => q.p95 > 300);
  const cell = (q: QueryBenchResult['queries'][number], value: number) =>
    q.timedOut ? `> ${STATEMENT_TIMEOUT_S * 1000} (timed out)` : String(value);
  const indexSeconds = result.prepare
    .filter((s) => s.step.startsWith('index'))
    .reduce((a, s) => a + s.seconds, 0);
  const lines = [
    `# Query compiler spike: ${result.items.toLocaleString('en')} items`,
    '',
    `Generated ${result.at.slice(0, 16).replace('T', ' ')} UTC on ${result.machine.cpu} (${result.machine.cores} threads), ` +
      `PostgreSQL ${result.machine.postgres}, ${result.runs} timed runs per query after warm-up, LIMIT 50, latency from the client.`,
    '',
    `Budget: p95 under 300 ms. ${over.length === 0 ? 'Every query meets it.' : `${over.length} of ${result.queries.length} exceed it: ${over.map((q) => q.id).join(', ')}.`}`,
    '',
    '| Query | Text | Rows | p50 ms | p95 ms | Max ms |',
    '|---|---|---:|---:|---:|---:|',
    ...result.queries.map(
      (q) =>
        `| ${q.id} | \`${q.text.replace(/\|/g, '\\|')}\` | ${q.rows} | ${cell(q, q.p50)} | ${cell(q, q.p95)} | ${cell(q, q.max)} |`,
    ),
    '',
    '## Indexes added for the query set',
    '',
    `Built in ${Math.round(indexSeconds)}s on top of the side-table indexes (skipped when present).`,
    '',
    '| Index | Definition |',
    '|---|---|',
    ...QUERY_INDEXES.map((i) => `| ${i.name} | \`${i.sql}\` |`),
  ];
  return `${lines.join('\n')}\n`;
}
