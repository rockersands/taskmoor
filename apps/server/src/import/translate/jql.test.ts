import {
  type CustomField,
  type CustomType,
  makeCatalogue,
  parseQuery,
  QueryError,
  resolveQuery,
} from '@taskmoor/query';
import { stableJson } from '@taskmoor/testkit/golden';
import { describe, expect, it } from 'vitest';
import type { Ref } from '../model';
import { CORPUS, type Vocabulary } from './corpus';
import {
  analyseQuery,
  NOTE,
  type Note,
  refusal,
  renderQuery,
  type SourceCatalogue,
  type SourceField,
  type TargetLookup,
} from './jql';

/** A fixed source: the corpus's vocabulary with the source's ids. */
const V: Vocabulary = {
  project: { id: 10000, key: 'ABC', name: 'Alpha Billing' },
  other: { id: 10001, key: 'OPS' },
  status: { id: 10100, name: 'In Progress' },
  doneStatus: { id: 10101, name: 'Done' },
  priority: { id: 10200, name: 'High' },
  resolution: { id: 10300, name: 'Fixed' },
  type: { id: 10400, name: 'Defect' },
  person: { username: 'ada.l', key: 'JIRAUSER10500' },
  otherPerson: { username: 'grace.h', key: 'grace.h' },
  group: 'release-managers',
  role: 'Developers',
  number: { id: 10600, name: 'Effort' },
  text: { id: 10601, name: 'Customer' },
  date: { id: 10602, name: 'Target date' },
  select: { id: 10603, name: 'Severity', option: { id: 10700, value: 'Major' } },
  multi: { id: 10604, name: 'Platforms', option: { id: 10710, value: 'Web' } },
  cascade: {
    id: 10605,
    name: 'Region',
    parent: { id: 10720, value: 'Europe' },
    child: { id: 10721, value: 'North' },
  },
  userField: { id: 10606, name: 'Reviewer' },
  labelsField: { id: 10607, name: 'Topics' },
  appField: { id: 10608, name: 'Rating' },
  filter: { id: 10800, name: 'Open defects' },
  sprint: { id: 7, name: 'ABC sprint 3' },
  level: { id: 10900, name: 'Staff only' },
  issue: { id: 11000, key: 'ABC-12' },
};

const FIELDS: (SourceField & { target: number })[] = [
  { id: '10600', name: 'Effort', type: 'number', target: 3 },
  { id: '10601', name: 'Customer', type: 'text', target: 4 },
  { id: '10602', name: 'Target date', type: 'date', target: 5 },
  { id: '10603', name: 'Severity', type: 'option', target: 6 },
  { id: '10604', name: 'Platforms', type: 'multi', target: 7 },
  { id: '10605', name: 'Region', type: 'cascade', target: 8 },
  { id: '10606', name: 'Reviewer', type: 'user', target: 9 },
  { id: '10607', name: 'Topics', type: 'labels', target: 10 },
  { id: '10608', name: 'Rating', type: 'text', target: 11 },
  // Not imported: a query naming it cannot translate.
  { id: '10609', name: 'Old plugin field', type: null, target: 0 },
];

const PEOPLE: Record<string, string> = {
  'ada.l': 'jirauser10500',
  jirauser10500: 'jirauser10500',
  'grace.h': 'grace.h',
};

const source: SourceCatalogue = {
  field: (id) => FIELDS.find((f) => f.id === id),
  fieldsNamed: (name) => FIELDS.filter((f) => f.name.toLowerCase() === name.toLowerCase()),
  person: (raw) => PEOPLE[raw.toLowerCase()],
  project: (raw) =>
    [
      { id: '10000', key: 'ABC', name: 'Alpha Billing' },
      { id: '10001', key: 'OPS', name: 'Operations' },
    ].find(
      (p) =>
        p.id === raw ||
        p.key.toLowerCase() === raw.toLowerCase() ||
        p.name.toLowerCase() === raw.toLowerCase(),
    ),
  savedSearches: (raw) =>
    raw === '10800' || raw.toLowerCase() === 'open defects' ? ['10800'] : [],
};

/** The target: what each source object became. */
const TARGET: Record<string, string | number> = {
  'track 10000': 'ABC',
  'track 10001': 'OPS',
  'status 10100': 'In Progress',
  'status 10101': 'Done',
  'priority 10200': 'High',
  'close_reason 10300': 'Fixed',
  'ticket_type 10400': 'Defect',
  'visibility_level 10900': 'Staff only',
  'user jirauser10500': 'ada@example.test',
  'user grace.h': 'grace@example.test',
  'field_option 10700': 'Major',
  'field_option 10710': 'Web',
  'field_option 10720': 'Europe',
  'field_option 10721': 'North',
  'saved_search 10800': 41,
  'ticket 11000': 912,
  'sprint 7': 3,
};

const target: TargetLookup = {
  field: (ref: Ref) => FIELDS.find((f) => f.id === ref.id)?.target ?? null,
  value: (ref, as) => {
    const found = TARGET[`${ref.kind} ${ref.id}`];
    if (found === undefined) return null;
    const span = { start: 0, end: 0 };
    if (as === 'key') return { kind: 'word', value: String(found), span };
    if (as === 'id') return { kind: 'number', value: Number(found), span };
    return { kind: 'string', value: String(found), span };
  },
};

const customs: CustomField[] = FIELDS.filter((f) => f.type !== null).map((f) => ({
  kind: 'custom',
  id: f.target,
  name: f.name,
  type: f.type as CustomType,
}));
const catalogue = makeCatalogue(customs, { ABC: 1, OPS: 2 });

type Outcome =
  | { outcome: 'translated' | 'changed' | 'flagged'; native: string; notes: Note[] }
  | { outcome: 'untranslatable'; problems: Note[] };

/** Both steps, then the target's own resolver, as the import checks a translated query. */
function translate(text: string): Outcome {
  const a = analyseQuery(text, source);
  if (!a.template) return { outcome: 'untranslatable', problems: a.problems };
  const rendered = renderQuery(a.template, target);
  if ('problems' in rendered) return { outcome: 'untranslatable', problems: rendered.problems };
  try {
    resolveQuery(parseQuery(rendered.text), catalogue, {
      currentUserId: 1,
      now: new Date('2026-01-01T00:00:00Z'),
    });
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    return { outcome: 'untranslatable', problems: [refusal(error)] };
  }
  const outcome = a.flags.length > 0 ? 'flagged' : a.changes.length > 0 ? 'changed' : 'translated';
  return { outcome, native: rendered.text, notes: [...a.flags, ...a.changes] };
}

describe('Translating saved queries (M1-094)', () => {
  const results = CORPUS.map((entry) => {
    const query = entry.query(V);
    return { id: entry.id, title: entry.title, query, entry, result: translate(query) };
  });

  it('[IMP-004] translates the whole corpus: every query translated or reported with a reason', () => {
    expect(new Set(CORPUS.map((e) => e.id)).size).toBe(CORPUS.length);
    for (const { id, entry, result } of results) {
      expect(result.outcome, `${id}: ${JSON.stringify(result)}`).toBe(entry.expect);
      if (result.outcome === 'untranslatable') {
        expect(result.problems.length, id).toBeGreaterThan(0);
        for (const p of result.problems) {
          expect(p.code, id).toMatch(/^[a-z_]+$/);
          expect(p.detail, id).not.toBe('');
          expect(p.message, id).not.toBe('');
        }
        const reason = entry.reason?.(V);
        expect(reason, `${id} names its reason`).toBeDefined();
        const found = result.problems.find((p) => p.code === reason?.code);
        expect(found, `${id}: ${JSON.stringify(result.problems)}`).toBeDefined();
        if (reason?.detail) expect(found?.detail, id).toContain(reason.detail);
      }
    }
    // Every outcome is in the corpus, the reasons included.
    const outcomes = new Set(results.map((r) => r.result.outcome));
    expect([...outcomes].sort()).toEqual(['changed', 'flagged', 'translated', 'untranslatable']);
  });

  it('[IMP-004] [QRY-003] maps ids and names to the imported objects', () => {
    const native = (id: string) => {
      const r = results.find((x) => x.id === id)?.result;
      return r && 'native' in r ? r.native : null;
    };
    expect(native('project-id')).toBe('track = ABC');
    expect(native('project-name')).toBe('track = ABC AND status != "Done"');
    expect(native('status-id')).toBe('status = "In Progress"');
    expect(native('assignee-user')).toBe('assignee = "ada@example.test"');
    expect(native('cf-select-id')).toBe('cf[6] = "Major"');
    expect(native('cf-number-name')).toBe('cf[3] >= 5 AND cf[3] IS NOT EMPTY');
    expect(native('cf-cascade')).toBe('cf[8] IN cascadeOption("Europe", "North")');
    expect(native('filter-id')).toBe('savedSearch = 41 AND closeReason IS EMPTY');
    expect(native('filter-name')).toBe('savedSearch = 41 ORDER BY updated DESC');
    expect(native('key-list')).toBe('key IN (ABC-12, 912)');
    expect(native('status-category')).toBe('stage = closed OR stage = "In Progress"');
    expect(native('unresolved')).toBe('closeReason IS EMPTY OR closeReason IS EMPTY');
    expect(native('board-filter')).toBe('track = ABC');
    expect(native('projects-lead-user')).toBe('track IN tracksOwnedByUser("ada@example.test")');
    expect(native('sprint-id')).toBe('sprint = 3');
  });

  it('[IMP-004] reports a reference that did not import', () => {
    const a = analyseQuery('resolution = 10399 AND cf[10609] = 1', source);
    expect(a.template).toBeNull();
    expect(a.problems.map((p) => p.code)).toEqual([NOTE.fieldNotImported]);
    const b = analyseQuery('resolution = 10399', source);
    const rendered = renderQuery(b.template as NonNullable<typeof b.template>, target);
    expect(rendered).toEqual({
      problems: [
        {
          code: NOTE.valueNotImported,
          detail: 'close_reason 10399',
          message: '"10399" names a close reason that was not imported',
        },
      ],
    });
  });

  it('[IMP-004] golden: the corpus and what it became', async () => {
    const golden = results.map(({ id, title, query, result }) => ({ id, title, query, ...result }));
    await expect(stableJson(golden)).toMatchFileSnapshot('./__golden__/corpus.json');
  });
});
