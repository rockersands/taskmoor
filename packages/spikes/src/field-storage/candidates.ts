/**
 * Three ways to store custom field values, built from the `gen` staging schema (ADR-008 spike).
 *
 * - jsonb: one JSONB column per item with a GIN index. Simplest; typed filtering and sorting
 *   rely on the containment operator or on scanning.
 * - side: the JSONB column for reads plus one typed side table per value type. Each side row
 *   also carries the item's space and creation time (both immutable), so space-scoped filters
 *   and "newest first" lists are served from one index without touching the item table.
 * - eav: one entity-attribute-value table with typed columns, carrying the same denormalised
 *   columns, and no JSONB copy.
 *
 * The first run (docs/spikes/field-storage-1m-v1.md) used side and EAV tables without the
 * denormalised columns; space-scoped queries then had to join and intersect, and lost to JSONB.
 */
export type CandidateId = 'jsonb' | 'side' | 'eav';

export const CANDIDATES: readonly CandidateId[] = ['jsonb', 'side', 'eav'];

export interface Candidate {
  id: CandidateId;
  schema: string;
  title: string;
  /** Statements that create and fill the schema, run in order; each is timed. */
  build: { step: string; sql: string }[];
}

const ITEM_COLUMNS = `id bigint PRIMARY KEY, space_id int NOT NULL, number int NOT NULL, key text NOT NULL,
  type text NOT NULL, parent_id bigint, status text NOT NULL, status_category text NOT NULL,
  priority text NOT NULL, summary text NOT NULL, description text, reporter_id int NOT NULL,
  assignee_id int, labels text[] NOT NULL, created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL, resolved_at timestamptz`;

const ITEM_SELECT = `id, space_id, number, key, type, parent_id, status, status_category, priority,
  summary, description, reporter_id, assignee_id, labels, created_at, updated_at, resolved_at`;

const ITEM_INDEXES = (schema: string) => `
CREATE INDEX ON ${schema}.item (space_id, created_at DESC);
CREATE INDEX ON ${schema}.item (created_at DESC);
CREATE INDEX ON ${schema}.item (assignee_id);
CREATE INDEX ON ${schema}.item (parent_id);`;

/**
 * One (item, field, value) row per custom field value, built once per dataset and shared by the
 * side and EAV candidates so the expensive JSONB unpacking runs a single time.
 */
const PAIRS_SQL = `
CREATE TABLE IF NOT EXISTS gen.pairs AS
  SELECT i.id AS item_id, i.space_id, i.created_at, f.id AS field_id, f.type, kv.value
    FROM gen.items i
    CROSS JOIN LATERAL jsonb_each(i.fields) kv
    JOIN gen.fields f ON f.id = kv.key::int;`;

const SIDE_TABLE = (name: string, type: string) => `
CREATE TABLE fs_side.${name} (
  item_id bigint NOT NULL, space_id int NOT NULL, field_id int NOT NULL,
  value ${type} NOT NULL, created_at timestamptz NOT NULL);`;

const SIDE_INDEXES = (name: string, multi = false) => `
ALTER TABLE fs_side.${name} ADD PRIMARY KEY (item_id, field_id${multi ? ', value' : ''});
CREATE INDEX ON fs_side.${name} (field_id, value, created_at DESC) INCLUDE (item_id);
CREATE INDEX ON fs_side.${name} (space_id, field_id, value, created_at DESC) INCLUDE (item_id);
CREATE INDEX ON fs_side.${name} (field_id, created_at DESC) INCLUDE (value, item_id);
-- Values belong to their field: without these, the planner multiplies the two selectivities
-- and expected 58 rows where 37,000 matched at 10M items, then fetched them all.
CREATE STATISTICS fs_side.${name}_field_value (dependencies, ndistinct, mcv) ON field_id, value FROM fs_side.${name};`;

export const candidates: Record<CandidateId, Candidate> = {
  jsonb: {
    id: 'jsonb',
    schema: 'fs_jsonb',
    title: 'JSONB column with a GIN index',
    build: [
      {
        step: 'create',
        sql: `DROP SCHEMA IF EXISTS fs_jsonb CASCADE; CREATE SCHEMA fs_jsonb;
CREATE TABLE fs_jsonb.item (${ITEM_COLUMNS}, fields jsonb NOT NULL);`,
      },
      {
        step: 'load',
        sql: `INSERT INTO fs_jsonb.item SELECT ${ITEM_SELECT}, fields FROM gen.items;`,
      },
      {
        step: 'index',
        sql: `${ITEM_INDEXES('fs_jsonb')}
CREATE INDEX ON fs_jsonb.item USING gin (fields jsonb_path_ops);`,
      },
      { step: 'analyze', sql: 'ANALYZE fs_jsonb.item;' },
    ],
  },

  side: {
    id: 'side',
    schema: 'fs_side',
    title: 'JSONB for reads plus typed side tables',
    build: [
      { step: 'pairs', sql: PAIRS_SQL },
      {
        step: 'create',
        sql: `DROP SCHEMA IF EXISTS fs_side CASCADE; CREATE SCHEMA fs_side;
CREATE TABLE fs_side.item (${ITEM_COLUMNS}, fields jsonb NOT NULL);
${SIDE_TABLE('v_text', 'text')}
${SIDE_TABLE('v_number', 'numeric')}
${SIDE_TABLE('v_date', 'date')}
${SIDE_TABLE('v_user', 'int')}
${SIDE_TABLE('v_option', 'text')}`,
      },
      {
        step: 'load',
        sql: `INSERT INTO fs_side.item SELECT ${ITEM_SELECT}, fields FROM gen.items;
INSERT INTO fs_side.v_text SELECT item_id, space_id, field_id, value #>> '{}', created_at
  FROM gen.pairs WHERE type = 'text';
INSERT INTO fs_side.v_number SELECT item_id, space_id, field_id, (value #>> '{}')::numeric, created_at
  FROM gen.pairs WHERE type = 'number';
INSERT INTO fs_side.v_date SELECT item_id, space_id, field_id, (value #>> '{}')::date, created_at
  FROM gen.pairs WHERE type = 'date';
INSERT INTO fs_side.v_user SELECT item_id, space_id, field_id, (value #>> '{}')::int, created_at
  FROM gen.pairs WHERE type = 'user';
INSERT INTO fs_side.v_option SELECT item_id, space_id, field_id, value #>> '{}', created_at
  FROM gen.pairs WHERE type = 'select';
INSERT INTO fs_side.v_option SELECT p.item_id, p.space_id, p.field_id, e.value, p.created_at
  FROM gen.pairs p CROSS JOIN LATERAL jsonb_array_elements_text(p.value) e
  WHERE p.type IN ('multiselect', 'labels');`,
      },
      {
        step: 'index',
        sql: `${ITEM_INDEXES('fs_side')}
${SIDE_INDEXES('v_text')}
${SIDE_INDEXES('v_number')}
${SIDE_INDEXES('v_date')}
${SIDE_INDEXES('v_user')}
${SIDE_INDEXES('v_option', true)}`,
      },
      {
        step: 'analyze',
        sql: 'ANALYZE fs_side.item, fs_side.v_text, fs_side.v_number, fs_side.v_date, fs_side.v_user, fs_side.v_option;',
      },
    ],
  },

  eav: {
    id: 'eav',
    schema: 'fs_eav',
    title: 'Entity-attribute-value table with typed columns',
    build: [
      { step: 'pairs', sql: PAIRS_SQL },
      {
        step: 'create',
        sql: `DROP SCHEMA IF EXISTS fs_eav CASCADE; CREATE SCHEMA fs_eav;
CREATE TABLE fs_eav.item (${ITEM_COLUMNS});
CREATE TABLE fs_eav.value (
  item_id bigint NOT NULL, space_id int NOT NULL, field_id int NOT NULL,
  seq smallint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL,
  text_value text, num_value numeric, date_value date, user_value int
);`,
      },
      {
        step: 'load',
        sql: `INSERT INTO fs_eav.item SELECT ${ITEM_SELECT} FROM gen.items;
INSERT INTO fs_eav.value (item_id, space_id, field_id, seq, created_at, text_value, num_value, date_value, user_value)
  SELECT item_id, space_id, field_id, 0, created_at,
         CASE WHEN type IN ('text', 'select') THEN value #>> '{}' END,
         CASE WHEN type = 'number' THEN (value #>> '{}')::numeric END,
         CASE WHEN type = 'date' THEN (value #>> '{}')::date END,
         CASE WHEN type = 'user' THEN (value #>> '{}')::int END
    FROM gen.pairs WHERE type NOT IN ('multiselect', 'labels');
INSERT INTO fs_eav.value (item_id, space_id, field_id, seq, created_at, text_value)
  SELECT p.item_id, p.space_id, p.field_id, e.ord - 1, p.created_at, e.value
    FROM gen.pairs p
    CROSS JOIN LATERAL jsonb_array_elements_text(p.value) WITH ORDINALITY e(value, ord)
   WHERE p.type IN ('multiselect', 'labels');`,
      },
      {
        step: 'index',
        sql: `${ITEM_INDEXES('fs_eav')}
ALTER TABLE fs_eav.value ADD PRIMARY KEY (item_id, field_id, seq);
CREATE INDEX ON fs_eav.value (field_id, text_value, created_at DESC) INCLUDE (item_id) WHERE text_value IS NOT NULL;
CREATE INDEX ON fs_eav.value (field_id, num_value, created_at DESC) INCLUDE (item_id) WHERE num_value IS NOT NULL;
CREATE INDEX ON fs_eav.value (field_id, date_value, created_at DESC) INCLUDE (item_id) WHERE date_value IS NOT NULL;
CREATE INDEX ON fs_eav.value (field_id, user_value, created_at DESC) INCLUDE (item_id) WHERE user_value IS NOT NULL;
CREATE INDEX ON fs_eav.value (space_id, field_id, text_value, created_at DESC) INCLUDE (item_id) WHERE text_value IS NOT NULL;
CREATE INDEX ON fs_eav.value (space_id, field_id, num_value, created_at DESC) INCLUDE (item_id) WHERE num_value IS NOT NULL;`,
      },
      { step: 'analyze', sql: 'ANALYZE fs_eav.item, fs_eav.value;' },
    ],
  },
};
