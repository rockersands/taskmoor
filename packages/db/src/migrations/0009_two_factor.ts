import { type Kysely, sql } from 'kysely';

/**
 * Two-factor sign-in (M1-084, IAM-001): authenticator-app secrets (sealed under the password
 * pepper), WebAuthn security keys and passkeys, single-use recovery codes, short-lived sign-in
 * challenges between the password and the second factor, and the workspace's requirement
 * policy (nobody, site administrators, everyone, plus chosen groups).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE totp_credential (
      user_id integer PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      secret_sealed text NOT NULL,
      last_step bigint,
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);

  await sql`
    CREATE TABLE webauthn_credential (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      credential_id text NOT NULL UNIQUE,
      public_key text NOT NULL,
      counter bigint NOT NULL DEFAULT 0,
      transports text[] NOT NULL DEFAULT '{}',
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz
    )`.execute(db);
  await sql`CREATE INDEX webauthn_credential_user_idx ON webauthn_credential (user_id)`.execute(db);

  await sql`
    CREATE TABLE recovery_code (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      code_hash text NOT NULL,
      used_at timestamptz
    )`.execute(db);
  await sql`CREATE INDEX recovery_code_user_idx ON recovery_code (user_id)`.execute(db);

  // Between a correct password and the second factor (or the enrolment a policy demands).
  await sql`
    CREATE TABLE sign_in_challenge (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      purpose text NOT NULL CHECK (purpose IN ('second_factor', 'enrollment')),
      webauthn_challenge text,
      attempts integer NOT NULL DEFAULT 0,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX sign_in_challenge_user_idx ON sign_in_challenge (user_id)`.execute(db);

  await sql`
    CREATE TABLE two_factor_policy (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      required text NOT NULL DEFAULT 'none' CHECK (required IN ('none', 'site_admins', 'everyone')),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`
    CREATE TABLE two_factor_policy_group (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      group_id integer NOT NULL REFERENCES user_group (id) ON DELETE CASCADE,
      PRIMARY KEY (workspace_id, group_id)
    )`.execute(db);
}
