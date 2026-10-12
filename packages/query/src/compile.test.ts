import { stableJson } from '@tracksmith/testkit';
import { describe, expect, it } from 'vitest';
import { compilePlan } from './compile';
import { makeCatalogue } from './fields';
import { QueryError } from './lexer';
import { parseQuery } from './parser';
import { resolveQuery } from './resolve';

const catalogue = makeCatalogue(
  [
    { kind: 'custom', id: 1, name: 'Story Points', type: 'number' },
    { kind: 'custom', id: 2, name: 'Team', type: 'option' },
    { kind: 'custom', id: 3, name: 'Due', type: 'date' },
    { kind: 'custom', id: 4, name: 'Owner', type: 'user' },
    { kind: 'custom', id: 5, name: 'Components', type: 'multi' },
    { kind: 'custom', id: 6, name: 'Notes', type: 'text' },
  ],
  { ABC: 1, DEF: 2 },
);
const ctx = { currentUserId: 42, now: new Date('2026-10-12T12:00:00Z') };

/** The representative set the M0-017 benchmark runs; the same strings with dataset names. */
export const BENCHMARK_QUERIES = [
  'space = ABC ORDER BY created DESC',
  'space = ABC AND status = "In Progress" ORDER BY updated DESC',
  'assignee = currentUser() AND statusCategory != done ORDER BY priority DESC, created DESC',
  'status IN (Backlog, "To Do") AND priority IN (High, Highest) ORDER BY created DESC',
  'labels IN (security, regression) ORDER BY created DESC',
  'summary ~ "login" ORDER BY created DESC',
  'created >= -30d AND type = Bug ORDER BY created DESC',
  'resolved IS EMPTY AND updated < -90d ORDER BY updated ASC',
  '"Story Points" > 5 AND space = ABC ORDER BY "Story Points" DESC',
  'Team = "Option 3" AND statusCategory = todo ORDER BY created DESC',
  'Due <= endOfMonth() AND Due >= startOfMonth() ORDER BY Due ASC',
  'Owner = currentUser() ORDER BY updated DESC',
  'Components IN (Alpha, Beta) AND status != Done ORDER BY created DESC',
  '"Story Points" IS EMPTY AND type IN (Story, Task) AND space = ABC ORDER BY created DESC',
  'parent = 12345 ORDER BY created ASC',
  '(assignee = currentUser() OR reporter = currentUser()) AND statusCategory != done ORDER BY updated DESC',
  'status WAS "In Review" AND status = Done ORDER BY updated DESC',
  'status CHANGED TO Done AFTER -7d ORDER BY updated DESC',
  'assignee CHANGED BY 42 DURING (2026-01-01, 2026-02-01) ORDER BY created DESC',
  'NOT (labels IN (infra) OR type = Subtask) AND space IN (ABC, DEF) ORDER BY created DESC',
];

function compile(text: string, allowedSpaceIds: number[] | null = [1, 2]) {
  const plan = resolveQuery(parseQuery(text), catalogue, ctx);
  return compilePlan(plan, {
    schema: 'fs_side',
    historyTable: 'gen.history',
    allowedSpaceIds,
    limit: 50,
  });
}

describe('compilePlan', () => {
  it('[QRY-003] compiles the benchmark set to the reviewed SQL', async () => {
    const out = Object.fromEntries(BENCHMARK_QUERIES.map((q) => [q, compile(q)]));
    await expect(stableJson(out)).toMatchFileSnapshot('./__golden__/compile.json');
  });

  it('numbers parameters in order and never inlines values', () => {
    const { text, params } = compile('summary ~ "50% off; DROP TABLE" AND "Story Points" > 3');
    expect(text).not.toContain('DROP');
    expect(params).toEqual([[1, 2], '%50\\% off; DROP TABLE%', 1, 3, 50]);
    expect(text).toContain('$2');
    expect(text).toMatch(/LIMIT \$5$/);
  });

  it('skips the space filter for callers who may see everything', () => {
    expect(compile('status = Done', null).text).not.toContain('space_id = ANY');
  });

  it('resolves relative dates and date functions against the context clock', () => {
    const { params } = compile('created >= -1w AND Due <= endOfMonth()');
    expect(params).toContain('2026-10-05T12:00:00.000Z');
    expect(params).toContain('2026-10-31');
  });
});

describe('resolveQuery errors', () => {
  it.each([
    ['nosuchfield = 1', 'Unknown field "nosuchfield"'],
    ['cf[999] = 1', 'Unknown field cf[999]'],
    ['"Story Points" ~ 3', '"Story Points" is not a text field; ~ needs one'],
    ['status > Done', '"status" cannot be compared with >; it is not a number or date'],
    ['summary IN (a, b)', 'IN cannot be used on the text field "summary"'],
    ['"Story Points" > EMPTY', 'EMPTY is only allowed with =, != and IS'],
    ['created > 2026-13-45', '"2026-13-45" is not a valid date'],
    ['space = ZZZ', 'Unknown space "ZZZ"'],
    ['created WAS -1d', '"created" keeps no change history'],
    ['created > nextLeapYear()', 'Unknown date function nextLeapYear()'],
    ['assignee = kalo', 'Expected a user ID or currentUser()'],
  ])('rejects "%s"', (text, message) => {
    let error: unknown;
    try {
      compile(text);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message.startsWith(message)).toBe(true);
  });

  it('needs a signed-in user for currentUser()', () => {
    const plan = () =>
      resolveQuery(parseQuery('assignee = currentUser()'), catalogue, {
        ...ctx,
        currentUserId: null,
      });
    expect(plan).toThrow(/currentUser\(\) needs a signed-in user/);
  });
});
