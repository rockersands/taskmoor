import { CORE_LOADERS, type Loader } from './load';
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
import { fieldRuleSets, layoutSets } from './load-forms';
import type { Command, EntityKind } from './model';

/**
 * The loader of every entity kind (ADR-048; M1-098 added configuration and attachments, M1-089
 * field rule sets and layout sets).
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
  workflow: workflows,
  workflow_map: workflowMaps,
  attachment: attachments,
};
