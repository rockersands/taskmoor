import { type Kysely, sql } from 'kysely';

/**
 * AI settings and provider credentials (M1-075; IAM-020, AI-001; ADR-098).
 *
 * `ai_setting`: one row per workspace with its AI settings as JSON (provider and its non-secret
 * settings; M1-076 adds the switches and per-feature choices). `version` goes up with every
 * change to the settings or a credential, so each process sees at its next call that it must
 * build its provider client again; `environment_imported_at` is when the provider and key given
 * in the environment (the Builder kit's `TASKMOOR_AI_PROVIDER` and `TASKMOOR_AI_KEY`) were moved
 * in, after which the environment is ignored.
 *
 * `ai_credential`: a provider secret per workspace and slot (the field of the provider settings
 * it fills: an API key, an access key pair, a token), sealed with envelope encryption: the
 * ciphertext under its own data key, the data key wrapped by the key-encryption key `kek_id`
 * names (the master key, the password pepper, or a KMS or Vault key), and the last four
 * characters, which is all any answer shows of it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ai_setting (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      value jsonb NOT NULL DEFAULT '{}'::jsonb,
      version integer NOT NULL DEFAULT 1,
      environment_imported_at timestamptz,
      updated_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`
    CREATE TABLE ai_credential (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      slot text NOT NULL CHECK (
        slot IN ('apiKey', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'accessToken')
      ),
      kek_id text NOT NULL CHECK (length(kek_id) BETWEEN 1 AND 300),
      wrapped_key text NOT NULL CHECK (length(wrapped_key) <= 4000),
      ciphertext text NOT NULL CHECK (length(ciphertext) <= 20000),
      last4 text NOT NULL CHECK (char_length(last4) <= 4),
      source text NOT NULL CHECK (source IN ('admin', 'environment')),
      updated_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, slot)
    )`.execute(db);
}
