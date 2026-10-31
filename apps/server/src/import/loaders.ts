import { CORE_LOADERS, type Loader } from './load';
import {
  accessPolicies,
  globalGrants,
  notificationPolicies,
  visibilityLevels,
  visibilityPolicies,
} from './load-access';
import { boards, sprints } from './load-agile';
import {
  areas,
  closeReasons,
  fieldContexts,
  fieldOptions,
  fields,
  linkTypes,
  priorities,
  releases,
  roles,
  workflowMaps,
  workflows,
} from './load-config';
import { attachments } from './load-files';
import { dashboards, savedSearches, subscriptions } from './load-filters';
import { fieldRuleSets, layoutSets } from './load-forms';
import { webLinks } from './load-weblinks';
import type { Command, EntityKind } from './model';

/**
 * The loader of every entity kind (ADR-048; M1-098 added configuration and attachments, M1-089
 * field rule sets and layout sets,
 * M1-091 web links, M1-092 access, visibility and notification policies and global grants,
 * M1-095 boards and sprints, M1-094 saved searches, subscriptions and dashboards).
 */
export const LOADERS: { [K in EntityKind]: Loader<Extract<Command, { kind: K }>> } = {
  ...CORE_LOADERS,
  role: roles,
  priority: priorities,
  close_reason: closeReasons,
  link_type: linkTypes,
  release: releases,
  area: areas,
  field: fields,
  field_context: fieldContexts,
  field_option: fieldOptions,
  field_rule_set: fieldRuleSets,
  layout_set: layoutSets,
  access_policy: accessPolicies,
  visibility_policy: visibilityPolicies,
  visibility_level: visibilityLevels,
  notification_policy: notificationPolicies,
  global_grant: globalGrants,
  workflow: workflows,
  workflow_map: workflowMaps,
  attachment: attachments,
  web_link: webLinks,
  board: boards,
  sprint: sprints,
  saved_search: savedSearches,
  subscription: subscriptions,
  dashboard: dashboards,
};
