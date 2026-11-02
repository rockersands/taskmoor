import { type Kysely, sql } from 'kysely';

/**
 * Security events (ASVS 2.2.3, 2.5.5, 7.1.3, 7.2.1, 7.2.2, 11.1.7, 11.1.8; ADR-109):
 *
 * - `domain_event.user_agent`: the browser or program of the request that caused an event, next
 *   to its address, so a security notice can say where a change came from;
 * - `security_email`: the security notices and alert emails to send, one per event, person and
 *   kind, outside notification preferences and digests; `to_address` is fixed when it is
 *   written (an email change is told to the old address);
 * - `security_alert_rule`: a site administrator's thresholds; no row means the defaults;
 * - `security_counter`: what each rule counted per key (an account, an address, a person or a
 *   token) in fixed windows;
 * - `security_alert`: each alert raised, once per rule, key and window.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE domain_event ADD COLUMN user_agent text`.execute(db);

  await sql`CREATE TABLE security_email (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id integer NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('password_changed', 'two_factor_enabled',
      'two_factor_disabled', 'recovery_codes_regenerated', 'two_factor_reset', 'email_changed',
      'alert')),
    domain_event_id bigint NOT NULL,
    to_address text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    message_id text,
    sent_at timestamptz,
    UNIQUE (domain_event_id, user_id, kind)
  )`.execute(db);
  await sql`CREATE INDEX security_email_unsent_idx ON security_email (id) WHERE sent_at IS NULL`.execute(
    db,
  );

  await sql`CREATE TABLE security_alert_rule (
    workspace_id integer NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
    rule text NOT NULL CHECK (rule IN ('sign_in_failures_account', 'sign_in_failures_address',
      'access_refusals', 'bulk_exports')),
    enabled boolean NOT NULL DEFAULT true,
    threshold integer NOT NULL CHECK (threshold BETWEEN 1 AND 100000),
    window_minutes integer NOT NULL CHECK (window_minutes BETWEEN 1 AND 1440),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, rule)
  )`.execute(db);

  await sql`CREATE TABLE security_counter (
    workspace_id integer NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
    rule text NOT NULL,
    key text NOT NULL,
    window_start timestamptz NOT NULL,
    count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, rule, key, window_start)
  )`.execute(db);
  await sql`CREATE INDEX security_counter_window_idx ON security_counter (window_start)`.execute(
    db,
  );

  await sql`CREATE TABLE security_alert (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id integer NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
    rule text NOT NULL,
    key text NOT NULL,
    window_start timestamptz NOT NULL,
    count integer NOT NULL,
    threshold integer NOT NULL,
    window_minutes integer NOT NULL,
    details jsonb NOT NULL DEFAULT '{}',
    raised_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, rule, key, window_start)
  )`.execute(db);
  await sql`CREATE INDEX security_alert_recent_idx ON security_alert (workspace_id, raised_at DESC)`.execute(
    db,
  );
}
