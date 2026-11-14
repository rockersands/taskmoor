import type { Translate } from '../../i18n/I18nProvider';
import type { MessageId } from '../../i18n/messages.en';

/** The subjects and verbs of audit actions that have words in the catalogue (AD-2). */
export const AUDIT_SUBJECTS = [
  'access',
  'access_grant',
  'access_policy',
  'ai',
  'ai_limit',
  'ai_notice',
  'ai_policy',
  'ai_price',
  'ai_run',
  'api_token',
  'area',
  'backup',
  'comment',
  'attachment',
  'attachment_settings',
  'audit',
  'backup_schedule',
  'board',
  'bulk_operation',
  'close_reason',
  'cross_track_release',
  'dashboard',
  'directory',
  'email_settings',
  'field',
  'field_context',
  'field_option',
  'field_rule_set',
  'frontend_origin',
  'global_grant',
  'group',
  'guardrail',
  'hierarchy_level',
  'identity_provider',
  'import_file',
  'import_run',
  'ip_allowlist',
  'label',
  'layout_set',
  'link_policy',
  'link_type',
  'mcp',
  'notification_policy',
  'oauth_client',
  'password_link',
  'personal_data',
  'plan',
  'priority',
  'priority_set',
  'property_index',
  'rate_limits',
  'release',
  'role',
  'saved_search',
  'scim',
  'security',
  'security_alerts',
  'service_account',
  'session',
  'session_policy',
  'setup',
  'sprint',
  'sso',
  'status',
  'team',
  'ticket',
  'ticket_template',
  'ticket_type',
  'time_tracking',
  'token',
  'token_policy',
  'track',
  'track_category',
  'track_group',
  'track_invitation',
  'track_role',
  'trash_policy',
  'two_factor_policy',
  'type_set',
  'update_check',
  'user',
  'visibility_level',
  'visibility_policy',
  'webhook',
  'workflow',
  'workflow_map',
  'workspace',
] as const;

export const AUDIT_VERBS = [
  'accepted',
  'acknowledged',
  'actor_added',
  'actor_removed',
  'added',
  'alert_raised',
  'approval_decided',
  'approvers_set',
  'archived',
  'bulk_revoked',
  'cancelled',
  'capacity_set',
  'changed',
  'completed',
  'consent',
  'copied',
  'created',
  'credential_deleted',
  'credential_set',
  'deactivated',
  'default_set',
  'deleted',
  'delivery_replayed',
  'draft_discarded',
  'draft_saved',
  'drafts_committed',
  'drafts_discarded',
  'drafts_set',
  'duplicated',
  'ended',
  'erased',
  'export_requested',
  'exported',
  'finished',
  'group_created',
  'group_deleted',
  'group_updated',
  'imported',
  'left',
  'locked_out',
  'member_added',
  'member_removed',
  'merged',
  'moved',
  'nested',
  'partition_dropped',
  'password_changed',
  'password_check_failed',
  'password_link_created',
  'program_board_created',
  'program_board_deleted',
  'program_board_updated',
  'published',
  'purged',
  'quarantined',
  'reactivated',
  'recorded',
  'recovery_codes_regenerated',
  'refused_repeatedly',
  'registered',
  'rejected',
  'removed',
  'reordered',
  'resent',
  'reset',
  'restored',
  'revoked',
  'rotated',
  'scenario_created',
  'scenario_deleted',
  'scenario_promoted',
  'scenario_updated',
  'schedule_ran',
  'settings_updated',
  'shared',
  'shipped',
  'sign_in_failed',
  'sign_in_refused',
  'signed_in',
  'started',
  'subscribed',
  'summary_layout_removed',
  'summary_layout_set',
  'sync_requested',
  'synced',
  'syslog_test',
  'syslog_updated',
  'threshold_reached',
  'tool_called',
  'track_moved',
  'track_switched',
  'two_factor_disabled',
  'two_factor_enabled',
  'two_factor_reset',
  'undeleted',
  'unnested',
  'unshared',
  'unshipped',
  'unsubscribed',
  'updated',
  'uploaded',
  'user_created',
  'user_removed',
  'user_updated',
] as const;

const SUBJECTS: ReadonlySet<string> = new Set(AUDIT_SUBJECTS);
const VERBS: ReadonlySet<string> = new Set(AUDIT_VERBS);

/** A subject's name in words ("Ticket template" for `ticket_template`); null when unknown. */
export function auditSubjectWords(t: Translate, type: string): string | null {
  return SUBJECTS.has(type) ? t(`admin.audit.subject.${type}` as MessageId) : null;
}

/**
 * Verbs that name what they act on, so their words stand without the subject: 'Password changed'
 * rather than 'Person password changed' (S3-AD-4), 'Sign-in locked after failed attempts' rather
 * than a session's.
 */
const OWN_OBJECT_VERBS: ReadonlySet<string> = new Set([
  'locked_out',
  'partition_dropped',
  'password_changed',
  'password_check_failed',
  'password_link_created',
  'recovery_codes_regenerated',
  'sign_in_refused',
  'two_factor_disabled',
  'two_factor_enabled',
  'two_factor_reset',
]);

/** The names the server gives a role that was given or taken, and to whom (S3-AD-4). */
export interface AuditAbout {
  role?: string;
  person?: string;
  group?: string;
}

const ROLE_MOVES: Partial<Record<string, MessageId>> = {
  'track_role.actor_added': 'admin.audit.roleGiven',
  'track_role.actor_removed': 'admin.audit.roleTaken',
};

const capitalised = (words: string) => words.charAt(0).toLocaleUpperCase() + words.slice(1);

/**
 * An action code in plain words, "Ticket template created" for `ticket_template.created` (D19),
 * and 'Track role “Reviewers” given to Ada' when the server names the role and the person
 * (S3-AD-4). A code the catalogue does not know yet shows as it is; `words.test.ts` holds every
 * code the server writes to having words.
 */
export function auditActionWords(t: Translate, action: string, about?: AuditAbout): string {
  const dot = action.indexOf('.');
  const subject = auditSubjectWords(t, action.slice(0, dot));
  const verb = action.slice(dot + 1);
  if (dot < 0 || subject === null || !VERBS.has(verb)) return t('common.value', { value: action });
  const move = ROLE_MOVES[action];
  if (move && about?.role !== undefined) {
    const kind =
      about.person !== undefined ? 'person' : about.group !== undefined ? 'group' : 'none';
    return t(move, { role: about.role, kind, who: about.person ?? about.group ?? '' });
  }
  const words = t(`admin.audit.verb.${verb}` as MessageId);
  if (OWN_OBJECT_VERBS.has(verb)) return capitalised(words);
  return t('admin.audit.actionWords', { subject, verb: words });
}

/**
 * What a record is about: 'Track “Shop”' by its name when the server gives one (AD-2), 'Track 4'
 * by its id otherwise, or the bare type and id when the type has no words.
 */
export function auditSubjectText(
  t: Translate,
  subject: { type: string; id: string | null; name?: string },
) {
  const words = auditSubjectWords(t, subject.type);
  const shown = subject.name ?? subject.id;
  if (words === null) {
    return t('common.value', { value: shown ? `${subject.type} ${shown}` : subject.type });
  }
  if (subject.name !== undefined) {
    return t('admin.audit.subjectNamed', { subject: words, name: subject.name });
  }
  return subject.id ? t('admin.audit.subjectId', { subject: words, id: subject.id }) : words;
}
