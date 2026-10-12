import type { QueryCase } from '../case';
import { CATALOGUE, CUSTOM_FIELDS, FIELDS, section } from './fixtures';

const c = section('QRY-009', 'ordering', '01b 1.7');

const slug = (s: string) =>
  s
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

const SORTABLE = [...FIELDS, ...CUSTOM_FIELDS].filter((f) => f.sortable);

export const ORDERING_CASES: QueryCase[] = [
  ...SORTABLE.flatMap((f) =>
    [f.canonical, ...f.aliases].flatMap((name) => [
      c(`${slug(name)}-default-asc`, {
        kind: 'parse',
        title: `ORDER BY ${name} defaults to ascending`,
        text: `ORDER BY ${name}`,
        expect: { canonical: `ORDER BY ${name} ASC` },
      }),
      c(`${slug(name)}-desc`, {
        kind: 'parse',
        title: `ORDER BY ${name} DESC`,
        text: `ORDER BY ${name} DESC`,
        expect: { canonical: `ORDER BY ${name} DESC` },
      }),
      c(`${slug(name)}-resolve`, {
        kind: 'resolve',
        title: `ORDER BY ${name} resolves`,
        text: `status = Open ORDER BY ${name} DESC`,
        catalogue: CATALOGUE,
        expect: { ok: true },
      }),
    ]),
  ),
  c('two-fields', {
    kind: 'parse',
    title: 'Two sort fields',
    text: 'ORDER BY priority DESC, created ASC',
    expect: { canonical: 'ORDER BY priority DESC, created ASC' },
  }),
  c('two-fields-resolve', {
    kind: 'resolve',
    title: 'Two sort fields resolve',
    text: 'ORDER BY priority DESC, created ASC',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('three-fields-mixed', {
    kind: 'parse',
    title: 'Three sort fields with defaults',
    text: 'ORDER BY priority DESC, "Story Points", created',
    expect: { canonical: 'ORDER BY priority DESC, "Story Points" ASC, created ASC' },
  }),
  c('custom-field-sort', {
    kind: 'resolve',
    title: 'Sorting by a custom field',
    text: 'ORDER BY "Story Points" DESC',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('custom-id-sort', {
    kind: 'resolve',
    title: 'Sorting by a custom field id',
    text: 'ORDER BY cf[10016] DESC',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('lower-case-direction', {
    kind: 'parse',
    title: 'asc and desc in lower case',
    text: 'ORDER BY created desc, key asc',
    expect: { canonical: 'ORDER BY created DESC, key ASC' },
  }),
  c('after-where', {
    kind: 'parse',
    title: 'ORDER BY after a where part',
    text: 'status = Open ORDER BY created DESC',
    expect: { canonical: 'status = Open ORDER BY created DESC' },
  }),
  c('after-parens', {
    kind: 'parse',
    title: 'ORDER BY after a parenthesised where part',
    text: '(status = Open OR status = Done) ORDER BY created DESC',
    expect: { canonical: 'status = Open OR status = Done ORDER BY created DESC' },
  }),
  c('unknown-sort-field', {
    kind: 'resolve',
    title: 'An unknown sort field is refused',
    text: 'ORDER BY nosuch DESC',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'nosuch' },
  }),
  c('same-field-twice', {
    kind: 'parse',
    title: 'The same field twice parses (the second is redundant)',
    text: 'ORDER BY created DESC, created ASC',
    expect: { canonical: 'ORDER BY created DESC, created ASC' },
  }),
  c('default-order-created-desc', {
    kind: 'resolve',
    title: 'Without ORDER BY results sort by created descending',
    text: 'status = Open',
    catalogue: CATALOGUE,
    expect: { ok: true },
    verify:
      'the default order is stated with a verify note in the spec; the compiler applies it, so this case only checks resolution',
  }),
  c('order-by-twice-refused', {
    kind: 'parse-error',
    title: 'Two ORDER BY parts are refused',
    text: 'ORDER BY created ORDER BY key',
    expect: { at: 17, message: 'Unexpected' },
  }),
  c('order-by-trailing-comma', {
    kind: 'parse-error',
    title: 'A trailing comma is refused',
    text: 'ORDER BY created,',
    expect: { at: 17, message: 'Expected a field name' },
  }),
];
