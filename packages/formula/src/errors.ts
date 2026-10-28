/**
 * Why a formula is refused, and where (CORE-011 (3)): every refusal names the span of the text
 * at fault as offsets into the formula (UTF-16 code units, as JavaScript indexes strings), with
 * the line and column of its start (both from 1).
 */
export type FormulaErrorCode =
  /** Longer than `LIMITS.length` characters. */
  | 'too_long'
  /** Nested deeper than `LIMITS.depth`. */
  | 'too_deep'
  /** More than `LIMITS.nodes` parts. */
  | 'too_complex'
  | 'empty'
  | 'unexpected_character'
  | 'unexpected_token'
  | 'unexpected_end'
  | 'unterminated_string'
  | 'unterminated_field'
  | 'empty_field'
  | 'invalid_number'
  /** A bare word that is neither a keyword nor a function call. */
  | 'unknown_name'
  | 'unknown_function'
  | 'arity'
  | 'unknown_field'
  | 'ambiguous_field'
  | 'unsupported_field'
  | 'type_mismatch'
  /** `children` or `children.{x}` outside a roll-up function. */
  | 'children_misplaced'
  /** The formula's type does not fit the output chosen for the field. */
  | 'output_mismatch'
  /** Formula fields that need each other's values on the same ticket. */
  | 'cycle';

export interface Location {
  line: number;
  column: number;
}

/** Line and column (from 1) of an offset into a text. */
export function locate(text: string, offset: number): Location {
  let line = 1;
  let column = 1;
  const end = Math.min(Math.max(0, offset), text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

export class FormulaError extends Error {
  override readonly name = 'FormulaError';
  readonly line: number;
  readonly column: number;

  constructor(
    readonly code: FormulaErrorCode,
    message: string,
    readonly start: number,
    readonly end: number,
    text: string,
  ) {
    super(message);
    const at = locate(text, start);
    this.line = at.line;
    this.column = at.column;
  }

  /** The refusal as the API answers it. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      start: this.start,
      end: this.end,
      line: this.line,
      column: this.column,
    };
  }
}
