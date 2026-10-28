import { type Kysely, sql } from 'kysely';

/**
 * SCIM 2.0 provisioning (M1-083; IAM-006, ADR-038).
 *
 * - `scim_user`: what an identity provider said about an account it manages: its `userName`
 *   (which need not be the email), its `externalId`, and the profile attributes Taskmoor has no
 *   column for (name parts, phone numbers, the enterprise extension ...), kept so a provider
 *   reads back what it wrote. The account itself stays in `app_user`; a person without a row
 *   here is still visible to SCIM, with the email as the userName. `removed_at` is set by a
 *   SCIM DELETE: the account stays (deactivated, keeping its authorship) but SCIM answers 404
 *   for it from then on.
 * - `scim_group`: the provider's `externalId` for a group.
 * - `api_token.scopes` gains `scim`, which a token holds alone: such a token reaches the SCIM
 *   endpoints and nothing else, and no other token reaches them.
 *
 * Expand only (ADR-022): new tables, and a check constraint that accepts more than before. The
 * previous release reads a `scim` token as one without scopes, so it can do nothing there.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE api_token DROP CONSTRAINT api_token_scopes_check`.execute(db);
  await sql`
    ALTER TABLE api_token ADD CONSTRAINT api_token_scopes_check CHECK (
      cardinality(scopes) > 0
      AND scopes <@ ARRAY['read', 'write', 'admin', 'scim']::text[]
      AND (NOT 'scim' = ANY (scopes) OR cardinality(scopes) = 1)
    )`.execute(db);

  await sql`
    CREATE TABLE scim_user (
      user_id integer PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_name text NOT NULL,
      external_id text,
      attributes jsonb NOT NULL DEFAULT '{}',
      removed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  // userName is unique among the accounts SCIM still manages, ignoring case (RFC 7643 4.1.1).
  await sql`CREATE UNIQUE INDEX scim_user_workspace_user_name_idx ON scim_user (workspace_id, lower(user_name)) WHERE removed_at IS NULL`.execute(
    db,
  );
  // externalId is the provider's own key and case-exact; two providers may reuse one.
  await sql`CREATE INDEX scim_user_workspace_external_id_idx ON scim_user (workspace_id, external_id) WHERE external_id IS NOT NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE scim_group (
      group_id integer PRIMARY KEY REFERENCES user_group (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      external_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX scim_group_workspace_external_id_idx ON scim_group (workspace_id, external_id) WHERE external_id IS NOT NULL`.execute(
    db,
  );
}
