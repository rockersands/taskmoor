import { dayNumber, isoDay, type Timeline, type TimelineClient, type TimelineItem } from './client';

/**
 * An in-memory track timeline for stories and tests (M1-048): the outcome "Launch day" rolled
 * up from two features, one of them with a subticket, a ticket dated by its sprint, one with no
 * dates, a blocking link, a sprint and a release. Rescheduling changes the ticket and the
 * roll-ups as the server would; `refuse` makes it answer as for someone who may not schedule.
 */
const item = (
  id: number,
  summary: string,
  extra: Partial<TimelineItem> & Pick<TimelineItem, 'type'>,
): TimelineItem => ({
  id,
  key: `LCH-${id}`,
  summary,
  level: { rank: 0, kind: 'standard' },
  parentId: null,
  status: { name: 'New', stage: 'new' },
  start: null,
  due: null,
  dated: null,
  rollup: null,
  ...extra,
});

export function timelineFixture(): Timeline {
  return {
    track: { id: 1, key: 'LCH', name: 'Launch' },
    items: [
      item(1, 'Launch day', { type: 'Outcome', level: { rank: 1, kind: 'outcome' } }),
      item(2, 'Build the site', {
        type: 'Feature',
        parentId: 1,
        start: '2026-11-02',
        due: '2026-11-10',
        dated: 'own',
        status: { name: 'Active', stage: 'active' },
      }),
      item(3, 'Write the copy', {
        type: 'Subticket',
        level: { rank: -1, kind: 'subticket' },
        parentId: 2,
        start: '2026-10-28',
        due: '2026-11-05',
        dated: 'own',
        status: { name: 'Closed', stage: 'closed' },
      }),
      item(4, 'Press kit', {
        type: 'Feature',
        parentId: 1,
        start: '2026-11-12',
        due: '2026-11-20',
        dated: 'own',
      }),
      item(5, 'Order the cake', {
        type: 'Feature',
        start: '2026-11-09',
        due: '2026-11-20',
        dated: 'sprint',
      }),
      item(6, 'Book the venue', { type: 'Feature' }),
    ],
    links: [{ from: 2, to: 4 }],
    markers: {
      sprints: [
        { id: 9, name: 'Launch Sprint 1', state: 'active', start: '2026-11-09', end: '2026-11-20' },
      ],
      releases: [{ id: 7, name: 'Launch', date: '2026-11-21', shipped: false }],
    },
    truncated: false,
  };
}

/** Recomputes every roll-up from the listed tickets, as the server does over the track. */
function rolled(items: TimelineItem[]): TimelineItem[] {
  const childrenOf = (id: number) => items.filter((i) => i.parentId === id);
  const descendants = (id: number): TimelineItem[] =>
    childrenOf(id).flatMap((c) => [c, ...descendants(c.id)]);
  return items.map((i) => {
    const all = descendants(i.id);
    if (all.length === 0) return { ...i, rollup: null };
    const starts = all
      .map((d) => d.start)
      .filter((d): d is string => d !== null)
      .sort();
    const dues = all
      .map((d) => d.due)
      .filter((d): d is string => d !== null)
      .sort();
    return {
      ...i,
      rollup: {
        start: starts[0] ?? null,
        due: dues.at(-1) ?? null,
        total: all.length,
        closed: all.filter((d) => d.status.stage === 'closed').length,
      },
    };
  });
}

export function fakeTimelineClient(
  options: { data?: Timeline; refuse?: boolean } = {},
): TimelineClient & { data: () => Timeline } {
  let data: Timeline = { ...(options.data ?? timelineFixture()) };
  data = { ...data, items: rolled(data.items) };
  return {
    data: () => data,
    timeline: async () => structuredClone(data),
    reschedule: async (key, dates) => {
      if (options.refuse) return { ok: false, code: 'forbidden' };
      data = {
        ...data,
        items: rolled(
          data.items.map((i) =>
            i.key === key ? { ...i, start: dates.startDate, due: dates.dueDate, dated: 'own' } : i,
          ),
        ),
      };
      return { ok: true };
    },
  };
}

/**
 * A large timeline for the render budget (AGL-015, M1-048: 2,000 tickets in under 1.5 s):
 * outcomes of nineteen features each, every one dated, over half a year.
 */
export function manyItems(n: number): Timeline {
  const base = dayNumber('2026-11-02');
  const items: TimelineItem[] = [];
  for (let i = 1; i <= n; i++) {
    const outcome = i % 20 === 1;
    const parent = outcome ? null : i - ((i - 1) % 20);
    const start = base + (i % 150);
    items.push(
      item(i, `${outcome ? 'Outcome' : 'Feature'} number ${i}`, {
        type: outcome ? 'Outcome' : 'Feature',
        level: outcome ? { rank: 1, kind: 'outcome' } : { rank: 0, kind: 'standard' },
        parentId: parent,
        ...(outcome
          ? {}
          : { start: isoDay(start), due: isoDay(start + 6 + (i % 9)), dated: 'own' as const }),
      }),
    );
  }
  return {
    ...timelineFixture(),
    items: rolled(items),
    links: [],
  };
}
