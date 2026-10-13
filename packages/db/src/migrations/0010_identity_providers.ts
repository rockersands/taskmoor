import { type Kysely, sql } from 'kysely';

/**
 * Single sign-on through OpenID Connect providers (M1-080; IAM-003, IAM-004): providers with
 * their sealed client secret, the email domains they serve and whether they enforce single
 * sign-on there, the group claims they map, the links between a provider's subjects and
 * Taskmoor accounts, and sign-in attempts in flight (state, nonce, PKCE verifier). Break-glass
 * accounts may still use their password where single sign-on is enforced (IAM-001).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE app_user ADD COLUMN break_glass boolean NOT NULL DEFAULT false`.execute(db);

  await sql`
    CREATE TABLE identity_provider (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      kind text NOT NULL DEFAULT 'oidc' CHECK (kind IN ('oidc')),
      issuer text NOT NULL,
      client_id text NOT NULL,
      client_secret_sealed text,
      scopes text NOT NULL DEFAULT 'openid email profile',
      group_claim text,
      domains text[] NOT NULL DEFAULT '{}',
      enforce_sso boolean NOT NULL DEFAULT false,
      jit boolean NOT NULL DEFAULT true,
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX identity_provider_workspace_name_idx ON identity_provider (workspace_id, lower(name))`.execute(
    db,
  );

  await sql`
    CREATE TABLE identity_provider_group (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      provider_id integer NOT NULL REFERENCES identity_provider (id) ON DELETE CASCADE,
      claim_value text NOT NULL,
      group_id integer NOT NULL REFERENCES user_group (id) ON DELETE CASCADE,
      PRIMARY KEY (provider_id, claim_value, group_id)
    )`.execute(db);

  await sql`
    CREATE TABLE user_identity (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      provider_id integer NOT NULL REFERENCES identity_provider (id) ON DELETE CASCADE,
      subject text NOT NULL,
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      email text,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_sign_in_at timestamptz,
      UNIQUE (provider_id, subject)
    )`.execute(db);
  await sql`CREATE INDEX user_identity_user_idx ON user_identity (user_id)`.execute(db);

  await sql`
    CREATE TABLE oidc_login (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      provider_id integer NOT NULL REFERENCES identity_provider (id) ON DELETE CASCADE,
      state_hash text NOT NULL UNIQUE,
      browser_hash text NOT NULL,
      nonce text NOT NULL,
      code_verifier_sealed text NOT NULL,
      return_to text NOT NULL DEFAULT '/',
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
}
