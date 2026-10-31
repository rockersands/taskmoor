import { type Kysely, sql } from 'kysely';

/**
 * Registered frontend origins (M1-108; IAM-025, API-017; ADR-087).
 *
 * `frontend_origin`: a frontend on another origin than the backend's own, added by a site
 * administrator, beside the ones `TASKMOOR_ALLOWED_ORIGINS` lists. Each row is an exact origin
 * (scheme, host and port: https, or http for localhost and names under it; no path, no
 * wildcard), a label, the exact URLs OAuth sign-in may return to (all on that origin; none
 * means the frontend signs in with the backend's cookie only), whether it may open the
 * WebSockets, who added it, and the last frontend version it reported with when.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE frontend_origin (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      origin text NOT NULL CHECK (
        origin ~ '^(https://[^/*?#@\\s]+|http://(localhost|[^/*?#@\\s]+\\.localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]{1,5})?)$'
        AND length(origin) <= 300
      ),
      label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 200),
      redirect_uris text[] NOT NULL DEFAULT '{}' CHECK (cardinality(redirect_uris) <= 20),
      websocket boolean NOT NULL DEFAULT true,
      last_version text CHECK (length(last_version) BETWEEN 1 AND 100),
      last_seen_at timestamptz,
      created_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX frontend_origin_idx ON frontend_origin (workspace_id, origin)`.execute(
    db,
  );
}
