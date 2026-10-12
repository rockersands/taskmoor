import type { ConformanceCase } from '../case';
import { BOARD_CASES } from './board';
import { CHECK_CASES } from './checks';
import { CLOSE_REASON_CASES } from './close-reason';
import { EDITOR_CASES } from './editor';
import { EFFECT_CASES } from './effects';
import { GUARD_CASES } from './guards';
import { IMPORT_EXPORT_CASES } from './import-export';
import { LAYOUT_CASES } from './layouts';
import { LINT_CASES } from './lint';
import { MODEL_CASES } from './model';
import { RULE_CASES } from './rules';
import { STATUS_PERMISSION_CASES } from './status-permissions';

/** The whole suite, in spec order. */
export const WORKFLOW_CASES: readonly ConformanceCase[] = [
  ...MODEL_CASES,
  ...EDITOR_CASES,
  ...GUARD_CASES,
  ...CHECK_CASES,
  ...EFFECT_CASES,
  ...LAYOUT_CASES,
  ...STATUS_PERMISSION_CASES,
  ...CLOSE_REASON_CASES,
  ...RULE_CASES,
  ...BOARD_CASES,
  ...IMPORT_EXPORT_CASES,
  ...LINT_CASES,
];
