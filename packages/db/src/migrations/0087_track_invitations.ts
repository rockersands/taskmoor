import { type Kysely, sql } from 'kysely';

/**
 * Invitations into a track (IAM-027 to IAM-030; ADR-118).
 *
 * - `track_invitation`: an address invited into one track with one role. The link's token is
 *   kept only as a hash (like `password_link`) and works once. `granted_user_id` names the
 *   account that got the role when the invitation was made, so revoking takes back what the
 *   invitation gave and nothing else. One open invitation per track and address.
 * - The permission `appoint_track_admins` (who may give a role that runs the track): everyone
 *   who may run a track today keeps that ability, so every grant of `administer_track` gets
 *   its twin, which an access policy's editor can then remove. The permission `invite_people`
 *   gets no grant: inviting is off until a site administrator turns it on.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE track_invitation (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      track_id integer NOT NULL REFERENCES track (id) ON DELETE CASCADE,
      role_id integer NOT NULL REFERENCES role (id) ON DELETE CASCADE,
      email text NOT NULL CHECK (email = lower(email)),
      token_hash text NOT NULL UNIQUE,
      invited_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      granted_user_id integer REFERENCES app_user (id) ON DELETE SET NULL,
      delivery text NOT NULL CHECK (delivery IN ('email', 'link')),
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_sent_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      accepted_at timestamptz,
      revoked_at timestamptz
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX track_invitation_open_idx ON track_invitation (track_id, email)
      WHERE accepted_at IS NULL AND revoked_at IS NULL`.execute(db);
  await sql`CREATE INDEX track_invitation_email_idx ON track_invitation (workspace_id, email)`.execute(
    db,
  );
  await sql`CREATE INDEX track_invitation_expiry_idx ON track_invitation (expires_at)`.execute(db);

  await sql`
    INSERT INTO access_grant (workspace_id, policy_id, permission, grantee, role_id, group_id,
                              user_id, field_key)
    SELECT workspace_id, policy_id, 'appoint_track_admins', grantee, role_id, group_id, user_id,
           field_key
      FROM access_grant
     WHERE permission = 'administer_track'
    ON CONFLICT DO NOTHING`.execute(db);
}
