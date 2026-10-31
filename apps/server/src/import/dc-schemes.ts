import type { NotificationRecipient } from '@taskmoor/db';
import { CUSTOM_PREFIX } from '../notifications/model';
import type {
  StagedGlobalPermission,
  StagedGrantee,
  StagedNotificationScheme,
  StagedPermissionScheme,
  StagedSecurityLevel,
  StagedSecurityScheme,
} from './dc-backup/stage-schemes';
import type {
  AccessPolicyCommand,
  GrantTo,
  Mapped,
  NotificationPolicyCommand,
  Ref,
  Warning,
} from './model';

/**
 * The Data Center backup's access, visibility and notification configuration in Taskmoor's
 * terms (M1-092; IMP-004, IMP-005; ADR-090): permission schemes as access policies (identical
 * ones merged), issue security schemes as visibility policies with their levels, notification
 * schemes as notification policies, and global permissions as global grants. A permission, a
 * grantee or an event with no counterpart is left out with a warning naming it.
 */

const ref = (kind: Ref['kind'], id: string): Ref => ({ kind, id });

/** Project permissions (by key) to track permissions (`authz/permissions.ts`). */
export const PERMISSIONS: Readonly<Record<string, string>> = {
  ADMINISTER_PROJECTS: 'administer_track',
  BROWSE_PROJECTS: 'browse_track',
  MANAGE_SPRINTS_PERMISSION: 'manage_sprints',
  VIEW_DEV_TOOLS: 'view_dev_tools',
  VIEW_READONLY_WORKFLOW: 'view_readonly_workflow',
  ASSIGNABLE_USER: 'assignable_user',
  ASSIGN_ISSUES: 'assign_tickets',
  CLOSE_ISSUES: 'close_tickets',
  CREATE_ISSUES: 'create_tickets',
  DELETE_ISSUES: 'delete_tickets',
  EDIT_ISSUES: 'edit_tickets',
  LINK_ISSUES: 'link_tickets',
  MODIFY_REPORTER: 'modify_requester',
  MOVE_ISSUES: 'move_tickets',
  RESOLVE_ISSUES: 'set_close_reason',
  SCHEDULE_ISSUES: 'schedule_tickets',
  SET_ISSUE_SECURITY: 'set_visibility_level',
  TRANSITION_ISSUES: 'transition_tickets',
  MANAGE_WATCHERS: 'manage_followers',
  VIEW_VOTERS_AND_WATCHERS: 'view_voters_followers',
  ADD_COMMENTS: 'add_comments',
  DELETE_ALL_COMMENTS: 'delete_all_comments',
  DELETE_OWN_COMMENTS: 'delete_own_comments',
  EDIT_ALL_COMMENTS: 'edit_all_comments',
  EDIT_OWN_COMMENTS: 'edit_own_comments',
  CREATE_ATTACHMENTS: 'create_attachments',
  DELETE_ALL_ATTACHMENTS: 'delete_all_attachments',
  DELETE_OWN_ATTACHMENTS: 'delete_own_attachments',
  WORK_ON_ISSUES: 'record_time',
  EDIT_OWN_WORKLOGS: 'edit_own_time_entries',
  EDIT_ALL_WORKLOGS: 'edit_all_time_entries',
  DELETE_OWN_WORKLOGS: 'delete_own_time_entries',
  DELETE_ALL_WORKLOGS: 'delete_all_time_entries',
};

/** Global permissions to global ones; `USE` (application access) has no counterpart. */
const GLOBALS: Readonly<Record<string, string>> = {
  SYSTEM_ADMIN: 'site_admin',
  ADMINISTER: 'configuration_admin',
  USER_PICKER: 'browse_users',
  CREATE_SHARED_OBJECTS: 'share_saved_searches',
  MANAGE_GROUP_FILTER_SUBSCRIPTIONS: 'manage_group_subscriptions',
  BULK_CHANGE: 'bulk_change',
};

/** Who a grant or level member names, as a grantee; null with a warning when nothing fits. */
function grantTo(g: StagedGrantee, warnings: Warning[]): GrantTo | null {
  const none = { role: null, group: null, user: null, field: null };
  const missing = () => {
    warnings.push({ code: 'grantee_not_found', detail: `${g.type}:${g.parameter ?? ''}` });
    return null;
  };
  switch (g.type) {
    case 'group':
      if (g.parameter === null) return { grantee: 'anyone', ...none };
      return g.group === null
        ? missing()
        : { grantee: 'group', ...none, group: ref('group', g.group) };
    case 'user':
      return g.user === null ? missing() : { grantee: 'user', ...none, user: ref('user', g.user) };
    case 'projectrole':
      return g.role === null ? missing() : { grantee: 'role', ...none, role: ref('role', g.role) };
    case 'reporter':
      return { grantee: 'requester', ...none };
    case 'assignee':
      return { grantee: 'assignee', ...none };
    case 'lead':
      return { grantee: 'track_owner', ...none };
    case 'applicationRole':
      return { grantee: 'any_user', ...none };
    case 'userCF':
    case 'groupCF':
      return g.field === null
        ? missing()
        : {
            grantee: g.type === 'userCF' ? 'user_field' : 'group_field',
            ...none,
            field: ref('field', g.field),
          };
    default:
      warnings.push({ code: 'grantee_not_mapped', detail: g.type });
      return null;
  }
}

const unique = (warnings: Warning[]): Warning[] => {
  const seen = new Set<string>();
  return warnings.filter((w) => {
    const key = `${w.code}\u0000${w.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export function mapAccessPolicy(s: StagedPermissionScheme): Mapped {
  if (s.mergedInto) {
    // Identical to an earlier scheme: its tracks use that one (IMP-005 (1)).
    return {
      skip: 'merged_identical',
      warnings: [{ code: 'merged_into', detail: s.mergedInto.name }],
    };
  }
  const warnings: Warning[] = [];
  const grants: AccessPolicyCommand['grants'] = [];
  for (const g of s.grants) {
    const permission = PERMISSIONS[g.permission];
    if (!permission) {
      warnings.push({ code: 'permission_not_mapped', detail: g.permission });
      continue;
    }
    const to = grantTo(g.grantee, warnings);
    if (to) grants.push({ permission, to });
  }
  return {
    command: {
      kind: 'access_policy',
      name: s.name,
      description: s.description,
      grants,
      tracks: s.tracks.map((t) => ref('track', t)),
    },
    warnings: unique(warnings),
  };
}

export function mapVisibilityPolicy(s: StagedSecurityScheme): Mapped {
  return {
    command: {
      kind: 'visibility_policy',
      name: s.name,
      description: s.description,
      tracks: s.tracks.map((t) => ref('track', t)),
    },
  };
}

export function mapVisibilityLevel(l: StagedSecurityLevel): Mapped {
  const warnings: Warning[] = [];
  const members = l.members.flatMap((m) => {
    const to = grantTo(m, warnings);
    return to ? [to] : [];
  });
  return {
    command: {
      kind: 'visibility_level',
      policy: ref('visibility_policy', l.scheme),
      name: l.name,
      description: l.description,
      position: l.position,
      isDefault: l.isDefault,
      members,
    },
    warnings: unique(warnings),
  };
}

/**
 * A custom event's name as Taskmoor's transitions fire it and policies name it (M1-090): its
 * name in lower case with dashes, which a transition's event allows; a policy names it as
 * `custom:<name>` (`notifications/model.ts`).
 */
export function customEventName(name: string, id: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return slug === '' ? `event-${id}` : /^[a-z]/.test(slug) ? slug : `event-${slug}`;
}

/** Event type ids to notification events (`notifications/model.ts`). */
const EVENTS: Readonly<Record<number, string>> = {
  1: 'ticket_created',
  2: 'ticket_updated',
  3: 'ticket_assigned',
  4: 'ticket_close_reason_set',
  5: 'ticket_closed',
  6: 'ticket_commented',
  7: 'ticket_reopened',
  8: 'ticket_deleted',
  9: 'ticket_moved',
  10: 'time_entry_added',
  11: 'work_started',
  12: 'work_stopped',
  13: 'generic',
  15: 'time_entry_updated',
  16: 'time_entry_deleted',
};

/** Notification types to recipients; the ones with a parameter say what it names. */
const RECIPIENTS: Readonly<Record<string, NotificationRecipient>> = {
  Current_Assignee: 'assignee',
  Current_Reporter: 'requester',
  Current_User: 'current_user',
  Project_Lead: 'track_owner',
  Component_Lead: 'area_owner',
  All_Watchers: 'follower',
  Single_User: 'user',
  Group_Dropdown: 'group',
  Project_Role: 'role',
  User_Custom_Field_Value: 'user_field',
  Group_Custom_Field_Value: 'group_field',
};

export function mapNotificationPolicy(s: StagedNotificationScheme): Mapped {
  const warnings: Warning[] = [];
  const rules: NotificationPolicyCommand['rules'] = [];
  for (const n of s.notifications) {
    // A custom event a workflow fires keeps its name (M1-090).
    const event =
      n.event === null
        ? undefined
        : (EVENTS[n.event] ??
          (n.eventName === undefined
            ? undefined
            : `${CUSTOM_PREFIX}${customEventName(n.eventName, n.event)}`));
    if (!event) {
      warnings.push({
        code:
          n.event !== null && n.event >= 10_000 ? 'custom_event_not_imported' : 'event_not_mapped',
        detail: String(n.event ?? ''),
      });
      continue;
    }
    const recipient = RECIPIENTS[n.grantee.type] as NotificationRecipient | undefined;
    if (!recipient) {
      warnings.push({ code: 'recipient_not_mapped', detail: n.grantee.type });
      continue;
    }
    const g = n.grantee;
    const needs =
      recipient === 'user'
        ? g.user
        : recipient === 'group'
          ? g.group
          : recipient === 'role'
            ? g.role
            : recipient === 'user_field' || recipient === 'group_field'
              ? g.field
              : '';
    if (needs === null) {
      warnings.push({ code: 'grantee_not_found', detail: `${g.type}:${g.parameter ?? ''}` });
      continue;
    }
    rules.push({
      event,
      recipient,
      user: recipient === 'user' && g.user ? ref('user', g.user) : null,
      group: recipient === 'group' && g.group ? ref('group', g.group) : null,
      role: recipient === 'role' && g.role ? ref('role', g.role) : null,
      field:
        (recipient === 'user_field' || recipient === 'group_field') && g.field
          ? ref('field', g.field)
          : null,
    });
  }
  return {
    command: {
      kind: 'notification_policy',
      name: s.name,
      description: s.description,
      rules,
      tracks: s.tracks.map((t) => ref('track', t)),
    },
    warnings: unique(warnings),
  };
}

export function mapGlobalGrant(g: StagedGlobalPermission): Mapped {
  const permission = GLOBALS[g.permission];
  if (!permission) {
    return {
      skip: g.permission === 'USE' ? 'not_needed' : 'permission_not_mapped',
      warnings:
        g.permission === 'USE' ? [] : [{ code: 'permission_not_mapped', detail: g.permission }],
    };
  }
  if (g.groupName === null) {
    // Everyone, signed in or not: Taskmoor gives global permissions to people only.
    return {
      command: { kind: 'global_grant', permission, group: null },
      warnings: [{ code: 'anyone_as_any_user', detail: g.permission }],
    };
  }
  if (g.group === null) return { fail: 'missing_reference:group' };
  const warnings: Warning[] =
    permission === 'site_admin' ? [{ code: 'site_admin_browses_every_track' }] : [];
  return { command: { kind: 'global_grant', permission, group: ref('group', g.group) }, warnings };
}
