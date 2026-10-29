import { type Kysely, sql } from 'kysely';

/**
 * Webhooks (M1-067; API-009; ADR-055).
 *
 * - `webhook`: an HTTPS endpoint a site administrator registered, the event types it takes
 *   (exact names or `prefix.*`), an optional query that events about a ticket must match, the
 *   body format (`json`, or a chat service's message for Slack, Microsoft Teams, Mattermost or
 *   Matrix) and a sealed secret: the HMAC-SHA256 signing key of `json` deliveries, the access
 *   token of Matrix. The query runs as `owner_id`, so a webhook never reports a ticket its
 *   owner may not see. Webhooks do not expire.
 * - `webhook_delivery`: one per webhook and event. `id` is the delivery id receivers
 *   deduplicate on; `body` is what is sent, so a replay sends the same bytes under the same id.
 *   Pending until delivered, failed after the last retry or a refusal that retrying cannot fix.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE webhook (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
      url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2000),
      format text NOT NULL DEFAULT 'json'
        CHECK (format IN ('json', 'slack', 'teams', 'mattermost', 'matrix')),
      events text[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 200),
      filter_query text CHECK (char_length(filter_query) <= 10000),
      secret_sealed text,
      enabled boolean NOT NULL DEFAULT true,
      owner_id integer NOT NULL REFERENCES app_user (id),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX webhook_name_idx ON webhook (workspace_id, lower(name))`.execute(
    db,
  );
  await sql`
    CREATE TABLE webhook_delivery (
      id uuid PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      webhook_id integer NOT NULL REFERENCES webhook (id) ON DELETE CASCADE,
      event_id bigint NOT NULL,
      event_type text NOT NULL,
      body jsonb NOT NULL,
      state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed')),
      attempts integer NOT NULL DEFAULT 0,
      last_status integer,
      last_error text,
      last_attempt_at timestamptz,
      duration_ms integer,
      delivered_at timestamptz,
      replays integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (webhook_id, event_id)
    )`.execute(db);
  await sql`CREATE INDEX webhook_delivery_list_idx ON webhook_delivery (webhook_id, state, created_at DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX webhook_delivery_trim_idx ON webhook_delivery (delivered_at) WHERE state = 'delivered'`.execute(
    db,
  );
}
