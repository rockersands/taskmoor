import type { QueryCase } from '../case';
import { CATALOGUE, section } from './fixtures';

const c = section('QRY-006', 'dates', '01b 1.4');

const DATE_FIELDS = [
  'created',
  'updated',
  'due',
  'closed',
  'lastViewed',
  '"Target date"',
  'cf[10022]',
];

/** Absolute formats of section 1.4; the ones with a space or a slash are quoted. */
const ABSOLUTE: { slug: string; text: string; verify?: string }[] = [
  { slug: 'iso-date', text: '2026-01-31' },
  { slug: 'iso-datetime', text: '"2026-01-31 14:05"' },
  { slug: 'slash-date', text: '"2026/01/31"' },
  { slug: 'slash-datetime', text: '"2026/01/31 14:05"' },
];

const RELATIVE = ['-1d', '-2w', '-3h', '-30m', '+1d', '1w', '-1M', '-1y'];

const FUNCTIONS = [
  'startOfDay',
  'startOfWeek',
  'startOfMonth',
  'startOfYear',
  'endOfDay',
  'endOfWeek',
  'endOfMonth',
  'endOfYear',
];
const INCREMENTS = ['', '-1d', '+1w', '2M', '-1y'];

const slug = (s: string) =>
  s
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

export const DATE_CASES: QueryCase[] = [
  ...DATE_FIELDS.flatMap((field) => [
    ...ABSOLUTE.flatMap(({ slug: s, text, verify }) => {
      const query = `${field} >= ${text}`;
      return [
        c(`${s}-${slug(field)}-parse`, {
          kind: 'parse',
          title: `${field} >= ${text} parses`,
          text: query,
          expect: { canonical: query },
          ...(verify ? { verify } : {}),
        }),
        c(`${s}-${slug(field)}-resolve`, {
          kind: 'resolve',
          title: `${field} >= ${text} resolves`,
          text: query,
          catalogue: CATALOGUE,
          expect: { ok: true },
        }),
      ];
    }),
    ...RELATIVE.flatMap((r) => {
      const query = `${field} > ${r}`;
      return [
        c(`relative-${slug(r)}-${slug(field)}-parse`, {
          kind: 'parse',
          title: `${field} > ${r} parses`,
          text: query,
          expect: { canonical: query },
        }),
        c(`relative-${slug(r)}-${slug(field)}-resolve`, {
          kind: 'resolve',
          title: `${field} > ${r} resolves`,
          text: query,
          catalogue: CATALOGUE,
          expect: { ok: true },
        }),
      ];
    }),
  ]),
  ...FUNCTIONS.flatMap((fn) =>
    INCREMENTS.flatMap((inc) => {
      const query = `created >= ${fn}(${inc})`;
      return [
        c(`${slug(fn)}-${inc ? slug(inc) : 'plain'}-parse`, {
          kind: 'parse',
          title: `${fn}(${inc}) parses`,
          text: query,
          expect: { canonical: query },
        }),
        c(`${slug(fn)}-${inc ? slug(inc) : 'plain'}-resolve`, {
          kind: 'resolve',
          title: `${fn}(${inc}) resolves`,
          text: query,
          catalogue: CATALOGUE,
          expect: { ok: true },
        }),
      ];
    }),
  ),
  c('unquoted-slash-date', {
    kind: 'parse',
    title: 'A slash date without quotes',
    text: 'created >= 2026/01/31',
    expect: { canonical: 'created >= 2026/01/31' },
    verify:
      'the public description lists the format but not whether quotes are needed; the suite expects it to parse bare',
  }),
  c('date-window', {
    kind: 'resolve',
    title: 'A date window with two bounds',
    text: 'created >= 2026-01-01 AND created < 2026-02-01',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('date-equals-day', {
    kind: 'resolve',
    title: '= a day',
    text: 'created = 2026-01-31',
    catalogue: CATALOGUE,
    expect: { ok: true },
    verify: 'equality with a date means within that day',
  }),
  c('invalid-day', {
    kind: 'resolve',
    title: 'An impossible date is refused',
    text: 'created > 2026-02-30',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'date' },
  }),
  c('invalid-month', {
    kind: 'resolve',
    title: 'An impossible month is refused',
    text: 'created > 2026-13-01',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'date' },
  }),
  c('word-not-date', {
    kind: 'resolve',
    title: 'A word that is not a date is refused',
    text: 'created > yesterday',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'date' },
  }),
  c('bad-duration-unit', {
    kind: 'resolve',
    title: 'A duration with an unknown unit is refused',
    text: 'created > -1q',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'date' },
  }),
  c('now-function', {
    kind: 'resolve',
    title: 'now()',
    text: 'created <= now()',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('date-in-list', {
    kind: 'resolve',
    title: 'Dates in an IN list',
    text: 'due IN (2026-01-31, 2026-02-28)',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('week-starts-per-site', {
    kind: 'resolve',
    title: 'startOfWeek() follows the site setting for the first day',
    text: 'created >= startOfWeek(-1w)',
    catalogue: CATALOGUE,
    expect: { ok: true },
    verify:
      'the week boundary depends on a site setting and the user time zone; this suite only checks that the query resolves',
  }),
  c('same-items-across-time-zones', {
    kind: 'equivalent',
    title: 'The same query text is the same plan for every user (time zone applies at execution)',
    texts: ['created >= startOfWeek(-1w)', 'created >= startOfWeek(-1w)'],
    catalogue: CATALOGUE,
    verify:
      'QRY-006 acceptance 1 needs execution against data; covered when the compiler runs the suite',
  }),
  c('increment-years', {
    kind: 'resolve',
    title: 'A year increment',
    text: 'created >= startOfYear(-2y)',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('increment-hours', {
    kind: 'resolve',
    title: 'An hour increment',
    text: 'updated >= startOfDay(-4h)',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('increment-minutes', {
    kind: 'resolve',
    title: 'A minute increment',
    text: 'updated >= now(-30m)',
    catalogue: CATALOGUE,
    expect: { ok: true },
    verify: 'now() with an increment is accepted here; Jira has no argument on now()',
  }),
];
