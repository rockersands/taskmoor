import { type Kysely, sql } from 'kysely';

/**
 * API tokens and service accounts (M1-004; IAM-007, ADR-034).
 *
 * - `app_user.kind`: people sign in; service accounts never do (no password, no session) and
 *   are not counted as users, but hold group memberships and grants like anyone else.
 * - `api_token`: personal and service-account tokens. Only the SHA-256 of a token is stored;
 *   every token has scopes and an expiry, and stays listed after revocation or expiry until
 *   pruning removes it. `replaced_by` links a rotated token to its successor.
 * - `token_policy`: the longest lifetime a new token may have (an administrator may raise it
 *   beyond a year) and how many days before expiry a token counts as due for rotation.
 *
 * Expand only (ADR-022): the new column has a default, so the previous release keeps writing
 * users during a rolling upgrade.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE app_user
      ADD COLUMN kind text NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'service')),
      ADD COLUMN description text NOT NULL DEFAULT ''`.execute(db);

  await sql`
    CREATE TABLE api_token (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      name text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      scopes text[] NOT NULL CHECK (cardinality(scopes) > 0
        AND scopes <@ ARRAY['read', 'write', 'admin']::text[]),
      created_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      last_used_at timestamptz,
      last_used_ip text,
      revoked_at timestamptz,
      revoked_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      replaced_by integer REFERENCES api_token (id) ON DELETE SET NULL
    )`.execute(db);
  await sql`CREATE INDEX api_token_user_idx ON api_token (user_id)`.execute(db);
  await sql`CREATE INDEX api_token_workspace_created_idx ON api_token (workspace_id, created_at, id)`.execute(
    db,
  );
  await sql`CREATE INDEX api_token_live_expiry_idx ON api_token (workspace_id, expires_at) WHERE revoked_at IS NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE token_policy (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      max_lifetime_days integer NOT NULL DEFAULT 365
        CHECK (max_lifetime_days BETWEEN 1 AND 3650),
      reminder_days integer NOT NULL DEFAULT 14 CHECK (reminder_days BETWEEN 1 AND 90),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`INSERT INTO token_policy (workspace_id) SELECT id FROM workspace`.execute(db);
}
