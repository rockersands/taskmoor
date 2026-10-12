import type { QueryCase } from '../case';
import { DATE_CASES } from './dates';
import { FIELD_CASES } from './fields';
import { FILTER_CASES, SPRINT_CASES } from './filters';
import { FUNCTION_CASES } from './functions';
import { GRAMMAR_CASES } from './grammar';
import { HISTORY_CASES } from './history';
import { OPERATOR_CASES } from './operators';
import { ORDERING_CASES } from './ordering';
import { TEXT_CASES } from './text';

/** The whole suite, in spec order. */
export const QUERY_CASES: readonly QueryCase[] = [
  ...GRAMMAR_CASES,
  ...OPERATOR_CASES,
  ...FIELD_CASES,
  ...FUNCTION_CASES,
  ...HISTORY_CASES,
  ...DATE_CASES,
  ...TEXT_CASES,
  ...ORDERING_CASES,
  ...FILTER_CASES,
  ...SPRINT_CASES,
];
