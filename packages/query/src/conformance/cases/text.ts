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
  // M1-040: the search syntax's own refusals, and ordering by relevance.
  ...(
    [
      ['only-excluded', '"-password"', 'cannot only exclude words', 'Only excluded terms'],
      ['no-words', '"+ - *"', 'no words to look for', 'A search without a letter or digit'],
      ['fuzzy-wildcard', '"lo?in~"', 'both fuzzy (~) and a wildcard', 'A fuzzy wildcard'],
      ['three-wildcards', '"a?b?c?d"', 'at most 2 ? wildcards', 'Three ? in a word'],
      ['leading-star', '"*Exception"', 'can only end a word', 'A * in front of a word'],
    ] as const
  ).map(([s, value, message, title]) =>
    c(`refused-${s}`, {
      kind: 'resolve',
      title: `${title} is refused`,
      text: `text ~ ${value}`,
      catalogue: CATALOGUE,
      expect: { ok: false, message },
    }),
  ),
  c('refused-inner-star', {
    kind: 'resolve',
    title: 'A * inside a word is refused: searches match words',
    text: 'summary ~ "Null*Pointer"',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'can only end a word' },
  }),
  c('relevance-order', {
    kind: 'resolve',
    title: 'Results order by relevance when the query searches text',
    text: 'text ~ login AND status = Open ORDER BY relevance',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('relevance-order-print', {
    kind: 'parse',
    title: 'ORDER BY relevance prints with its direction',
    text: 'summary ~ login order by relevance',
    expect: { canonical: 'summary ~ login ORDER BY relevance ASC' },
  }),
  c('relevance-needs-search', {
    kind: 'resolve',
    title: 'ORDER BY relevance without a text search is refused',
    text: 'status = Open ORDER BY relevance',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'needs a text search' },
  }),
  c('relevance-negated-search', {
    kind: 'resolve',
    title: 'A negated text search ranks nothing',
    text: 'NOT summary ~ login ORDER BY relevance',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'needs a text search' },
  }),
  c('relevance-double-negation', {
    kind: 'resolve',
    title: 'NOT ... !~ is a search relevance ranks',
    text: 'NOT summary !~ login ORDER BY relevance DESC',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('relevance-not-a-condition', {
    kind: 'resolve',
    title: 'relevance takes no operator',
    text: 'relevance > 1',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'only orders results' },
  }),
];
