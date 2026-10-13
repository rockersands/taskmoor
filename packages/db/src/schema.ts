import type { ColumnType, Generated } from 'kysely';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * JSONB columns read as parsed values and are written as JSON text. Passing text avoids the pg
 * driver turning JS arrays into Postgres arrays.
 */
export type Json = ColumnType<JsonValue, string, string>;

/** Timestamps read as Date and accept Date or ISO text on write. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/** Instance-wide key/value settings (setup state, feature switches, public metadata). */
export interface InstanceSettingTable {
  key: string;
  value: Json;
  updated_at: DefaultTimestamp;
}

/** A tenant: every other table carries its id (ADR-006). Installs start with one, "default". */
export interface WorkspaceTable {
  id: Generated<number>;
  key: string;
  name: string;
  created_at: DefaultTimestamp;
}

/**
 * People who can sign in. Email is stored lower-cased and is unique within a workspace; the hash
 * format is the iam package's. Deactivation keeps the row, so attribution survives (IAM-008).
 */
export interface AppUserTable {
  id: Generated<number>;
  workspace_id: number;
  email: string;
  name: string;
  password_hash: string | null;
  is_site_admin: Generated<boolean>;
  time_zone: string | null;
  locale: string | null;
  password_changed_at: Timestamp | null;
  last_sign_in_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  deactivated_at: Timestamp | null;
}

/** Groups of users (IAM-008); names are unique within a workspace, ignoring case. */
export interface UserGroupTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  created_at: DefaultTimestamp;
}

export interface GroupMemberTable {
  workspace_id: number;
  group_id: number;
  user_id: number;
  added_at: DefaultTimestamp;
}

/** A group inside another group; members of the child count as members of the parent. */
export interface GroupNestingTable {
  workspace_id: number;
  parent_id: number;
  child_id: number;
}

/**
 * Sign-in sessions (ADR-032): the browser holds a random token, the row keeps its SHA-256.
 * A session ends at `expires_at` or after the idle timeout since `last_seen_at`.
 */
export interface UserSessionTable {
  id: Generated<number>;
  workspace_id: number;
  user_id: number;
  token_hash: string;
  created_at: DefaultTimestamp;
  expires_at: Timestamp;
  last_seen_at: DefaultTimestamp;
  ip: string | null;
  user_agent: string | null;
}

/** Failed sign-ins per key (an account's email or a client address) for lockout and rate limits. */
export interface SignInThrottleTable {
  workspace_id: number;
  key: string;
  failures: number;
  window_started_at: DefaultTimestamp;
  locked_until: Timestamp | null;
  updated_at: DefaultTimestamp;
}

/** One-time links to set a password, made by an administrator (activation or reset). */
export interface PasswordLinkTable {
  id: Generated<number>;
  workspace_id: number;
  user_id: number;
  token_hash: string;
  purpose: 'activate' | 'reset';
  created_by: number | null;
  created_at: DefaultTimestamp;
  expires_at: Timestamp;
  used_at: Timestamp | null;
}

/** Track roles (Administrators, Members, Viewers by default); tracks name their actors. */
export interface RoleTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  created_at: DefaultTimestamp;
}

/** A set of grants that tracks share (Jira: permission scheme). */
export interface AccessPolicyTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  created_at: DefaultTimestamp;
}

export type GranteeKind =
  | 'role'
  | 'group'
  | 'user'
  | 'track_owner'
  | 'any_user'
  | 'anyone'
  | 'requester'
  | 'assignee'
  | 'user_field'
  | 'group_field';

/** One track permission granted to one grantee by a policy. */
export interface AccessGrantTable {
  id: Generated<number>;
  workspace_id: number;
  policy_id: number;
  permission: string;
  grantee: GranteeKind;
  role_id: number | null;
  group_id: number | null;
  user_id: number | null;
  field_key: string | null;
}

/**
 * A track as a permission scope (M1-002); M1-006 adds category, archiving and configuration
 * mode. Keys are unique within a workspace, ignoring case.
 */
export interface TrackTable {
  id: Generated<number>;
  workspace_id: number;
  key: string;
  name: string;
  owner_id: number | null;
  access_policy_id: number;
  created_at: DefaultTimestamp;
}

/** A user or a group acting in a role on one track. */
export interface TrackRoleActorTable {
  workspace_id: number;
  track_id: number;
  role_id: number;
  user_id: number | null;
  group_id: number | null;
}

/** A global permission (spec 05a section 1.1) granted to a group, a user or everyone signed in. */
export interface GlobalGrantTable {
  id: Generated<number>;
  workspace_id: number;
  permission: string;
  grantee: 'group' | 'user' | 'any_user';
  group_id: number | null;
  user_id: number | null;
}

/** Moves on every change that can alter a permission; cached permission sets carry it. */
export interface AuthzEpochTable {
  workspace_id: number;
  epoch: ColumnType<string, string | number | undefined, string | number>;
}

/**
 * The M0 session table, replaced by user_session. Kept until a later release so the previous
 * release keeps working during a rolling upgrade (ADR-022); nothing in this release uses it.
 */
export interface SessionTable {
  id: string;
  user_id: number;
  created_at: DefaultTimestamp;
  expires_at: Timestamp;
  last_seen_at: DefaultTimestamp;
}

/** Every table Kysely knows about. Add a table here in the same change as its migration. */
export interface Database {
  instance_setting: InstanceSettingTable;
  workspace: WorkspaceTable;
  app_user: AppUserTable;
  user_group: UserGroupTable;
  group_member: GroupMemberTable;
  group_nesting: GroupNestingTable;
  user_session: UserSessionTable;
  sign_in_throttle: SignInThrottleTable;
  password_link: PasswordLinkTable;
  role: RoleTable;
  access_policy: AccessPolicyTable;
  access_grant: AccessGrantTable;
  track: TrackTable;
  track_role_actor: TrackRoleActorTable;
  global_grant: GlobalGrantTable;
  authz_epoch: AuthzEpochTable;
  session: SessionTable;
}
