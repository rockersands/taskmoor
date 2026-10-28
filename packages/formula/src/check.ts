import type { Node } from './ast';
import { FormulaError, type FormulaErrorCode } from './errors';
import { parseFormula } from './parser';
import {
  type BaseType,
  type Ir,
  type Op,
  type OutputType,
  outputValueType,
  type Program,
  type RefUse,
  type ValueType,
} from './program';

/**
 * Type checking (M1-013; CORE-011): every field reference is resolved by the caller, every
 * operator and function checked against the types it is given, and the result compiled to the
 * tree the evaluator runs. A formula is refused at the first mistake, with its place.
 *
 * Types: number, text, date (a day), duration (seconds), true/false, and empty (`null`), which
 * fits anywhere. Dates and durations follow their units: a date minus a date is a number of
 * days, a date plus a number is a later date, a duration divided by a duration is a number.
 * `if` and `ifEmpty` give text when one branch is text, turning the other into text, so a
 * formula can answer "Overdue" or a number of days.
 */
export type FieldValueType = Exclude<BaseType, 'boolean'>;
export interface ResolvedField {
  /** A stable id for the field (the caller's: `cf[12]`, `due`). */
  id: string;
  type: FieldValueType;
}
export type Resolution =
  | ResolvedField
  | {
      problem: Extract<FormulaErrorCode, 'unknown_field' | 'ambiguous_field' | 'unsupported_field'>;
      message?: string;
    };

export interface CompileOptions {
  /** Finds a field by the name written between braces. */
  resolve: (name: string) => Resolution;
  /** The field's output; the formula's type must fit it. */
  output?: OutputType;
}

export type Compiled = { ok: true; program: Program } | { ok: false; error: FormulaError };

type ListType = `list:${ValueType}`;
type Type = ValueType | ListType | 'children';
interface Typed {
  ir: Ir;
  t: Type;
  node: Node;
}

/** Function names as the documentation writes them, by their lower-case form. */
export const FUNCTIONS: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(
    Object.create(null),
    Object.fromEntries(
      [
        'if',
        'isEmpty',
        'ifEmpty',
        'sum',
        'avg',
        'min',
        'max',
        'count',
        'abs',
        'round',
        'floor',
        'ceil',
        'mod',
        'pow',
        'sqrt',
        'today',
        'date',
        'daysBetween',
        'workingDaysBetween',
        'workingDaysUntil',
        'addDays',
        'year',
        'month',
        'day',
        'weekday',
        'hours',
        'minutes',
        'text',
        'concat',
        'upper',
        'lower',
        'len',
      ].map((n) => [n.toLowerCase(), n]),
    ),
  ),
);

const isList = (t: Type): t is ListType => t.startsWith('list:');
const elementOf = (t: ListType): ValueType => t.slice(5) as ValueType;

function typeName(t: Type): string {
  if (t === 'children') return 'the child tickets';
  if (isList(t)) return `values of the child tickets (${typeName(elementOf(t))})`;
  switch (t) {
    case 'number':
      return 'a number';
    case 'text':
      return 'text';
    case 'date':
      return 'a date';
    case 'duration':
      return 'a duration';
    case 'boolean':
      return 'true or false';
    default:
      return 'empty';
  }
}

class Checker {
  readonly refs: RefUse[] = [];
  readonly childRefs: RefUse[] = [];
  readsChildren = false;
  volatile = false;
  workingWeek = false;

  constructor(
    private readonly source: string,
    private readonly resolve: CompileOptions['resolve'],
  ) {}

  fail(code: FormulaErrorCode, message: string, at: { start: number; end: number }): never {
    throw new FormulaError(code, message, at.start, Math.max(at.end, at.start), this.source);
  }

  private field(name: string, at: { start: number; end: number }): ResolvedField {
    const found = this.resolve(name);
    if ('problem' in found) {
      const fallback: Record<string, string> = {
        unknown_field: `No field is called ${name}`,
        ambiguous_field: `Several fields are called ${name}: name one as {cf[id]}`,
        unsupported_field: `Formulas cannot read ${name} yet`,
      };
      this.fail(found.problem, found.message ?? (fallback[found.problem] as string), at);
    }
    return found;
  }

  /** A value (not a list), or a refusal naming where a list stands. */
  private scalar(x: Typed, what: string): ValueType {
    if (x.t === 'children' || isList(x.t)) {
      this.fail(
        'children_misplaced',
        `${what} takes a value; the child tickets are read through sum, avg, min, max or count`,
        x.node,
      );
    }
    return x.t as ValueType;
  }

  private expect(x: Typed, allowed: readonly ValueType[], what: string): ValueType {
    const t = this.scalar(x, what);
    if (t !== 'empty' && !allowed.includes(t)) {
      this.fail(
        'type_mismatch',
        `${what} takes ${allowed.map(typeName).join(' or ')}, not ${typeName(t)}`,
        x.node,
      );
    }
    return t;
  }

  private op(op: Op, args: Typed[], t: Type, node: Node): Typed {
    return {
      ir: { k: 'op', op, a: args.map((a) => a.ir), t: args.map((a) => a.t as ValueType) },
      t,
      node,
    };
  }

  /** Converts a branch to text for `if` and `ifEmpty` when the other branch is text. */
  private asText(x: Typed): Typed {
    if (x.t === 'text' || x.t === 'empty') return x;
    return this.op('text', [x], 'text', x.node);
  }

  private unify(a: Typed, b: Typed, what: string): [Typed, Typed, ValueType] {
    const ta = this.scalar(a, what);
    const tb = this.scalar(b, what);
    if (ta === tb) return [a, b, ta];
    if (ta === 'empty') return [a, b, tb];
    if (tb === 'empty') return [a, b, ta];
    if (ta === 'text' || tb === 'text') return [this.asText(a), this.asText(b), 'text'];
    return this.fail(
      'type_mismatch',
      `${what} gives ${typeName(ta)} one way and ${typeName(tb)} the other`,
      b.node,
    );
  }

  check(node: Node): Typed {
    switch (node.kind) {
      case 'number':
        return { ir: { k: 'lit', v: node.value }, t: 'number', node };
      case 'text':
        return { ir: { k: 'lit', v: node.value }, t: 'text', node };
      case 'boolean':
        return { ir: { k: 'lit', v: node.value }, t: 'boolean', node };
      case 'empty':
        return { ir: { k: 'lit', v: null }, t: 'empty', node };
      case 'field': {
        const f = this.field(node.name, node);
        this.refs.push({ id: f.id, start: node.start, end: node.end });
        return { ir: { k: 'ref', id: f.id }, t: f.type, node };
      }
      case 'children': {
        this.readsChildren = true;
        if (node.field === null) return { ir: { k: 'kids' }, t: 'children', node };
        const f = this.field(node.field.name, node.field);
        this.childRefs.push({ id: f.id, start: node.field.start, end: node.field.end });
        return { ir: { k: 'list', id: f.id }, t: `list:${f.type}`, node };
      }
      case 'unary': {
        const x = this.check(node.operand);
        if (node.op === 'not') {
          this.expect(x, ['boolean'], 'not');
          return this.op('not', [x], 'boolean', node);
        }
        const t = this.expect(x, ['number', 'duration'], `The sign ${node.op}`);
        return this.op(node.op === '-' ? 'neg' : 'pos', [x], t, node);
      }
      case 'binary':
        return this.binary(node);
      case 'call':
        return this.call(node);
    }
  }

  private binary(node: Extract<Node, { kind: 'binary' }>): Typed {
    const l = this.check(node.left);
    const r = this.check(node.right);
    const at = { start: node.opStart, end: node.opEnd };
    const sides = () => [this.scalar(l, node.op), this.scalar(r, node.op)] as const;
    const mismatch = (): never =>
      this.fail(
        'type_mismatch',
        `${node.op} does not take ${typeName(l.t)} and ${typeName(r.t)}`,
        at,
      );
    switch (node.op) {
      case 'and':
      case 'or':
        this.expect(l, ['boolean'], node.op);
        this.expect(r, ['boolean'], node.op);
        return this.op(node.op, [l, r], 'boolean', node);
      case '&':
        sides();
        return this.op('join', [l, r], 'text', node);
      case '=':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const [a, b] = sides();
        if (a === 'empty' || b === 'empty') {
          this.fail(
            'type_mismatch',
            'A comparison with null is never true: test for an empty value with isEmpty()',
            at,
          );
        }
        if (a !== b) mismatch();
        if (a === 'boolean' && node.op !== '=' && node.op !== '!=') mismatch();
        const op = { '=': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' }[
          node.op
        ] as Op;
        return this.op(op, [l, r], 'boolean', node);
      }
      case '+': {
        const [a, b] = sides();
        if (a === 'text' && b === 'text') {
          this.fail('type_mismatch', 'Text is joined with &, as in {First} & " " & {Last}', at);
        }
        const t = arithmetic('+', a, b);
        if (t === null) return mismatch();
        // A date plus days is a date: the days come second.
        if (t === 'date') return this.op('adddays', a === 'date' ? [l, r] : [r, l], t, node);
        return this.op('add', [l, r], t, node);
      }
      case '-': {
        const [a, b] = sides();
        const t = arithmetic('-', a, b);
        if (t === null) return mismatch();
        if (a === 'date' && b === 'date') return this.op('daysbetween', [r, l], 'number', node);
        if (t === 'date') return this.op('adddays', [l, this.op('neg', [r], b, r.node)], t, node);
        return this.op('sub', [l, r], t, node);
      }
      case '*':
      case '/':
      case '^': {
        const [a, b] = sides();
        const t = arithmetic(node.op, a, b);
        if (t === null) return mismatch();
        const op = node.op === '*' ? 'mul' : node.op === '/' ? 'div' : 'pow';
        return this.op(op, [l, r], t, node);
      }
    }
  }

  private call(node: Extract<Node, { kind: 'call' }>): Typed {
    const name = FUNCTIONS[node.name];
    const at = { start: node.start, end: node.nameEnd };
    if (name === undefined) this.fail('unknown_function', `Unknown function ${node.name}`, at);
    const args = node.args.map((a) => this.check(a));
    const arity = (min: number, max: number = min) => {
      if (args.length < min || args.length > max) {
        const count =
          min === max
            ? `${min} argument${min === 1 ? '' : 's'}`
            : max === Number.POSITIVE_INFINITY
              ? `at least ${min} argument${min === 1 ? '' : 's'}`
              : `${min} to ${max} arguments`;
        this.fail('arity', `${name} takes ${count}`, { start: node.start, end: node.end });
      }
    };
    const arg = (i: number) => args[i] as Typed;
    switch (node.name) {
      case 'if': {
        arity(2, 3);
        this.expect(arg(0), ['boolean'], 'The condition of if');
        if (args.length === 2) {
          const t = this.scalar(arg(1), name);
          return this.op('if', [arg(0), arg(1)], t, node);
        }
        const [a, b, t] = this.unify(arg(1), arg(2), name);
        return this.op('if', [arg(0), a, b], t, node);
      }
      case 'isempty':
        arity(1);
        this.scalar(arg(0), name);
        return this.op('isempty', args, 'boolean', node);
      case 'ifempty': {
        arity(2);
        const [a, b, t] = this.unify(arg(0), arg(1), name);
        return this.op('ifempty', [a, b], t, node);
      }
      case 'sum':
      case 'avg':
      case 'min':
      case 'max': {
        arity(1, Number.POSITIVE_INFINITY);
        const allowed: ValueType[] =
          node.name === 'min' || node.name === 'max'
            ? ['number', 'duration', 'date']
            : ['number', 'duration'];
        let t: ValueType = 'empty';
        for (const a of args) {
          if (a.t === 'children') {
            this.fail(
              'type_mismatch',
              `${name} reads a field of the child tickets, as in ${name}(children.{Points})`,
              a.node,
            );
          }
          const e = isList(a.t) ? elementOf(a.t) : (a.t as ValueType);
          if (e !== 'empty' && !allowed.includes(e)) {
            this.fail(
              'type_mismatch',
              `${name} takes ${allowed.map(typeName).join(' or ')}, not ${typeName(e)}`,
              a.node,
            );
          }
          if (e !== 'empty' && t !== 'empty' && e !== t) {
            this.fail('type_mismatch', `${name} mixes ${typeName(t)} and ${typeName(e)}`, a.node);
          }
          if (e !== 'empty') t = e;
        }
        if (t === 'empty' && node.name === 'sum') t = 'number';
        return this.op(node.name, args, t, node);
      }
      case 'count':
        arity(1, Number.POSITIVE_INFINITY);
        return this.op('count', args, 'number', node);
      case 'abs': {
        arity(1);
        const t = this.expect(arg(0), ['number', 'duration'], name);
        return this.op('abs', args, t, node);
      }
      case 'round':
        arity(1, 2);
        for (const a of args) this.expect(a, ['number'], name);
        return this.op('round', args, 'number', node);
      case 'floor':
      case 'ceil':
      case 'sqrt':
        arity(1);
        this.expect(arg(0), ['number'], name);
        return this.op(node.name, args, 'number', node);
      case 'mod':
      case 'pow':
        arity(2);
        for (const a of args) this.expect(a, ['number'], name);
        return this.op(node.name, args, 'number', node);
      case 'today':
        arity(0);
        this.volatile = true;
        return this.op('today', args, 'date', node);
      case 'date':
        arity(1);
        this.expect(arg(0), ['text', 'date'], name);
        return this.op('date', args, 'date', node);
      case 'daysbetween':
      case 'workingdaysbetween':
        arity(2);
        for (const a of args) this.expect(a, ['date'], name);
        if (node.name === 'workingdaysbetween') this.workingWeek = true;
        return this.op(node.name, args, 'number', node);
      case 'workingdaysuntil':
        arity(1);
        this.expect(arg(0), ['date'], name);
        this.workingWeek = true;
        this.volatile = true;
        return this.op('workingdaysuntil', args, 'number', node);
      case 'adddays':
        arity(2);
        this.expect(arg(0), ['date'], name);
        this.expect(arg(1), ['number'], name);
        return this.op('adddays', args, 'date', node);
      case 'year':
      case 'month':
      case 'day':
      case 'weekday':
        arity(1);
        this.expect(arg(0), ['date'], name);
        return this.op(node.name, args, 'number', node);
      case 'hours':
      case 'minutes':
        arity(1);
        this.expect(arg(0), ['number'], name);
        return this.op(node.name, args, 'duration', node);
      case 'text':
        arity(1);
        this.scalar(arg(0), name);
        return this.op('text', args, 'text', node);
      case 'concat':
        arity(1, Number.POSITIVE_INFINITY);
        for (const a of args) this.scalar(a, name);
        return this.op('join', args, 'text', node);
      case 'upper':
      case 'lower':
        arity(1);
        this.expect(arg(0), ['text'], name);
        return this.op(node.name, args, 'text', node);
      case 'len':
        arity(1);
        this.expect(arg(0), ['text'], name);
        return this.op('len', args, 'number', node);
    }
    return this.fail('unknown_function', `Unknown function ${node.name}`, at);
  }
}

/** What each arithmetic operator takes, by the pair of types, and gives. */
const ARITHMETIC: Record<'+' | '-' | '*' | '/' | '^', Readonly<Record<string, ValueType>>> = {
  '+': {
    'number number': 'number',
    'duration duration': 'duration',
    'date number': 'date',
    'number date': 'date',
  },
  '-': {
    'number number': 'number',
    'duration duration': 'duration',
    'date number': 'date',
    'date date': 'number',
  },
  '*': {
    'number number': 'number',
    'duration number': 'duration',
    'number duration': 'duration',
  },
  '/': {
    'number number': 'number',
    'duration number': 'duration',
    'duration duration': 'number',
  },
  '^': { 'number number': 'number' },
};

/**
 * The type of an arithmetic operation, or null when it does not take those types. An empty
 * side (`null`) stands for whatever makes the operation work: the other side's type, else a
 * number.
 */
function arithmetic(op: '+' | '-' | '*' | '/' | '^', a: ValueType, b: ValueType): ValueType | null {
  if (a === 'empty' && b === 'empty') return 'empty';
  const table = ARITHMETIC[op];
  const pairs: [ValueType, ValueType][] =
    a === 'empty'
      ? [
          [b, b],
          ['number', b],
        ]
      : b === 'empty'
        ? [
            [a, a],
            [a, 'number'],
          ]
        : [[a, b]];
  for (const [x, y] of pairs) {
    const t = Object.hasOwn(table, `${x} ${y}`) ? table[`${x} ${y}`] : undefined;
    if (t !== undefined) return t;
  }
  return null;
}

/** Whether a formula's type fits an output; `empty` fits all. */
export function fitsOutput(type: ValueType, output: OutputType): boolean {
  return type === 'empty' || type === outputValueType(output);
}

/**
 * Parses and checks a formula. Refusals (CORE-011 (3)) carry their place; nothing runs here.
 */
export function compileFormula(source: string, options: CompileOptions): Compiled {
  try {
    const tree = parseFormula(source);
    const checker = new Checker(source, options.resolve);
    const top = checker.check(tree);
    const type = (() => {
      if (top.t === 'children' || isList(top.t)) {
        return checker.fail(
          'children_misplaced',
          'The child tickets are read through sum, avg, min, max or count',
          tree,
        );
      }
      return top.t as ValueType;
    })();
    if (options.output !== undefined && !fitsOutput(type, options.output)) {
      const want = outputValueType(options.output);
      throw new FormulaError(
        'output_mismatch',
        `The formula gives ${typeName(type)}, but the field shows ${
          options.output === want ? typeName(want) : `${typeName(want)} (${options.output})`
        }${want === 'text' ? ': wrap it in text()' : ''}`,
        0,
        source.length,
        source,
      );
    }
    return {
      ok: true,
      program: {
        source,
        ir: top.ir,
        type,
        refs: checker.refs,
        childRefs: checker.childRefs,
        readsChildren: checker.readsChildren,
        volatile: checker.volatile,
        workingWeek: checker.workingWeek,
      },
    };
  } catch (error) {
    if (error instanceof FormulaError) return { ok: false, error };
    throw error;
  }
}

/** The value type of a field reference's type, for callers that build resolvers. */
export type { BaseType };
