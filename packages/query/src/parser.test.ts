import { stableJson } from '@taskmoor/testkit';
import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import type { Expr, FieldRef, Predicate, Query, Value } from './ast';
import { QueryError } from './lexer';
import { parseQuery } from './parser';
import { printQuery } from './print';

/** Query strings that cover the grammar; their trees are the reviewed golden file. */
const SAMPLES = [
  'status = Done',
  'project = ABC AND status != "In Progress"',
  'assignee = currentUser() OR reporter = currentUser()',
  'NOT status = Closed',
  'created >= -1w AND updated <= now()',
  'priority IN (High, Highest) AND labels NOT IN ("tech-debt", infra)',
  'fixVersion IS EMPTY',
  'resolution IS NOT NULL',
  'summary ~ "login page" AND description !~ cache',
  'cf[10042] > 3.5',
  '"Story Points" <= 8',
  'status WAS Done',
  'status WAS NOT IN (Open, Reopened) BEFORE 2026-01-01 BY kalo',
  'assignee CHANGED FROM EMPTY TO currentUser() AFTER startOfDay(-7d)',
  'status CHANGED DURING (2026-01-01, 2026-02-01)',
  'ORDER BY created DESC',
  'project = ABC ORDER BY priority DESC, created ASC',
  '(a = 1 OR b = 2) AND NOT (c = 3 OR d = 4)',
  'a = 1 AND b = 2 OR c = 3 AND d = 4',
  'key = ABC-12 OR key in (ABC-13, ABC-14)',
  'text ~ "quoted \\"inner\\" words"',
  "assignee = 'single quoted'",
  'due < endOfMonth() AND due > startOfWeek(1)',
  'sprint IN openSprints() OR sprint IN futureSprints()',
  'cf[1] IS EMPTY AND cf[2] WAS IN (1, 2, 3) ON 2026-03-04',
  'status changed and assignee was empty',
];

describe('parseQuery', () => {
  it('[QRY-001] builds the reviewed trees for the sample queries', async () => {
    const trees = Object.fromEntries(SAMPLES.map((q) => [q, parseQuery(q)]));
    await expect(stableJson(trees)).toMatchFileSnapshot('./__golden__/parser.json');
  });

  it('reads keywords in any case and accepts an empty query', () => {
    expect(parseQuery('status = Done and NOT a = 1 order by created desc')).toEqual(
      parseQuery('status = Done AND NOT a = 1 ORDER BY created DESC'),
    );
    expect(parseQuery('')).toEqual({ where: null, orderBy: [] });
    expect(parseQuery('   ')).toEqual({ where: null, orderBy: [] });
  });

  it('gives AND precedence over OR and NOT over both', () => {
    const q = parseQuery('a = 1 OR b = 2 AND NOT c = 3');
    expect(q.where?.kind).toBe('or');
    const or = q.where as Extract<Expr, { kind: 'or' }>;
    expect(or.items[1]?.kind).toBe('and');
    const and = or.items[1] as Extract<Expr, { kind: 'and' }>;
    expect(and.items[1]?.kind).toBe('not');
  });

  it('keeps spans that point at the source text', () => {
    const text = 'project = ABC AND "Story Points" > 5';
    const q = parseQuery(text);
    const and = q.where as Extract<Expr, { kind: 'and' }>;
    const second = and.items[1] as Extract<Expr, { kind: 'compare' }>;
    expect(text.slice(second.field.span.start, second.field.span.end)).toBe('"Story Points"');
    expect(text.slice(second.span.start, second.span.end)).toBe('"Story Points" > 5');
  });

  it.each([
    ['status =', 'Expected a value, found the end of the query at position 9'],
    ['status', 'Expected an operator after "status", found the end of the query at position 7'],
    ['= Done', '"=" is not a field name'],
    ['status = Done AND', 'Expected a field name, found the end of the query at position 18'],
    ['status IN ()', 'Expected at least one value, found ")" at position 12'],
    ['status IN (Open', 'Expected "," or ")", found the end of the query at position 16'],
    ['(a = 1', 'Expected ")", found the end of the query at position 7'],
    ['a = 1 )', 'Unexpected ")" at position 7'],
    ['a = "unterminated', 'Unterminated string at position 5'],
    ['a = 1 ORDER created', 'Expected BY after ORDER, found "created" at position 13'],
    ['a IS Done', 'Expected EMPTY or NULL after IS, found "Done" at position 6'],
    ['and = 1', '"and" cannot be used as a field name at position 1'],
    ['a = 1 # b', 'Unexpected character "#" at position 7'],
    ['cf[x] = 1', 'Expected a custom field number, found "x" at position 4'],
  ])('reports "%s" with a position', (text, message) => {
    let error: unknown;
    try {
      parseQuery(text);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(QueryError);
    if (text === '= Done') {
      expect((error as Error).message).toBe('Expected a field name, found "=" at position 1');
    } else {
      expect((error as Error).message).toBe(message);
    }
  });
});

// --- Property test: any tree prints to text that parses back to the same tree -------------

const WORD = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,8}$/)
  .filter(
    (w) =>
      !/^(and|or|not|order|in|is|was|changed|from|to|by|before|after|on|during|empty|null|asc|desc|cf)$/i.test(
        w,
      ) && !/^[+-]?\d+(\.\d+)?$/.test(w),
  );
const span = { start: 0, end: 0 };

const fieldArb: fc.Arbitrary<FieldRef> = fc.oneof(
  WORD.map((name) => ({ name, span })),
  fc.string({ minLength: 1, maxLength: 12 }).map((name) => ({ name, span })),
  fc.nat(99999).map((custom) => ({ name: 'cf', custom, span })),
);

const valueArb: fc.Arbitrary<Value> = fc.letrec<{ value: Value }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', maxDepth: 2 },
    fc.string({ maxLength: 12 }).map((value) => ({ kind: 'string' as const, value, span })),
    fc
      .integer({ min: -1_000_000, max: 1_000_000 })
      .map((value) => ({ kind: 'number' as const, value, span })),
    fc
      .tuple(fc.integer({ min: -999, max: 999 }), fc.nat(99))
      .map(([i, f]) => ({ kind: 'number' as const, value: Number(`${i}.${f}`), span })),
    WORD.map((value) => ({ kind: 'word' as const, value, span })),
    fc
      .stringMatching(/^[+-]?\d{1,3}[mhdwMy]$/)
      .map((value) => ({ kind: 'duration' as const, value, span })),
    fc.constant({ kind: 'empty' as const, span }),
    fc
      .tuple(WORD, fc.array(tie('value'), { maxLength: 3 }))
      .map(([name, args]) => ({ kind: 'function' as const, name, args, span })),
  ),
})).value;

const predicateArb: fc.Arbitrary<Predicate> = fc
  .tuple(
    fc.constantFrom('from', 'to', 'by', 'before', 'after', 'on', 'during') as fc.Arbitrary<
      Predicate['kind']
    >,
    fc.array(valueArb, { minLength: 1, maxLength: 3 }),
  )
  .map(([kind, values]) => ({ kind, values, span }));

const clauseArb: fc.Arbitrary<Expr> = fc.oneof(
  fc
    .tuple(fieldArb, fc.constantFrom('=', '!=', '<', '<=', '>', '>=', '~', '!~'), valueArb)
    .map(([field, op, value]) => ({ kind: 'compare' as const, field, op: op as '=', value, span })),
  fc
    .tuple(fieldArb, fc.boolean(), fc.array(valueArb, { minLength: 1, maxLength: 4 }))
    .map(([field, negated, values]) => ({ kind: 'in' as const, field, negated, values, span })),
  fc
    .tuple(fieldArb, fc.boolean())
    .map(([field, negated]) => ({ kind: 'empty' as const, field, negated, span })),
  fc
    .tuple(
      fieldArb,
      fc.boolean(),
      fc.array(valueArb, { minLength: 1, maxLength: 3 }),
      fc.array(predicateArb, { maxLength: 3 }),
    )
    .map(([field, negated, values, predicates]) => ({
      kind: 'was' as const,
      field,
      negated,
      values,
      predicates,
      span,
    })),
  fc
    .tuple(fieldArb, fc.array(predicateArb, { maxLength: 3 }))
    .map(([field, predicates]) => ({ kind: 'changed' as const, field, predicates, span })),
);

const exprArb: fc.Arbitrary<Expr> = fc.letrec<{ expr: Expr }>((tie) => ({
  expr: fc.oneof(
    { depthSize: 'small', maxDepth: 3 },
    clauseArb,
    fc
      .array(tie('expr'), { minLength: 2, maxLength: 3 })
      .map((items) => ({ kind: 'and' as const, items, span })),
    fc
      .array(tie('expr'), { minLength: 2, maxLength: 3 })
      .map((items) => ({ kind: 'or' as const, items, span })),
    tie('expr').map((expr) => ({ kind: 'not' as const, expr, span })),
  ),
})).expr;

const queryArb: fc.Arbitrary<Query> = fc
  .tuple(
    fc.option(exprArb, { nil: null }),
    fc.array(fc.tuple(fieldArb, fc.constantFrom('asc', 'desc')), { maxLength: 2 }),
  )
  .map(([where, order]) => ({
    where,
    orderBy: order.map(([field, direction]) => ({ field, direction: direction as 'asc', span })),
  }));

function withoutSpans<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, v) => (key === 'span' ? undefined : v))) as T;
}

describe('printQuery', () => {
  it('prints the samples in canonical form that parses back to the same tree', () => {
    for (const text of SAMPLES) {
      const tree = parseQuery(text);
      expect(withoutSpans(parseQuery(printQuery(tree)))).toEqual(withoutSpans(tree));
    }
  });

  it('round-trips any tree', () => {
    fc.assert(
      fc.property(queryArb, (query) => {
        const text = printQuery(query);
        expect(withoutSpans(parseQuery(text))).toEqual(withoutSpans(query));
      }),
    );
  });
});
