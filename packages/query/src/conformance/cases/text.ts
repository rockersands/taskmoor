import type { QueryCase } from '../case';
import { CATALOGUE, section } from './fixtures';

const c = section('QRY-007', 'text', '01b 1.8');

const TEXT_FIELDS = [
  'text',
  'summary',
  'description',
  'comment',
  'environment',
  'Notes',
  'timeEntryComment',
];

/** Search syntax inside the string is opaque to the grammar; each form must survive printing. */
const FORMS: { slug: string; value: string; title: string }[] = [
  { slug: 'word', value: '"login"', title: 'a word' },
  { slug: 'words-anded', value: '"login password"', title: 'two words (ANDed)' },
  { slug: 'phrase', value: '"\\"login failed\\""', title: 'a quoted phrase' },
  { slug: 'wildcard', value: '"log*"', title: 'a trailing wildcard' },
  { slug: 'single-char', value: '"lo?in"', title: 'a single-character wildcard' },
  { slug: 'fuzzy', value: '"login~"', title: 'a fuzzy term' },
  { slug: 'exclude', value: '"login -password"', title: 'an excluded term' },
  { slug: 'escaped-reserved', value: '"C\\\\+\\\\+"', title: 'escaped reserved characters' },
  { slug: 'upper', value: '"LOGIN"', title: 'upper case (search is case-insensitive)' },
];

const slug = (s: string) =>
  s
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

export const TEXT_CASES: QueryCase[] = [
  ...TEXT_FIELDS.flatMap((field) =>
    FORMS.flatMap(({ slug: s, value, title }) => {
      const text = `${field} ~ ${value}`;
      return [
        c(`${s}-${slug(field)}-parse`, {
          kind: 'parse',
          title: `${field} ~ ${title} parses`,
          text,
          expect: { canonical: text },
        }),
        c(`${s}-${slug(field)}-resolve`, {
          kind: 'resolve',
          title: `${field} ~ ${title} resolves`,
          text,
          catalogue: CATALOGUE,
          expect: { ok: true },
        }),
      ];
    }),
  ),
  ...TEXT_FIELDS.map((field) =>
    c(`not-contains-${slug(field)}`, {
      kind: 'resolve',
      title: `${field} !~ resolves`,
      text: `${field} !~ "login"`,
      catalogue: CATALOGUE,
      expect: { ok: true },
    }),
  ),
  c('text-master-field', {
    kind: 'parse',
    title:
      'The master text field searches summary, description, environment, comments and free-text fields',
    text: 'text ~ "login"',
    expect: { canonical: 'text ~ "login"' },
  }),
  c('single-quoted-search', {
    kind: 'parse',
    title: 'A single-quoted search prints double-quoted',
    text: "summary ~ 'login'",
    expect: { canonical: 'summary ~ "login"' },
  }),
  c('contains-and-equals', {
    kind: 'parse',
    title: 'Text search combined with other clauses',
    text: 'text ~ "login" AND status = Open',
    expect: { canonical: 'text ~ "login" AND status = Open' },
  }),
  c('contains-unquoted-word', {
    kind: 'parse',
    title: 'A bare word after ~',
    text: 'summary ~ login',
    expect: { canonical: 'summary ~ login' },
  }),
  c('contains-unquoted-resolve', {
    kind: 'resolve',
    title: 'A bare word after ~ resolves',
    text: 'summary ~ login',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('contains-number-text', {
    kind: 'resolve',
    title: 'A number after ~ on a text field is searched as text',
    text: 'summary ~ 404',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('contains-empty-refused', {
    kind: 'resolve',
    title: '~ EMPTY is refused',
    text: 'summary ~ EMPTY',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'EMPTY' },
  }),
];
