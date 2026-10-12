import { Rng, ZipfSampler } from '@tracksmith/testkit/gen';
import type pg from 'pg';
import type { CandidateId } from './candidates';

/** What the queries need to know about the loaded dataset. */
export interface QueryContext {
  seed: number;
  itemCount: number;
  userCount: number;
  spaceIds: number[];
  /** One site-wide field of each type that the queries filter and sort on. */
  fields: {
    text: number;
    number: number;
    date: number;
    user: number;
    select: { id: number; options: string[] };
  };
}

export interface QueryDef {
  id: string;
  title: string;
  kind: 'read' | 'write';
  /** How results of different candidates are compared in the equivalence test. */
  compare: 'ids' | 'rows' | 'none';
  sql: Record<CandidateId, string>;
  /** Same (ctx, run) gives the same parameters for every candidate. */
  params: (ctx: QueryContext, run: number) => unknown[];
}

const DAY = 86_400_000;

function space(ctx: QueryContext, rng: Rng): number {
  return ctx.spaceIds[new ZipfSampler(ctx.spaceIds.length).sample(rng)] as number;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const order = (alias: string) => `ORDER BY ${alias}.created_at DESC LIMIT 50`;

export const QUERIES: readonly QueryDef[] = [
  {
    id: 'open',
    title: 'Open one item with all its field values',
    kind: 'read',
    compare: 'ids',
    sql: {
      jsonb: 'SELECT * FROM fs_jsonb.item WHERE id = $1',
      side: 'SELECT * FROM fs_side.item WHERE id = $1',
      eav: `SELECT i.*, (SELECT jsonb_object_agg(field_id,
              coalesce(text_value, num_value::text, date_value::text, user_value::text))
              FROM fs_eav.value v WHERE v.item_id = i.id) AS fields
            FROM fs_eav.item i WHERE i.id = $1`,
    },
    params: (ctx, run) => [Rng.derive(ctx.seed, 'open', run).int(1, ctx.itemCount)],
  },
  {
    id: 'select-in-space',
    title: 'Select field = option within a space, newest 50',
    kind: 'read',
    compare: 'ids',
    sql: {
      jsonb: `SELECT id FROM fs_jsonb.item
              WHERE space_id = $1 AND fields @> jsonb_build_object($2::int::text, $3::text)
              ${order('fs_jsonb.item')}`,
      side: `SELECT i.id FROM fs_side.item i
             JOIN fs_side.v_option v ON v.item_id = i.id
             WHERE i.space_id = $1 AND v.field_id = $2 AND v.value = $3 ${order('i')}`,
      eav: `SELECT i.id FROM fs_eav.item i
            JOIN fs_eav.value v ON v.item_id = i.id
            WHERE i.space_id = $1 AND v.field_id = $2 AND v.text_value = $3 ${order('i')}`,
    },
    params: (ctx, run) => {
      const rng = Rng.derive(ctx.seed, 'select-in-space', run);
      return [space(ctx, rng), ctx.fields.select.id, rng.pick(ctx.fields.select.options)];
    },
  },
  {
    id: 'number-range',
    title: 'Number field > x across the site, newest 50',
    kind: 'read',
    compare: 'ids',
    sql: {
      jsonb: `SELECT id FROM fs_jsonb.item WHERE (fields->>$1::int::text)::numeric > $2
              ${order('fs_jsonb.item')}`,
      side: `SELECT i.id FROM fs_side.v_number v JOIN fs_side.item i ON i.id = v.item_id
             WHERE v.field_id = $1 AND v.value > $2 ${order('i')}`,
      eav: `SELECT i.id FROM fs_eav.value v JOIN fs_eav.item i ON i.id = v.item_id
            WHERE v.field_id = $1 AND v.num_value > $2 ${order('i')}`,
    },
    params: (ctx, run) => [
      ctx.fields.number,
      Rng.derive(ctx.seed, 'number-range', run).int(0, 900),
    ],
  },
  {
    id: 'date-and-status',
    title: 'Date field in a 30-day window and a status category, newest 50',
    kind: 'read',
    compare: 'ids',
    sql: {
      jsonb: `SELECT id FROM fs_jsonb.item
              WHERE (fields->>$1::int::text)::date BETWEEN $2::date AND $3::date
                AND status_category = $4 ${order('fs_jsonb.item')}`,
      side: `SELECT i.id FROM fs_side.v_date v JOIN fs_side.item i ON i.id = v.item_id
             WHERE v.field_id = $1 AND v.value BETWEEN $2::date AND $3::date
               AND i.status_category = $4 ${order('i')}`,
      eav: `SELECT i.id FROM fs_eav.value v JOIN fs_eav.item i ON i.id = v.item_id
            WHERE v.field_id = $1 AND v.date_value BETWEEN $2::date AND $3::date
              AND i.status_category = $4 ${order('i')}`,
    },
    params: (ctx, run) => {
      const rng = Rng.derive(ctx.seed, 'date-and-status', run);
      const from = Date.UTC(2018, 0, 1) + rng.int(0, 8 * 365) * DAY;
      return [
        ctx.fields.date,
        isoDate(from),
        isoDate(from + 30 * DAY),
        rng.pick(['todo', 'in_progress', 'done']),
      ];
    },
  },
  {
    id: 'two-fields',
    title: 'Select field = option AND number field > x, newest 50',
    kind: 'read',
    compare: 'ids',
    sql: {
      jsonb: `SELECT id FROM fs_jsonb.item
              WHERE fields @> jsonb_build_object($1::int::text, $2::text)
                AND (fields->>$3::int::text)::numeric > $4 ${order('fs_jsonb.item')}`,
      side: `SELECT i.id FROM fs_side.item i
             JOIN fs_side.v_option o ON o.item_id = i.id AND o.field_id = $1 AND o.value = $2
             JOIN fs_side.v_number n ON n.item_id = i.id AND n.field_id = $3 AND n.value > $4
             ${order('i')}`,
      eav: `SELECT i.id FROM fs_eav.item i
            JOIN fs_eav.value o ON o.item_id = i.id AND o.field_id = $1 AND o.text_value = $2
            JOIN fs_eav.value n ON n.item_id = i.id AND n.field_id = $3 AND n.num_value > $4
            ${order('i')}`,
    },
    params: (ctx, run) => {
      const rng = Rng.derive(ctx.seed, 'two-fields', run);
      return [
        ctx.fields.select.id,
        rng.pick(ctx.fields.select.options),
        ctx.fields.number,
        rng.int(0, 500),
      ];
    },
  },
  {
    id: 'sort-by-number',
    title: 'Items in a space sorted by a number field, top 50',
    kind: 'read',
    compare: 'ids',
    sql: {
      jsonb: `SELECT id FROM fs_jsonb.item WHERE space_id = $1 AND fields ? $2::int::text
              ORDER BY (fields->>$2::int::text)::numeric DESC, id LIMIT 50`,
      side: `SELECT i.id FROM fs_side.v_number v JOIN fs_side.item i ON i.id = v.item_id
             WHERE i.space_id = $1 AND v.field_id = $2 ORDER BY v.value DESC, i.id LIMIT 50`,
      eav: `SELECT i.id FROM fs_eav.value v JOIN fs_eav.item i ON i.id = v.item_id
            WHERE i.space_id = $1 AND v.field_id = $2 ORDER BY v.num_value DESC, i.id LIMIT 50`,
    },
    params: (ctx, run) => [
      space(ctx, Rng.derive(ctx.seed, 'sort-by-number', run)),
      ctx.fields.number,
    ],
  },
  {
    id: 'count-by-option',
    title: 'Count items per option of a select field within a space',
    kind: 'read',
    compare: 'rows',
    sql: {
      jsonb: `SELECT fields->>$2::int::text AS value, count(*)::int AS n FROM fs_jsonb.item
              WHERE space_id = $1 AND fields ? $2::int::text GROUP BY 1 ORDER BY 1`,
      side: `SELECT v.value, count(*)::int AS n FROM fs_side.v_option v
             JOIN fs_side.item i ON i.id = v.item_id
             WHERE i.space_id = $1 AND v.field_id = $2 GROUP BY 1 ORDER BY 1`,
      eav: `SELECT v.text_value AS value, count(*)::int AS n FROM fs_eav.value v
            JOIN fs_eav.item i ON i.id = v.item_id
            WHERE i.space_id = $1 AND v.field_id = $2 GROUP BY 1 ORDER BY 1`,
    },
    params: (ctx, run) => [
      space(ctx, Rng.derive(ctx.seed, 'count-by-option', run)),
      ctx.fields.select.id,
    ],
  },
  {
    id: 'user-field',
    title: 'User field = person across the site, newest 50',
    kind: 'read',
    compare: 'ids',
    sql: {
      jsonb: `SELECT id FROM fs_jsonb.item
              WHERE fields @> jsonb_build_object($1::int::text, $2::int) ${order('fs_jsonb.item')}`,
      side: `SELECT i.id FROM fs_side.v_user v JOIN fs_side.item i ON i.id = v.item_id
             WHERE v.field_id = $1 AND v.value = $2 ${order('i')}`,
      eav: `SELECT i.id FROM fs_eav.value v JOIN fs_eav.item i ON i.id = v.item_id
            WHERE v.field_id = $1 AND v.user_value = $2 ${order('i')}`,
    },
    params: (ctx, run) => {
      const rng = Rng.derive(ctx.seed, 'user-field', run);
      return [ctx.fields.user, new ZipfSampler(ctx.userCount).sample(rng) + 1];
    },
  },
  {
    id: 'count-number-range',
    title: 'Count items site-wide with number field > x',
    kind: 'read',
    compare: 'rows',
    sql: {
      jsonb: `SELECT count(*)::int AS n FROM fs_jsonb.item
              WHERE (fields->>$1::int::text)::numeric > $2`,
      side: 'SELECT count(*)::int AS n FROM fs_side.v_number WHERE field_id = $1 AND value > $2',
      eav: 'SELECT count(*)::int AS n FROM fs_eav.value WHERE field_id = $1 AND num_value > $2',
    },
    params: (ctx, run) => [
      ctx.fields.number,
      Rng.derive(ctx.seed, 'count-number-range', run).int(0, 900),
    ],
  },
  {
    id: 'edit-number',
    title: 'Set a number field on one item',
    kind: 'write',
    compare: 'none',
    sql: {
      jsonb: `UPDATE fs_jsonb.item SET fields = fields || jsonb_build_object($2::int::text, $3::numeric)
              WHERE id = $1`,
      side: `WITH u AS (
               UPDATE fs_side.item SET fields = fields || jsonb_build_object($2::int::text, $3::numeric)
               WHERE id = $1 RETURNING id)
             INSERT INTO fs_side.v_number (item_id, field_id, value)
             SELECT id, $2::int, $3::numeric FROM u
             ON CONFLICT (item_id, field_id) DO UPDATE SET value = EXCLUDED.value`,
      eav: `INSERT INTO fs_eav.value (item_id, field_id, seq, num_value) VALUES ($1, $2, 0, $3)
            ON CONFLICT (item_id, field_id, seq) DO UPDATE SET num_value = EXCLUDED.num_value`,
    },
    params: (ctx, run) => {
      const rng = Rng.derive(ctx.seed, 'edit-number', run);
      return [rng.int(1, ctx.itemCount), ctx.fields.number, rng.int(0, 100_000) / 100];
    },
  },
];

/** Reads the query context from the `gen` staging schema. */
export async function loadContext(pool: pg.Pool, seed = 1): Promise<QueryContext> {
  const fields = await pool.query<{ id: number; type: string; options: string[] }>(
    `SELECT id, type, options FROM gen.fields WHERE space_id IS NULL ORDER BY id`,
  );
  const first = (type: string) => {
    const f = fields.rows.find((r) => r.type === type);
    if (!f) throw new Error(`No site-wide ${type} field in the dataset`);
    return f;
  };
  const select = first('select');
  const spaces = await pool.query<{ id: number }>('SELECT id FROM gen.spaces ORDER BY id');
  const counts = await pool.query<{ items: string; users: string }>(
    'SELECT (SELECT count(*) FROM gen.items) AS items, (SELECT count(*) FROM gen.users) AS users',
  );
  return {
    seed,
    itemCount: Number(counts.rows[0]?.items),
    userCount: Number(counts.rows[0]?.users),
    spaceIds: spaces.rows.map((r) => r.id),
    fields: {
      text: first('text').id,
      number: first('number').id,
      date: first('date').id,
      user: first('user').id,
      select: { id: select.id, options: select.options },
    },
  };
}
