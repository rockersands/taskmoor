import { type Kysely, sql } from 'kysely';

/**
 * OAuth 2.1 for MCP clients (M1-072; API-002, API-012; ADR-084).
 *
 * - `oauth_client`: clients that registered themselves (RFC 7591), public and without a secret,
 *   by a random id (`tmc_...`): the name they gave, their redirect URIs, when they registered and
 *   were last used.
 * - `oauth_request`: an authorization request checked and waiting for the person's sign-in and
 *   consent, for ten minutes, by the hash of a random id: the sign-in and consent pages carry
 *   that id instead of the whole request.
 * - `oauth_code.scope` and `user_session.scope`: what a registered client's code and token
 *   family may do, `read` or `read write`. Null for the first-party frontends and for cookie
 *   sessions, which may do everything their person may.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE oauth_client (
      id text PRIMARY KEY CHECK (id ~ '^tmc_[A-Za-z0-9_-]{20,80}$'),
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
      client_uri text CHECK (length(client_uri) BETWEEN 1 AND 2000),
      software_id text CHECK (length(software_id) BETWEEN 1 AND 200),
      software_version text CHECK (length(software_version) BETWEEN 1 AND 100),
      registered_ip text,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz
    )`.execute(db);
  await sql`CREATE INDEX oauth_client_workspace_idx ON oauth_client (workspace_id, created_at)`.execute(
    db,
  );
  await sql`
    CREATE TABLE oauth_request (
      id_hash text PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      client_id text NOT NULL REFERENCES oauth_client (id) ON DELETE CASCADE,
      redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2000),
      code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
      state text CHECK (length(state) <= 2000),
      scope text NOT NULL CHECK (scope IN ('read', 'read write')),
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX oauth_request_expires_idx ON oauth_request (expires_at)`.execute(db);
  await sql`
    ALTER TABLE oauth_code
      ADD COLUMN scope text CHECK (scope IS NULL OR scope IN ('read', 'read write'))`.execute(db);
  await sql`
    ALTER TABLE user_session
      ADD COLUMN scope text CHECK (scope IS NULL OR (client_id IS NOT NULL AND scope IN ('read', 'read write')))`.execute(
    db,
  );
}
