import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';

/**
 * The search benchmark's dataset (M1-037): the synthetic dataset `pnpm gen` stages in schema
 * `gen` (Zipf-skewed tracks and people, 25 custom values per ticket from 1,500 fields), reshaped
 * into the product's own schema in the same database, so the production compiler's statements
 * run against the production tables, side tables and indexes (ADR-008, ADR-010).
 *
 * Benchmark code only: nothing in the server imports it. Indexes are dropped while rows go in
 * and rebuilt from their own definitions afterwards, and triggers are off during the load, so
 * the rows the triggers would write (key history) are written here.
 */
type Db = Kysely<Database>;

export interface LoadReport {
  tickets: number;
  sideRows: Record<string, number>;
  steps: { step: string; seconds: number }[];
}

const SIDE = ['v_text', 'v_number', 'v_date', 'v_time', 'v_user', 'v_option'] as const;

/** Whether the product tables already hold the dataset. */
export async function loaded(db: Db): Promise<boolean> {
  const { rows } = await sql<{
    n: string;
  }>`SELECT count(*) AS n FROM (SELECT 1 FROM ticket LIMIT 1) t`.execute(db);
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Each track's key in its key history, where opening a ticket by key looks it up (a loader that
 * wrote only the track row left every key unknown). Safe to run again.
 */
export async function ensureTrackKeys(db: Db): Promise<void> {
  await sql`INSERT INTO track_key_history (workspace_id, track_id, key)
    SELECT t.workspace_id, t.id, t.key FROM track t
     WHERE NOT EXISTS (SELECT 1 FROM track_key_history h WHERE h.track_id = t.id)`.execute(db);
}

export async function loadFromGen(
  db: Db,
  log: (m: string) => void = () => {},
): Promise<LoadReport> {
  const steps: LoadReport['steps'] = [];
  return db.connection().execute(async (conn) => {
    const run = async (step: string, statement: ReturnType<typeof sql>) => {
      const t0 = Date.now();
      await statement.execute(conn);
      const seconds = Math.round((Date.now() - t0) / 100) / 10;
      steps.push({ step, seconds });
      log(`  ${step}: ${seconds}s`);
    };
    await sql`SET maintenance_work_mem = '1GB'`.execute(conn);
    await sql`SET work_mem = '256MB'`.execute(conn);
    await sql`SET max_parallel_maintenance_workers = 2`.execute(conn);
    // No triggers and no foreign key checks while loading; the rows are consistent by design.
    await sql`SET session_replication_role = replica`.execute(conn);

    // Indexes of the tables loaded in bulk, rebuilt after the load from their own definitions.
    const { rows: indexes } = await sql<{
      name: string;
      definition: string;
      constraint: string | null;
      constraintDefinition: string | null;
      table: string;
    }>`
      SELECT i.relname AS name, pg_get_indexdef(i.oid) AS definition, c.conname AS constraint,
             pg_get_constraintdef(c.oid) AS "constraintDefinition", t.relname AS table
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        LEFT JOIN pg_constraint c ON c.conindid = i.oid
       WHERE t.relname IN ('ticket', 'ticket_key_history', 'ticket_follower', 'v_text', 'v_number',
                           'v_date', 'v_time', 'v_user', 'v_option')
         AND t.relnamespace = 'public'::regnamespace
         AND NOT (t.relname = 'ticket' AND i.relname = 'ticket_pkey')`.execute(conn);
    for (const index of indexes) {
      if (index.constraint) {
        await sql`ALTER TABLE ${sql.table(index.table)} DROP CONSTRAINT ${sql.ref(index.constraint)}`.execute(
          conn,
        );
      } else {
        await sql`DROP INDEX ${sql.ref(index.name)}`.execute(conn);
      }
    }

    await run(
      'people',
      sql`INSERT INTO app_user (id, workspace_id, email, name, deactivated_at)
          SELECT id, 1, email, name, CASE WHEN active THEN NULL ELSE now() END FROM gen.users`,
    );
    await sql`SELECT setval('app_user_id_seq', (SELECT max(id) FROM app_user))`.execute(conn);
    await run(
      'tracks',
      sql`INSERT INTO track (id, workspace_id, key, name, type, owner_id, access_policy_id, type_set_id)
          SELECT s.id, 1, s.key, s.name, s.type, s.lead_id,
                 (SELECT id FROM access_policy WHERE workspace_id = 1 AND is_default),
                 coalesce((SELECT type_set_id FROM type_set_default WHERE workspace_id = 1 AND track_type = s.type),
                          (SELECT type_set_id FROM type_set_default WHERE workspace_id = 1 AND track_type = 'software'))
            FROM gen.spaces s`,
    );
    await sql`SELECT setval('track_id_seq', (SELECT max(id) FROM track))`.execute(conn);
    await ensureTrackKeys(conn);
    await sql`INSERT INTO ticket_counter (track_id, workspace_id, last_number)
      SELECT space_id, 1, max(number) FROM gen.items GROUP BY space_id`.execute(conn);

    // Statuses the dataset uses that the product does not ship, in their stages.
    await sql`INSERT INTO status (workspace_id, name, stage, sort_order)
      SELECT 1, g.status, CASE g.status_category WHEN 'todo' THEN 'new' WHEN 'in_progress' THEN 'active' ELSE 'closed' END,
             (SELECT max(sort_order) FROM status WHERE workspace_id = 1) + row_number() OVER (ORDER BY g.status)
        FROM (SELECT DISTINCT status, status_category FROM gen.items) g
       WHERE NOT EXISTS (SELECT 1 FROM status s WHERE s.workspace_id = 1 AND lower(s.name) = lower(g.status))`.execute(
      conn,
    );
    await sql`CREATE TEMP TABLE status_map AS
      SELECT DISTINCT ON (g.status) g.status AS name, s.id FROM (SELECT DISTINCT status FROM gen.items) g
        JOIN status s ON s.workspace_id = 1 AND lower(s.name) = lower(g.status)`.execute(conn);
    await sql`CREATE TEMP TABLE priority_map AS
      SELECT m.name, p.id FROM (VALUES ('Highest', 'Urgent'), ('High', 'High'), ('Medium', 'Normal'),
                                      ('Low', 'Low'), ('Lowest', 'Low')) AS m(name, product)
        JOIN priority p ON p.workspace_id = 1 AND p.name = m.product`.execute(conn);
    await sql`CREATE TEMP TABLE type_map AS
      SELECT m.name, t.id FROM (VALUES ('Epic', 'Outcome'), ('Story', 'Feature'), ('Task', 'Chore'),
                                      ('Bug', 'Bug'), ('Subtask', 'Subticket')) AS m(name, product)
        JOIN ticket_type t ON t.workspace_id = 1 AND t.owner_track_id IS NULL AND t.name = m.product`.execute(
      conn,
    );

    await run(
      'fields',
      sql`INSERT INTO field (id, workspace_id, track_id, name, type, multiple)
          SELECT id, 1, space_id, name,
                 CASE type WHEN 'multiselect' THEN 'select' ELSE type END, type = 'multiselect'
            FROM gen.fields`,
    );
    await sql`SELECT setval('field_id_seq', (SELECT max(id) FROM field))`.execute(conn);
    await sql`INSERT INTO field_context (workspace_id, field_id, name) SELECT 1, id, 'Default' FROM field`.execute(
      conn,
    );
    await sql`INSERT INTO field_context_scope (workspace_id, field_id, context_id, track_id)
      SELECT 1, c.field_id, c.id, f.track_id FROM field_context c JOIN field f ON f.id = c.field_id`.execute(
      conn,
    );
    await sql`INSERT INTO field_option (workspace_id, field_id, context_id, value, sort_order)
      SELECT 1, f.id, c.id, o.value, o.n
        FROM gen.fields f JOIN field_context c ON c.field_id = f.id,
             jsonb_array_elements_text(f.options) WITH ORDINALITY AS o(value, n)
       WHERE f.type IN ('select', 'multiselect')`.execute(conn);
    await sql`CREATE TEMP TABLE option_map AS SELECT field_id, value, id FROM field_option`.execute(
      conn,
    );
    await sql`CREATE INDEX ON option_map (field_id, value)`.execute(conn);
    await sql`ANALYZE option_map`.execute(conn);

    // Tickets: custom values in the product's stored forms (option ids, sorted for multiple
    // selects), descriptions as documents; one in five has a due date, one in four estimates.
    await run(
      'tickets',
      sql`INSERT INTO ticket (id, workspace_id, track_id, number, ticket_type_id, parent_id, summary,
            description, assignee_id, requester_id, creator_id, rank, created_at, updated_at,
            priority_id, closed_at, labels, status_id, fields, due_date, original_estimate,
            remaining_estimate)
          SELECT i.id, 1, i.space_id, i.number, tm.id, i.parent_id, left(i.summary, 255),
                 CASE WHEN i.description IS NOT NULL THEN jsonb_build_object('type', 'doc', 'content',
                   jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content',
                     jsonb_build_array(jsonb_build_object('type', 'text', 'text', i.description))))) END,
                 i.assignee_id, i.reporter_id, i.reporter_id, 'b' || lpad(i.id::text, 10, '0'),
                 i.created_at, i.updated_at, pm.id, i.resolved_at, i.labels, sm.id,
                 coalesce((
                   SELECT jsonb_object_agg(e.key, CASE f.type
                       WHEN 'select' THEN to_jsonb((SELECT o.id FROM option_map o
                                                     WHERE o.field_id = f.id AND o.value = e.value #>> '{}'))
                       WHEN 'multiselect' THEN (SELECT jsonb_agg(o.id ORDER BY o.id)
                                                  FROM jsonb_array_elements_text(e.value) v
                                                  JOIN option_map o ON o.field_id = f.id AND o.value = v)
                       ELSE e.value END)
                     FROM jsonb_each(i.fields) e JOIN gen.fields f ON f.id = e.key::int), '{}'::jsonb),
                 CASE WHEN i.id % 5 = 0 THEN (i.created_at + (i.id % 90) * interval '1 day')::date END,
                 CASE WHEN i.id % 4 = 0 THEN 3600 * (1 + i.id % 16) END,
                 CASE WHEN i.id % 4 = 0 THEN 1800 * (1 + i.id % 16) END
            FROM gen.items i
            JOIN type_map tm ON tm.name = i.type
            JOIN status_map sm ON sm.name = i.status
            LEFT JOIN priority_map pm ON pm.name = i.priority`,
    );
    await sql`SELECT setval('ticket_id_seq', (SELECT max(id) FROM ticket))`.execute(conn);
    await sql`SELECT setval('ticket_rank_seq', (SELECT count(*) FROM ticket))`.execute(conn);
    await run(
      'key history',
      sql`INSERT INTO ticket_key_history (workspace_id, ticket_id, track_id, number, created_at)
          SELECT 1, id, track_id, number, created_at FROM ticket`,
    );
    await run(
      'followers',
      sql`INSERT INTO ticket_follower (workspace_id, ticket_id, user_id, created_at)
          SELECT 1, id, requester_id, created_at FROM ticket WHERE requester_id IS NOT NULL
          UNION
          SELECT 1, id, assignee_id, created_at FROM ticket WHERE assignee_id IS NOT NULL AND id % 3 = 0`,
    );

    // Side rows as syncFieldValues writes them (fields/storage.ts).
    const values = (types: string) =>
      sql.raw(`SELECT k.id AS ticket_id, k.track_id, k.created_at, f.id AS field_id, f.type, f.multiple, e.value
         FROM ticket k CROSS JOIN LATERAL jsonb_each(k.fields) e JOIN field f ON f.id = e.key::int
        WHERE f.type IN (${types})`);
    await run(
      'v_text',
      sql`INSERT INTO v_text (workspace_id, ticket_id, track_id, field_id, value, sort_key, created_at)
          SELECT 1, v.ticket_id, v.track_id, v.field_id, t.value, lower(t.value), v.created_at
            FROM (${values("'text', 'labels'")}) v
            CROSS JOIN LATERAL (
              SELECT DISTINCT x AS value FROM jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(v.value) = 'array' THEN v.value ELSE jsonb_build_array(v.value) END) x
            ) t`,
    );
    await run(
      'v_number',
      sql`INSERT INTO v_number (workspace_id, ticket_id, track_id, field_id, value, created_at)
          SELECT 1, v.ticket_id, v.track_id, v.field_id, (v.value #>> '{}')::numeric, v.created_at
            FROM (${values("'number'")}) v`,
    );
    await run(
      'v_date',
      sql`INSERT INTO v_date (workspace_id, ticket_id, track_id, field_id, value, created_at)
          SELECT 1, v.ticket_id, v.track_id, v.field_id, left(v.value #>> '{}', 10)::date, v.created_at
            FROM (${values("'date'")}) v`,
    );
    await run(
      'v_user',
      sql`INSERT INTO v_user (workspace_id, ticket_id, track_id, field_id, value, created_at)
          SELECT 1, v.ticket_id, v.track_id, v.field_id, (v.value #>> '{}')::int, v.created_at
            FROM (${values("'user'")}) v`,
    );
    await run(
      'v_option',
      sql`INSERT INTO v_option (workspace_id, ticket_id, track_id, field_id, value, created_at)
          SELECT DISTINCT 1, v.ticket_id, v.track_id, v.field_id, x::int, v.created_at
            FROM (${values("'select'")}) v
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(v.value) = 'array' THEN v.value ELSE jsonb_build_array(v.value) END) x
           WHERE v.value <> 'null'::jsonb`,
    );

    // One ticket in a hundred at a visibility level only track administrators belong to.
    await sql`INSERT INTO visibility_policy (workspace_id, name) VALUES (1, 'Bench levels')`.execute(
      conn,
    );
    await sql`INSERT INTO visibility_level (workspace_id, policy_id, name, position)
      SELECT 1, id, 'Restricted', 0 FROM visibility_policy WHERE name = 'Bench levels'`.execute(
      conn,
    );
    await sql`INSERT INTO visibility_member (workspace_id, level_id, grantee, role_id)
      SELECT 1, l.id, 'role', r.id FROM visibility_level l, role r
       WHERE l.name = 'Restricted' AND r.workspace_id = 1 AND r.name = 'Administrators'`.execute(
      conn,
    );
    await sql`UPDATE track SET visibility_policy_id = (SELECT id FROM visibility_policy WHERE name = 'Bench levels')`.execute(
      conn,
    );
    await run(
      'levels',
      sql`UPDATE ticket SET visibility_level_id = (SELECT id FROM visibility_level WHERE name = 'Restricted')
           WHERE id % 100 = 7`,
    );

    await sql`SET session_replication_role = DEFAULT`.execute(conn);
    for (const index of indexes) {
      const t0 = Date.now();
      if (index.constraint) {
        await sql`ALTER TABLE ${sql.table(index.table)} ADD CONSTRAINT ${sql.ref(index.constraint)}
          ${sql.raw(index.constraintDefinition ?? '')}`.execute(conn);
      } else {
        await sql.raw(index.definition).execute(conn);
      }
      const seconds = Math.round((Date.now() - t0) / 100) / 10;
      steps.push({ step: `index ${index.name}`, seconds });
      log(`  index ${index.name}: ${seconds}s`);
    }
    await run('vacuum analyze', sql`VACUUM ANALYZE`);
    const counts: Record<string, number> = {};
    for (const table of SIDE) {
      const { rows } = await sql<{
        n: string;
      }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(conn);
      counts[table] = Number(rows[0]?.n ?? 0);
    }
    const tickets = await sql<{ n: string }>`SELECT count(*) AS n FROM ticket`.execute(conn);
    return { tickets: Number(tickets.rows[0]?.n ?? 0), sideRows: counts, steps };
  });
}
