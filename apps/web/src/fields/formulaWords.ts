import { type FormulaErrorCode, FUNCTIONS } from '@taskmoor/formula';
import type { MessageId } from '../i18n/messages.en';
import type { Field, FormulaProblem } from './client';

/**
 * A formula's refusal in the reader's language (CORE-011 (3); NFR-006): every code the formula
 * language gives (`packages/formula/src/errors.ts`) has its own words, never the server's English.
 * Words that name a part of the formula show that part as it was typed (`{text}`).
 */
export const FORMULA_PROBLEMS: Readonly<Record<FormulaErrorCode, MessageId>> = {
  too_long: 'admin.fields.formula.problem.too_long',
  too_deep: 'admin.fields.formula.problem.too_deep',
  too_complex: 'admin.fields.formula.problem.too_complex',
  empty: 'admin.fields.formula.problem.empty',
  unexpected_character: 'admin.fields.formula.problem.unexpected_character',
  unexpected_token: 'admin.fields.formula.problem.unexpected_token',
  unexpected_end: 'admin.fields.formula.problem.unexpected_end',
  unterminated_string: 'admin.fields.formula.problem.unterminated_string',
  unterminated_field: 'admin.fields.formula.problem.unterminated_field',
  empty_field: 'admin.fields.formula.problem.empty_field',
  invalid_number: 'admin.fields.formula.problem.invalid_number',
  unknown_name: 'admin.fields.formula.problem.unknown_name',
  unknown_function: 'admin.fields.formula.problem.unknown_function',
  arity: 'admin.fields.formula.problem.arity',
  unknown_field: 'admin.fields.formula.problem.unknown_field',
  ambiguous_field: 'admin.fields.formula.problem.ambiguous_field',
  unsupported_field: 'admin.fields.formula.problem.unsupported_field',
  type_mismatch: 'admin.fields.formula.problem.type_mismatch',
  children_misplaced: 'admin.fields.formula.problem.children_misplaced',
  output_mismatch: 'admin.fields.formula.problem.output_mismatch',
  cycle: 'admin.fields.formula.problem.cycle',
};

/** The codes whose words show the part at fault; the rest speak of the formula as a whole. */
const NAMES_A_PART: ReadonlySet<string> = new Set([
  'unexpected_character',
  'unexpected_token',
  'invalid_number',
  'unknown_name',
  'unknown_function',
  'arity',
  'unknown_field',
  'ambiguous_field',
  'unsupported_field',
  'type_mismatch',
  'children_misplaced',
  'cycle',
]);

type Translate = (id: MessageId, values?: Record<string, string | number>) => string;

/** "Line 1, column 5: No field is called {Pionts}." for a refusal of `expression`. */
export function formulaProblemText(
  t: Translate,
  problem: FormulaProblem,
  expression: string,
): string {
  const known = Object.hasOwn(FORMULA_PROBLEMS, problem.code);
  const text = expression.slice(problem.start, problem.end).trim();
  const id: MessageId = !known
    ? 'admin.fields.formula.problem.other'
    : NAMES_A_PART.has(problem.code) && text === ''
      ? 'admin.fields.formula.problem.other'
      : FORMULA_PROBLEMS[problem.code as FormulaErrorCode];
  return t('admin.fields.formula.at', {
    line: problem.line,
    column: problem.column,
    problem: t(id, { text }),
  });
}

/** The words for what a formula gives: a number, a date, a duration or text. */
export const FORMULA_GIVES: Readonly<Record<string, MessageId>> = {
  number: 'admin.fields.formula.gives.number',
  date: 'admin.fields.formula.gives.date',
  duration: 'admin.fields.formula.gives.duration',
  text: 'admin.fields.formula.gives.text',
  boolean: 'admin.fields.formula.gives.boolean',
};

/**
 * The built-in fields a formula reads, as the formula language names them (`fields/formulas.ts`
 * on the server): written in braces in every language, so they are the language's words, not the
 * page's.
 */
export const FORMULA_SYSTEM_FIELDS: readonly { id: string; name: string }[] = [
  { id: 'summary', name: 'Summary' },
  { id: 'dueDate', name: 'Due date' },
  { id: 'startDate', name: 'Start date' },
  { id: 'created', name: 'Created' },
  { id: 'updated', name: 'Updated' },
  { id: 'closed', name: 'Closed' },
  { id: 'originalEstimate', name: 'Original estimate' },
  { id: 'remainingEstimate', name: 'Remaining estimate' },
  { id: 'timeSpent', name: 'Time spent' },
];

/** The functions a formula calls, as the documentation writes them. */
export const FORMULA_FUNCTIONS: readonly string[] = Object.values(FUNCTIONS);

/** Custom field types a formula reads (`readableType` on the server). */
const READABLE = new Set([
  'number',
  'date',
  'datetime',
  'text',
  'read-only-text',
  'url',
  'formula',
]);

/**
 * The custom fields a formula of `trackId`'s (null: shared) may read: shared fields, and a
 * local track's own for its own formulas, of the types formulas read. `self` is left out.
 */
export function readableFields(
  fields: readonly Field[],
  trackId: number | null,
  self?: number,
): Field[] {
  return fields.filter(
    (f) => f.id !== self && READABLE.has(f.type) && (f.trackId === null || f.trackId === trackId),
  );
}

/** The name in braces a field the check says a formula reads goes by (`cf[12]` or `dueDate`). */
export function readName(ref: string, fields: readonly Field[]): string {
  const system = FORMULA_SYSTEM_FIELDS.find((s) => s.id === ref);
  if (system) return `{${system.name}}`;
  const id = /^cf\[(\d+)\]$/.exec(ref)?.[1];
  const field = id === undefined ? undefined : fields.find((f) => f.id === Number(id));
  return `{${field?.name ?? ref}}`;
}
