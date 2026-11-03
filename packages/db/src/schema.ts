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
 * People who can sign in, and service accounts that cannot (IAM-007: no password, no session,
 * not counted as users). Email is stored lower-cased and is unique within a workspace; the hash
 * format is the iam package's. Deactivation keeps the row, so attribution survives (IAM-008).
 */
export interface AppUserTable {
  id: Generated<number>;
  workspace_id: number;
  email: string;
  name: string;
  password_hash: string | null;
  is_site_admin: Generated<boolean>;
  kind: Generated<'person' | 'service'>;
  /** What a service account is for; empty for people. */
  description: Generated<string>;
  time_zone: string | null;
  locale: string | null;
  password_changed_at: Timestamp | null;
  last_sign_in_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  deactivated_at: Timestamp | null;
  /** May sign in with a password where single sign-on is enforced (IAM-001). */
  break_glass: Generated<boolean>;
  /** `system` (follow the device) or the name of a skin (M1-122). */
  appearance: Generated<string>;
  /**
   * When a site administrator erased the person (ASVS 8.3.2, ADR-111): name and email are a
   * placeholder from then on and nothing personal is kept; the row stays for attribution.
   */
  erased_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

/** Groups of users (IAM-008); names are unique within a workspace, ignoring case. */
export interface UserGroupTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  created_at: DefaultTimestamp;
}

/**
 * A site-wide team (M1-123, CORE-027): who works together. It grants nothing; boards, areas
 * and Team fields name it by id. Names are unique within a workspace, ignoring case.
 */
export interface TeamTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  lead_id: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface TeamMemberTable {
  workspace_id: number;
  team_id: number;
  user_id: number;
  added_at: DefaultTimestamp;
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
 * A session ends at `expires_at` or after the idle timeout since `last_seen_at`. A row with a
 * `client_id` is an OAuth token family instead (M1-107, ADR-080): no cookie token, its tokens
 * in `oauth_token`, ended with the browser session (`parent_id`) that approved it.
 */
export interface UserSessionTable {
  id: Generated<number>;
  workspace_id: number;
  user_id: number;
  /** Null exactly for token families. */
  token_hash: string | null;
  created_at: DefaultTimestamp;
  expires_at: Timestamp;
  last_seen_at: DefaultTimestamp;
  ip: string | null;
  user_agent: string | null;
  /** The frontend a token family belongs to; null for a cookie session. */
  client_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** The cookie session that approved a token family's code. */
  parent_id: ColumnType<number | null, number | null | undefined, number | null>;
  /** What a registered client's family may do (M1-072): `read` or `read write`; null for all. */
  scope: ColumnType<string | null, string | null | undefined, string | null>;
}

/** One-minute authorization codes with their PKCE challenge (M1-107, ADR-080). */
export interface OauthCodeTable {
  code_hash: string;
  workspace_id: number;
  /** The signed-in browser session at this backend that approved the code. */
  session_id: number;
  client_id: string;
  redirect_uri: string;
  /** BASE64URL(SHA-256(verifier)): only S256 is accepted. */
  code_challenge: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  /** The token family the code was exchanged for; ended if the code comes back. */
  family_id: number | null;
  created_at: DefaultTimestamp;
  /** A registered client's scope (M1-072); null for the first-party frontends. */
  scope: ColumnType<string | null, string | null | undefined, string | null>;
}

/** A client that registered itself (M1-072; RFC 7591): public, no secret. */
export interface OauthClientTable {
  /** `tmc_` and random characters. */
  id: string;
  workspace_id: number;
  name: string;
  redirect_uris: string[];
  client_uri: string | null;
  software_id: string | null;
  software_version: string | null;
  registered_ip: string | null;
  created_at: DefaultTimestamp;
  last_used_at: Timestamp | null;
}

/**
 * A frontend on another origin, registered by a site administrator (M1-108; ADR-087), beside
 * those TASKMOOR_ALLOWED_ORIGINS lists.
 */
export interface FrontendOriginTable {
  id: Generated<number>;
  workspace_id: number;
  /** Exact: scheme, host and port. */
  origin: string;
  label: ColumnType<string, string | undefined, string>;
  /** Where OAuth sign-in may return, exact URLs on this origin; none: the cookie only. */
  redirect_uris: ColumnType<string[], string[] | undefined, string[]>;
  /** Whether it may open the sync and co-editing sockets. */
  websocket: ColumnType<boolean, boolean | undefined, boolean>;
  /** The frontend version it last reported (its version.json), and when. */
  last_version: string | null;
  last_seen_at: Timestamp | null;
  created_by: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/**
 * A workspace's AI settings (M1-075, ADR-098): provider and non-secret settings as JSON;
 * `version` goes up with every change to them or to a credential.
 */
export interface AiSettingTable {
  workspace_id: number;
  value: ColumnType<JsonValue, string | undefined, string>;
  version: ColumnType<number, number | undefined, number>;
  /** When the environment's provider and key were moved in; the environment is ignored since. */
  environment_imported_at: Timestamp | null;
  updated_by: number | null;
  updated_at: DefaultTimestamp;
}

/** A provider secret, sealed with envelope encryption (IAM-020, ADR-098). Never returned. */
export interface AiCredentialTable {
  workspace_id: number;
  slot: 'apiKey' | 'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'accessToken';
  /** The key-encryption key that wrapped the data key: `master:…`, `pepper:…`, `kms:…`. */
  kek_id: string;
  wrapped_key: string;
  ciphertext: string;
  /** The last four characters, all an answer shows; empty for short secrets. */
  last4: string;
  source: 'admin' | 'environment';
  updated_by: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** An authorization request waiting for sign-in and consent, for ten minutes (M1-072). */
export interface OauthRequestTable {
  id_hash: string;
  workspace_id: number;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  /** `read` or `read write`. */
  scope: string;
  expires_at: Timestamp;
  created_at: DefaultTimestamp;
}

/** Access and refresh tokens of the token families, by hash (M1-107, ADR-080). */
export interface OauthTokenTable {
  token_hash: string;
  workspace_id: number;
  session_id: number;
  kind: 'access' | 'refresh';
  expires_at: Timestamp;
  /** When a refresh token was exchanged; presenting it again ends the family. */
  used_at: Timestamp | null;
  created_at: DefaultTimestamp;
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
  /** The type set the track offers (M1-007); a local-mode track owns its set. */
  type_set_id: number | null;
  /** The priorities it offers (M1-014); null for the workspace's default set. */
  priority_set_id: number | null;
  /** Its workflow map (M1-028); null for the workspace's default map. */
  workflow_map_id: ColumnType<number | null, number | null | undefined, number | null>;
  /** Its field rule set and layout set; null for the workspace's defaults (M1-012). */
  field_rule_set_id: ColumnType<number | null, number | null | undefined, number | null>;
  layout_set_id: ColumnType<number | null, number | null | undefined, number | null>;
  /** Its visibility policy; null for none (M1-020). */
  visibility_policy_id: ColumnType<number | null, number | null | undefined, number | null>;
  /** Its notification policy; null for the workspace's default (M1-056). */
  notification_policy_id: ColumnType<number | null, number | null | undefined, number | null>;
  /** In the trash since (M1-101, CORE-025); restorable until the purge starts. */
  deleted_at: Timestamp | null;
  deleted_by: number | null;
  /** Its permanent deletion has begun (it runs in batches); no restore any more. */
  purge_started_at: Timestamp | null;
}

export type HierarchyLevelKind = 'subticket' | 'standard' | 'outcome' | 'custom';

/**
 * A hierarchy level (M1-007; CORE-006, spec 01a section 1.2). The built-in levels sit at ranks
 * -1 (subticket), 0 (standard) and 1 (Outcome); custom levels at 2 and above. Ranks are unique
 * per workspace (a deferred constraint) and run without a gap.
 */
export interface HierarchyLevelTable {
  id: Generated<number>;
  workspace_id: number;
  kind: HierarchyLevelKind;
  rank: number;
  name: string;
  description: Generated<string>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/**
 * A ticket type (CORE-005): its look and its level. One with `owner_track_id` belongs to that
 * local-mode track; the others are shared.
 */
export interface TicketTypeTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  icon: string | null;
  color: string | null;
  level_id: number;
  owner_track_id: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/**
 * The ticket types a track offers, in order, with one preselected (CORE-005; Jira: issue type
 * scheme). One with `owner_track_id` belongs to that local-mode track.
 */
export interface TypeSetTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  /** A member of the set (deferred foreign key), or null for no preselection. */
  default_type_id: number | null;
  owner_track_id: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface TypeSetMemberTable {
  workspace_id: number;
  type_set_id: number;
  ticket_type_id: number;
  /** Position in the set, from 1; unique per set (deferred). */
  sort_order: number;
}

/** The set new tracks of each type use (shared mode) or copy (local mode). */
export interface TypeSetDefaultTable {
  workspace_id: number;
  track_type: TrackType;
  type_set_id: number;
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

/** JSONB that may be null: read parsed, written as JSON text. */
export type NullableJson = ColumnType<JsonValue | null, string | null | undefined, string | null>;

/** A calendar day as `YYYY-MM-DD` text (the client reads dates without a time zone). */
export type DateText = ColumnType<string | null, string | null | undefined, string | null>;

/**
 * A ticket (M1-008; CORE-001, CORE-008, spec 01a section 1.3): KEY-n from its track's key and
 * its number, its type and parent, content and people fields, and its place in the global rank
 * (`rank`, a fractional key unique per workspace, AGL-009). `version` counts changes for
 * optimistic saves. A deleted ticket stays in the trash with `deleted_at` (CORE-025 (3));
 * subtickets deleted along with their parent name it in `trashed_with`.
 */
export interface TicketTable {
  id: Generated<number>;
  workspace_id: number;
  track_id: number;
  number: number;
  ticket_type_id: number;
  parent_id: number | null;
  summary: string;
  /** Rich text as a ProseMirror document (ADR-014); null when empty. */
  description: NullableJson;
  environment: NullableJson;
  assignee_id: number | null;
  requester_id: number | null;
  /** Null for tickets the system made (an import of an unknown person, a job). */
  creator_id: number | null;
  start_date: DateText;
  due_date: DateText;
  rank: string;
  version: Generated<number>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  deleted_at: Timestamp | null;
  deleted_by: number | null;
  trashed_with: number | null;
  priority_id: number | null;
  close_reason_id: number | null;
  /** When the ticket reached a closed stage (set by workflows, M1-023). */
  closed_at: Timestamp | null;
  labels: ColumnType<string[], string[] | undefined, string[]>;
  /** Seconds; null when there is no estimate (M1-019). */
  original_estimate: number | null;
  remaining_estimate: number | null;
  /** Seconds: the sum of the ticket's time entries. */
  time_spent: Generated<number>;
  /** Left out on insert, a trigger sets the track workflow's initial status (M1-023). */
  status_id: ColumnType<number, number | undefined, number>;
  /** Custom field values by field id, in the forms of `apps/server/src/fields/types.ts`. */
  fields: ColumnType<Record<string, JsonValue>, string | undefined, string>;
  /** Who besides track browsing may see it (M1-020); null for everyone who browses the track. */
  visibility_level_id: ColumnType<number | null, number | null | undefined, number | null>;
  /** The stemmed words of the summary, description and environment, kept by Postgres (M1-040). */
  summary_words: SearchWords;
  description_words: SearchWords;
  environment_words: SearchWords;
  /**
   * The first comment by someone other than the requester and the latest comment, counting
   * comments everyone who sees the ticket may read; kept by triggers (M1-125, CORE-012).
   */
  first_response_at: ColumnType<Date | null, never, never>;
  last_comment_at: ColumnType<Date | null, never, never>;
}

/**
 * A text's words as Postgres indexes them (`tsvector` in the `taskmoor_search` configuration,
 * M1-040): a generated column, never written.
 */
export type SearchWords = ColumnType<string | null, never, never>;

/** A rich text field's text as last written in another format (M1-017, IMP-008). */
export interface TicketTextOriginalTable {
  ticket_id: number;
  workspace_id: number;
  field: RichTextField;
  format: 'adf' | 'wiki';
  /** The document exactly as written (wiki markup as a JSON string). */
  source: Json;
  /** SHA-256 of the canonical document converted from it. */
  doc_sha256: string;
  written_by: number | null;
  written_at: DefaultTimestamp;
}

/** A rich text field's collaboration state: one Yjs update holding the document (ADR-014). */
export interface TicketTextStateTable {
  ticket_id: number;
  workspace_id: number;
  field: RichTextField;
  state: Buffer;
  /** SHA-256 of the canonical document the state holds. */
  doc_sha256: string;
  updated_at: DefaultTimestamp;
}

export type RichTextField = 'description' | 'environment';

/** The last ticket number given out in each track. */
export interface TicketCounterTable {
  track_id: number;
  workspace_id: number;
  last_number: number;
}

/**
 * Every track and number a ticket has had, the current pair with `replaced_at` null (CORE-023
 * (3)). A number belongs to one ticket in its track for good. A trigger on `ticket` writes it.
 */
export interface TicketKeyHistoryTable {
  id: Generated<number>;
  workspace_id: number;
  ticket_id: number;
  track_id: number;
  number: number;
  created_at: DefaultTimestamp;
  replaced_at: Timestamp | null;
}

/**
 * One field one mutation changed on a ticket (M1-009, CORE-022): values as text (ids for
 * references) with the names they had then. Rows of one mutation share `change_set`.
 * Partitioned by hash of the ticket.
 */
export interface TicketChangeTable {
  id: Generated<string>;
  workspace_id: number;
  ticket_id: number;
  change_set: string;
  at: DefaultTimestamp;
  actor_id: number | null;
  field: string;
  from_value: string | null;
  to_value: string | null;
  from_display: string | null;
  to_display: string | null;
  /** The workflow transition that made the change (M1-024); null for other changes. */
  transition_id: number | null;
}

/** A child that lost its parent link when the parent went to the trash; a restore puts it back. */
export interface TicketDetachedParentTable {
  ticket_id: number;
  workspace_id: number;
  parent_id: number;
  detached_at: DefaultTimestamp;
}

/** A priority of the workspace's ordered list (CORE-014). */
export interface PriorityTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  icon: string | null;
  color: string | null;
  /** Position from 1, gapless (deferred unique constraint). */
  sort_order: number;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** The priorities a track offers, with the one new tickets take (CORE-014 (2)). */
export interface PrioritySetTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  /** The set of tracks whose `priority_set_id` is null; one per workspace. */
  is_default: Generated<boolean>;
  default_priority_id: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface PrioritySetMemberTable {
  workspace_id: number;
  priority_set_id: number;
  priority_id: number;
}

/** Why a ticket was closed (CORE-014; Jira: resolution). */
export interface CloseReasonTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  sort_order: number;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** The workspace's label vocabulary, for autocomplete (CORE-017). */
export interface LabelTable {
  workspace_id: number;
  name: string;
  created_at: DefaultTimestamp;
}

/** A release of a track (CORE-016; Jira: version). */
export interface ReleaseTable {
  id: Generated<number>;
  workspace_id: number;
  track_id: number;
  name: string;
  description: Generated<string>;
  start_date: DateText;
  release_date: DateText;
  /** Manual order within the track, from 1. */
  sort_order: number;
  shipped_at: Timestamp | null;
  archived_at: Timestamp | null;
  require_approvals: Generated<boolean>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface ReleaseApproverTable {
  workspace_id: number;
  release_id: number;
  user_id: number;
  decision: 'approved' | 'declined' | null;
  comment: Generated<string>;
  decided_at: Timestamp | null;
}

export type AreaDefaultAssignee = 'area_owner' | 'track_owner' | 'unassigned';

/** An area of a track, with its owner (CORE-015; Jira: component). */
export interface AreaTable {
  id: Generated<number>;
  workspace_id: number;
  track_id: number;
  name: string;
  description: Generated<string>;
  owner_id: number | null;
  /** The team that owns the area (M1-123). */
  owner_team_id: ColumnType<number | null, number | null | undefined, number | null>;
  default_assignee: ColumnType<
    AreaDefaultAssignee,
    AreaDefaultAssignee | undefined,
    AreaDefaultAssignee
  >;
  archived_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export type TicketReleaseRole = 'target' | 'found';

/** Target releases and found-in releases of tickets. */
export interface TicketReleaseTable {
  workspace_id: number;
  ticket_id: number;
  release_id: number;
  role: TicketReleaseRole;
}

export interface TicketAreaTable {
  workspace_id: number;
  ticket_id: number;
  area_id: number;
}

/** A link type: its name and the phrase each side reads (M1-015, CORE-018). */
export interface LinkTypeTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  /** What the source reads, such as "blocks". */
  outward: string;
  /** What the target reads, such as "is blocked by". */
  inward: string;
  /** The type cloning uses; one per workspace, never deleted. */
  is_copy: Generated<boolean>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** A directed link of a type from one ticket to another, in any tracks. */
export interface TicketLinkTable {
  id: Generated<number>;
  workspace_id: number;
  link_type_id: number;
  source_id: number;
  target_id: number;
  created_by: number | null;
  created_at: DefaultTimestamp;
}

/** How long the workspace's trash keeps tickets and tracks (M1-101, CORE-025 (3)). */
export interface TrashPolicyTable {
  workspace_id: number;
  retention_days: Generated<number>;
  updated_at: DefaultTimestamp;
}

/**
 * A backup the scheduler or the operator CLI took, or a restore drill (M1-101, OPS-008):
 * instance-wide, like the backups themselves. `details` holds what the run measured (entries,
 * row counts, seconds); `pruned_at` is set when retention removed the backup's directory.
 */
export interface BackupRunTable {
  id: Generated<string>;
  kind: 'scheduled' | 'manual' | 'drill';
  state: ColumnType<
    'running' | 'succeeded' | 'failed',
    'running' | 'succeeded' | 'failed' | undefined,
    'running' | 'succeeded' | 'failed'
  >;
  started_at: DefaultTimestamp;
  heartbeat_at: DefaultTimestamp;
  finished_at: Timestamp | null;
  path: string | null;
  size_bytes: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  details: ColumnType<JsonValue, string | undefined, string>;
  error: string | null;
  pruned_at: Timestamp | null;
}

/** The workspace's switch for ticket links. */
export interface LinkPolicyTable {
  workspace_id: number;
  enabled: Generated<boolean>;
  updated_at: DefaultTimestamp;
}

/** A link from a ticket to something outside; integrations find theirs by global id. */
export interface TicketWebLinkTable {
  id: Generated<number>;
  workspace_id: number;
  ticket_id: number;
  url: string;
  title: string;
  summary: Generated<string>;
  icon_url: string | null;
  relationship: Generated<string>;
  global_id: string | null;
  created_by: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** A named checklist on a ticket (CORE-033; ADR-120). */
export interface TicketChecklistTable {
  id: Generated<number>;
  workspace_id: number;
  ticket_id: number;
  name: string;
  position: number;
  created_by: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** One line of a checklist; its state is open, in_progress, done or rejected. */
export interface TicketChecklistItemTable {
  id: Generated<number>;
  workspace_id: number;
  checklist_id: number;
  text: string;
  state: Generated<string>;
  position: number;
  created_by: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** Someone following, or voting for, a ticket. */
export interface TicketPersonTable {
  workspace_id: number;
  ticket_id: number;
  user_id: number;
  created_at: DefaultTimestamp;
}

/** A ticket a person opened, and when they last did (M1-052): the home page's Recent list. */
export interface TicketVisitTable {
  workspace_id: number;
  user_id: number;
  ticket_id: number;
  visited_at: DefaultTimestamp;
}

/** A workspace's own limit for a configuration guardrail (M1-055, CORE-026). */
export interface GuardrailLimitTable {
  workspace_id: number;
  name: string;
  value: number;
  updated_at: DefaultTimestamp;
  updated_by: number | null;
}

/**
 * A board (M1-043; AGL-001): its tickets are those its filter query matches, less those its
 * sub-filter hides; the configuration is JSON the routes validate (`boards/model.ts`).
 */
export interface BoardTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  kind: 'scrum' | 'kanban';
  /** Exactly one of the two: a track, or the person who owns the board. */
  location_track_id: number | null;
  location_user_id: number | null;
  /** Exactly one of the two: the board's own query, or a saved search (M1-063). */
  filter_query: string | null;
  saved_search_id: ColumnType<number | null, number | null | undefined, number | null>;
  sub_filter_query: string | null;
  columns: Json;
  swimlanes: Json;
  board_filters: ColumnType<JsonValue, string | undefined, string>;
  board_filter_display: ColumnType<'buttons' | 'dropdown', 'buttons' | 'dropdown' | undefined>;
  card_rules: Json;
  /** Estimation statistic, time tracking and parallel sprints (M1-044, ADR-054). */
  sprint_settings: ColumnType<JsonValue, string | undefined, string>;
  /** The team the board belongs to (M1-123). */
  team_id: ColumnType<number | null, number | null | undefined, number | null>;
  version: Generated<number>;
  created_by: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  /** Its columns are its local-mode track's statuses (M1-126; WF-010). */
  manages_workflow: Generated<boolean>;
  /** Which column closes tickets: null the rightmost, `none` no column, or a column's id. */
  closing_column: ColumnType<string | null, string | null | undefined, string | null>;
}

/** A board's sprint (M1-044; AGL-010, AGL-011; ADR-054). */
export interface SprintTable {
  id: Generated<number>;
  workspace_id: number;
  board_id: number;
  name: string;
  goal: Generated<string>;
  state: ColumnType<SprintState, SprintState | undefined, SprintState>;
  sequence: number;
  start_at: Timestamp | null;
  end_at: Timestamp | null;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  started_by: number | null;
  completed_by: number | null;
  created_by: number | null;
  version: Generated<number>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  /** Set on a deleted completed sprint: it leaves reports, its rows stay (AGL-010 (3)). */
  deleted_at: Timestamp | null;
}

export type SprintState = 'future' | 'active' | 'closed';

/** A ticket in a sprint; `open` while the sprint is future or active (one open per ticket). */
export interface SprintTicketTable {
  workspace_id: number;
  sprint_id: number;
  ticket_id: number;
  open: Generated<boolean>;
  added_at: DefaultTimestamp;
}

export type SprintChangeKind = 'added' | 'removed' | 'committed' | 'completed' | 'carried_over';

/** A sprint membership change with the ticket's estimate at that time (scope change). */
export interface SprintChangeTable {
  id: Generated<string>;
  workspace_id: number;
  sprint_id: number;
  ticket_id: number;
  kind: SprintChangeKind;
  after_start: Generated<boolean>;
  at: DefaultTimestamp;
  actor_id: number | null;
  original_estimate: number | null;
  remaining_estimate: number | null;
  /** The board's number field (story points) then; numeric comes back as text. */
  points: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  to_sprint_id: number | null;
}

export type WebhookFormat = 'json' | 'slack' | 'teams' | 'mattermost' | 'matrix';

/** An outbound webhook (M1-067; API-009; ADR-055); its query runs as its owner. */
export interface WebhookTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  url: string;
  format: ColumnType<WebhookFormat, WebhookFormat | undefined, WebhookFormat>;
  /** Event types, exact or `prefix.*`. */
  events: string[];
  filter_query: string | null;
  /** The signing secret (`json`) or the Matrix access token, sealed with the pepper ring. */
  secret_sealed: string | null;
  enabled: Generated<boolean>;
  owner_id: number;
  version: Generated<number>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export type WebhookDeliveryState = 'pending' | 'delivered' | 'failed';

/** One event sent to one webhook; `id` is the delivery id receivers deduplicate on. */
export interface WebhookDeliveryTable {
  id: string;
  workspace_id: number;
  webhook_id: number;
  /** The domain event (bigint, as text). */
  event_id: ColumnType<string, string | number, string | number>;
  event_type: string;
  /** What is sent, so a replay sends the same. */
  body: ColumnType<JsonValue, string, string>;
  state: ColumnType<WebhookDeliveryState, WebhookDeliveryState | undefined, WebhookDeliveryState>;
  attempts: Generated<number>;
  last_status: number | null;
  last_error: string | null;
  last_attempt_at: Timestamp | null;
  duration_ms: number | null;
  delivered_at: Timestamp | null;
  replays: Generated<number>;
  created_at: DefaultTimestamp;
}

/** A saved search (M1-063; QRY-011): a named query kept by its owner. */
export interface SavedSearchTable {
  id: Generated<number>;
  workspace_id: number;
  owner_id: number;
  name: string;
  description: Generated<string>;
  query: string;
  /** The result columns chosen for it; null for the default set. */
  columns: ColumnType<JsonValue | null, string | null | undefined, string | null>;
  /**
   * Why a query an import brought could not be translated (M1-094); null otherwise, and again
   * once its query is saved.
   */
  import_problem: ColumnType<string | null, string | null | undefined, string | null>;
  version: Generated<number>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export type SavedSearchShareScope = 'user' | 'group' | 'track' | 'any_user' | 'public';

export type DashboardLayout = 'one' | 'two' | 'two-wide-left' | 'two-wide-right' | 'three';

/** A page of widgets kept by its owner (M1-064; RPT-004; ADR-060). */
export interface DashboardTable {
  id: Generated<number>;
  workspace_id: number;
  owner_id: number;
  name: string;
  description: Generated<string>;
  layout: ColumnType<DashboardLayout, DashboardLayout | undefined, DashboardLayout>;
  /** The widgets in order: id, kind, column, title and the kind's settings (checked by the API). */
  widgets: ColumnType<JsonValue, string | undefined, string>;
  /** The administrator's choice for everyone's home; at most one per workspace. */
  is_default: Generated<boolean>;
  version: Generated<number>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** A track's customized Summary, at most one per track; no row is the default (ADR-116). */
export interface TrackSummaryLayoutTable {
  track_id: number;
  workspace_id: number;
  layout: ColumnType<DashboardLayout, DashboardLayout | undefined, DashboardLayout>;
  /** The widgets in order, as a dashboard's (checked by the API). */
  widgets: ColumnType<JsonValue, string | undefined, string>;
  version: Generated<number>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** Who besides its owner sees a dashboard; the scopes of saved searches (ADR-053). */
export interface DashboardShareTable {
  id: Generated<number>;
  workspace_id: number;
  dashboard_id: number;
  scope: SavedSearchShareScope;
  user_id: number | null;
  group_id: number | null;
  track_id: number | null;
  role_id: number | null;
}

/** Who besides its owner sees a saved search; no row means private (QRY-011). */
export interface SavedSearchShareTable {
  id: Generated<number>;
  workspace_id: number;
  saved_search_id: number;
  scope: SavedSearchShareScope;
  user_id: number | null;
  group_id: number | null;
  track_id: number | null;
  /** With a track: only the actors of this role; null for every member. */
  role_id: number | null;
}

export interface SavedSearchStarTable {
  workspace_id: number;
  saved_search_id: number;
  user_id: number;
  starred_at: DefaultTimestamp;
}

export type SubscriptionSchedule = 'daily' | 'weekly' | 'monthly' | 'cron';

/** A saved search's results emailed on a schedule to a person or a group (QRY-012). */
export interface SavedSearchSubscriptionTable {
  id: Generated<number>;
  workspace_id: number;
  saved_search_id: number;
  created_by: number;
  recipient_user_id: number | null;
  recipient_group_id: number | null;
  schedule: SubscriptionSchedule;
  hour: Generated<number>;
  minute: Generated<number>;
  /** 0 is Sunday. */
  weekday: number | null;
  day_of_month: number | null;
  cron: string | null;
  time_zone: Generated<string>;
  only_if_results: Generated<boolean>;
  next_run_at: Timestamp;
  last_run_at: Timestamp | null;
  last_sent: number | null;
  last_error: string | null;
  created_at: DefaultTimestamp;
}

/** Someone who may change a board besides its track's administrators (AGL-001 (2)). */
export interface BoardAdminTable {
  workspace_id: number;
  board_id: number;
  user_id: number;
}

/** A person's own settings. */
export interface UserPreferenceTable {
  user_id: number;
  workspace_id: number;
  /** Follow the tickets one creates, edits or comments on (CORE-019). */
  auto_follow: Generated<boolean>;
  /** Be notified of one's own changes (M1-056; off by default). */
  notify_own_changes: Generated<boolean>;
  /** Email at once, as a daily or weekly digest, or none (M1-057). */
  email_delivery: ColumnType<EmailDelivery, EmailDelivery | undefined, EmailDelivery>;
  /** Quiet hours in the person's time zone, both or neither; email waits until they end. */
  quiet_start: number | null;
  quiet_end: number | null;
  updated_at: DefaultTimestamp;
}

/** The workspace's time tracking settings (M1-019, TIM-001). */
export interface TimeTrackingSettingTable {
  workspace_id: number;
  enabled: Generated<boolean>;
  /** numeric columns read as text. */
  hours_per_day: ColumnType<string, number | string | undefined, number | string>;
  days_per_week: ColumnType<string, number | string | undefined, number | string>;
  display_format: Generated<'pretty' | 'days' | 'hours'>;
  default_unit: Generated<'week' | 'day' | 'hour' | 'minute'>;
  copy_transition_comments: Generated<boolean>;
  updated_at: DefaultTimestamp;
}

/** Time someone worked on a ticket. */
export interface TimeEntryTable {
  id: Generated<number>;
  workspace_id: number;
  ticket_id: number;
  author_id: number;
  started_at: Timestamp;
  /** Seconds. */
  duration: number;
  description: Generated<string>;
  visible_role_id: number | null;
  visible_group_id: number | null;
  created_by: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/**
 * A comment on a ticket (M1-018, CORE-020): a rich-text document of the shared schema, visible
 * to everyone who sees the ticket or only to one role in its track or one group. `version`
 * counts its states; earlier ones are in `ticket_comment_version`. Deleting is soft. The
 * visibility columns have no foreign key: a comment whose role or group is gone stays
 * restricted (ADR-044).
 */
export interface TicketCommentTable {
  id: Generated<number>;
  workspace_id: number;
  ticket_id: number;
  author_id: number | null;
  body: Json;
  visible_role_id: number | null;
  visible_group_id: number | null;
  version: Generated<number>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  edited_at: Timestamp | null;
  edited_by: number | null;
  deleted_at: Timestamp | null;
  deleted_by: number | null;
  /** The stemmed words of the body (M1-040). */
  body_words: SearchWords;
}

/** An earlier state of a comment, kept when it was edited (CORE-020 (3)). */
export interface TicketCommentVersionTable {
  comment_id: number;
  version: number;
  workspace_id: number;
  body: Json;
  visible_role_id: number | null;
  visible_group_id: number | null;
  written_by: number | null;
  written_at: Timestamp;
  replaced_by: number | null;
  replaced_at: DefaultTimestamp;
}

/**
 * The vector of a ticket's summary and description (M1-078, AI-012; ADR-106): a unit vector of
 * `model`, made from the text whose MD5 is `source_hash` (`taskmoor_embedding_text`).
 */
export interface TicketEmbeddingTable {
  ticket_id: number;
  workspace_id: number;
  model: string;
  source_hash: string;
  embedding: number[];
  embedded_at: DefaultTimestamp;
}

/** The vector of a comment's body (M1-078); its ticket's for the permission filter. */
export interface CommentEmbeddingTable {
  comment_id: number;
  ticket_id: number;
  workspace_id: number;
  model: string;
  source_hash: string;
  embedding: number[];
  embedded_at: DefaultTimestamp;
}

/** One person's emoji reaction to a comment (CORE-020 (2)). */
export interface TicketCommentReactionTable {
  comment_id: number;
  emoji: string;
  user_id: number;
  workspace_id: number;
  created_at: DefaultTimestamp;
}

/** The workspace's attachment settings (M1-016, CORE-021). */
export interface AttachmentSettingTable {
  workspace_id: number;
  /** Bytes; bigint reads as text. No upper bound: there is no fixed ceiling. */
  max_file_size: ColumnType<string, number | string | undefined, number | string>;
  /** Storage quotas in bytes (M1-118; ASVS 12.1.3); null is none, the default. */
  workspace_quota: ColumnType<
    string | null,
    number | string | null | undefined,
    number | string | null
  >;
  person_quota: ColumnType<
    string | null,
    number | string | null | undefined,
    number | string | null
  >;
  updated_at: DefaultTimestamp;
}

export type StorageKindColumn = 'local' | 's3';
export type AttachmentScanState = 'pending' | 'clean' | 'infected' | 'failed';
export type AttachmentThumbnailState = 'none' | 'pending' | 'ready' | 'failed';

/**
 * A file on a ticket (CORE-021). `name` is for display only; the bytes are in `storage` under
 * `storage_key`, a random key (ADR-040). Only `clean` files are served.
 */
export interface AttachmentTable {
  id: Generated<number>;
  workspace_id: number;
  ticket_id: number;
  name: string;
  declared_type: string;
  sniffed_type: string | null;
  /** Bytes; bigint reads as text. */
  size: ColumnType<string, number | string, number | string>;
  sha256: string;
  storage: StorageKindColumn;
  storage_key: string;
  scan_state: Generated<AttachmentScanState>;
  scan_detail: string | null;
  scanned_at: Timestamp | null;
  thumbnail_state: Generated<AttachmentThumbnailState>;
  thumbnail_key: string | null;
  width: number | null;
  height: number | null;
  author_id: number | null;
  created_at: DefaultTimestamp;
}

/** Stored objects waiting to be deleted (ADR-040): gone attachments and unfinished uploads. */
export interface StorageCleanupTable {
  id: ColumnType<string, never, never>;
  workspace_id: number;
  storage: StorageKindColumn;
  storage_key: string;
  reason: 'upload' | 'deleted';
  not_before: DefaultTimestamp;
  attempts: Generated<number>;
  last_error: string | null;
  created_at: DefaultTimestamp;
}

/** A status, in one of three stages (M1-023, CORE-014). */
export type StatusStage = 'new' | 'active' | 'closed';
export interface StatusTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  stage: StatusStage;
  sort_order: number;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** A workflow: versioned data, one version published, at most one draft (WF-001, WF-002). */
export interface WorkflowTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  is_default: Generated<boolean>;
  published_version: Generated<number>;
  draft_version: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  /** The local-mode track that owns it (M1-028); null for a shared workflow. */
  owner_track_id: ColumnType<number | null, number | null | undefined, number | null>;
}

/**
 * Which workflow each ticket type uses (M1-028, WF-001 (3)): the entries name some types, the
 * default workflow takes the rest. Shared maps serve shared-mode tracks; a local-mode track
 * owns one.
 */
export interface WorkflowMapTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  description: Generated<string>;
  default_workflow_id: number;
  owner_track_id: ColumnType<number | null, number | null | undefined, number | null>;
  is_default: Generated<boolean>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface WorkflowMapEntryTable {
  workspace_id: number;
  map_id: number;
  ticket_type_id: number;
  workflow_id: number;
}

export type WorkflowMigrationStatus = 'queued' | 'running' | 'done';

/**
 * Tickets moving to statuses their new workflow has after a change of workflow map (M1-028),
 * run in the background with progress.
 */
export interface WorkflowMigrationTable {
  id: Generated<string>;
  workspace_id: number;
  user_id: number | null;
  reason: 'track_map' | 'map_change';
  map_id: number | null;
  track_id: number | null;
  status: ColumnType<
    WorkflowMigrationStatus,
    WorkflowMigrationStatus | undefined,
    WorkflowMigrationStatus
  >;
  total: number;
  migrated: Generated<number>;
  /** The change set of every history row the migration writes. */
  change_set: string;
  created_at: DefaultTimestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

/** Where a migration takes the tickets of one type and status in one track. */
export interface WorkflowMigrationStepTable {
  migration_id: string;
  workspace_id: number;
  track_id: number;
  ticket_type_id: number;
  from_status_id: number;
  to_status_id: number;
  /** Tickets there when the migration was asked for. */
  ticket_count: number;
}

export interface WorkflowVersionTable {
  workspace_id: number;
  workflow_id: number;
  version: number;
  /** Statuses, the initial status and transitions (`apps/server/src/workflows/model.ts`). */
  definition: Json;
  created_by: number | null;
  created_at: DefaultTimestamp;
  published_at: Timestamp | null;
  published_by: number | null;
}

/** The statuses a workflow version uses. */
export interface WorkflowVersionStatusTable {
  workspace_id: number;
  workflow_id: number;
  version: number;
  status_id: number;
}

/** A custom field (M1-010, CORE-010); type and `multiple` never change after creation. */
export type CustomFieldType =
  | 'text'
  | 'paragraph'
  | 'number'
  | 'date'
  | 'datetime'
  | 'select'
  | 'cascading-select'
  | 'user'
  | 'group'
  | 'labels'
  | 'url'
  | 'read-only-text'
  | 'release'
  | 'area'
  /** Computed from other fields (M1-013, CORE-011); `config` holds the expression and output. */
  | 'formula'
  /** A site team (M1-123, CORE-027); one value. */
  | 'team';
export interface FieldTable {
  id: Generated<number>;
  workspace_id: number;
  /** The local-mode track that owns the field; null for a shared field. */
  track_id: number | null;
  name: string;
  description: Generated<string>;
  type: CustomFieldType;
  multiple: Generated<boolean>;
  config: ColumnType<Record<string, JsonValue>, string | undefined, string>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** Where a field applies and what it offers there (CORE-009). */
export interface FieldContextTable {
  id: Generated<number>;
  workspace_id: number;
  field_id: number;
  name: string;
  description: Generated<string>;
  /** In stored form; null for none. */
  default_value: NullableJson;
  config: ColumnType<Record<string, JsonValue>, string | undefined, string>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** A track and ticket type a context covers; null is every track or every type. */
export interface FieldContextScopeTable {
  workspace_id: number;
  field_id: number;
  context_id: number;
  track_id: number | null;
  ticket_type_id: number | null;
}

/** An option of a context; a cascading child names its parent. */
export interface FieldOptionTable {
  id: Generated<number>;
  workspace_id: number;
  field_id: number;
  context_id: number;
  parent_id: number | null;
  value: string;
  sort_order: number;
  disabled: Generated<boolean>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** A labels field's own vocabulary. */
export interface FieldLabelTable {
  workspace_id: number;
  field_id: number;
  name: string;
  created_at: DefaultTimestamp;
}

/**
 * A custom field value for filtering, sorting and counting (M1-011, ADR-008): the ticket's
 * track and creation time are copied so a side index serves track-scoped, newest-first pages.
 */
interface SideRow<V> {
  workspace_id: number;
  ticket_id: number;
  track_id: number;
  field_id: number;
  value: V;
  created_at: Date | string;
}
export interface TextValueTable extends SideRow<string> {
  /** Case-folded, in the C collation: the order the application sorts text in. */
  sort_key: string;
}
export type NumberValueTable = SideRow<ColumnType<string, number | string, number | string>>;
export type DateValueTable = SideRow<string>;
export type TimeValueTable = SideRow<ColumnType<Date, Date | string, Date | string>>;
export type IdValueTable = SideRow<number>;

/**
 * A JSON document an integration keeps on an entity under a key (M1-129; API-013; ADR-083):
 * one table per kind of entity, so properties go with their entity.
 */
interface PropertyRow {
  workspace_id: number;
  key: string;
  value: ColumnType<JsonValue, string, string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  updated_by: number | null;
}
export interface TicketPropertyTable extends PropertyRow {
  ticket_id: number;
}
export interface TrackPropertyTable extends PropertyRow {
  track_id: number;
}
export interface UserPropertyTable extends PropertyRow {
  user_id: number;
}
export interface BoardPropertyTable extends PropertyRow {
  board_id: number;
}
export interface SprintPropertyTable extends PropertyRow {
  sprint_id: number;
}

/** A value inside a ticket property that queries may name (M1-129; ADR-083). */
export interface PropertyIndexTable {
  id: Generated<number>;
  workspace_id: number;
  key: string;
  /** Dot-separated names inside the document; '' for the whole value. */
  path: Generated<string>;
  type: 'number' | 'string' | 'text' | 'date' | 'user';
  /** A plain field name queries may use for it. */
  alias: string | null;
  created_at: Generated<Date>;
  created_by: number | null;
}

/** A field rule set or a layout set (M1-012); a local-mode track's own name it. */
export interface ConfigurationSetTable {
  id: Generated<number>;
  workspace_id: number;
  track_id: number | null;
  name: string;
  description: Generated<string>;
  is_default: Generated<boolean>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/**
 * A visibility policy (M1-020; IAM-011): levels and the default a new or moved ticket takes. A
 * local-mode track's own policy names it in `track_id`.
 */
export interface VisibilityPolicyTable {
  id: Generated<number>;
  workspace_id: number;
  track_id: number | null;
  name: string;
  description: Generated<string>;
  default_level_id: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface VisibilityLevelTable {
  id: Generated<number>;
  workspace_id: number;
  policy_id: number;
  name: string;
  description: Generated<string>;
  position: number;
}

/** Who sees tickets at a level: any grantee an access grant takes. */
export interface VisibilityMemberTable {
  id: Generated<number>;
  workspace_id: number;
  level_id: number;
  grantee: GranteeKind;
  role_id: number | null;
  group_id: number | null;
  user_id: number | null;
  field_key: string | null;
}

export type NotificationRecipient =
  | 'assignee'
  | 'requester'
  | 'area_owner'
  | 'user'
  | 'group'
  | 'role'
  | 'follower'
  | 'track_owner'
  | 'current_user'
  | 'user_field'
  | 'group_field';
export type NotificationChannel = 'email' | 'inbox';

/** A notification policy (M1-056; NTF-001): which recipients each event reaches. */
export interface NotificationPolicyTable {
  id: Generated<number>;
  workspace_id: number;
  track_id: number | null;
  name: string;
  description: Generated<string>;
  is_default: Generated<boolean>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface NotificationRuleTable {
  id: Generated<number>;
  workspace_id: number;
  policy_id: number;
  event: string;
  recipient: NotificationRecipient;
  user_id: number | null;
  group_id: number | null;
  role_id: number | null;
  field_key: string | null;
}

/** A person's choice for one event and channel; no row means on (NTF-004). */
export interface NotificationPreferenceTable {
  user_id: number;
  workspace_id: number;
  event: string;
  channel: NotificationChannel;
  enabled: boolean;
}

/** One notification to one person on one channel, for one domain event (M1-056). */
export interface NotificationTable {
  id: Generated<string>;
  workspace_id: number;
  user_id: number;
  channel: NotificationChannel;
  event: string;
  ticket_id: number | null;
  domain_event_id: string;
  actor_id: number | null;
  payload: ColumnType<Record<string, JsonValue>, string | undefined, string>;
  created_at: DefaultTimestamp;
  read_at: Timestamp | null;
  delivered_at: Timestamp | null;
  /** The email that carried it (M1-057). */
  email_delivery_id: string | null;
  /** An inbox item put aside until then (M1-058); it comes back unread. */
  snoozed_until: Timestamp | null;
  /** A direct ask: a mention of the person, or the ticket assigned to them (M1-058). */
  direct: Generated<boolean>;
}

/** Per person, a counter bumped with every change to their inbox (M1-058). */
export interface InboxStateTable {
  user_id: number;
  workspace_id: number;
  version: Generated<string>;
  changed_at: DefaultTimestamp;
}

export type EmailDelivery = 'instant' | 'daily' | 'weekly' | 'off';
export type EmailKind = Exclude<EmailDelivery, 'off'>;

/** A workspace's email batching window and digest hour (M1-057). */
export interface EmailSettingTable {
  workspace_id: number;
  batch_window_seconds: Generated<number>;
  digest_hour: Generated<number>;
  updated_at: DefaultTimestamp;
}

/** One email sent (or that failed), with how many notifications it carried. */
export interface EmailDeliveryTable {
  id: Generated<string>;
  workspace_id: number;
  user_id: number;
  kind: EmailKind;
  ticket_id: number | null;
  notification_count: number;
  subject: string;
  message_id: string | null;
  error: string | null;
  sent_at: DefaultTimestamp;
}

/** A one-click unsubscribe link: the hash of its token, and what it turns off. */
export interface EmailUnsubscribeTable {
  token_hash: Buffer;
  workspace_id: number;
  user_id: number;
  /** Null: every email. */
  event: string | null;
  created_at: DefaultTimestamp;
  used_at: Timestamp | null;
}

/**
 * The change log of ADR-013 (M1-031): triggers write a row per change to a ticket, track or
 * the authorization data; `seq` is given at commit, so its order is commit order.
 */
export interface ChangeLogTable {
  id: Generated<string>;
  seq: string | null;
  workspace_id: number;
  /** The sync group: a track, or null for the workspace's. */
  track_id: number | null;
  entity: 'ticket' | 'track' | 'authz';
  entity_id: number;
  op: 'upsert' | 'delete';
  data: ColumnType<Record<string, JsonValue> | null, string | null | undefined, string | null>;
  created_at: DefaultTimestamp;
}

/**
 * A (person, client, mutation) pair a client sent (M1-032): written before the mutation runs,
 * finished with its response, so a second copy is answered without running it again.
 */
export interface MutationReceiptTable {
  workspace_id: number;
  user_id: number;
  client_id: string;
  mutation_id: string;
  method: string;
  path: string;
  status: 'pending' | 'done';
  status_code: number | null;
  body: ColumnType<JsonValue | null, string | null | undefined, string | null>;
  position: string | null;
  created_at: DefaultTimestamp;
  finished_at: Timestamp | null;
}

/** Below `floor_seq` the log was trimmed: a client further behind bootstraps again. */
export interface ChangeLogFloorTable {
  workspace_id: number;
  floor_seq: Generated<string>;
  retention_days: Generated<number>;
}

/** Whether a field is required or hidden, and its help text, for a ticket type or every type. */
export interface FieldRuleTable {
  workspace_id: number;
  rule_set_id: number;
  ticket_type_id: number | null;
  /** As the query language names it: `dueDate`, `cf[12]`. */
  field: string;
  required: Generated<boolean>;
  hidden: Generated<boolean>;
  description: string | null;
  /** The roles and groups that alone may set the field (M1-029); null for everyone. */
  editable_by: NullableJson;
}

/** The tabs and sections of a form for a ticket type (or every type) and operation. */
export interface LayoutTable {
  id: Generated<number>;
  workspace_id: number;
  layout_set_id: number;
  ticket_type_id: number | null;
  operation: 'create' | 'edit' | 'view';
  definition: Json;
}

/** Moves on every change to the field catalogue; cached copies carry it. */
export interface FieldEpochTable {
  workspace_id: number;
  epoch: ColumnType<string, string | number | undefined, string | number>;
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
  /** Client address of the request that caused the event; null for the CLI and jobs. */
  ip: string | null;
  /** The request's User-Agent (M1-118, ADR-109), cut to 400 characters; null outside a request. */
  user_agent: string | null;
}

/**
 * The audit log (M1-003, ADR-034): append-only (a trigger refuses UPDATE, DELETE and
 * TRUNCATE), partitioned by month on `recorded_at`, one hash chain per workspace. Write it
 * only through `appendAudit` in apps/server/src/audit/chain.ts, which keeps the chain whole.
 */
export interface AuditEventTable {
  workspace_id: number;
  /** Position in the workspace's chain, from 1, without gaps. */
  seq: ColumnType<string, string | number, never>;
  /** When the record joined the log; never earlier than the previous record's. */
  recorded_at: ColumnType<Date, Date | string, never>;
  /** When the recorded thing happened (the domain event's time). */
  occurred_at: ColumnType<Date, Date | string, never>;
  actor_id: ColumnType<number | null, number | null, never>;
  action: ColumnType<string, string, never>;
  subject_type: ColumnType<string | null, string | null, never>;
  subject_id: ColumnType<string | null, string | null, never>;
  details: ColumnType<JsonValue, string, never>;
  ip: ColumnType<string | null, string | null, never>;
  source_event_id: ColumnType<string | null, string | number | null, never>;
  prev_hash: ColumnType<string, string, never>;
  hash: ColumnType<string, string, never>;
}

/**
 * Each workspace's audit chain: the head that appends lock and extend, and the checkpoint
 * retention leaves when it drops old partitions (the last dropped record's seq and hash).
 */
export interface AuditChainTable {
  workspace_id: number;
  head_seq: ColumnType<string, string | number | undefined, string | number>;
  head_hash: Generated<string>;
  head_recorded_at: Timestamp | null;
  checkpoint_seq: ColumnType<string, string | number | undefined, string | number>;
  checkpoint_hash: Generated<string>;
  checkpoint_at: Timestamp | null;
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

/** A change asked for many tickets at once, run as a job for the person who asked (M1-021). */
export interface BulkOperationTable {
  id: Generated<string>;
  workspace_id: number;
  user_id: number;
  /** `clone` makes copies of tickets (M1-124, CORE-023). */
  action: 'edit' | 'move' | 'transition' | 'delete' | 'clone';
  params: Json;
  status: ColumnType<
    'queued' | 'running' | 'done' | 'cancelled',
    'queued' | 'running' | 'done' | 'cancelled' | undefined,
    'queued' | 'running' | 'done' | 'cancelled'
  >;
  cancel_requested: Generated<boolean>;
  total: number;
  succeeded: Generated<number>;
  failed: Generated<number>;
  skipped: Generated<number>;
  created_at: DefaultTimestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

/** One ticket of a bulk operation and, once run, what became of it. */
export interface BulkItemTable {
  operation_id: string;
  workspace_id: number;
  position: number;
  /** What was asked: an id or a key. */
  ref: string;
  ticket_id: number | null;
  outcome: 'done' | 'failed' | 'skipped' | null;
  status_code: number | null;
  error: NullableJson;
  finished_at: Timestamp | null;
  /** The ticket the item made: a clone's copy (M1-124). */
  result_ticket_id: number | null;
  /** What a finished item made, as shown with its outcome. */
  result: NullableJson;
}

export type ImportRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
/** `deleted`: a delta run found the source no longer holds the record (M1-096). */
export type ImportOutcome =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'linked'
  | 'failed'
  | 'skipped'
  | 'deleted';

/**
 * One import (M1-086; IMP-009, IMP-010): its source, state, the checkpoint it resumes from,
 * tallies, warnings and unsupported kinds found so far, and the fidelity report once finished.
 */
export interface ImportRunTable {
  id: Generated<string>;
  workspace_id: number;
  user_id: number | null;
  /** The importer: the source format, such as `synthetic`. */
  import_source: string;
  /** Which instance the data came from, as the source names it. */
  source_system: string;
  name: Generated<string>;
  /** The uploaded data or the settings of a configured source. */
  source: Json;
  dry_run: Generated<boolean>;
  status: ColumnType<ImportRunStatus, ImportRunStatus | undefined, ImportRunStatus>;
  cancel_requested: Generated<boolean>;
  checkpoint: ColumnType<Record<string, JsonValue>, string | undefined, string>;
  tallies: ColumnType<Record<string, JsonValue>, string | undefined, string>;
  warnings: ColumnType<Record<string, JsonValue>, string | undefined, string>;
  unsupported: ColumnType<Record<string, JsonValue>, string | undefined, string>;
  batches: Generated<number>;
  report: NullableJson;
  last_error: string | null;
  created_at: DefaultTimestamp;
  started_at: Timestamp | null;
  updated_at: DefaultTimestamp;
  finished_at: Timestamp | null;
  /** Where a remote source's fetch got to (M1-095): its steps, page tokens and counts. */
  fetch_state: ColumnType<Record<string, JsonValue>, string | undefined, string>;
  /** The earlier run a delta run starts from (M1-096). */
  delta_from: string | null;
}

/**
 * A record a remote source's fetch staged for its run (M1-095; ADR-094), read back in the order
 * of `depth` (parents first) and `ordinal`.
 */
export interface ImportStagedTable {
  run_id: string;
  workspace_id: number;
  kind: string;
  source_id: string;
  depth: Generated<number>;
  ordinal: ColumnType<string, number | string, number | string>;
  label: string | null;
  data: ColumnType<JsonValue, string, string>;
}

/** What one run did with one source record. */
export interface ImportRecordTable {
  run_id: string;
  workspace_id: number;
  entity_kind: string;
  source_id: string;
  outcome: ImportOutcome;
  target_id: string | null;
  checksum: string | null;
  sampled: Generated<boolean>;
  error: NullableJson;
  /** How people know a configuration object in the source (M1-088); null for content. */
  label: string | null;
}

/** An imported object by (import source, source system, entity kind, source id) (IMP-009). */
export interface ImportExternalIdTable {
  workspace_id: number;
  import_source: string;
  source_system: string;
  entity_kind: string;
  source_id: string;
  target_id: string;
  checksum: string;
  first_run_id: string | null;
  last_run_id: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
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

/** How long a sign-in lasts in a workspace (ASVS 3.3.2); no row means the defaults. */
export interface SessionPolicyTable {
  workspace_id: number;
  lifetime_minutes: number;
  idle_minutes: number;
  updated_at: DefaultTimestamp;
}

export interface TwoFactorPolicyGroupTable {
  workspace_id: number;
  group_id: number;
}

/** What a security email tells (ADR-109): a credential change, or an alert to administrators. */
export type SecurityEmailKind =
  | 'password_changed'
  | 'two_factor_enabled'
  | 'two_factor_disabled'
  | 'recovery_codes_regenerated'
  | 'two_factor_reset'
  | 'email_changed'
  | 'alert';

/** A security notice or alert email (ASVS 2.2.3, 2.5.5, 11.1.8): sent once, outside digests. */
export interface SecurityEmailTable {
  id: Generated<string>;
  workspace_id: number;
  user_id: number;
  kind: SecurityEmailKind;
  domain_event_id: string;
  /** Fixed when written: an email change is told to the old address. */
  to_address: string;
  details: ColumnType<Record<string, JsonValue>, string | undefined, string>;
  created_at: DefaultTimestamp;
  attempts: Generated<number>;
  last_error: string | null;
  message_id: string | null;
  sent_at: Timestamp | null;
}

/** The alert rules a site administrator can tune (ASVS 11.1.7); no row means the defaults. */
export type SecurityAlertRuleName =
  | 'sign_in_failures_account'
  | 'sign_in_failures_address'
  | 'access_refusals'
  | 'bulk_exports';

export interface SecurityAlertRuleTable {
  workspace_id: number;
  rule: SecurityAlertRuleName;
  enabled: boolean;
  threshold: number;
  window_minutes: number;
  updated_at: DefaultTimestamp;
}

/** What a rule counted for one key in one fixed window. */
export interface SecurityCounterTable {
  workspace_id: number;
  rule: string;
  key: string;
  window_start: Timestamp;
  count: Generated<number>;
}

/** An alert raised: at most one per rule, key and window. */
export interface SecurityAlertTable {
  id: Generated<string>;
  workspace_id: number;
  rule: string;
  key: string;
  window_start: Timestamp;
  count: number;
  threshold: number;
  window_minutes: number;
  details: ColumnType<Record<string, JsonValue>, string | undefined, string>;
  raised_at: DefaultTimestamp;
}

/** An OpenID Connect provider (M1-080). The client secret is sealed under the pepper. */
export interface IdentityProviderTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  /** The protocol: OpenID Connect (M1-080) or SAML 2.0 (M1-081). */
  kind: Generated<'oidc' | 'saml'>;
  /** OpenID Connect: the issuer URL. SAML: the identity provider's entity ID. */
  issuer: string;
  /** OpenID Connect only; null for SAML. */
  client_id: string | null;
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
  /** SAML: where AuthnRequests go (HTTP-Redirect binding). */
  saml_sso_url: string | null;
  /** SAML: the certificates whose keys may sign responses, PEM. */
  saml_certificates: Generated<string[]>;
  /** SAML: Taskmoor's entity ID towards this provider; null derives it from PUBLIC_URL. */
  saml_sp_entity_id: string | null;
  /** SAML: the attribute holding the email address; null tries the usual ones. */
  saml_email_attribute: string | null;
  /** SAML: whether the provider may start sign-ins itself (IdP-initiated). */
  saml_idp_initiated: Generated<boolean>;
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
 * A SAML sign-in in flight (M1-081): the AuthnRequest bound to the browser that started it,
 * and, once the provider's response verified, the person it names under a one-time handle
 * until the browser collects it. IdP-initiated sign-ins have no request and no browser.
 */
export interface SamlLoginTable {
  id: Generated<number>;
  workspace_id: number;
  provider_id: number;
  request_id: string | null;
  browser_hash: string | null;
  return_to: Generated<string>;
  handle_hash: string | null;
  identity: NullableJson;
  expires_at: Timestamp;
  created_at: DefaultTimestamp;
}

/** An accepted assertion's ID, kept until the assertion expires, so it is used once. */
export interface SamlAssertionTable {
  workspace_id: number;
  assertion_id: string;
  provider_id: number;
  expires_at: Timestamp;
}

/** `scim` is held alone: it reaches the SCIM endpoints and nothing else (ADR-038). */
export type ApiTokenScope = 'read' | 'write' | 'admin' | 'scim';

/**
 * Personal and service-account API tokens (IAM-007, ADR-035): the holder keeps the token, the
 * row keeps its SHA-256. Revoked and expired tokens stay listed until pruning removes them.
 */
export interface ApiTokenTable {
  id: Generated<number>;
  workspace_id: number;
  user_id: number;
  name: string;
  token_hash: string;
  scopes: ColumnType<ApiTokenScope[], ApiTokenScope[], ApiTokenScope[]>;
  created_by: number | null;
  created_at: DefaultTimestamp;
  expires_at: Timestamp;
  /** Written at most once a minute, so ordinary requests stay read-only. */
  last_used_at: Timestamp | null;
  last_used_ip: string | null;
  revoked_at: Timestamp | null;
  revoked_by: number | null;
  /** The token that replaced this one when it was rotated. */
  replaced_by: number | null;
}

/** A workspace's IP allowlist (M1-085; IAM-015): on or off, and the groups exempt from it. */
export interface IpAllowlistTable {
  workspace_id: number;
  enabled: Generated<boolean>;
  exempt_group_ids: ColumnType<number[], number[] | undefined, number[]>;
  updated_at: DefaultTimestamp;
}

/** An address or range the allowlist lets in, as typed (`inet`: an address with its prefix). */
export interface IpAllowlistEntryTable {
  id: Generated<number>;
  workspace_id: number;
  range: string;
  note: Generated<string>;
  created_at: DefaultTimestamp;
}

/**
 * An email domain of the organization (M1-085; IAM-004): people at any other domain are
 * external once a workspace names one.
 */
export interface OrganizationDomainTable {
  workspace_id: number;
  domain: string;
}

/** Where audit records are forwarded over syslog, and how far it has got (M1-085). */
export interface AuditSyslogTable {
  workspace_id: number;
  enabled: Generated<boolean>;
  host: string;
  port: number;
  transport: 'udp' | 'tcp' | 'tls';
  last_seq: ColumnType<string, string | number | undefined, string | number>;
  last_sent_at: Timestamp | null;
  last_error: string | null;
  updated_at: DefaultTimestamp;
}

/**
 * A workspace's rate limits (M1-066; API-010): requests a second and burst per API token,
 * signed-in person, address without either, and per ticket for writes.
 */
export interface RateLimitPolicyTable {
  workspace_id: number;
  token_rate: Generated<number>;
  token_burst: Generated<number>;
  user_rate: Generated<number>;
  user_burst: Generated<number>;
  address_rate: Generated<number>;
  address_burst: Generated<number>;
  ticket_write_rate: Generated<number>;
  ticket_write_burst: Generated<number>;
  updated_at: DefaultTimestamp;
}

/** Requests, errors and refusals per API client and minute, for the usage dashboard. */
export interface ApiUsageTable {
  workspace_id: number;
  client_kind: 'token' | 'user' | 'address';
  /** The token or user id as text, or the address. */
  client: string;
  minute: Timestamp;
  requests: Generated<number>;
  errors: Generated<number>;
  throttled: Generated<number>;
}

/** Per-workspace limits on tokens: the longest lifetime and the rotation reminder window. */
export interface TokenPolicyTable {
  workspace_id: number;
  max_lifetime_days: Generated<number>;
  reminder_days: Generated<number>;
  updated_at: DefaultTimestamp;
}

/**
 * What an identity provider said about an account it provisions over SCIM (IAM-006, ADR-038):
 * its userName, externalId and the profile attributes `app_user` has no column for. A SCIM
 * DELETE sets `removed_at`: the account stays, deactivated, and SCIM no longer sees it.
 */
export interface ScimUserTable {
  user_id: number;
  workspace_id: number;
  user_name: string;
  external_id: string | null;
  attributes: Json;
  removed_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** The provider's externalId for a group it provisions over SCIM. */
export interface ScimGroupTable {
  group_id: number;
  workspace_id: number;
  external_id: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/**
 * An LDAP or Active Directory directory (M1-082, IAM-005): where Taskmoor reads people and
 * groups from and signs them in against. The service account's password is sealed under the
 * pepper and never leaves the server.
 */
export interface LdapDirectoryTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  /** Which attribute and behaviour defaults apply (objectGUID and USNs for Active Directory). */
  kind: 'active_directory' | 'openldap' | 'generic';
  /** `ldaps://host:port` or `ldap://host:port` (then with StartTLS outside loopback). */
  url: string;
  start_tls: Generated<boolean>;
  /** PEM certificates to trust for this directory instead of the system store; empty uses it. */
  ca_certificates: Generated<string[]>;
  bind_dn: string;
  bind_password_sealed: string;
  base_dn: string;
  /** Where people are searched; null searches the base DN. */
  user_base_dn: string | null;
  user_filter: string;
  /** Where groups are searched; null searches the base DN. */
  group_base_dn: string | null;
  group_filter: string;
  /** Attribute names that differ from the kind's defaults (`ldap/settings.ts`). */
  attribute_map: Json;
  /** read_write writes password, profile and membership changes made in Taskmoor back. */
  mode: Generated<'read_only' | 'read_write'>;
  /** Precedence among directories, lowest first: an address two directories hold is the first's. */
  position: number;
  enabled: Generated<boolean>;
  sync_interval_minutes: Generated<number>;
  /** An incremental run becomes a full one when the last full run is older than this. */
  full_sync_hours: Generated<number>;
  next_sync_at: Timestamp | null;
  last_full_sync_at: Timestamp | null;
  /** Where the next incremental run starts: a USN on one domain controller, or a timestamp. */
  sync_cursor: NullableJson;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** An account a directory manages, by the entry's stable identifier. */
export interface LdapUserTable {
  user_id: number;
  workspace_id: number;
  directory_id: number;
  /** objectGUID (as a GUID string) or entryUUID: survives renames and moves. */
  external_id: string;
  dn: string;
  username: string;
  /** The directory marks the entry disabled (Active Directory's ACCOUNTDISABLE, a ppolicy lock). */
  disabled: Generated<boolean>;
  /** The sync deactivated the account, so the sync may bring it back. */
  deactivated_by_sync: Generated<boolean>;
  /** The entry left the directory or its filter; the account stays, deactivated. */
  removed_at: Timestamp | null;
  synced_at: DefaultTimestamp;
}

/** A group a directory manages; its members and nested groups follow the directory. */
export interface LdapGroupTable {
  group_id: number;
  workspace_id: number;
  directory_id: number;
  external_id: string;
  dn: string;
  synced_at: DefaultTimestamp;
}

/** A directory sync: queued, running or finished, with its counts and warnings (`ldap/sync.ts`). */
export interface LdapSyncRunTable {
  id: Generated<number>;
  workspace_id: number;
  directory_id: number;
  mode: 'full' | 'incremental';
  trigger: 'schedule' | 'manual';
  requested_by: number | null;
  /** A manual run may remove more than the safety limit allows (`ldap/sync.ts`). */
  confirm_removals: Generated<boolean>;
  status: Generated<'queued' | 'running' | 'succeeded' | 'failed'>;
  worker: string | null;
  created_at: DefaultTimestamp;
  started_at: Timestamp | null;
  heartbeat_at: Timestamp | null;
  finished_at: Timestamp | null;
  stats: ColumnType<JsonValue, string | undefined, string>;
  warnings: ColumnType<JsonValue, string | undefined, string>;
  error: string | null;
}

/** Bigint columns read as text (the pg driver keeps their precision). */
type Bigint = ColumnType<string, string | number, string | number>;
type DefaultBigint = ColumnType<string, string | number | undefined, string | number>;

/** A workspace's AI content logging and redaction rules (M1-077; IAM-021, IAM-022; ADR-100). */
export interface AiPolicyTable {
  workspace_id: number;
  /** Days prompt and answer content is kept; 0 keeps none. */
  content_days: ColumnType<number, number | undefined, number>;
  redact_patterns: ColumnType<string[], string[] | undefined, string[]>;
  redact_terms: ColumnType<string[], string[] | undefined, string[]>;
  /** `description`, `environment` or `cf[<id>]`. */
  redacted_fields: ColumnType<string[], string[] | undefined, string[]>;
  updated_by: number | null;
  updated_at: DefaultTimestamp;
}

/** An administrator's price for a model, in billionths of a dollar per token (M1-077). */
export interface AiPriceTable {
  workspace_id: number;
  provider: string;
  model: string;
  input_nanos: Bigint;
  output_nanos: Bigint;
  cache_read_nanos: Bigint;
  cache_write_nanos: Bigint;
  long_above_tokens: number | null;
  long_input_nanos: ColumnType<string | null, string | number | null, string | number | null>;
  long_output_nanos: ColumnType<string | null, string | number | null, string | number | null>;
  updated_by: number | null;
  updated_at: DefaultTimestamp;
}

/** A hard stop on AI use per period (M1-077; OPS-020). */
export interface AiSpendLimitTable {
  id: Generated<number>;
  workspace_id: number;
  scope: 'workspace' | 'feature' | 'user';
  feature: string | null;
  /** One person; null on a user limit means each person. */
  user_id: number | null;
  period: 'day' | 'week' | 'month';
  metric: 'tokens' | 'cost';
  /** Tokens, or nanos for a cost limit. */
  amount: Bigint;
  alert_percents: ColumnType<number[], number[] | undefined, number[]>;
  created_by: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** The AI audit log: one row per gateway call (M1-077; IAM-021). */
export interface AiCallTable {
  id: Generated<string>;
  workspace_id: number;
  occurred_at: DefaultTimestamp;
  user_id: number | null;
  track_id: number | null;
  run_id: string | null;
  feature: string;
  provider: string;
  model: string;
  served_model: string;
  mode: 'generate' | 'stream' | 'batch';
  outcome: 'ok' | 'refused' | 'error' | 'aborted' | 'limited';
  error_kind: string | null;
  limit_id: number | null;
  input_tokens: ColumnType<number, number | undefined, number>;
  output_tokens: ColumnType<number, number | undefined, number>;
  cache_read_tokens: ColumnType<number, number | undefined, number>;
  cache_write_tokens: ColumnType<number, number | undefined, number>;
  cost_nanos: DefaultBigint;
  priced: boolean;
  latency_ms: ColumnType<number, number | undefined, number>;
  retries: ColumnType<number, number | undefined, number>;
  fell_back: ColumnType<boolean, boolean | undefined, boolean>;
  /** What was sent and answered, only while content logging keeps it. */
  content: ColumnType<JsonValue | null, string | null | undefined, string | null>;
  content_expires_at: Timestamp | null;
}

/** AI calls summed per UTC day, feature, person (0: nobody), provider and model (M1-077). */
export interface AiUsageDayTable {
  workspace_id: number;
  day: ColumnType<string, string, string>;
  feature: string;
  user_id: number;
  provider: string;
  model: string;
  calls: ColumnType<number, number | undefined, number>;
  limited: ColumnType<number, number | undefined, number>;
  failed: ColumnType<number, number | undefined, number>;
  unpriced: ColumnType<number, number | undefined, number>;
  input_tokens: DefaultBigint;
  output_tokens: DefaultBigint;
  cache_read_tokens: DefaultBigint;
  cache_write_tokens: DefaultBigint;
  cost_nanos: DefaultBigint;
}

/** Usage per spend-limit period and key (`workspace`, `feature:<id>`, `user:<id>`) (M1-077). */
export interface AiSpendCounterTable {
  workspace_id: number;
  period: 'day' | 'week' | 'month';
  period_start: ColumnType<string, string, string>;
  key: string;
  tokens: DefaultBigint;
  cost_nanos: DefaultBigint;
}

/** A spend-limit threshold already announced for a period and person (M1-077). */
export interface AiLimitAlertTable {
  workspace_id: number;
  limit_id: number;
  period_start: ColumnType<string, string, string>;
  user_id: ColumnType<number, number | undefined, number>;
  percent: number;
  used: Bigint;
  raised_at: DefaultTimestamp;
}

/**
 * A download of one person's data (ASVS 8.3.2, ADR-111): a ZIP a background job writes into the
 * attachment store, kept for a week. `user_id` is whose data it is, `requested_by` who asked.
 */
/** Where a person is in the guided tutorial (ADR-115); section `offer` is the first-run offer. */
export interface TutorialProgressTable {
  workspace_id: number;
  user_id: number;
  section: string;
  state: 'active' | 'done' | 'skipped' | 'shown' | 'dismissed';
  step: Generated<number>;
  updated_at: Generated<Date>;
}

export interface PersonalExportTable {
  id: Generated<string>;
  workspace_id: number;
  user_id: number;
  requested_by: number | null;
  state: Generated<'queued' | 'running' | 'ready' | 'failed' | 'expired'>;
  storage: StorageKindColumn | null;
  storage_key: string | null;
  /** Bytes; bigint reads as text. */
  size: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  sha256: string | null;
  error: string | null;
  created_at: DefaultTimestamp;
  finished_at: Timestamp | null;
  expires_at: Timestamp | null;
}

/** Who has read the AI data-egress notice (M1-077; IAM-022). */
export interface AiNoticeAckTable {
  workspace_id: number;
  user_id: number;
  acknowledged_at: DefaultTimestamp;
}

/** Every table Kysely knows about. Add a table here in the same change as its migration. */
export interface Database {
  instance_setting: InstanceSettingTable;
  workspace: WorkspaceTable;
  app_user: AppUserTable;
  personal_export: PersonalExportTable;
  tutorial_progress: TutorialProgressTable;
  user_group: UserGroupTable;
  group_member: GroupMemberTable;
  team: TeamTable;
  team_member: TeamMemberTable;
  group_nesting: GroupNestingTable;
  user_session: UserSessionTable;
  oauth_code: OauthCodeTable;
  oauth_client: OauthClientTable;
  oauth_request: OauthRequestTable;
  frontend_origin: FrontendOriginTable;
  ai_setting: AiSettingTable;
  ai_credential: AiCredentialTable;
  ai_policy: AiPolicyTable;
  ai_price: AiPriceTable;
  ai_spend_limit: AiSpendLimitTable;
  ai_call: AiCallTable;
  ai_usage_day: AiUsageDayTable;
  ai_spend_counter: AiSpendCounterTable;
  ai_limit_alert: AiLimitAlertTable;
  ai_notice_ack: AiNoticeAckTable;
  oauth_token: OauthTokenTable;
  sign_in_throttle: SignInThrottleTable;
  password_link: PasswordLinkTable;
  role: RoleTable;
  access_policy: AccessPolicyTable;
  access_grant: AccessGrantTable;
  track: TrackTable;
  track_category: TrackCategoryTable;
  track_key_history: TrackKeyHistoryTable;
  track_role_actor: TrackRoleActorTable;
  hierarchy_level: HierarchyLevelTable;
  ticket_type: TicketTypeTable;
  type_set: TypeSetTable;
  type_set_member: TypeSetMemberTable;
  type_set_default: TypeSetDefaultTable;
  ticket: TicketTable;
  ticket_counter: TicketCounterTable;
  ticket_key_history: TicketKeyHistoryTable;
  ticket_detached_parent: TicketDetachedParentTable;
  ticket_change: TicketChangeTable;
  ticket_text_original: TicketTextOriginalTable;
  ticket_text_state: TicketTextStateTable;
  priority: PriorityTable;
  priority_set: PrioritySetTable;
  priority_set_member: PrioritySetMemberTable;
  close_reason: CloseReasonTable;
  label: LabelTable;
  release: ReleaseTable;
  release_approver: ReleaseApproverTable;
  area: AreaTable;
  ticket_release: TicketReleaseTable;
  ticket_area: TicketAreaTable;
  link_type: LinkTypeTable;
  ticket_link: TicketLinkTable;
  link_policy: LinkPolicyTable;
  trash_policy: TrashPolicyTable;
  backup_run: BackupRunTable;
  ticket_web_link: TicketWebLinkTable;
  ticket_checklist: TicketChecklistTable;
  ticket_checklist_item: TicketChecklistItemTable;
  ticket_follower: TicketPersonTable;
  ticket_visit: TicketVisitTable;
  guardrail_limit: GuardrailLimitTable;
  board: BoardTable;
  board_admin: BoardAdminTable;
  sprint: SprintTable;
  sprint_ticket: SprintTicketTable;
  webhook: WebhookTable;
  webhook_delivery: WebhookDeliveryTable;
  sprint_change: SprintChangeTable;
  saved_search: SavedSearchTable;
  saved_search_share: SavedSearchShareTable;
  dashboard: DashboardTable;
  dashboard_share: DashboardShareTable;
  track_summary_layout: TrackSummaryLayoutTable;
  saved_search_star: SavedSearchStarTable;
  saved_search_subscription: SavedSearchSubscriptionTable;
  ticket_vote: TicketPersonTable;
  user_preference: UserPreferenceTable;
  time_tracking_setting: TimeTrackingSettingTable;
  time_entry: TimeEntryTable;
  ticket_comment: TicketCommentTable;
  ticket_comment_version: TicketCommentVersionTable;
  ticket_comment_reaction: TicketCommentReactionTable;
  ticket_embedding: TicketEmbeddingTable;
  comment_embedding: CommentEmbeddingTable;
  attachment_setting: AttachmentSettingTable;
  attachment: AttachmentTable;
  storage_cleanup: StorageCleanupTable;
  status: StatusTable;
  workflow: WorkflowTable;
  workflow_version: WorkflowVersionTable;
  workflow_version_status: WorkflowVersionStatusTable;
  field: FieldTable;
  field_context: FieldContextTable;
  field_context_scope: FieldContextScopeTable;
  field_option: FieldOptionTable;
  field_label: FieldLabelTable;
  field_epoch: FieldEpochTable;
  field_rule_set: ConfigurationSetTable;
  field_rule: FieldRuleTable;
  layout_set: ConfigurationSetTable;
  layout: LayoutTable;
  visibility_policy: VisibilityPolicyTable;
  visibility_level: VisibilityLevelTable;
  visibility_member: VisibilityMemberTable;
  notification_policy: NotificationPolicyTable;
  notification_rule: NotificationRuleTable;
  notification_preference: NotificationPreferenceTable;
  notification: NotificationTable;
  inbox_state: InboxStateTable;
  email_setting: EmailSettingTable;
  email_delivery: EmailDeliveryTable;
  email_unsubscribe: EmailUnsubscribeTable;
  change_log: ChangeLogTable;
  change_log_floor: ChangeLogFloorTable;
  mutation_receipt: MutationReceiptTable;
  v_text: TextValueTable;
  v_number: NumberValueTable;
  v_date: DateValueTable;
  v_time: TimeValueTable;
  v_user: IdValueTable;
  v_option: IdValueTable;
  // Entity properties (M1-129): the documents, the declared indexes and their typed values,
  // shaped like the custom field side tables (`field_id` is the index's id).
  ticket_property: TicketPropertyTable;
  track_property: TrackPropertyTable;
  user_property: UserPropertyTable;
  board_property: BoardPropertyTable;
  sprint_property: SprintPropertyTable;
  property_index: PropertyIndexTable;
  p_text: TextValueTable;
  p_number: NumberValueTable;
  p_time: TimeValueTable;
  p_user: IdValueTable;
  global_grant: GlobalGrantTable;
  authz_epoch: AuthzEpochTable;
  domain_event: DomainEventTable;
  job: JobTable;
  bulk_operation: BulkOperationTable;
  bulk_item: BulkItemTable;
  import_run: ImportRunTable;
  import_record: ImportRecordTable;
  import_external_id: ImportExternalIdTable;
  import_staged: ImportStagedTable;
  workflow_map: WorkflowMapTable;
  workflow_map_entry: WorkflowMapEntryTable;
  workflow_migration: WorkflowMigrationTable;
  workflow_migration_step: WorkflowMigrationStepTable;
  totp_credential: TotpCredentialTable;
  webauthn_credential: WebauthnCredentialTable;
  recovery_code: RecoveryCodeTable;
  sign_in_challenge: SignInChallengeTable;
  two_factor_policy: TwoFactorPolicyTable;
  session_policy: SessionPolicyTable;
  security_email: SecurityEmailTable;
  security_alert_rule: SecurityAlertRuleTable;
  security_counter: SecurityCounterTable;
  security_alert: SecurityAlertTable;
  two_factor_policy_group: TwoFactorPolicyGroupTable;
  identity_provider: IdentityProviderTable;
  identity_provider_group: IdentityProviderGroupTable;
  user_identity: UserIdentityTable;
  oidc_login: OidcLoginTable;
  saml_login: SamlLoginTable;
  saml_assertion: SamlAssertionTable;
  audit_event: AuditEventTable;
  audit_chain: AuditChainTable;
  api_token: ApiTokenTable;
  token_policy: TokenPolicyTable;
  rate_limit_policy: RateLimitPolicyTable;
  ip_allowlist: IpAllowlistTable;
  ip_allowlist_entry: IpAllowlistEntryTable;
  organization_domain: OrganizationDomainTable;
  audit_syslog: AuditSyslogTable;
  api_usage: ApiUsageTable;
  scim_user: ScimUserTable;
  scim_group: ScimGroupTable;
  ldap_directory: LdapDirectoryTable;
  ldap_user: LdapUserTable;
  ldap_group: LdapGroupTable;
  ldap_sync_run: LdapSyncRunTable;
}
