import type { QueryCase } from '../case';
import { CATALOGUE, FUNCTIONS, type SpecFunction, section } from './fixtures';

const c = section('QRY-004', 'functions', '01b 1.6');

const call = (name: string, args: string[]) => `${name}(${args.join(', ')})`;

function usage(f: SpecFunction, name: string, args: string[]): string {
  const { field, op } = f.usage;
  return op === 'IN' ? `${field} IN ${call(name, args)}` : `${field} ${op} ${call(name, args)}`;
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();

function casesFor(f: SpecFunction): QueryCase[] {
  const names = f.legacy ? [f.name, f.legacy] : [f.name];
  const out: QueryCase[] = [];
  for (const name of names) {
    const text = usage(f, name, f.sample);
    const legacy = name === f.legacy ? ' (legacy name)' : '';
    out.push(
      c(`${slug(name)}-parse`, {
        kind: 'parse',
        title: `${name}()${legacy} parses`,
        text,
        expect: { canonical: text },
      }),
      c(`${slug(name)}-resolve`, {
        kind: 'resolve',
        title: `${name}()${legacy} resolves`,
        text,
        catalogue: CATALOGUE,
        expect: { ok: true },
      }),
      c(`${slug(name)}-case`, {
        kind: 'equivalent',
        title: `${name}() in any case is the same function`,
        texts: [text, usage(f, name.toUpperCase(), f.sample)],
        catalogue: CATALOGUE,
      }),
    );
    if (f.legacy && name === f.legacy) {
      out.push(
        c(`${slug(name)}-same-as-new`, {
          kind: 'equivalent',
          title: `${f.legacy}() is ${f.name}()`,
          texts: [usage(f, f.name, f.sample), text],
          catalogue: CATALOGUE,
        }),
      );
    }
  }
  // Bad arguments are refused naming the argument.
  const [min, max] = f.args;
  if (max < 100) {
    out.push(
      c(`${slug(f.name)}-too-many-args`, {
        kind: 'resolve',
        title: `${f.name}() with too many arguments is refused`,
        text: usage(f, f.name, [
          ...f.sample,
          ...Array.from({ length: max - f.sample.length + 1 }, () => '"extra"'),
        ]),
        catalogue: CATALOGUE,
        expect: { ok: false, message: '' },
        verify: 'the refusal must name the argument; the wording is open',
      }),
    );
  }
  if (min > 0) {
    out.push(
      c(`${slug(f.name)}-too-few-args`, {
        kind: 'resolve',
        title: `${f.name}() without its required argument is refused`,
        text: usage(f, f.name, []),
        catalogue: CATALOGUE,
        expect: { ok: false, message: '' },
        verify: 'the refusal must name the argument; the wording is open',
      }),
    );
  }
  return out;
}

export const FUNCTION_CASES: QueryCase[] = [
  ...FUNCTIONS.flatMap(casesFor),
  c('current-user-on-user-field-only', {
    kind: 'resolve',
    title: 'currentUser() is refused on a non-user field',
    text: 'status = currentUser()',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'currentUser' },
  }),
  c('date-function-on-user-field', {
    kind: 'resolve',
    title: 'A date function is refused on a user field',
    text: 'assignee = startOfDay()',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'startOfDay' },
  }),
  c('unknown-function', {
    kind: 'resolve',
    title: 'An unknown function is refused by name',
    text: 'created > nosuchFunction()',
    catalogue: CATALOGUE,
    expect: { ok: false, message: 'nosuchFunction' },
  }),
  c('members-of-team', {
    kind: 'parse',
    title: 'membersOf() accepts a team id',
    text: 'assignee IN membersOf("id:7c1d")',
    expect: { canonical: 'assignee IN membersOf("id:7c1d")' },
  }),
  c('members-of-not-in', {
    kind: 'parse',
    title: 'NOT IN membersOf()',
    text: 'assignee NOT IN membersOf("developers")',
    expect: { canonical: 'assignee NOT IN membersOf("developers")' },
  }),
  c('function-in-list', {
    kind: 'parse',
    title: 'A function among list values',
    text: 'assignee IN (currentUser(), "alice")',
    expect: { canonical: 'assignee IN (currentUser(), "alice")' },
  }),
  c('nested-function-arguments', {
    kind: 'parse',
    title: 'Function arguments may be functions',
    text: 'key IN updatedBy(currentUser(), startOfWeek())',
    expect: { canonical: 'key IN updatedBy(currentUser(), startOfWeek())' },
  }),
  c('linked-issues-legacy-two-link-types', {
    kind: 'parse',
    title: 'linkedIssues() with several link types',
    text: 'key IN linkedIssues(ABC-12, "blocks", "is blocked by")',
    expect: { canonical: 'key IN linkedIssues(ABC-12, "blocks", "is blocked by")' },
  }),
  c('sprint-functions-combined', {
    kind: 'parse',
    title: 'Sprint functions combine with OR',
    text: 'sprint IN openSprints() OR sprint IN futureSprints()',
    expect: { canonical: 'sprint IN openSprints() OR sprint IN futureSprints()' },
  }),
  c('released-versions-no-space', {
    kind: 'parse',
    title: 'releasedVersions() without a space argument',
    text: 'fixVersion IN releasedVersions()',
    expect: { canonical: 'fixVersion IN releasedVersions()' },
  }),
];
