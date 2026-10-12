import type { QueryCase } from '../case';
import { CATALOGUE, section } from './fixtures';

const c = section('QRY-005', 'history', '01b 1.3');

/**
 * Fields with a sample past value; Tracksmith keeps history on every field. Users are named by
 * a quoted name, which a user directory resolves (verify: Jira Cloud wants account ids; the
 * spec accepts names and ids).
 */
const FIELDS: { field: string; value: string; other: string; known?: boolean }[] = [
  { field: 'status', value: '"In Review"', other: 'Done', known: true },
  { field: 'assignee', value: '"alice"', other: '"bob"', known: true },
  { field: 'priority', value: 'High', other: 'Low', known: true },
  { field: 'summary', value: '"old title"', other: '"new title"', known: true },
  { field: 'resolution', value: 'Done', other: '"Won\'t do"' },
  { field: 'fixVersion', value: '"1.0"', other: '"2.0"' },
  { field: 'reporter', value: '"alice"', other: '"bob"' },
  { field: '"Story Points"', value: '3', other: '5' },
  { field: 'Team', value: 'Platform', other: 'Mobile' },
  { field: 'labels', value: 'backend', other: 'frontend' },
  { field: 'due', value: '2026-01-31', other: '2026-02-28' },
  { field: 'cf[10016]', value: '3', other: '5' },
];

const FORMS = ['WAS', 'WAS NOT', 'WAS IN', 'WAS NOT IN', 'CHANGED'] as const;

const PREDICATES: { slug: string; text: string }[] = [
  { slug: 'after', text: 'AFTER 2026-01-01' },
  { slug: 'before', text: 'BEFORE 2026-02-01' },
  { slug: 'on', text: 'ON 2026-01-15' },
  { slug: 'during', text: 'DURING (2026-01-01, 2026-02-01)' },
  { slug: 'by', text: 'BY "alice"' },
  { slug: 'by-list', text: 'BY ("alice", "bob")' },
  { slug: 'after-before', text: 'AFTER 2026-01-01 BEFORE 2026-02-01' },
  { slug: 'by-during', text: 'BY "alice" DURING (2026-01-01, 2026-02-01)' },
  { slug: 'after-function', text: 'AFTER startOfYear()' },
  { slug: 'during-relative', text: 'DURING (-30d, now())' },
];

function form(field: string, f: (typeof FORMS)[number], value: string, other: string): string {
  switch (f) {
    case 'WAS':
      return `${field} WAS ${value}`;
    case 'WAS NOT':
      return `${field} WAS NOT ${value}`;
    case 'WAS IN':
      return `${field} WAS IN (${value}, ${other})`;
    case 'WAS NOT IN':
      return `${field} WAS NOT IN (${value}, ${other})`;
    case 'CHANGED':
      return `${field} CHANGED`;
  }
}

const slug = (s: string) =>
  s
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

export const HISTORY_CASES: QueryCase[] = [
  // Every form on every field.
  ...FIELDS.flatMap(({ field, value, other }) =>
    FORMS.flatMap((f) => {
      const text = form(field, f, value, other);
      return [
        c(`${slug(f)}-${slug(field)}-parse`, {
          kind: 'parse',
          title: `${f} on ${field} parses`,
          text,
          expect: { canonical: text },
        }),
        c(`${slug(f)}-${slug(field)}-resolve`, {
          kind: 'resolve',
          title: `${f} on ${field} resolves (history on every field)`,
          text,
          catalogue: CATALOGUE,
          expect: { ok: true },
        }),
      ];
    }),
  ),
  // Every predicate on every form (on status).
  ...FORMS.flatMap((f) =>
    PREDICATES.flatMap((p) => {
      const text = `${form('status', f, '"In Review"', 'Done')} ${p.text}`;
      return [
        c(`${slug(f)}-${p.slug}-parse`, {
          kind: 'parse',
          title: `${f} ${p.text} parses`,
          text,
          expect: { canonical: text },
        }),
        c(`${slug(f)}-${p.slug}-resolve`, {
          kind: 'resolve',
          title: `${f} ${p.text} resolves`,
          text,
          catalogue: CATALOGUE,
          expect: { ok: true },
        }),
      ];
    }),
  ),
  // CHANGED FROM and TO.
  c('changed-from', {
    kind: 'parse',
    title: 'CHANGED FROM',
    text: 'status CHANGED FROM "In Review"',
    expect: { canonical: 'status CHANGED FROM "In Review"' },
  }),
  c('changed-to', {
    kind: 'parse',
    title: 'CHANGED TO',
    text: 'status CHANGED TO Done',
    expect: { canonical: 'status CHANGED TO Done' },
  }),
  c('changed-from-to', {
    kind: 'parse',
    title: 'CHANGED FROM x TO y',
    text: 'status CHANGED FROM "In Review" TO Done',
    expect: { canonical: 'status CHANGED FROM "In Review" TO Done' },
  }),
  c('changed-from-to-resolve', {
    kind: 'resolve',
    title: 'CHANGED FROM x TO y resolves',
    text: 'status CHANGED FROM "In Review" TO Done',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('acceptance-story-points', {
    kind: 'parse',
    title: 'The acceptance query of QRY-005 parses',
    text: '"Story points" CHANGED FROM 3 TO 5 BY alice DURING ("2026-01-01", "2026-02-01")',
    expect: {
      canonical: '"Story points" CHANGED FROM 3 TO 5 BY alice DURING ("2026-01-01", "2026-02-01")',
    },
  }),
  c('acceptance-story-points-resolve', {
    kind: 'resolve',
    title: 'The acceptance query of QRY-005 resolves on a custom field',
    text: '"Story Points" CHANGED FROM 3 TO 5 BY "alice" DURING (2026-01-01, 2026-02-01)',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('was-in-review-resolve', {
    kind: 'resolve',
    title: 'status WAS "In Review" resolves',
    text: 'status WAS "In Review"',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('changed-by-current-user', {
    kind: 'resolve',
    title: 'CHANGED BY currentUser()',
    text: 'assignee CHANGED BY currentUser()',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('was-empty', {
    kind: 'parse',
    title: 'WAS EMPTY',
    text: 'assignee WAS EMPTY',
    expect: { canonical: 'assignee WAS EMPTY' },
  }),
  c('was-empty-resolve', {
    kind: 'resolve',
    title: 'WAS EMPTY resolves',
    text: 'assignee WAS EMPTY',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('changed-from-empty', {
    kind: 'parse',
    title: 'CHANGED FROM EMPTY',
    text: 'assignee CHANGED FROM EMPTY',
    expect: { canonical: 'assignee CHANGED FROM EMPTY' },
  }),
  c('lower-case-forms', {
    kind: 'parse',
    title: 'History keywords in lower case',
    text: 'status was "In Review" after 2026-01-01',
    expect: { canonical: 'status WAS "In Review" AFTER 2026-01-01' },
  }),
  c('changed-lower', {
    kind: 'parse',
    title: 'changed in lower case',
    text: 'assignee changed by "alice"',
    expect: { canonical: 'assignee CHANGED BY "alice"' },
  }),
  c('history-combined-with-and', {
    kind: 'parse',
    title: 'History clauses combine with others',
    text: 'status WAS Done AND status != Done',
    expect: { canonical: 'status WAS Done AND status != Done' },
  }),
  c('not-history', {
    kind: 'parse',
    title: 'NOT over a history clause',
    text: 'NOT status WAS Done',
    expect: { canonical: 'NOT status WAS Done' },
  }),
  c('changed-during-resolve-relative', {
    kind: 'resolve',
    title: 'DURING with relative dates resolves',
    text: 'status CHANGED DURING (-30d, -1d)',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('was-before-function', {
    kind: 'resolve',
    title: 'BEFORE a date function resolves',
    text: 'status WAS Done BEFORE startOfMonth()',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('field-without-history-in-jira', {
    kind: 'resolve',
    title: 'A field outside Jira’s six still has history here',
    text: 'summary CHANGED AFTER -1w',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('predicate-order-free', {
    kind: 'equivalent',
    title: 'Predicates in another order are the same query',
    texts: [
      'status WAS Done BY "alice" AFTER 2026-01-01',
      'status WAS Done AFTER 2026-01-01 BY "alice"',
    ],
    catalogue: CATALOGUE,
    verify: 'predicate order is not significant; this suite expects the same plan either way',
  }),
];
