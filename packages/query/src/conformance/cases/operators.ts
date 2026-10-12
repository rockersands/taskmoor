import type { QueryCase } from '../case';
import {
  CATALOGUE,
  OPERATORS,
  type Operator,
  operatorAllowed,
  section,
  type ValueType,
} from './fixtures';

const c = section('QRY-002', 'operators', '01b 1.2');

/** One field of each value type, with a sample value in canonical syntax. */
const TYPES: { type: ValueType; field: string; sample: string }[] = [
  { type: 'text', field: 'summary', sample: '"login"' },
  { type: 'number', field: '"Story Points"', sample: '8' },
  { type: 'date', field: 'created', sample: '2026-01-31' },
  { type: 'user', field: 'assignee', sample: 'currentUser()' },
  { type: 'option', field: 'Team', sample: 'Platform' },
  { type: 'multi', field: 'Platforms', sample: 'ios' },
  { type: 'labels', field: 'labels', sample: 'backend' },
  { type: 'release', field: 'targetRelease', sample: '"1.0"' },
  { type: 'priority', field: 'priority', sample: 'High' },
  { type: 'status', field: 'status', sample: 'Done' },
  { type: 'key', field: 'key', sample: 'ABC-12' },
  { type: 'track', field: 'track', sample: 'ABC' },
  { type: 'type', field: 'type', sample: 'Bug' },
  { type: 'sprint', field: 'sprint', sample: '42' },
  { type: 'attachments', field: 'attachments', sample: 'EMPTY' },
  { type: 'area', field: 'area', sample: '"API"' },
  { type: 'savedSearch', field: 'savedSearch', sample: '10001' },
];

const opSlug: Record<Operator, string> = {
  '=': 'eq',
  '!=': 'ne',
  '>': 'gt',
  '>=': 'ge',
  '<': 'lt',
  '<=': 'le',
  IN: 'in',
  'NOT IN': 'not-in',
  '~': 'contains',
  '!~': 'not-contains',
  IS: 'is-empty',
  'IS NOT': 'is-not-empty',
  WAS: 'was',
  'WAS NOT': 'was-not',
  'WAS IN': 'was-in',
  'WAS NOT IN': 'was-not-in',
  CHANGED: 'changed',
};

/** The clause text for an operator on a field; the list operators get a one-item list. */
export function clause(field: string, op: Operator, sample: string): string {
  switch (op) {
    case 'IN':
    case 'NOT IN':
    case 'WAS IN':
    case 'WAS NOT IN':
      return `${field} ${op} (${sample})`;
    case 'IS':
    case 'IS NOT':
      return `${field} ${op} EMPTY`;
    case 'CHANGED':
      return `${field} CHANGED`;
    default:
      return `${field} ${op} ${sample}`;
  }
}

/**
 * The canonical print of a clause: a one-value `WAS IN (x)` is `WAS x` (the tree is the same),
 * and a list made of one function call prints without parentheses (`IN openSprints()`).
 */
export function canonicalOf(field: string, op: Operator, sample: string): string {
  const fn = /^[A-Za-z]+\(.*\)$/.test(sample);
  switch (op) {
    case 'IN':
    case 'NOT IN':
      return fn ? `${field} ${op} ${sample}` : clause(field, op, sample);
    case 'WAS IN':
      return `${field} WAS ${sample}`;
    case 'WAS NOT IN':
      return `${field} WAS NOT ${sample}`;
    default:
      return clause(field, op, sample);
  }
}

const thousand = Array.from({ length: 1000 }, (_, i) => String(i + 1)).join(', ');

export const OPERATOR_CASES: QueryCase[] = [
  ...TYPES.flatMap(({ type, field, sample }) =>
    OPERATORS.flatMap((op) => {
      const value = type === 'attachments' ? '"x"' : sample;
      const text = clause(field, op, value);
      const allowed = operatorAllowed(op, type);
      return [
        c(`${opSlug[op]}-${type}-parse`, {
          kind: 'parse',
          title: `${op} on a ${type} field parses (validity is the resolver's job)`,
          text,
          expect: { canonical: canonicalOf(field, op, value) },
        }),
        c(`${opSlug[op]}-${type}-resolve`, {
          kind: 'resolve',
          title: allowed
            ? `${op} is valid on a ${type} field`
            : `${op} is refused on a ${type} field, naming the field`,
          text,
          catalogue: CATALOGUE,
          // An invalid pairing must be refused; the exact wording is the implementation's.
          expect: allowed ? { ok: true } : { ok: false, message: '' },
          verify:
            'the operator rules per type are restated from the operator table and the field notes; Jira documents them per field',
        }),
      ];
    }),
  ),
  // EMPTY semantics per type (QRY-002, acceptance 3).
  ...TYPES.filter((t) => t.type !== 'attachments').flatMap(({ type, field }) => [
    c(`empty-eq-${type}`, {
      kind: 'resolve',
      title: `= EMPTY on a ${type} field`,
      text: `${field} = EMPTY`,
      catalogue: CATALOGUE,
      expect: { ok: true },
    }),
    c(`empty-ne-${type}`, {
      kind: 'resolve',
      title: `!= EMPTY on a ${type} field`,
      text: `${field} != EMPTY`,
      catalogue: CATALOGUE,
      expect: { ok: true },
    }),
    c(`empty-is-${type}`, {
      kind: 'resolve',
      title: `IS EMPTY on a ${type} field`,
      text: `${field} IS EMPTY`,
      catalogue: CATALOGUE,
      expect: { ok: true },
    }),
    c(`empty-is-not-${type}`, {
      kind: 'resolve',
      title: `IS NOT EMPTY on a ${type} field`,
      text: `${field} IS NOT EMPTY`,
      catalogue: CATALOGUE,
      expect: { ok: true },
    }),
    c(`empty-gt-${type}`, {
      kind: 'resolve',
      title: `> EMPTY is refused on a ${type} field`,
      text: `${field} > EMPTY`,
      catalogue: CATALOGUE,
      expect: { ok: false, message: '' },
    }),
  ]),
  c('tilde-on-number-names-field', {
    kind: 'resolve',
    title: '~ on a number field is refused naming the field',
    text: '"Story Points" ~ "8"',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'Story Points' },
  }),
  c('in-with-1000-values', {
    kind: 'parse',
    title: 'IN with 1,000 values parses',
    text: `id IN (${thousand})`,
    expect: { canonical: `id IN (${thousand})` },
  }),
  c('in-with-1000-values-resolves', {
    kind: 'resolve',
    title: 'IN with 1,000 values resolves',
    text: `id IN (${thousand})`,
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('not-equals-excludes-empty', {
    kind: 'parse',
    title: 'A clause never matches empty fields unless the query says so',
    text: 'assignee != currentUser() OR assignee IS EMPTY',
    expect: { canonical: 'assignee != currentUser() OR assignee IS EMPTY' },
  }),
  c('ordering-on-priority', {
    kind: 'resolve',
    title: 'Ordering comparisons work on priorities',
    text: 'priority >= High',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('ordering-on-version', {
    kind: 'resolve',
    title: 'Ordering comparisons work on versions',
    text: 'fixVersion >= "1.0"',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('number-compared-with-text', {
    kind: 'resolve',
    title: 'A number field compared with text is refused',
    text: '"Story Points" > "many"',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'number' },
  }),
];
