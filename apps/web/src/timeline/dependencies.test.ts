import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TimelineItem } from './client';
import { blockerCount, dependenciesOf, dependencyState } from './dependencies';

const item = (id: number, extra: Partial<TimelineItem> = {}): TimelineItem => ({
  id,
  key: `DEP-${id}`,
  summary: `Ticket ${id}`,
  type: 'Feature',
  level: { rank: 0, kind: 'standard' },
  parentId: null,
  status: { name: 'New', stage: 'new' },
  start: null,
  due: null,
  dated: null,
  rollup: null,
  ...extra,
});
const dated = (id: number, start: string, due: string, extra: Partial<TimelineItem> = {}) =>
  item(id, { start, due, dated: 'own', ...extra });
const closed = { status: { name: 'Done', stage: 'closed' as const } };

describe('when a dependency is late (PLN-006)', () => {
  it('[PLN-006] is late when the blocker ends on or after the day the blocked ticket starts', () => {
    const blocker = dated(1, '2026-11-02', '2026-11-10');
    expect(dependencyState(blocker, dated(2, '2026-11-09', '2026-11-20'))).toBe('late');
    // The same day: the blocked ticket would start before its blocker is done.
    expect(dependencyState(blocker, dated(3, '2026-11-10', '2026-11-20'))).toBe('late');
    expect(dependencyState(blocker, dated(4, '2026-11-11', '2026-11-20'))).toBe('onTime');
  });

  it('[PLN-006] is never late once the blocker or the blocked ticket is closed, or without dates', () => {
    const blocked = dated(2, '2026-11-09', '2026-11-20');
    expect(dependencyState(dated(1, '2026-11-02', '2026-11-10', closed), blocked)).toBe('closed');
    expect(
      dependencyState(
        dated(1, '2026-11-02', '2026-11-10'),
        dated(2, '2026-11-09', '2026-11-20', closed),
      ),
    ).toBe('onTime');
    expect(dependencyState(item(1), blocked)).toBe('undated');
    expect(dependencyState(dated(1, '2026-11-02', '2026-11-10'), item(2))).toBe('undated');
  });

  it('[PLN-006] reads a parent without days by the span rolled up from its children', () => {
    const parent = item(1, {
      rollup: { start: '2026-11-01', due: '2026-11-15', total: 2, closed: 0 },
    });
    expect(dependencyState(parent, dated(2, '2026-11-12', '2026-11-20'))).toBe('late');
  });
});

/**
 * The late rule's table of cases, shared with the server's `isLate` (the auto-scheduler, ADR-122
 * stage 7), read from the repository root or from the app.
 */
interface LateSide {
  start: string | null;
  due: string | null;
  closed: boolean;
}
const lateRule = (() => {
  const file = 'apps/server/src/plans/__cases__/late-rule.json';
  const path = [file, `../../${file}`]
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return JSON.parse(readFileSync(path ?? file, 'utf8')) as {
    cases: { name: string; blocker: LateSide; blocked: LateSide; state: string }[];
  };
})();

describe('the late rule’s shared cases (PLN-006, PLN-004)', () => {
  const side = (id: number, s: LateSide) =>
    item(id, {
      start: s.start,
      due: s.due,
      dated: s.start || s.due ? 'own' : null,
      ...(s.closed ? closed : {}),
    });
  it.each(lateRule.cases.map((c) => [c.name, c] as const))('[PLN-006] [PLN-004] %s', (_name, c) => {
    expect(dependencyState(side(1, c.blocker), side(2, c.blocked))).toBe(c.state);
  });
});

describe('a timeline’s blocked tickets (PLN-006)', () => {
  it('[PLN-006] gathers each blocked ticket’s blockers in rank order, with the counts of others', () => {
    const items = [
      dated(1, '2026-11-02', '2026-11-10'),
      dated(2, '2026-11-01', '2026-11-05'),
      dated(3, '2026-11-09', '2026-11-20'),
      item(4),
    ];
    const found = dependenciesOf(
      items,
      [
        { from: 2, to: 3 },
        { from: 1, to: 3 },
        // A link to a ticket not listed draws nothing.
        { from: 1, to: 99 },
      ],
      [
        { id: 3, outside: 2, unlisted: 1 },
        { id: 4, outside: 1, unlisted: 0 },
        { id: 99, outside: 5, unlisted: 0 },
      ],
    );
    expect([...found.keys()]).toEqual([3, 4]);
    const three = found.get(3);
    expect(three?.blockers.map((b) => [b.item.key, b.state])).toEqual([
      ['DEP-1', 'late'],
      ['DEP-2', 'onTime'],
    ]);
    expect(three && [three.late, three.outside, three.unlisted, blockerCount(three)]).toEqual([
      1, 2, 1, 5,
    ]);
    expect(found.get(4)).toMatchObject({ blockers: [], outside: 1, late: 0 });
  });
});
