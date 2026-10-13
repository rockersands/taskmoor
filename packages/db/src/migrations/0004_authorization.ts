import { type Kysely, sql } from 'kysely';

/**
 * Authorization (M1-002; ADR-012, IAM-009 to IAM-012): tracks as permission scopes, track roles
 * and their actors, access policies and their grants, global permission grants, and a
 * per-workspace epoch that every change to these tables (and to memberships, nesting and the
 * admin flag) moves, so cached permission sets know when they are stale.
 *
 * The track table holds what authorization needs; M1-006 adds the rest of the track (category,
 * archiving, configuration mode). Defaults for every workspace: the roles Administrators,
 * Members and Viewers, a "Default access policy" and global grants for signed-in people.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE role (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX role_workspace_name_idx ON role (workspace_id, lower(name))`.execute(
    db,
  );

  await sql`
    CREATE TABLE access_policy (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX access_policy_workspace_name_idx ON access_policy (workspace_id, lower(name))`.execute(
    db,
  );

  // Who holds a track permission: a role, a group, a user, the track owner, any signed-in
  // person, anyone, or (decided per ticket, M1-020) the requester, the assignee or a user or
  // group field. The id column used depends on the kind.
  await sql`
    CREATE TABLE access_grant (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      policy_id integer NOT NULL REFERENCES access_policy (id) ON DELETE CASCADE,
      permission text NOT NULL,
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
    CREATE UNIQUE INDEX access_grant_unique_idx ON access_grant (policy_id, permission, grantee,
      coalesce(role_id, 0), coalesce(group_id, 0), coalesce(user_id, 0), coalesce(field_key, ''))`.execute(
    db,
  );
  await sql`CREATE INDEX access_grant_permission_idx ON access_grant (permission, grantee)`.execute(
    db,
  );

  await sql`
    CREATE TABLE track (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      key text NOT NULL,
      name text NOT NULL,
      owner_id integer REFERENCES app_user (id) ON DELETE SET NULL,
      access_policy_id integer NOT NULL REFERENCES access_policy (id),
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX track_workspace_key_idx ON track (workspace_id, upper(key))`.execute(
    db,
  );
  await sql`CREATE INDEX track_policy_idx ON track (access_policy_id)`.execute(db);
  await sql`CREATE INDEX track_owner_idx ON track (owner_id)`.execute(db);

  await sql`
    CREATE TABLE track_role_actor (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      track_id integer NOT NULL REFERENCES track (id) ON DELETE CASCADE,
      role_id integer NOT NULL REFERENCES role (id) ON DELETE CASCADE,
      user_id integer REFERENCES app_user (id) ON DELETE CASCADE,
      group_id integer REFERENCES user_group (id) ON DELETE CASCADE,
      CHECK ((user_id IS NULL) <> (group_id IS NULL))
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX track_role_actor_unique_idx ON track_role_actor (track_id, role_id,
      coalesce(user_id, 0), coalesce(group_id, 0))`.execute(db);
  await sql`CREATE INDEX track_role_actor_user_idx ON track_role_actor (user_id) WHERE user_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX track_role_actor_group_idx ON track_role_actor (group_id) WHERE group_id IS NOT NULL`.execute(
    db,
  );

  // Global permissions (IAM-009, spec 05a section 1.1), granted to groups, users or everyone
  // signed in. app_user.is_site_admin remains the bootstrap grant of site administration.
  await sql`
    CREATE TABLE global_grant (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      permission text NOT NULL,
      grantee text NOT NULL CHECK (grantee IN ('group', 'user', 'any_user')),
      group_id integer REFERENCES user_group (id) ON DELETE CASCADE,
      user_id integer REFERENCES app_user (id) ON DELETE CASCADE,
      CHECK ((grantee = 'group') = (group_id IS NOT NULL)),
      CHECK ((grantee = 'user') = (user_id IS NOT NULL))
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX global_grant_unique_idx ON global_grant (workspace_id, permission, grantee,
      coalesce(group_id, 0), coalesce(user_id, 0))`.execute(db);

  // The epoch: one row per workspace, moved by every change that can alter a permission.
  await sql`
    CREATE TABLE authz_epoch (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      epoch bigint NOT NULL DEFAULT 0
    )`.execute(db);
  await sql`INSERT INTO authz_epoch (workspace_id) SELECT id FROM workspace`.execute(db);
  await sql`
    CREATE FUNCTION authz_epoch_bump() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO authz_epoch (workspace_id, epoch)
      VALUES (CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END, 1)
      ON CONFLICT (workspace_id) DO UPDATE SET epoch = authz_epoch.epoch + 1;
      RETURN NULL;
    END $$`.execute(db);
  for (const table of [
    'group_member',
    'group_nesting',
    'user_group',
    'role',
    'access_policy',
    'access_grant',
    'track_role_actor',
    'global_grant',
  ]) {
    await sql`
      CREATE TRIGGER ${sql.raw(`${table}_authz_epoch`)}
      AFTER INSERT OR UPDATE OR DELETE ON ${sql.table(table)}
      FOR EACH ROW EXECUTE FUNCTION authz_epoch_bump()`.execute(db);
  }
  await sql`
    CREATE TRIGGER track_authz_epoch
    AFTER INSERT OR DELETE OR UPDATE OF owner_id, access_policy_id ON track
    FOR EACH ROW EXECUTE FUNCTION authz_epoch_bump()`.execute(db);
  await sql`
    CREATE TRIGGER app_user_authz_epoch
    AFTER UPDATE OF is_site_admin, deactivated_at ON app_user
    FOR EACH ROW EXECUTE FUNCTION authz_epoch_bump()`.execute(db);

  await seedDefaults(db);
}

/** The track permissions of spec 05a section 1.2, as stored in grants. */
const ADMIN_ONLY = [
  'administer_track',
  'manage_layouts',
  'edit_workflows',
  'delete_tickets',
  'delete_all_comments',
  'edit_all_comments',
  'delete_all_attachments',
  'edit_all_time_entries',
  'delete_all_time_entries',
  'restore_archived',
  'archive_tickets',
];
const MEMBER = [
  'browse_track',
  'manage_sprints',
  'view_aggregated_data',
  'view_dev_tools',
  'view_readonly_workflow',
  'assignable_user',
  'assign_tickets',
  'close_tickets',
  'create_tickets',
  'edit_tickets',
  'link_tickets',
  'modify_requester',
  'move_tickets',
  'set_close_reason',
  'schedule_tickets',
  'set_visibility_level',
  'transition_tickets',
  'send_in_email',
  'manage_followers',
  'view_voters_followers',
  'add_comments',
  'delete_own_comments',
  'edit_own_comments',
  'create_attachments',
  'delete_own_attachments',
  'record_time',
  'edit_own_time_entries',
  'delete_own_time_entries',
];
const VIEWER = [
  'browse_track',
  'view_aggregated_data',
  'view_readonly_workflow',
  'view_voters_followers',
  'add_comments',
  'delete_own_comments',
  'edit_own_comments',
];

async function seedDefaults(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{ id: number }>`SELECT id FROM workspace ORDER BY id`.execute(db);
  for (const { id: ws } of rows) {
    await sql`
      INSERT INTO role (workspace_id, name, description) VALUES
        (${ws}, 'Administrators', 'Run the track: configuration, members and everything in it'),
        (${ws}, 'Members', 'Do the work: create, edit, move and close tickets'),
        (${ws}, 'Viewers', 'Read and comment')
      ON CONFLICT DO NOTHING`.execute(db);
    const policy = await sql<{ id: number }>`
      INSERT INTO access_policy (workspace_id, name, description)
      VALUES (${ws}, 'Default access policy', 'Administrators, Members and Viewers as their names say')
      RETURNING id`.execute(db);
    const policyId = policy.rows[0]?.id;
    const roles = await sql<{ id: number; name: string }>`
      SELECT id, name FROM role WHERE workspace_id = ${ws}`.execute(db);
    const roleId = (name: string) => roles.rows.find((r) => r.name === name)?.id;
    const grants: [string, number | undefined][] = [
      ...[...ADMIN_ONLY, ...MEMBER].map(
        (p) => [p, roleId('Administrators')] as [string, number | undefined],
      ),
      ...MEMBER.map((p) => [p, roleId('Members')] as [string, number | undefined]),
      ...VIEWER.map((p) => [p, roleId('Viewers')] as [string, number | undefined]),
    ];
    for (const [permission, role] of grants) {
      await sql`
        INSERT INTO access_grant (workspace_id, policy_id, permission, grantee, role_id)
        VALUES (${ws}, ${policyId}, ${permission}, 'role', ${role})
        ON CONFLICT DO NOTHING`.execute(db);
    }
    await sql`
      INSERT INTO access_grant (workspace_id, policy_id, permission, grantee)
      VALUES (${ws}, ${policyId}, 'administer_track', 'track_owner'),
             (${ws}, ${policyId}, 'browse_track', 'track_owner')
      ON CONFLICT DO NOTHING`.execute(db);
    for (const permission of [
      'browse_users',
      'share_saved_searches',
      'bulk_change',
      'create_local_tracks',
    ]) {
      await sql`
        INSERT INTO global_grant (workspace_id, permission, grantee)
        VALUES (${ws}, ${permission}, 'any_user')
        ON CONFLICT DO NOTHING`.execute(db);
    }
  }
}
