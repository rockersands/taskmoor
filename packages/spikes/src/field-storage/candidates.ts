/**
 * Three ways to store custom field values, built from the `gen` staging schema (ADR-008 spike).
 *
 * - jsonb: one JSONB column per item with a GIN index. Simplest; filtering on typed values
 *   relies on the GIN containment operator or on scanning.
 * - side: the JSONB column for reads plus typed side tables (one per value type) with a
 *   (field, value, item) index each, for filtering and sorting.
 * - eav: one entity-attribute-value table with typed columns, no JSONB copy.
 */
export type CandidateId = 'jsonb' | 'side' | 'eav';

export const CANDIDATES: readonly CandidateId[] = ['jsonb', 'side', 'eav'];

export interface Candidate {
  id: CandidateId;
  schema: string;
  title: string;
  /** Statements that create and fill the schema, run in order; each is timed. */
  build: { step: string; sql: string }[];
  /** Tables whose sizes count as "field storage" (the item table is reported separately). */
  valueTables: string[];
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

/** Pairs of (item, field, value) for scalar fields of one type, from the staging JSONB. */
const scalarPairs = (type: string, cast: string) => `
  SELECT i.id AS item_id, f.id AS field_id, (kv.value #>> '{}')${cast} AS value
    FROM gen.items i
    CROSS JOIN LATERAL jsonb_each(i.fields) kv
    JOIN gen.fields f ON f.id = kv.key::int
   WHERE f.type = '${type}'`;

/** Pairs for array-valued fields (multiselect, labels), one row per element. */
const arrayPairs = (types: string[]) => `
  SELECT i.id AS item_id, f.id AS field_id, e.value
    FROM gen.items i
    CROSS JOIN LATERAL jsonb_each(i.fields) kv
    JOIN gen.fields f ON f.id = kv.key::int
    CROSS JOIN LATERAL jsonb_array_elements_text(kv.value) e
   WHERE f.type IN (${types.map((t) => `'${t}'`).join(', ')})`;

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
    valueTables: [],
  },

  side: {
    id: 'side',
    schema: 'fs_side',
    title: 'JSONB for reads plus typed side tables',
    build: [
      {
        step: 'create',
        sql: `DROP SCHEMA IF EXISTS fs_side CASCADE; CREATE SCHEMA fs_side;
CREATE TABLE fs_side.item (${ITEM_COLUMNS}, fields jsonb NOT NULL);
CREATE TABLE fs_side.v_text (item_id bigint NOT NULL, field_id int NOT NULL, value text NOT NULL);
CREATE TABLE fs_side.v_number (item_id bigint NOT NULL, field_id int NOT NULL, value numeric NOT NULL);
CREATE TABLE fs_side.v_date (item_id bigint NOT NULL, field_id int NOT NULL, value date NOT NULL);
CREATE TABLE fs_side.v_user (item_id bigint NOT NULL, field_id int NOT NULL, value int NOT NULL);
CREATE TABLE fs_side.v_option (item_id bigint NOT NULL, field_id int NOT NULL, value text NOT NULL);`,
      },
      {
        step: 'load',
        sql: `INSERT INTO fs_side.item SELECT ${ITEM_SELECT}, fields FROM gen.items;
INSERT INTO fs_side.v_text ${scalarPairs('text', '')};
INSERT INTO fs_side.v_number ${scalarPairs('number', '::numeric')};
INSERT INTO fs_side.v_date ${scalarPairs('date', '::date')};
INSERT INTO fs_side.v_user ${scalarPairs('user', '::int')};
INSERT INTO fs_side.v_option ${scalarPairs('select', '')};
INSERT INTO fs_side.v_option ${arrayPairs(['multiselect', 'labels'])};`,
      },
      {
        step: 'index',
        sql: `${ITEM_INDEXES('fs_side')}
ALTER TABLE fs_side.v_text ADD PRIMARY KEY (item_id, field_id);
ALTER TABLE fs_side.v_number ADD PRIMARY KEY (item_id, field_id);
ALTER TABLE fs_side.v_date ADD PRIMARY KEY (item_id, field_id);
ALTER TABLE fs_side.v_user ADD PRIMARY KEY (item_id, field_id);
ALTER TABLE fs_side.v_option ADD PRIMARY KEY (item_id, field_id, value);
CREATE INDEX ON fs_side.v_text (field_id, value, item_id);
CREATE INDEX ON fs_side.v_number (field_id, value, item_id);
CREATE INDEX ON fs_side.v_date (field_id, value, item_id);
CREATE INDEX ON fs_side.v_user (field_id, value, item_id);
CREATE INDEX ON fs_side.v_option (field_id, value, item_id);`,
      },
      {
        step: 'analyze',
        sql: 'ANALYZE fs_side.item, fs_side.v_text, fs_side.v_number, fs_side.v_date, fs_side.v_user, fs_side.v_option;',
      },
    ],
    valueTables: ['v_text', 'v_number', 'v_date', 'v_user', 'v_option'],
  },

  eav: {
    id: 'eav',
    schema: 'fs_eav',
    title: 'Entity-attribute-value table with typed columns',
    build: [
      {
        step: 'create',
        sql: `DROP SCHEMA IF EXISTS fs_eav CASCADE; CREATE SCHEMA fs_eav;
CREATE TABLE fs_eav.item (${ITEM_COLUMNS});
CREATE TABLE fs_eav.value (
  item_id bigint NOT NULL, field_id int NOT NULL, seq smallint NOT NULL DEFAULT 0,
  text_value text, num_value numeric, date_value date, user_value int
);`,
      },
      {
        step: 'load',
        sql: `INSERT INTO fs_eav.item SELECT ${ITEM_SELECT} FROM gen.items;
INSERT INTO fs_eav.value (item_id, field_id, seq, text_value)
  SELECT item_id, field_id, 0, value FROM (${scalarPairs('text', '')}) s;
INSERT INTO fs_eav.value (item_id, field_id, seq, text_value)
  SELECT item_id, field_id, 0, value FROM (${scalarPairs('select', '')}) s;
INSERT INTO fs_eav.value (item_id, field_id, seq, num_value)
  SELECT item_id, field_id, 0, value FROM (${scalarPairs('number', '::numeric')}) s;
INSERT INTO fs_eav.value (item_id, field_id, seq, date_value)
  SELECT item_id, field_id, 0, value FROM (${scalarPairs('date', '::date')}) s;
INSERT INTO fs_eav.value (item_id, field_id, seq, user_value)
  SELECT item_id, field_id, 0, value FROM (${scalarPairs('user', '::int')}) s;
INSERT INTO fs_eav.value (item_id, field_id, seq, text_value)
  SELECT item_id, field_id, row_number() OVER (PARTITION BY item_id, field_id) - 1, value
    FROM (${arrayPairs(['multiselect', 'labels'])}) s;`,
      },
      {
        step: 'index',
        sql: `${ITEM_INDEXES('fs_eav')}
ALTER TABLE fs_eav.value ADD PRIMARY KEY (item_id, field_id, seq);
CREATE INDEX ON fs_eav.value (field_id, text_value, item_id) WHERE text_value IS NOT NULL;
CREATE INDEX ON fs_eav.value (field_id, num_value, item_id) WHERE num_value IS NOT NULL;
CREATE INDEX ON fs_eav.value (field_id, date_value, item_id) WHERE date_value IS NOT NULL;
CREATE INDEX ON fs_eav.value (field_id, user_value, item_id) WHERE user_value IS NOT NULL;`,
      },
      { step: 'analyze', sql: 'ANALYZE fs_eav.item, fs_eav.value;' },
    ],
    valueTables: ['value'],
  },
};
