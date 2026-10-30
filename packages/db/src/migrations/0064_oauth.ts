import { type Kysely, sql } from 'kysely';

/**
 * Cross-origin sign-in (M1-107; IAM-024, ADR-080): OAuth 2.1 authorization codes with PKCE and
 * rotating refresh tokens for a frontend on another site.
 *
 * - `user_session` also holds token families. A family is the session a frontend gets for one
 *   code: `client_id` names the frontend, `parent_id` the browser session at this backend that
 *   approved the code. Families have no cookie token (`token_hash` is null), and ending the
 *   parent ends its families. Rows without a client stay the cookie sessions they were.
 * - `oauth_code`: one-minute authorization codes, bound to the parent session, the client, the
 *   redirect URI and the PKCE challenge. A used code stays until it expires and names the
 *   family it made, so presenting it again within that minute ends the family.
 * - `oauth_token`: access tokens (minutes) and refresh tokens (the family's lifetime) of each
 *   family, by hash. A refresh token is used once; presenting a used one ends the family and
 *   its parent (reuse detection).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE user_session
      ALTER COLUMN token_hash DROP NOT NULL,
      ADD COLUMN client_id text CHECK (length(client_id) BETWEEN 1 AND 100),
      ADD COLUMN parent_id integer REFERENCES user_session (id) ON DELETE CASCADE,
      ADD CONSTRAINT user_session_kind_check CHECK (
        (client_id IS NULL AND token_hash IS NOT NULL AND parent_id IS NULL)
        OR (client_id IS NOT NULL AND token_hash IS NULL)
      )`.execute(db);
  await sql`CREATE INDEX user_session_parent_idx ON user_session (parent_id)
    WHERE parent_id IS NOT NULL`.execute(db);
  await sql`
    CREATE TABLE oauth_code (
      code_hash text PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      session_id integer NOT NULL REFERENCES user_session (id) ON DELETE CASCADE,
      client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 100),
      redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2000),
      code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      family_id integer REFERENCES user_session (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX oauth_code_expires_idx ON oauth_code (expires_at)`.execute(db);
  await sql`
    CREATE TABLE oauth_token (
      token_hash text PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      session_id integer NOT NULL REFERENCES user_session (id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
      expires_at timestamptz NOT NULL,
      used_at timestamptz CHECK (used_at IS NULL OR kind = 'refresh'),
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX oauth_token_session_idx ON oauth_token (session_id)`.execute(db);
  await sql`CREATE INDEX oauth_token_expires_idx ON oauth_token (expires_at)`.execute(db);
}
