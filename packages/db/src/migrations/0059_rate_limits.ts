import { type Kysely, sql } from 'kysely';

/**
 * Rate limits and API usage (M1-066; API-010; ADR-075).
 *
 * - `rate_limit_policy`: a workspace's token-bucket limits, one row per workspace, the defaults
 *   until an administrator changes them: requests a second and the burst a bucket holds, for
 *   API tokens, signed-in people, addresses without either, and writes to one ticket.
 * - `api_usage`: requests, errors and refusals per client and minute, added to by every API
 *   process every few seconds, kept eight days for the usage dashboard's hour and day.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE rate_limit_policy (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      token_rate integer NOT NULL DEFAULT 50 CHECK (token_rate > 0),
      token_burst integer NOT NULL DEFAULT 200 CHECK (token_burst > 0),
      user_rate integer NOT NULL DEFAULT 50 CHECK (user_rate > 0),
      user_burst integer NOT NULL DEFAULT 200 CHECK (user_burst > 0),
      address_rate integer NOT NULL DEFAULT 20 CHECK (address_rate > 0),
      address_burst integer NOT NULL DEFAULT 100 CHECK (address_burst > 0),
      ticket_write_rate integer NOT NULL DEFAULT 10 CHECK (ticket_write_rate > 0),
      ticket_write_burst integer NOT NULL DEFAULT 40 CHECK (ticket_write_burst > 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);

  await sql`
    CREATE TABLE api_usage (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      client_kind text NOT NULL CHECK (client_kind IN ('token', 'user', 'address')),
      client text NOT NULL,
      minute timestamptz NOT NULL,
      requests integer NOT NULL DEFAULT 0,
      errors integer NOT NULL DEFAULT 0,
      throttled integer NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, minute, client_kind, client)
    )`.execute(db);
}
