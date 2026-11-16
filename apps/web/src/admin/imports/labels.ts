import type { MessageId } from '../../i18n/messages.en';
import type { RecordOutcome, RunStatus } from './client';

/** The kinds the importer loads (the server's `ENTITY_KINDS`), and the source's own notes. */
export const IMPORT_KINDS = [
  'user',
  'group',
  'team',
  'role',
  'status',
  'priority',
  'close_reason',
  'ticket_type',
  'link_type',
  'track',
  'release',
  'area',
  'field',
  'field_context',
  'field_option',
  'field_rule_set',
  'layout_set',
  'access_policy',
  'visibility_policy',
  'visibility_level',
  'notification_policy',
  'global_grant',
  'workflow',
  'workflow_map',
  'board',
  'ticket',
  'sprint',
  'comment',
  'link',
  'web_link',
  'time_entry',
  'attachment',
  'checklist',
  'history',
  'saved_search',
  'subscription',
  'dashboard',
  'source',
] as const;

export function kindLabel(kind: string): MessageId {
  return (IMPORT_KINDS as readonly string[]).includes(kind)
    ? (`admin.imports.kind.${kind}` as MessageId)
    : 'admin.imports.kind.other';
}

export const outcomeLabel = (outcome: RecordOutcome): MessageId =>
  `admin.imports.outcome.${outcome}` as MessageId;

export const statusLabel = (status: RunStatus): MessageId =>
  `admin.imports.status.${status}` as MessageId;

export const FORMATS = ['dc-backup', 'taskmoor', 'csv', 'cloud-rest', 'synthetic'] as const;

export const formatLabel = (format: string): MessageId =>
  (FORMATS as readonly string[]).includes(format)
    ? (`admin.imports.format.${format}` as MessageId)
    : 'admin.imports.format.other';

/** Warning codes the wizard explains in words; the manual's import page has the rest. */
export const EXPLAINED_WARNINGS = [
  'deleted_in_source',
  'edited_in_target',
  'person_unmapped',
  'no_email',
  'placeholder_email',
  'deleted_user',
  'type_not_offered',
  'missing_reference',
  'unmapped_reference',
  'unknown_priority',
  'history_changed',
  'history_field_not_imported',
  'query_not_translated',
  'query_flagged',
  'query_changed',
  'removed_character',
  'source_throttled',
  'source_failures_retried',
  'agile_api_unavailable',
  'site_admin_browses_every_track',
  'system_admin_as_configuration_admin',
  'link_type_created',
  'parent_wrong_level',
  'app_field_as_read_only_text',
  'comment_visibility_not_imported',
  'rich_text_as_plain_text',
  'merged_into',
  'name_taken',
  'former_key_taken',
  'ticket_in_another_open_sprint',
  // The CSV import read a file that is not UTF-8 as Windows-1252 (T-263).
  'read_as_windows_1252',
] as const;

export function warningExplanation(code: string): MessageId {
  return (EXPLAINED_WARNINGS as readonly string[]).includes(code)
    ? (`admin.imports.warning.${code}` as MessageId)
    : 'admin.imports.warning.other';
}
