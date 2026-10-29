import { describe, expect, it } from 'vitest';
import { wallClock } from './dates';
import { FUNCTION_NAMES, nativeFunctionName, nativePermissionName } from './dialect';
import { type CustomField, makeCatalogue } from './fields';
import { arity, FUNCTIONS } from './functions';
import { QueryError } from './lexer';
import { parseQuery } from './parser';
import { type Pred, type ResolveContext, resolveQuery, type Typed } from './resolve';

/**
 * The functions of section 1.6 in the resolver (M1-038; QRY-004, QRY-006): signatures, the
 * refusals that name the argument, what the resolver evaluates itself (the person, dates on
 * the person's wall clock) and what it leaves to the server as a call with typed arguments.
 */
const CUSTOMS: CustomField[] = [
  { kind: 'custom', id: 10, name: 'Team', type: 'option' },
  { kind: 'custom', id: 11, name: 'Kind', type: 'cascade' },
  { kind: 'custom', id: 12, name: 'Review day', type: 'date' },
];
const catalogue = makeCatalogue(CUSTOMS, { ABC: 1, DEF: 2 });
const NOW = new Date('2026-10-14T03:00:00Z');
const base: ResolveContext = { currentUserId: 7, now: NOW };

const where = (text: string, ctx: Partial<ResolveContext> = {}) =>
  resolveQuery(parseQuery(text), catalogue, { ...base, ...ctx }).where as Pred;

/** The single value of a one-clause query. */
function value(text: string, ctx: Partial<ResolveContext> = {}): Typed {
  const p = where(text, ctx);
  if (p.kind === 'compare') return p.value;
  if (p.kind === 'in') return p.values[0] as Typed;
  throw new Error(`no single value in ${text}`);
}

const instant = (text: string, ctx: Partial<ResolveContext> = {}) => {
  const v = value(text, ctx);
  if (v.type !== 'datetime') throw new Error(`${text} is not an instant`);
  return v.value;
};

function refusal(text: string, ctx: Partial<ResolveContext> = {}): string {
  try {
    where(text, ctx);
    return 'accepted';
  } catch (e) {
    if (e instanceof QueryError) return e.detail;
    throw e;
  }
}

describe('query functions (M1-038)', () => {
  it('[QRY-004] knows every function of section 1.6 under every name the dialect lists', () => {
    const natives = new Set(FUNCTIONS.map((f) => f.name));
    for (const [native, ...jira] of FUNCTION_NAMES) {
      expect(natives.has(native), native).toBe(true);
      for (const name of [native, ...jira]) {
        expect(nativeFunctionName(name), name).toBe(native);
        expect(nativeFunctionName(name.toUpperCase()), name).toBe(native);
      }
    }
    expect(FUNCTION_NAMES.map(([native]) => native).sort()).toEqual([...natives].sort());
  });

  it('[QRY-004] leaves what only the database knows to the server, arguments typed', () => {
    expect(value('key IN linkedIssues(abc-12, "is blocked by", blocks)')).toEqual({
      type: 'call',
      fn: 'linkedTickets',
      args: [
        { type: 'text', value: 'ABC-12' },
        { type: 'text', value: 'is blocked by' },
        { type: 'text', value: 'blocks' },
      ],
    });
    expect(value('key IN updatedBy(currentUser(), "2026-10-01", now())')).toEqual({
      type: 'call',
      fn: 'updatedBy',
      args: [
        { type: 'number', value: 7 },
        { type: 'datetime', value: new Date('2026-10-01T00:00:00Z') },
        { type: 'datetime', value: NOW },
      ],
    });
    expect(value('assignee IN membersOf("QA team")')).toEqual({
      type: 'call',
      fn: 'membersOf',
      args: [{ type: 'text', value: 'QA team' }],
    });
    // A group's members also stand for a person in a list and after BY.
    expect(where('assignee IN (alice, membersOf(qa), currentUser())')).toMatchObject({
      values: [
        { type: 'text', value: 'alice' },
        { type: 'call', fn: 'membersOf' },
        { type: 'number', value: 7 },
      ],
    });
    expect(value('track IN projectsLeadByUser()')).toEqual({
      type: 'call',
      fn: 'tracksOwnedByUser',
      args: [],
    });
    expect(value('key IN watchedIssues()')).toEqual({
      type: 'call',
      fn: 'followedTickets',
      args: [],
    });
    expect(value('targetRelease = latestReleasedVersion(DEF)')).toEqual({
      type: 'call',
      fn: 'latestShippedRelease',
      args: [{ type: 'number', value: 2 }],
    });
    expect(value('Kind IN cascadeOption(Hardware, Laptop)')).toMatchObject({
      fn: 'cascadeOption',
    });
  });

  it.each([
    ['assignee = currentUser(1)', 'currentUser() takes no arguments'],
    ['assignee IN membersOf()', 'membersOf() needs its group (the first argument)'],
    [
      'assignee IN membersOf(a, b)',
      'membersOf() takes at most 1 argument; the second is one too many',
    ],
    ['key IN linkedTickets()', 'linkedTickets() needs its ticket (the first argument)'],
    [
      'key IN linkedTickets(ABC-1, a, b, c)',
      'linkedTickets() takes at most 3 arguments; the fourth is one too many',
    ],
    ['key IN updatedBy()', 'updatedBy() needs its user (the first argument)'],
    ['key IN updatedBy(alice, soon)', 'is not a date'],
    ['key IN linkedTickets(followedTickets())', 'linkedTickets(): its ticket cannot be a function'],
    ['key IN updatedBy(startOfDay())', 'startOfDay() does not return a user'],
    [
      'created > startOfDay(1x)',
      'startOfDay(): its increment must be a duration such as -1d or +2w',
    ],
    ['created > now("soon")', 'now(): its increment must be a duration such as -1d or +2w'],
    [
      'track IN tracksWhereUserHasPermission()',
      'tracksWhereUserHasPermission() needs its permission (the first argument)',
    ],
    ['targetRelease = latestShippedRelease(ZZZ)', 'Unknown track "ZZZ"'],
    [
      `Team IN choiceOption(${Array.from({ length: 51 }, (_, i) => i + 1).join(', ')})`,
      'choiceOption() takes at most 50 arguments; the 51st is one too many',
    ],
  ])('[QRY-004] refuses %s, naming the argument', (text, message) => {
    expect(refusal(text)).toContain(message);
  });

  it.each([
    ['assignee = membersOf(qa)', 'membersOf() returns several values: use IN or NOT IN, not ='],
    [
      'key != followedTickets()',
      'followedTickets() returns several values: use IN or NOT IN, not !=',
    ],
    ['status IN membersOf(qa)', 'membersOf() returns people, which "status" does not take'],
    [
      'assignee IN followedTickets()',
      'followedTickets() returns tickets, which "assignee" does not take',
    ],
    ['Team IN cascadeOption(a)', 'accepted'],
    [
      'type IN choiceOption(1)',
      'choiceOption() returns options of a select field, which "type" does not take',
    ],
    ['created > nextWeek()', 'Unknown function nextWeek()'],
    ['assignee = currentUser()', 'accepted'],
  ])('[QRY-004] checks %s against its field and operator', (text, message) => {
    expect(refusal(text)).toBe(message === 'accepted' ? 'accepted' : message);
  });

  it('[QRY-004] needs a signed-in person for currentUser(), also inside another function', () => {
    expect(refusal('key IN updatedBy(currentUser())', { currentUserId: null })).toBe(
      'currentUser() needs a signed-in user',
    );
  });

  it('[QRY-004] counts arguments as the spec gives them', () => {
    const counts = Object.fromEntries(FUNCTIONS.map((f) => [f.name, arity(f)]));
    expect(counts.linkedTickets).toEqual([1, 3]);
    expect(counts.updatedBy).toEqual([1, 3]);
    expect(counts.ticketsWithWebLinksByGlobalId).toEqual([1, Number.POSITIVE_INFINITY]);
    expect(counts.choiceOption).toEqual([1, 50]);
    expect(counts.startOfWeek).toEqual([0, 1]);
    expect(counts.ticketHistory).toEqual([0, 0]);
  });
});

describe("date functions on the person's clock (M1-038)", () => {
  const wall = (at: Date, timeZone: string) => {
    const w = wallClock(at, timeZone);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}.${String(w.ms).padStart(3, '0')}`;
  };

  it("[QRY-006] startOfWeek(-1w) starts at each person's own midnight when their weeks match", () => {
    // 03:00 UTC on Wednesday 14 October: Wednesday 13:00 in Brisbane (UTC+10), Tuesday 22:00
    // in Bogota (UTC-5); both in the week of Sunday 11 October.
    const east = instant('created >= startOfWeek(-1w)', { timeZone: 'Australia/Brisbane' });
    const west = instant('created >= startOfWeek(-1w)', { timeZone: 'America/Bogota' });
    expect(wall(east, 'Australia/Brisbane')).toBe('2026-10-04 00:00:00.000');
    expect(wall(west, 'America/Bogota')).toBe('2026-10-04 00:00:00.000');
    expect(east.toISOString()).toBe('2026-10-03T14:00:00.000Z');
    expect(west.toISOString()).toBe('2026-10-04T05:00:00.000Z');
  });

  it('[QRY-006] ends the week on Saturday unless the week starts on another day', () => {
    const end = instant('created <= endOfWeek()');
    expect(end.toISOString()).toBe('2026-10-17T23:59:59.999Z');
    expect(new Date(end.getTime() + 1).getUTCDay()).toBe(0);
    const monday = instant('created <= endOfWeek()', { weekStart: 1 });
    expect(monday.toISOString()).toBe('2026-10-18T23:59:59.999Z');
    expect(instant('created >= startOfWeek()', { weekStart: 1 }).toISOString()).toBe(
      '2026-10-12T00:00:00.000Z',
    );
  });

  it('[QRY-006] applies increments on the calendar after finding the period', () => {
    expect(instant('created >= startOfMonth(+14d)').toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(instant('created >= startOfMonth(-1M)').toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(instant('created <= endOfMonth(-1M)').toISOString()).toBe('2026-09-30T23:59:59.999Z');
    expect(instant('created <= endOfMonth(+1M)').toISOString()).toBe('2026-11-30T23:59:59.999Z');
    expect(instant('created >= startOfYear(-1y)').toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(instant('created <= endOfYear()').toISOString()).toBe('2026-12-31T23:59:59.999Z');
    expect(instant('created >= startOfDay(-1d)').toISOString()).toBe('2026-10-13T00:00:00.000Z');
    expect(instant('created <= endOfDay(1)').toISOString()).toBe('2026-10-15T23:59:59.999Z');
    expect(instant('updated >= now(-30m)').toISOString()).toBe('2026-10-14T02:30:00.000Z');
    // From the last day of a month, a month on is the end of the next one, whatever its length.
    const jan31 = { now: new Date('2027-01-31T12:00:00Z') };
    expect(instant('created <= endOfMonth(+1M)', jan31).toISOString()).toBe(
      '2027-02-28T23:59:59.999Z',
    );
  });

  it('[QRY-006] keeps days whole across a clock change', () => {
    // Europe/Berlin moves from +01:00 to +02:00 on 29 March 2026: that day has 23 hours.
    const ctx = { timeZone: 'Europe/Berlin', now: new Date('2026-03-29T10:00:00Z') };
    const start = instant('created >= startOfDay()', ctx);
    const end = instant('created <= endOfDay()', ctx);
    expect(start.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-29T21:59:59.999Z');
    expect(wall(start, 'Europe/Berlin')).toBe('2026-03-29 00:00:00.000');
    expect(wall(end, 'Europe/Berlin')).toBe('2026-03-29 23:59:59.999');
    // A time the clock skips reads past the gap; a repeated one as its first occurrence.
    expect(instant('created >= "2026-03-29 02:30"', ctx).toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
    expect(instant('created >= "2026-10-25 02:30"', ctx).toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  it("[QRY-006] reads absolute dates and date fields on the person's clock", () => {
    expect(instant('created >= 2026-10-01', { timeZone: 'Asia/Tokyo' }).toISOString()).toBe(
      '2026-09-30T15:00:00.000Z',
    );
    // 20:00 UTC is already the next day in Tokyo: a date field compares with that day.
    const late = { now: new Date('2026-10-14T20:00:00Z') };
    expect(value('due >= startOfDay()', { ...late, timeZone: 'Asia/Tokyo' })).toEqual({
      type: 'date',
      value: '2026-10-15',
    });
    expect(value('due >= startOfDay()', late)).toEqual({ type: 'date', value: '2026-10-14' });
    expect(value('"Review day" <= endOfWeek()', late)).toEqual({
      type: 'date',
      value: '2026-10-17',
    });
    // An unknown zone reads as UTC rather than failing the query.
    expect(instant('created >= 2026-10-01', { timeZone: 'Mars/Olympus' }).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });

  it('[QRY-004] currentLogin() and lastLogin() read the sign-ins the server gives', () => {
    const logins = {
      current: new Date('2026-10-14T01:00:00Z'),
      last: new Date('2026-10-10T08:00:00Z'),
    };
    expect(instant('updated >= currentLogin()', { logins })).toEqual(logins.current);
    expect(instant('updated >= lastLogin()', { logins })).toEqual(logins.last);
    // Without an earlier sign-in the one before is this one; without any, now.
    expect(
      instant('updated >= lastLogin()', { logins: { current: logins.current, last: null } }),
    ).toEqual(logins.current);
    expect(instant('updated >= currentLogin()')).toEqual(NOW);
  });
});

describe('permission names (M1-038)', () => {
  it('[QRY-004] reads a track permission by its code or a Jira-compatible key', () => {
    expect(nativePermissionName('BROWSE_PROJECTS')).toBe('browse_track');
    expect(nativePermissionName('Browse projects')).toBe('browse_track');
    expect(nativePermissionName('browse track')).toBe('browse_track');
    expect(nativePermissionName('Browse')).toBe('browse_track');
    expect(nativePermissionName('edit_issues')).toBe('edit_tickets');
    expect(nativePermissionName('Work on issues')).toBe('record_time');
    expect(nativePermissionName('fly')).toBeUndefined();
  });
});
