/**
 * The permission catalogue (IAM-009, IAM-010; spec 05a sections 1.1 and 1.2). Grants store
 * these codes; the UI names them through its messages.
 */

/** Global permissions: granted to groups, users or everyone signed in (global_grant). */
export const GLOBAL_PERMISSIONS = [
  'site_admin',
  'configuration_admin',
  'browse_users',
  'share_saved_searches',
  'manage_group_subscriptions',
  'manage_onboarding',
  'bulk_change',
  'create_local_tracks',
  'connect_goals',
  'automation_admin',
  'ai_admin',
  'extension_admin',
] as const;
export type GlobalPermission = (typeof GLOBAL_PERMISSIONS)[number];

/** Track permissions: granted per access policy (access_grant), grouped as in section 1.2. */
export const TRACK_PERMISSION_GROUPS = {
  administration: ['administer_track', 'manage_layouts', 'edit_workflows'],
  track: [
    'browse_track',
    'manage_sprints',
    'service_agent',
    'view_aggregated_data',
    'view_dev_tools',
    'view_readonly_workflow',
  ],
  tickets: [
    'archive_tickets',
    'assignable_user',
    'assign_tickets',
    'close_tickets',
    'create_tickets',
    'delete_tickets',
    'edit_tickets',
    'link_tickets',
    'modify_requester',
    'move_tickets',
    'set_close_reason',
    'schedule_tickets',
    'set_visibility_level',
    'transition_tickets',
    'restore_archived',
    'send_in_email',
  ],
  followers: ['manage_followers', 'view_voters_followers'],
  comments: [
    'add_comments',
    'delete_all_comments',
    'delete_own_comments',
    'edit_all_comments',
    'edit_own_comments',
  ],
  attachments: ['create_attachments', 'delete_all_attachments', 'delete_own_attachments'],
  time: [
    'record_time',
    'edit_all_time_entries',
    'edit_own_time_entries',
    'delete_all_time_entries',
    'delete_own_time_entries',
  ],
} as const;

export type TrackPermission =
  (typeof TRACK_PERMISSION_GROUPS)[keyof typeof TRACK_PERMISSION_GROUPS][number];

export const TRACK_PERMISSIONS: readonly TrackPermission[] =
  Object.values(TRACK_PERMISSION_GROUPS).flat();

/** What a configuration administrator may do in every track: configuration, not content. */
export const CONFIGURATION_PERMISSIONS: readonly TrackPermission[] = [
  'administer_track',
  'manage_layouts',
  'edit_workflows',
  'view_readonly_workflow',
];

/**
 * What anyone may still do in an archived track (CORE-025): look, never change. Every other
 * permission, site administrators' included, waits until the track is restored.
 */
export const ARCHIVED_TRACK_PERMISSIONS: readonly TrackPermission[] = [
  'browse_track',
  'view_aggregated_data',
  'view_dev_tools',
  'view_readonly_workflow',
  'view_voters_followers',
];

export function isReadOnlyPermission(permission: TrackPermission): boolean {
  return ARCHIVED_TRACK_PERMISSIONS.includes(permission);
}

/** Grantees decided at track level; the others need the ticket (requester, assignee, fields). */
export const TRACK_LEVEL_GRANTEES = [
  'role',
  'group',
  'user',
  'track_owner',
  'any_user',
  'anyone',
] as const;
export const TICKET_LEVEL_GRANTEES = [
  'requester',
  'assignee',
  'user_field',
  'group_field',
] as const;
export type GranteeKind =
  | (typeof TRACK_LEVEL_GRANTEES)[number]
  | (typeof TICKET_LEVEL_GRANTEES)[number];

export function isTrackPermission(value: string): value is TrackPermission {
  return (TRACK_PERMISSIONS as readonly string[]).includes(value);
}

export function isGlobalPermission(value: string): value is GlobalPermission {
  return (GLOBAL_PERMISSIONS as readonly string[]).includes(value);
}
