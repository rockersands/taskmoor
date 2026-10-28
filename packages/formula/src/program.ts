/**
 * What the type checker hands the evaluator: a tree of operations whose types are settled, so
 * evaluation never looks a type up. At run time dates are day numbers (days since 1970-01-01),
 * durations are seconds and text is a string; empty is null.
 */
export type BaseType = 'number' | 'text' | 'date' | 'duration' | 'boolean';
/** `empty` is the type of `null`, which fits wherever a value does. */
export type ValueType = BaseType | 'empty';
/** What a formula field can show (spec 01a section 1.4). */
export const OUTPUT_TYPES = [
  'number',
  'currency',
  'percentage',
  'date',
  'duration',
  'text',
] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];

/** The value type an output takes: numbers for number, currency and percentage. */
export function outputValueType(output: OutputType): Exclude<BaseType, 'boolean'> {
  switch (output) {
    case 'number':
    case 'currency':
    case 'percentage':
      return 'number';
    default:
      return output;
  }
}

export type Scalar = number | string | boolean | null;

/** The operations of a checked formula. */
export type Op =
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'pow'
  | 'neg'
  | 'pos'
  | 'not'
  | 'and'
  | 'or'
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'join'
  | 'if'
  | 'isempty'
  | 'ifempty'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'count'
  | 'abs'
  | 'round'
  | 'floor'
  | 'ceil'
  | 'mod'
  | 'sqrt'
  | 'today'
  | 'date'
  | 'daysbetween'
  | 'workingdaysbetween'
  | 'workingdaysuntil'
  | 'adddays'
  | 'year'
  | 'month'
  | 'day'
  | 'weekday'
  | 'hours'
  | 'minutes'
  | 'text'
  | 'upper'
  | 'lower'
  | 'len';

export type Ir =
  | { k: 'lit'; v: Scalar }
  /** A field of the ticket, by the id the resolver gave it. */
  | { k: 'ref'; id: string }
  /** A field's values on the child tickets. */
  | { k: 'list'; id: string }
  /** The child tickets themselves (counted only). */
  | { k: 'kids' }
  /** An operation; `t` holds each argument's type, for comparisons and text. */
  | { k: 'op'; op: Op; a: Ir[]; t: ValueType[] };

/** A field reference and where it is written. */
export interface RefUse {
  id: string;
  start: number;
  end: number;
}

export interface Program {
  /** The formula as written. */
  source: string;
  ir: Ir;
  type: ValueType;
  /** Fields of the ticket itself the formula reads, in order of appearance. */
  refs: RefUse[];
  /** Fields it reads on the child tickets. */
  childRefs: RefUse[];
  /** Whether it reads the child tickets at all (a roll-up). */
  readsChildren: boolean;
  /** Whether its value moves with the date (`today()`, `workingDaysUntil`). */
  volatile: boolean;
  /** Whether it counts working days (the workspace's working week). */
  workingWeek: boolean;
}
