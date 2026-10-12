import type { QueryCase } from '../case';
import { CATALOGUE, section } from './fixtures';

const filters = section('QRY-011', 'saved-searches', '01b 1.5, 1.7');
const sprints = section('QRY-013', 'sprints', 'QRY-013');

/** The native name, then the Jira-compatible names (`filter` first). */
const FILTER_NAMES = ['savedSearch', 'filter', 'request', 'savedFilter', 'searchRequest'];

export const FILTER_CASES: QueryCase[] = [
  ...FILTER_NAMES.flatMap((name) => [
    filters(`${name.toLowerCase()}-by-id`, {
      kind: 'parse',
      title: `${name} = id`,
      text: `${name} = 10001`,
      expect: { canonical: `${name} = 10001` },
    }),
    filters(`${name.toLowerCase()}-by-name`, {
      kind: 'parse',
      title: `${name} = name`,
      text: `${name} = "My open work"`,
      expect: { canonical: `${name} = "My open work"` },
    }),
    filters(`${name.toLowerCase()}-resolve`, {
      kind: 'resolve',
      title: `${name} resolves`,
      text: `${name} = 10001`,
      catalogue: CATALOGUE,
      expect: { ok: true },
    }),
    filters(`${name.toLowerCase()}-same-as-saved-search`, {
      kind: 'equivalent',
      title: `${name} is savedSearch`,
      texts: ['savedSearch = 10001', `${name} = 10001`],
      catalogue: CATALOGUE,
    }),
  ]),
  filters('saved-search-in-list', {
    kind: 'parse',
    title: 'savedSearch IN a list',
    text: 'savedSearch IN (10001, 10002)',
    expect: { canonical: 'savedSearch IN (10001, 10002)' },
  }),
  filters('saved-search-not-in', {
    kind: 'parse',
    title: 'savedSearch NOT IN a list',
    text: 'savedSearch NOT IN (10001)',
    expect: { canonical: 'savedSearch NOT IN (10001)' },
  }),
  filters('saved-search-ne', {
    kind: 'parse',
    title: 'savedSearch !=',
    text: 'savedSearch != 10001',
    expect: { canonical: 'savedSearch != 10001' },
  }),
  filters('saved-search-combined', {
    kind: 'parse',
    title: 'A saved search reference combined with clauses',
    text: 'savedSearch = 10001 AND status = Open ORDER BY created DESC',
    expect: { canonical: 'savedSearch = 10001 AND status = Open ORDER BY created DESC' },
  }),
  filters('saved-search-self-reference', {
    kind: 'resolve',
    title: 'A saved search that references itself is refused on save',
    text: 'savedSearch = 10001',
    catalogue: CATALOGUE,
    expect: { ok: true },
    verify:
      'cycle detection needs the saved searches themselves (QRY-011 acceptance 2); at resolution the reference is a plain value',
  }),
];

export const SPRINT_CASES: QueryCase[] = [
  sprints('current', {
    kind: 'parse',
    title: 'sprint = @current',
    text: 'sprint = @current',
    expect: { canonical: 'sprint = @current' },
  }),
  sprints('next', {
    kind: 'parse',
    title: 'sprint = @next',
    text: 'sprint = @next',
    expect: { canonical: 'sprint = @next' },
  }),
  sprints('previous', {
    kind: 'parse',
    title: 'sprint = @previous',
    text: 'sprint = @previous',
    expect: { canonical: 'sprint = @previous' },
  }),
  sprints('in-tokens', {
    kind: 'parse',
    title: 'sprint IN (@current, @next)',
    text: 'sprint IN (@current, @next)',
    expect: { canonical: 'sprint IN (@current, @next)' },
  }),
  sprints('current-resolve', {
    kind: 'resolve',
    title: 'sprint = @current resolves',
    text: 'sprint = @current',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  sprints('unknown-token', {
    kind: 'resolve',
    title: 'An unknown @token is refused',
    text: 'sprint = @later',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'later' },
  }),
  sprints('token-on-other-field', {
    kind: 'resolve',
    title: '@current is refused outside sprint',
    text: 'status = @current',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'current' },
  }),
];
