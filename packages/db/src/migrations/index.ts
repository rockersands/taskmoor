import type { TaskmoorMigration } from '../migration';
import * as m0001 from './0001_foundation';
import * as m0002 from './0002_users_and_sessions';
import * as m0003 from './0003_identity';
import * as m0004 from './0004_authorization';
import * as m0005 from './0005_events';
import * as m0006 from './0006_audit';
import * as m0007 from './0007_tokens';
import * as m0008 from './0008_tracks';
import * as m0009 from './0009_two_factor';
import * as m0010 from './0010_identity_providers';
import * as m0011 from './0011_ticket_types';
import * as m0012 from './0012_scim';
import * as m0013 from './0013_appearance';
import * as m0014 from './0014_tickets';
import * as m0015 from './0015_ticket_history';
import * as m0018 from './0018_ticket_fields';
import * as m0019 from './0019_links';
import * as m0020 from './0020_saml';
import * as m0021 from './0021_ldap';
import * as m0022 from './0022_trash_backups';
import * as m0023 from './0023_time_tracking';
import * as m0024 from './0024_workflows';
import * as m0025 from './0025_transition_history';
import * as m0026 from './0026_custom_fields';
import * as m0027 from './0027_field_values';
import * as m0028 from './0028_field_rules_layouts';
import * as m0029 from './0029_visibility_levels';
import * as m0030 from './0030_notifications';
import * as m0031 from './0031_attachments';
import * as m0032 from './0032_email';
import * as m0033 from './0033_formula_fields';
import * as m0034 from './0034_rich_text';
import * as m0036 from './0036_change_log';
import * as m0037 from './0037_mutation_receipts';
import * as m0038 from './0038_field_edit_permissions';
import * as m0040 from './0040_bulk_operations';
import * as m0041 from './0041_comments';
import * as m0042 from './0042_workflow_maps';
import * as m0043 from './0043_search_indexes';
import * as m0044 from './0044_inbox';
import * as m0045 from './0045_imports';
import * as m0046 from './0046_ticket_visits';
import * as m0047 from './0047_boards';
import * as m0050 from './0050_guardrails';
import * as m0051 from './0051_saved_searches';
import * as m0052 from './0052_sprints';
import * as m0053 from './0053_webhooks';
import * as m0054 from './0054_dashboards';
import * as m0055 from './0055_contract_m0_session';
import * as m0056 from './0056_history_search';
import * as m0057 from './0057_full_text_search';
import * as m0058 from './0058_info_fields';
import * as m0059 from './0059_rate_limits';
import * as m0060 from './0060_teams';
import * as m0061 from './0061_clone';
import * as m0062 from './0062_allowlists_syslog';
import * as m0063 from './0063_board_workflow';
import * as m0064 from './0064_oauth';
import * as m0065 from './0065_import_labels';
import * as m0066 from './0066_entity_properties';
import * as m0067 from './0067_oauth_clients';
import * as m0068 from './0068_frontend_origins';
import * as m0071 from './0071_import_staged';
import * as m0073 from './0073_saved_search_import_problem';

/**
 * Every migration, in order. Migrations are forward-only: never edit or remove one that has
 * shipped; add a new one instead (expand, migrate data, then contract in a later release).
 * A test fails if a file in this folder is missing from the list. Ordinary migrations of one
 * upgrade run together in one transaction; a module that exports `online = true` runs alone
 * outside a transaction (an index built CONCURRENTLY, ADR-022).
 */
export const migrations: Record<string, TaskmoorMigration> = {
  '0001_foundation': m0001,
  '0002_users_and_sessions': m0002,
  '0003_identity': m0003,
  '0004_authorization': m0004,
  '0005_events': m0005,
  '0006_audit': m0006,
  '0007_tokens': m0007,
  '0008_tracks': m0008,
  '0009_two_factor': m0009,
  '0010_identity_providers': m0010,
  '0011_ticket_types': m0011,
  '0012_scim': m0012,
  '0013_appearance': m0013,
  '0014_tickets': m0014,
  '0015_ticket_history': m0015,
  '0018_ticket_fields': m0018,
  '0019_links': m0019,
  '0020_saml': m0020,
  '0021_ldap': m0021,
  '0022_trash_backups': m0022,
  '0023_time_tracking': m0023,
  '0024_workflows': m0024,
  '0025_transition_history': m0025,
  '0026_custom_fields': m0026,
  '0027_field_values': m0027,
  '0028_field_rules_layouts': m0028,
  '0029_visibility_levels': m0029,
  '0030_notifications': m0030,
  '0031_attachments': m0031,
  '0032_email': m0032,
  '0033_formula_fields': m0033,
  '0034_rich_text': m0034,
  '0036_change_log': m0036,
  '0037_mutation_receipts': m0037,
  '0038_field_edit_permissions': m0038,
  '0040_bulk_operations': m0040,
  '0041_comments': m0041,
  '0042_workflow_maps': m0042,
  '0043_search_indexes': m0043,
  '0044_inbox': m0044,
  '0045_imports': m0045,
  '0046_ticket_visits': m0046,
  '0047_boards': m0047,
  '0050_guardrails': m0050,
  '0051_saved_searches': m0051,
  '0052_sprints': m0052,
  '0053_webhooks': m0053,
  '0054_dashboards': m0054,
  '0055_contract_m0_session': m0055,
  '0056_history_search': m0056,
  '0057_full_text_search': m0057,
  '0058_info_fields': m0058,
  '0059_rate_limits': m0059,
  '0060_teams': m0060,
  '0061_clone': m0061,
  '0062_allowlists_syslog': m0062,
  '0063_board_workflow': m0063,
  '0064_oauth': m0064,
  '0065_import_labels': m0065,
  '0066_entity_properties': m0066,
  '0067_oauth_clients': m0067,
  '0068_frontend_origins': m0068,
  '0071_import_staged': m0071,
  '0073_saved_search_import_problem': m0073,
};
