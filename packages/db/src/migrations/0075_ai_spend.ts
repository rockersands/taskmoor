import { type Kysely, sql } from 'kysely';

/**
 * AI spend limits, cost tracking, the AI audit log and redaction (M1-077; OPS-020, IAM-021,
 * IAM-022; ADR-100).
 *
 * - `ai_policy`: per workspace, how many days prompt and answer content is kept (0: never, the
 *   default), the built-in redaction patterns in force, terms to redact, and fields whose
 *   values never leave the server (`description`, `environment`, `cf[12]`).
 * - `ai_price`: an administrator's price for a provider and model, in billionths of a dollar
 *   per token, with an optional dearer rate above a prompt size. Models without a row use the
 *   list prices in code, shown as prices to verify.
 * - `ai_spend_limit`: hard stops for the workspace, a feature, one person or each person, per
 *   day, week or month (UTC), in tokens or in cost, with the percentages that raise an alert.
 * - `ai_call`: the AI audit log, one row per gateway call whatever its outcome (including calls
 *   a limit refused): who, feature, provider, model, tokens, cost and latency. Content only when
 *   the policy keeps it, and only until `content_expires_at`.
 * - `ai_usage_day`: the same calls summed per UTC day, feature, person, provider and model, for
 *   the usage dashboard; written in the call's transaction, so its totals match the log.
 * - `ai_spend_counter`: usage per period and key (`workspace`, `feature:<id>`, `user:<id>`),
 *   read by primary key before every call.
 * - `ai_limit_alert`: the thresholds already announced per limit, period and person.
 * - `ai_notice_ack`: who has read the data-egress notice.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ai_policy (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      content_days integer NOT NULL DEFAULT 0 CHECK (content_days BETWEEN 0 AND 90),
      redact_patterns text[] NOT NULL DEFAULT '{card-number,iban,us-ssn}'
        CHECK (redact_patterns <@ ARRAY['card-number', 'iban', 'us-ssn', 'email']),
      redact_terms text[] NOT NULL DEFAULT '{}' CHECK (cardinality(redact_terms) <= 200),
      redacted_fields text[] NOT NULL DEFAULT '{}' CHECK (cardinality(redacted_fields) <= 500),
      updated_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);

  await sql`
    CREATE TABLE ai_price (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
      model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
      input_nanos bigint NOT NULL CHECK (input_nanos >= 0),
      output_nanos bigint NOT NULL CHECK (output_nanos >= 0),
      cache_read_nanos bigint NOT NULL CHECK (cache_read_nanos >= 0),
      cache_write_nanos bigint NOT NULL CHECK (cache_write_nanos >= 0),
      long_above_tokens integer CHECK (long_above_tokens > 0),
      long_input_nanos bigint CHECK (long_input_nanos >= 0),
      long_output_nanos bigint CHECK (long_output_nanos >= 0),
      updated_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, provider, model),
      CHECK ((long_above_tokens IS NULL) = (long_input_nanos IS NULL)
        AND (long_above_tokens IS NULL) = (long_output_nanos IS NULL))
    )`.execute(db);

  await sql`
    CREATE TABLE ai_spend_limit (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      scope text NOT NULL CHECK (scope IN ('workspace', 'feature', 'user')),
      feature text CHECK (char_length(feature) BETWEEN 1 AND 64),
      user_id integer REFERENCES app_user (id) ON DELETE CASCADE,
      period text NOT NULL CHECK (period IN ('day', 'week', 'month')),
      metric text NOT NULL CHECK (metric IN ('tokens', 'cost')),
      amount bigint NOT NULL CHECK (amount > 0),
      alert_percents smallint[] NOT NULL DEFAULT '{80,100}'
        CHECK (cardinality(alert_percents) <= 5 AND 0 < ALL (alert_percents)
          AND 100 >= ALL (alert_percents)),
      created_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((scope = 'feature') = (feature IS NOT NULL)),
      CHECK (scope = 'user' OR user_id IS NULL)
    )`.execute(db);
  await sql`CREATE INDEX ai_spend_limit_workspace_idx ON ai_spend_limit (workspace_id)`.execute(db);

  await sql`
    CREATE TABLE ai_call (
      id bigserial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      occurred_at timestamptz NOT NULL DEFAULT now(),
      user_id integer REFERENCES app_user (id) ON DELETE SET NULL,
      track_id integer REFERENCES track (id) ON DELETE SET NULL,
      run_id uuid,
      feature text NOT NULL CHECK (char_length(feature) BETWEEN 1 AND 64),
      provider text NOT NULL,
      model text NOT NULL,
      served_model text NOT NULL,
      mode text NOT NULL CHECK (mode IN ('generate', 'stream', 'batch')),
      outcome text NOT NULL CHECK (outcome IN ('ok', 'refused', 'error', 'aborted', 'limited')),
      error_kind text CHECK (char_length(error_kind) <= 64),
      limit_id integer REFERENCES ai_spend_limit (id) ON DELETE SET NULL,
      input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
      output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
      cache_read_tokens integer NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
      cache_write_tokens integer NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
      cost_nanos bigint NOT NULL DEFAULT 0 CHECK (cost_nanos >= 0),
      priced boolean NOT NULL,
      latency_ms integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
      retries smallint NOT NULL DEFAULT 0,
      fell_back boolean NOT NULL DEFAULT false,
      content jsonb,
      content_expires_at timestamptz,
      CHECK ((content IS NULL) = (content_expires_at IS NULL))
    )`.execute(db);
  await sql`CREATE INDEX ai_call_time_idx ON ai_call (workspace_id, occurred_at DESC, id DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX ai_call_user_idx ON ai_call (workspace_id, user_id, occurred_at DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX ai_call_run_idx ON ai_call (run_id) WHERE run_id IS NOT NULL`.execute(db);
  await sql`CREATE INDEX ai_call_content_idx ON ai_call (content_expires_at)
    WHERE content IS NOT NULL`.execute(db);

  // user_id 0: calls the system made for nobody. No foreign key, so a person's usage stays.
  await sql`
    CREATE TABLE ai_usage_day (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      day date NOT NULL,
      feature text NOT NULL,
      user_id integer NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      calls integer NOT NULL DEFAULT 0,
      limited integer NOT NULL DEFAULT 0,
      failed integer NOT NULL DEFAULT 0,
      unpriced integer NOT NULL DEFAULT 0,
      input_tokens bigint NOT NULL DEFAULT 0,
      output_tokens bigint NOT NULL DEFAULT 0,
      cache_read_tokens bigint NOT NULL DEFAULT 0,
      cache_write_tokens bigint NOT NULL DEFAULT 0,
      cost_nanos bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, day, feature, user_id, provider, model)
    )`.execute(db);

  await sql`
    CREATE TABLE ai_spend_counter (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      period text NOT NULL CHECK (period IN ('day', 'week', 'month')),
      period_start date NOT NULL,
      key text NOT NULL,
      tokens bigint NOT NULL DEFAULT 0,
      cost_nanos bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, period, period_start, key)
    )`.execute(db);

  await sql`
    CREATE TABLE ai_limit_alert (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      limit_id integer NOT NULL REFERENCES ai_spend_limit (id) ON DELETE CASCADE,
      period_start date NOT NULL,
      user_id integer NOT NULL DEFAULT 0,
      percent smallint NOT NULL,
      used bigint NOT NULL,
      raised_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (limit_id, period_start, user_id, percent)
    )`.execute(db);

  await sql`
    CREATE TABLE ai_notice_ack (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      acknowledged_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, user_id)
    )`.execute(db);
}
