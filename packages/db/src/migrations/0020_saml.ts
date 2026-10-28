import { type Kysely, sql } from 'kysely';

/**
 * SAML 2.0 single sign-on (M1-081; IAM-002, ADR-019).
 *
 * SAML identity providers are rows of `identity_provider` with `kind` 'saml', next to the
 * OpenID Connect ones, so domains, enforced single sign-on, just-in-time accounts, group maps
 * and the links between a provider's subjects and accounts (`user_identity`) work the same for
 * both. For a SAML provider `issuer` holds its entity ID and `client_id` is empty; the `saml_*`
 * columns hold its sign-in address (HTTP-Redirect binding), its signing certificates (PEM;
 * several, so keys can roll over), Taskmoor's entity ID towards it when an administrator fixes
 * one (otherwise it derives from PUBLIC_URL), the attribute carrying the email address, and
 * whether it may start sign-ins itself (IdP-initiated; off unless chosen).
 *
 * - `saml_login`: a sign-in in flight. A service-provider-initiated one holds the AuthnRequest
 *   ID bound to the browser that started it (a cookie's hash). A verified response then waits
 *   here for its browser under a one-time handle (`handle_hash`, `identity`); an IdP-initiated
 *   one has no request and no browser.
 * - `saml_assertion`: the IDs of accepted assertions until they expire, so none is used twice.
 *
 * Expand only (ADR-022): new columns with defaults, a relaxed NOT NULL and a check that accepts
 * more than before. The previous release ignores `kind` and would offer a SAML provider as an
 * OpenID Connect one whose discovery fails, which ends that sign-in, and it already refuses
 * passwords for the domains of an enforcing provider.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE identity_provider DROP CONSTRAINT identity_provider_kind_check`.execute(db);
  await sql`ALTER TABLE identity_provider ADD CONSTRAINT identity_provider_kind_check
    CHECK (kind IN ('oidc', 'saml'))`.execute(db);
  await sql`ALTER TABLE identity_provider ALTER COLUMN client_id DROP NOT NULL`.execute(db);
  await sql`
    ALTER TABLE identity_provider
      ADD COLUMN saml_sso_url text,
      ADD COLUMN saml_certificates text[] NOT NULL DEFAULT '{}',
      ADD COLUMN saml_sp_entity_id text,
      ADD COLUMN saml_email_attribute text,
      ADD COLUMN saml_idp_initiated boolean NOT NULL DEFAULT false`.execute(db);
  await sql`ALTER TABLE identity_provider ADD CONSTRAINT identity_provider_protocol_check CHECK (
    (kind = 'oidc' AND client_id IS NOT NULL)
    OR (kind = 'saml' AND saml_sso_url IS NOT NULL AND cardinality(saml_certificates) > 0)
  )`.execute(db);

  await sql`
    CREATE TABLE saml_login (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      provider_id integer NOT NULL REFERENCES identity_provider (id) ON DELETE CASCADE,
      request_id text UNIQUE,
      browser_hash text,
      return_to text NOT NULL DEFAULT '/',
      handle_hash text UNIQUE,
      identity jsonb,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((request_id IS NULL) = (browser_hash IS NULL)),
      CHECK (request_id IS NOT NULL OR handle_hash IS NOT NULL),
      CHECK ((handle_hash IS NULL) = (identity IS NULL))
    )`.execute(db);
  await sql`CREATE INDEX saml_login_expires_idx ON saml_login (expires_at)`.execute(db);

  await sql`
    CREATE TABLE saml_assertion (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      assertion_id text NOT NULL,
      provider_id integer NOT NULL REFERENCES identity_provider (id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (workspace_id, assertion_id)
    )`.execute(db);
  await sql`CREATE INDEX saml_assertion_expires_idx ON saml_assertion (expires_at)`.execute(db);
}
