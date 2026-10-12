import { makeCatalogue } from '../../fields';
import type { QueryCase } from '../case';
import { CATALOGUE, CUSTOM_FIELDS, FIELDS, type SpecField, section } from './fixtures';

const c = section('QRY-003', 'fields', '01b 1.5');

/** The simplest clause that fits the field's type. */
export function clauseFor(name: string, f: SpecField): string {
  if (f.type === 'attachments') return `${name} IS EMPTY`;
  if (f.type === 'text') return `${name} ~ ${f.sample}`;
  if (f.type === 'sprint' || f.type === 'area' || f.type === 'release')
    return `${name} = ${f.sample}`;
  return `${name} = ${f.sample}`;
}

const slug = (name: string) =>
  name
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

function casesFor(f: SpecField, label: string): QueryCase[] {
  const names = [f.canonical, ...f.aliases];
  const out: QueryCase[] = [];
  for (const name of names) {
    const text = clauseFor(name, f);
    const alias = name === f.canonical ? '' : ` (as ${name})`;
    out.push(
      c(`${label}-${slug(name)}-parse`, {
        kind: 'parse',
        title: `${f.canonical}${alias} parses`,
        text,
        expect: { canonical: text },
      }),
      c(`${label}-${slug(name)}-resolve`, {
        kind: 'resolve',
        title: `${f.canonical}${alias} resolves`,
        text,
        catalogue: CATALOGUE,
        expect: { ok: true },
        ...(f.note ? { verify: f.note } : {}),
      }),
    );
    // Names are matched without regard to case (section 1.1); quoted names and cf[n] are as written.
    if (!name.startsWith('"') && !name.startsWith('cf[')) {
      out.push(
        c(`${label}-${slug(name)}-upper`, {
          kind: 'resolve',
          title: `${name.toUpperCase()} resolves like ${name}`,
          text: clauseFor(name.toUpperCase(), f),
          catalogue: CATALOGUE,
          expect: { ok: true },
        }),
        c(`${label}-${slug(name)}-lower`, {
          kind: 'resolve',
          title: `${name.toLowerCase()} resolves like ${name}`,
          text: clauseFor(name.toLowerCase(), f),
          catalogue: CATALOGUE,
          expect: { ok: true },
        }),
      );
    }
    if (name !== f.canonical) {
      out.push(
        c(`${label}-${slug(name)}-same-as-canonical`, {
          kind: 'equivalent',
          title: `${name} is the same field as ${f.canonical}`,
          texts: [clauseFor(f.canonical, f), text],
          catalogue: CATALOGUE,
        }),
      );
    }
  }
  return out;
}

const twoTeams = makeCatalogue(
  [
    { kind: 'custom', id: 10020, name: 'Team', type: 'option' },
    { kind: 'custom', id: 10030, name: 'Team', type: 'option' },
  ],
  { ABC: 1 },
);

export const FIELD_CASES: QueryCase[] = [
  ...FIELDS.flatMap((f) => casesFor(f, 'field')),
  ...CUSTOM_FIELDS.flatMap((f) => casesFor(f, 'custom')),
  c('both-vocabularies', {
    kind: 'equivalent',
    title: 'project = ABC AND issuetype = Bug is the same query as track = ABC AND type = Bug',
    texts: ['project = ABC AND issuetype = Bug', 'track = ABC AND type = Bug'],
    catalogue: CATALOGUE,
  }),
  c('both-vocabularies-order', {
    kind: 'equivalent',
    title: 'Both vocabularies in ORDER BY',
    texts: ['ORDER BY createdDate DESC, issuetype ASC', 'ORDER BY created DESC, type ASC'],
    catalogue: CATALOGUE,
  }),
  c('legacy-mixed-with-new', {
    kind: 'equivalent',
    title: 'Legacy and new names mix in one query',
    texts: [
      'project = ABC AND type = Bug AND createdDate > -1w',
      'track = ABC AND issuetype = Bug AND created > -1w',
    ],
    catalogue: CATALOGUE,
  }),
  c('ambiguous-custom-name', {
    kind: 'resolve',
    title: 'An ambiguous custom field name is refused with the candidate ids',
    text: 'Team = Platform',
    catalogue: twoTeams,
    expect: { ok: false, message: '10020' },
  }),
  c('ambiguous-resolved-by-id', {
    kind: 'resolve',
    title: 'The same field by id resolves',
    text: 'cf[10030] = Platform',
    catalogue: twoTeams,
    expect: { ok: true },
  }),
  c('unknown-field', {
    kind: 'resolve',
    title: 'An unknown field is refused by name',
    text: 'nosuchfield = 1',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'nosuchfield' },
  }),
  c('unknown-custom-id', {
    kind: 'resolve',
    title: 'An unknown custom field id is refused',
    text: 'cf[99999] = 1',
    catalogue: CATALOGUE,
    expect: { ok: false, message: '99999' },
  }),
  c('custom-by-name-and-id', {
    kind: 'equivalent',
    title: 'A custom field by name and by id is one field',
    texts: ['"Story Points" > 5', 'cf[10016] > 5'],
    catalogue: CATALOGUE,
  }),
  c('epic-link-rewritten', {
    kind: 'equivalent',
    title: '"Epic link" is parent',
    texts: ['"Epic link" = ABC-1', 'parent = ABC-1'],
    catalogue: CATALOGUE,
    verify: 'the retired "Epic link" field is read as parent',
  }),
  c('track-key-resolves', {
    kind: 'resolve',
    title: 'A track key resolves to its id',
    text: 'track = WEB',
    catalogue: CATALOGUE,
    expect: { ok: true },
  }),
  c('unknown-track-key', {
    kind: 'resolve',
    title: 'An unknown track key is refused',
    text: 'track = NOPE',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'NOPE' },
  }),
];
