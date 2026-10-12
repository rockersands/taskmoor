import type { ConformanceCase } from '../case';
import { BOARD_CASES } from './board';
import { CONDITION_CASES } from './conditions';
import { EDITOR_CASES } from './editor';
import { IMPORT_EXPORT_CASES } from './import-export';
import { LAYOUT_CASES } from './layouts';
import { LINT_CASES } from './lint';
import { MODEL_CASES } from './model';
import { POST_FUNCTION_CASES } from './post-functions';
import { RESOLUTION_CASES } from './resolution';
import { RULE_CASES } from './rules';
import { STATUS_PERMISSION_CASES } from './status-permissions';
import { VALIDATOR_CASES } from './validators';

/** The whole suite, in spec order. */
export const WORKFLOW_CASES: readonly ConformanceCase[] = [
  ...MODEL_CASES,
  ...EDITOR_CASES,
  ...CONDITION_CASES,
  ...VALIDATOR_CASES,
  ...POST_FUNCTION_CASES,
  ...LAYOUT_CASES,
  ...STATUS_PERMISSION_CASES,
  ...RESOLUTION_CASES,
  ...RULE_CASES,
  ...BOARD_CASES,
  ...IMPORT_EXPORT_CASES,
  ...LINT_CASES,
];
