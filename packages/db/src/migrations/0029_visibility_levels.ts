import { type Kysely, sql } from 'kysely';

/**
 * Visibility policies and levels (M1-020; IAM-011, ADR-012; spec 05a section 1.2).
 *
 * - `visibility_policy`: a named list of levels with a default level. Shared policies belong to
 *   the workspace; a local-mode track's own policy names it in `track_id` and leaves with it.
 *   `track.visibility_policy_id` chooses the policy a track uses (null: none, every ticket is
 *   seen by whoever browses the track).
 * - `visibility_level`: up to 50 per policy; `visibility_member` names who sees tickets at the
 *   level, with every grantee an access grant takes (role, group, user, track owner, any
 *   signed-in user, anyone, requester, assignee, user field, group field).
 * - `ticket.visibility_level_id`: null for a ticket everyone who browses the track sees.
 * - Members, levels and policy choices move `authz_epoch`, so cached answers reload (ADR-012).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE visibility_policy (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      track_id integer REFERENCES track (id) ON DELETE CASCADE,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      default_level_id integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX visibility_policy_name_idx
      ON visibility_policy (workspace_id, coalesce(track_id, 0), lower(name))`.execute(db);

  await sql`
    CREATE TABLE visibility_level (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      policy_id integer NOT NULL REFERENCES visibility_policy (id) ON DELETE CASCADE,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      position integer NOT NULL
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX visibility_level_name_idx
      ON visibility_level (policy_id, lower(name))`.execute(db);
  await sql`
    ALTER TABLE visibility_policy ADD CONSTRAINT visibility_policy_default_level_fkey
      FOREIGN KEY (default_level_id) REFERENCES visibility_level (id) ON DELETE SET NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE visibility_member (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      level_id integer NOT NULL REFERENCES visibility_level (id) ON DELETE CASCADE,
      grantee text NOT NULL CHECK (grantee IN ('role', 'group', 'user', 'track_owner', 'any_user',
        'anyone', 'requester', 'assignee', 'user_field', 'group_field')),
      role_id integer REFERENCES role (id) ON DELETE CASCADE,
      group_id integer REFERENCES user_group (id) ON DELETE CASCADE,
      user_id integer REFERENCES app_user (id) ON DELETE CASCADE,
      field_key text,
      CHECK ((grantee = 'role') = (role_id IS NOT NULL)),
      CHECK ((grantee = 'group') = (group_id IS NOT NULL)),
      CHECK ((grantee = 'user') = (user_id IS NOT NULL)),
      CHECK ((grantee IN ('user_field', 'group_field')) = (field_key IS NOT NULL))
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX visibility_member_unique_idx ON visibility_member (level_id, grantee,
      coalesce(role_id, 0), coalesce(group_id, 0), coalesce(user_id, 0),
      coalesce(field_key, ''))`.execute(db);

  await sql`
    ALTER TABLE track ADD COLUMN visibility_policy_id integer REFERENCES visibility_policy (id)`.execute(
    db,
  );
  await sql`CREATE INDEX track_visibility_policy_idx ON track (visibility_policy_id)`.execute(db);
  await sql`
    ALTER TABLE ticket ADD COLUMN visibility_level_id integer REFERENCES visibility_level (id)`.execute(
    db,
  );
  await sql`
    CREATE INDEX ticket_visibility_level_idx ON ticket (visibility_level_id)
      WHERE visibility_level_id IS NOT NULL`.execute(db);

  for (const table of ['visibility_policy', 'visibility_level', 'visibility_member']) {
    await sql`
      CREATE TRIGGER ${sql.raw(`${table}_authz_epoch`)}
      AFTER INSERT OR UPDATE OR DELETE ON ${sql.table(table)}
      FOR EACH ROW EXECUTE FUNCTION authz_epoch_bump()`.execute(db);
  }
  await sql`
    CREATE TRIGGER track_visibility_authz_epoch
    AFTER UPDATE OF visibility_policy_id ON track
    FOR EACH ROW EXECUTE FUNCTION authz_epoch_bump()`.execute(db);
}
