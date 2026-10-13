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
  /** May sign in with a password where single sign-on is enforced (IAM-001). */
  break_glass: Generated<boolean>;
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

/**
 * A set of grants (Jira: permission scheme). Shared policies serve many tracks; a policy with
 * `owner_track_id` belongs to one local-mode track (M1-006). One policy per workspace is the
 * default that new shared-mode tracks use and local-mode tracks copy.
 */
export interface AccessPolicyTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  created_at: DefaultTimestamp;
  is_default: Generated<boolean>;
  owner_track_id: number | null;
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

export type TrackType = 'software' | 'business' | 'service' | 'discovery';
export type TrackMode = 'shared' | 'local';

/**
 * A track (M1-002, M1-006; CORE-001 to CORE-003, CORE-025): the container of tickets. Keys are
 * unique within a workspace ignoring case, together with every key a track used before
 * (`track_key_history`). The type is a preset of the feature toggles; the mode says whether the
 * configuration is shared or owned by the track. An archived track is read-only and hidden
 * from search.
 */
export interface TrackTable {
  id: Generated<number>;
  workspace_id: number;
  key: string;
  name: string;
  owner_id: number | null;
  access_policy_id: number;
  created_at: DefaultTimestamp;
  description: Generated<string>;
  type: ColumnType<TrackType, TrackType | undefined, TrackType>;
  mode: ColumnType<TrackMode, TrackMode | undefined, TrackMode>;
  category_id: number | null;
  icon: string | null;
  color: string | null;
  feature_board: Generated<boolean>;
  feature_backlog: Generated<boolean>;
  feature_sprints: Generated<boolean>;
  feature_releases: Generated<boolean>;
  feature_development: Generated<boolean>;
  feature_forms: Generated<boolean>;
  feature_approvals: Generated<boolean>;
  feature_calendar: Generated<boolean>;
  feature_timeline: Generated<boolean>;
  archived_at: Timestamp | null;
  archived_by: number | null;
  updated_at: DefaultTimestamp;
}

/** Categories that group tracks (CORE-001); names are unique within a workspace, ignoring case. */
export interface TrackCategoryTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/**
 * Every key a track has had, the current one with `replaced_at` null. Unique within a workspace
 * ignoring case, so an old key keeps resolving and no other track can take it (CORE-001 (2)).
 * A trigger on `track` writes it.
 */
export interface TrackKeyHistoryTable {
  id: Generated<number>;
  workspace_id: number;
  track_id: number;
  key: string;
  created_at: DefaultTimestamp;
  replaced_at: Timestamp | null;
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
 * One domain event per mutation (M1-005, ADR-015), written in the mutation's transaction.
 * The catalogue in apps/server/src/events/catalogue.ts types `type` and `payload`.
 */
export interface DomainEventTable {
  id: Generated<string>;
  workspace_id: number;
  type: string;
  version: Generated<number>;
  actor_id: number | null;
  subject_type: string;
  subject_id: string;
  payload: Json;
  occurred_at: DefaultTimestamp;
  published_at: Timestamp | null;
}

/** Background work (ADR-015): claimed with SKIP LOCKED, retried with backoff, keyed forever. */
export interface JobTable {
  id: Generated<string>;
  workspace_id: number;
  task: string;
  payload: Json;
  key: string | null;
  run_at: DefaultTimestamp;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  locked_at: Timestamp | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: DefaultTimestamp;
  started_at: Timestamp | null;
  done_at: Timestamp | null;
}

/** An authenticator-app secret, sealed under the password pepper (M1-084). */
export interface TotpCredentialTable {
  user_id: number;
  workspace_id: number;
  secret_sealed: string;
  /** The last time step used, so a code works once. */
  last_step: string | null;
  created_at: DefaultTimestamp;
}

/** A WebAuthn security key or passkey used as a second factor. */
export interface WebauthnCredentialTable {
  id: Generated<number>;
  workspace_id: number;
  user_id: number;
  credential_id: string;
  /** The COSE public key, base64url. */
  public_key: string;
  counter: ColumnType<string, string | number | undefined, string | number>;
  transports: Generated<string[]>;
  name: string;
  created_at: DefaultTimestamp;
  last_used_at: Timestamp | null;
}

export interface RecoveryCodeTable {
  id: Generated<number>;
  workspace_id: number;
  user_id: number;
  code_hash: string;
  used_at: Timestamp | null;
}

/** The step between a correct password and the second factor or a required enrolment. */
export interface SignInChallengeTable {
  id: Generated<number>;
  workspace_id: number;
  user_id: number;
  token_hash: string;
  purpose: 'second_factor' | 'enrollment';
  webauthn_challenge: string | null;
  attempts: Generated<number>;
  expires_at: Timestamp;
  created_at: DefaultTimestamp;
}

export interface TwoFactorPolicyTable {
  workspace_id: number;
  required: 'none' | 'site_admins' | 'everyone';
  updated_at: DefaultTimestamp;
}

export interface TwoFactorPolicyGroupTable {
  workspace_id: number;
  group_id: number;
}

/** An OpenID Connect provider (M1-080). The client secret is sealed under the pepper. */
export interface IdentityProviderTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  kind: Generated<'oidc'>;
  issuer: string;
  client_id: string;
  client_secret_sealed: string | null;
  scopes: Generated<string>;
  group_claim: string | null;
  /** Email domains this provider serves; sign-in offers it for them. */
  domains: Generated<string[]>;
  /** Password sign-in is refused for these domains, except break-glass accounts. */
  enforce_sso: Generated<boolean>;
  /** Unknown people of these domains get an account on first sign-in. */
  jit: Generated<boolean>;
  enabled: Generated<boolean>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** A group claim value that makes its holders members of a group. */
export interface IdentityProviderGroupTable {
  workspace_id: number;
  provider_id: number;
  claim_value: string;
  group_id: number;
}

/** A provider's subject linked to a Taskmoor account. */
export interface UserIdentityTable {
  id: Generated<number>;
  workspace_id: number;
  provider_id: number;
  subject: string;
  user_id: number;
  email: string | null;
  created_at: DefaultTimestamp;
  last_sign_in_at: Timestamp | null;
}

/** A sign-in through a provider in flight: state, nonce and PKCE verifier, bound to a browser. */
export interface OidcLoginTable {
  id: Generated<number>;
  workspace_id: number;
  provider_id: number;
  state_hash: string;
  browser_hash: string;
  nonce: string;
  code_verifier_sealed: string;
  return_to: Generated<string>;
  expires_at: Timestamp;
  created_at: DefaultTimestamp;
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
  track_category: TrackCategoryTable;
  track_key_history: TrackKeyHistoryTable;
  track_role_actor: TrackRoleActorTable;
  global_grant: GlobalGrantTable;
  authz_epoch: AuthzEpochTable;
  domain_event: DomainEventTable;
  job: JobTable;
  totp_credential: TotpCredentialTable;
  webauthn_credential: WebauthnCredentialTable;
  recovery_code: RecoveryCodeTable;
  sign_in_challenge: SignInChallengeTable;
  two_factor_policy: TwoFactorPolicyTable;
  two_factor_policy_group: TwoFactorPolicyGroupTable;
  identity_provider: IdentityProviderTable;
  identity_provider_group: IdentityProviderGroupTable;
  user_identity: UserIdentityTable;
  oidc_login: OidcLoginTable;
  session: SessionTable;
}
