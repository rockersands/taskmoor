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
}

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

/** Someone following, or voting for, a ticket. */
export interface TicketPersonTable {
  workspace_id: number;
  ticket_id: number;
  user_id: number;
  created_at: DefaultTimestamp;
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
  | 'formula';
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
  action: 'edit' | 'move' | 'transition' | 'delete';
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
}

export type ImportRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type ImportOutcome = 'created' | 'updated' | 'unchanged' | 'linked' | 'failed' | 'skipped';

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

export interface TwoFactorPolicyGroupTable {
  workspace_id: number;
  group_id: number;
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
  ticket_follower: TicketPersonTable;
  ticket_vote: TicketPersonTable;
  user_preference: UserPreferenceTable;
  time_tracking_setting: TimeTrackingSettingTable;
  time_entry: TimeEntryTable;
  ticket_comment: TicketCommentTable;
  ticket_comment_version: TicketCommentVersionTable;
  ticket_comment_reaction: TicketCommentReactionTable;
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
  global_grant: GlobalGrantTable;
  authz_epoch: AuthzEpochTable;
  domain_event: DomainEventTable;
  job: JobTable;
  bulk_operation: BulkOperationTable;
  bulk_item: BulkItemTable;
  import_run: ImportRunTable;
  import_record: ImportRecordTable;
  import_external_id: ImportExternalIdTable;
  workflow_map: WorkflowMapTable;
  workflow_map_entry: WorkflowMapEntryTable;
  workflow_migration: WorkflowMigrationTable;
  workflow_migration_step: WorkflowMigrationStepTable;
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
  saml_login: SamlLoginTable;
  saml_assertion: SamlAssertionTable;
  audit_event: AuditEventTable;
  audit_chain: AuditChainTable;
  api_token: ApiTokenTable;
  token_policy: TokenPolicyTable;
  scim_user: ScimUserTable;
  scim_group: ScimGroupTable;
  ldap_directory: LdapDirectoryTable;
  ldap_user: LdapUserTable;
  ldap_group: LdapGroupTable;
  ldap_sync_run: LdapSyncRunTable;
  session: SessionTable;
}
