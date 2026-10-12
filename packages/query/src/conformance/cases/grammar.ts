import type { QueryCase } from '../case';
import { section } from './fixtures';

const c = section('QRY-001', 'grammar', '01b 1.1');

/** Parses and prints back as `canonical`. */
const parse = (
  slug: string,
  title: string,
  text: string,
  canonical = text,
  verify?: string,
): QueryCase =>
  c(slug, { kind: 'parse', title, text, expect: { canonical }, ...(verify ? { verify } : {}) });

/** Refused with the error at offset `at` and a message containing `message`. */
const error = (
  slug: string,
  title: string,
  text: string,
  at: number,
  message?: string,
): QueryCase =>
  c(slug, { kind: 'parse-error', title, text, expect: { at, ...(message ? { message } : {}) } });

export const GRAMMAR_CASES: QueryCase[] = [
  // Clauses and precedence.
  parse('clause', 'A clause is field, operator, value', 'status = Done'),
  parse('and', 'AND joins clauses', 'status = Done AND priority = High'),
  parse('or', 'OR joins clauses', 'status = Done OR priority = High'),
  parse(
    'and-before-or',
    'AND binds tighter than OR',
    'status = Done OR priority = High AND assignee = currentUser()',
  ),
  parse(
    'and-before-or-left',
    'AND binds tighter than OR on the left too',
    'status = Done AND priority = High OR assignee = currentUser()',
  ),
  parse(
    'parens-override',
    'Parentheses override precedence',
    '(status = Done OR priority = High) AND assignee = currentUser()',
  ),
  parse(
    'redundant-parens-dropped',
    'Parentheses that change nothing are dropped',
    '(status = Done) AND (priority = High)',
    'status = Done AND priority = High',
  ),
  parse('not-before-and', 'NOT binds tighter than AND', 'NOT status = Done AND priority = High'),
  parse(
    'not-parens',
    'NOT over a group keeps its parentheses',
    'NOT (status = Done AND priority = High)',
  ),
  parse('not-not', 'NOT nests', 'NOT NOT status = Done'),
  parse(
    'three-levels',
    'Three levels of nesting; parentheses that precedence implies are dropped',
    'status = Done AND (priority = High OR (assignee = currentUser() AND reporter = currentUser()))',
    'status = Done AND (priority = High OR assignee = currentUser() AND reporter = currentUser())',
  ),
  parse(
    'same-operator-flattens',
    'A chain of the same operator is one list',
    'status = Done AND priority = High AND assignee = currentUser()',
  ),
  parse(
    'mixed-chain',
    'A mixed chain keeps the precedence shape',
    'status = Done OR priority = High OR assignee = currentUser() AND reporter = currentUser()',
  ),
  // Keywords and names are case-insensitive; the canonical form upper-cases keywords.
  parse(
    'keywords-lower',
    'Keywords in lower case',
    'status = Done and priority = High or assignee is empty',
    'status = Done AND priority = High OR assignee IS EMPTY',
  ),
  parse(
    'keywords-mixed',
    'Keywords in mixed case',
    'status = Done And priority = High Or assignee Is Empty',
    'status = Done AND priority = High OR assignee IS EMPTY',
  ),
  parse('not-lower', 'NOT in lower case', 'not status = Done', 'NOT status = Done'),
  parse('in-lower', 'IN in lower case', 'status in (Done, Closed)', 'status IN (Done, Closed)'),
  parse(
    'order-by-lower',
    'ORDER BY in lower case',
    'status = Done order by created desc',
    'status = Done ORDER BY created DESC',
  ),
  parse('field-case-kept', 'A field name keeps its case in print', 'Status = Done'),
  parse('field-upper', 'A field name in upper case', 'STATUS = Done'),
  // Quoting.
  parse('quoted-field', 'A field name with spaces is quoted', '"Story Points" <= 8'),
  parse(
    'single-quoted-field',
    'Single quotes work and print as double quotes',
    "'Story Points' <= 8",
    '"Story Points" <= 8',
  ),
  parse('quoted-value', 'A value with spaces is quoted', 'status = "In Progress"'),
  parse(
    'single-quoted-value',
    'A single-quoted value prints double-quoted',
    "status = 'In Progress'",
    'status = "In Progress"',
  ),
  parse('escaped-quote', 'An escaped quote inside a string', 'summary ~ "say \\"hi\\""'),
  parse('escaped-backslash', 'An escaped backslash inside a string', 'summary ~ "a\\\\b"'),
  parse('quoted-reserved-field', 'A reserved word can be a field name when quoted', '"order" = 1'),
  parse('quoted-keyword-value', 'A keyword can be a value when quoted', 'status = "and"'),
  parse('unquoted-simple-value', 'A simple value needs no quotes', 'status = Done'),
  parse('quoted-simple-value-kept', 'A quoted simple value stays quoted', 'status = "Done"'),
  // Custom field addressing.
  parse('cf-id', 'A custom field by id', 'cf[10016] = 8'),
  parse('cf-id-spaces', 'cf[ ] tolerates spaces', 'cf[ 10016 ] = 8', 'cf[10016] = 8'),
  parse('cf-id-order', 'A custom field by id in ORDER BY', 'ORDER BY cf[10016] DESC'),
  // EMPTY and NULL.
  parse('is-empty', 'IS EMPTY', 'assignee IS EMPTY'),
  parse('is-null', 'IS NULL prints as IS EMPTY', 'assignee IS NULL', 'assignee IS EMPTY'),
  parse('is-not-empty', 'IS NOT EMPTY', 'assignee IS NOT EMPTY'),
  parse(
    'is-not-null',
    'IS NOT NULL prints as IS NOT EMPTY',
    'assignee IS NOT NULL',
    'assignee IS NOT EMPTY',
  ),
  parse('eq-empty', '= EMPTY', 'assignee = EMPTY'),
  parse('ne-empty', '!= EMPTY', 'assignee != EMPTY'),
  parse('eq-null', '= NULL prints as = EMPTY', 'assignee = null', 'assignee = EMPTY'),
  parse('empty-lower', 'empty in lower case', 'assignee is empty', 'assignee IS EMPTY'),
  parse(
    'empty-or-clause',
    'The usual "or is empty" idiom',
    'assignee != currentUser() OR assignee IS EMPTY',
  ),
  // Lists.
  parse('in-list', 'IN with a list', 'status IN (Open, "In Progress")'),
  parse('in-one', 'IN with one value', 'status IN (Open)'),
  parse(
    'in-spacing',
    'Spacing inside a list is normalised',
    'status IN(Open,"In Progress" ,  Done)',
    'status IN (Open, "In Progress", Done)',
  ),
  parse('not-in-list', 'NOT IN with a list', 'status NOT IN (Open, Done)'),
  parse('in-function', 'IN with a function returning a list', 'sprint IN openSprints()'),
  parse('in-numbers', 'IN with numbers', 'id IN (1, 2, 3)'),
  parse('in-keys', 'IN with keys', 'key IN (ABC-1, ABC-2)'),
  parse('in-mixed', 'IN with mixed value kinds', 'assignee IN (currentUser(), "alice", EMPTY)'),
  // Values.
  parse('number', 'A whole number', 'votes > 3'),
  parse('decimal', 'A decimal number', '"Story Points" = 0.5'),
  parse('key-value', 'A work item key', 'key = ABC-12'),
  parse('date-word', 'A date as a bare word', 'created > 2026-01-31'),
  parse('duration-negative', 'A negative duration', 'created > -1w'),
  parse('duration-positive', 'A positive duration', 'due < +2d'),
  parse('duration-unsigned', 'An unsigned duration', 'due < 2d'),
  parse('function-no-args', 'A function without arguments', 'assignee = currentUser()'),
  parse('function-args', 'A function with arguments', 'created >= startOfDay(-1d)'),
  parse(
    'function-two-args',
    'A function with two arguments',
    'key IN linkedWorkItems(ABC-12, "blocks")',
  ),
  parse(
    'function-spacing',
    'Spacing inside a call is normalised',
    'created >= startOfDay( -1d )',
    'created >= startOfDay(-1d)',
  ),
  parse('value-dots', 'A value with dots', 'fixVersion = 1.2.3'),
  // Whole queries.
  parse('empty-query', 'An empty query', '', ''),
  parse('whitespace-only', 'Whitespace only is an empty query', '   ', ''),
  parse('order-only', 'ORDER BY without a where part', 'ORDER BY created DESC'),
  parse(
    'multi-line',
    'Line breaks are whitespace',
    'status = Done\n  AND priority = High\nORDER BY created DESC',
    'status = Done AND priority = High ORDER BY created DESC',
  ),
  parse('tabs', 'Tabs are whitespace', 'status\t=\tDone', 'status = Done'),
  parse(
    'history-forms',
    'History operators are part of the grammar',
    'status WAS "In Review" AND assignee CHANGED',
  ),
  // Errors with positions (0-based offsets) and hints.
  error('missing-value', 'A clause without a value', 'status = ', 9, 'Expected a value'),
  error(
    'missing-operator',
    'A field without an operator',
    'status Done',
    7,
    'Expected an operator',
  ),
  error('unclosed-paren', 'An unclosed parenthesis', '(status = Done', 14, 'Expected ")"'),
  error('stray-paren', 'A stray closing parenthesis', 'status = Done)', 13, 'Unexpected'),
  error(
    'reserved-field',
    'A reserved word as a field name',
    'and = 1',
    0,
    'cannot be used as a field name',
  ),
  error('empty-list', 'An empty list', 'status IN ()', 11, 'at least one value'),
  error('is-without-empty', 'IS without EMPTY or NULL', 'status IS', 9, 'Expected EMPTY or NULL'),
  error('is-value', 'IS with a value', 'status IS Done', 10, 'Expected EMPTY or NULL'),
  error(
    'not-without-in',
    'NOT after a field without IN',
    'status NOT Done',
    11,
    'Expected IN after NOT',
  ),
  error('order-without-by', 'ORDER without BY', 'ORDER status', 6, 'Expected BY after ORDER'),
  error(
    'order-by-nothing',
    'ORDER BY without a field',
    'status = Done ORDER BY',
    22,
    'Expected a field name',
  ),
  error('unclosed-string', 'An unclosed string', 'status = "unclosed', 9),
  error('trailing-junk', 'Text after a complete query', 'status = Done priority', 14, 'Unexpected'),
  error('operator-only', 'An operator without a field', '= Done', 0, 'Expected a field name'),
  error('keyword-value', 'A reserved word as a value', 'status = and', 9, 'Expected a value'),
  error('double-operator', 'Two operators', 'status = = Done', 9, 'Expected a value'),
  error(
    'missing-comma',
    'A list without commas',
    'status IN (Open Done)',
    16,
    'Expected "," or ")"',
  ),
  error(
    'cf-without-number',
    'cf[ ] without a number',
    'cf[] = 1',
    3,
    'Expected a custom field number',
  ),
  error('cf-unclosed', 'cf[ without ]', 'cf[10016 = 1', 9, 'Expected "]"'),
  error(
    'and-at-start',
    'AND at the start',
    'AND status = Done',
    0,
    'cannot be used as a field name',
  ),
  error('dangling-and', 'AND at the end', 'status = Done AND', 17, 'Expected a field name'),
  error('dangling-or', 'OR at the end', 'status = Done OR', 16, 'Expected a field name'),
  error('not-at-end', 'NOT at the end', 'status = Done AND NOT', 21, 'Expected a field name'),
  error(
    'function-unclosed',
    'A function call without a closing parenthesis',
    'assignee = currentUser(',
    23,
    'Expected',
  ),
];
