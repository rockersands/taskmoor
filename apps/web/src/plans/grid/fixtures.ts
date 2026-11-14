import type { GridField, GridSkeleton } from './types';

/** A row of a made-up skeleton, for tests and stories. */
export interface FixtureRow {
  /** Ticket id; 0 makes a group row. */
  ticket: number;
  /** Parent row index, -1 at the top; rows come in preorder. */
  parent: number;
  key?: string;
  /** A group row's name; null for "No value". */
  label?: string | null;
  /** A group row's value; its label unless given. */
  value?: string | null;
  level?: number;
  track?: number;
  inPlan?: boolean;
  via?: number;
  closed?: boolean;
  notShown?: number;
  elsewhere?: number;
  values?: Record<string, number | string | null>;
}

/** A skeleton from rows in preorder; depths follow the parents. */
export function skeletonOf(
  rows: readonly FixtureRow[],
  fields: readonly GridField[] = [],
  extra: Partial<Pick<GridSkeleton, 'today' | 'workingWeek' | 'more' | 'generation'>> = {},
): GridSkeleton {
  const depth: number[] = [];
  rows.forEach((r, i) => {
    depth[i] = r.parent === -1 ? 0 : (depth[r.parent] as number) + 1;
  });
  const values: GridSkeleton['values'] = {};
  for (const f of fields) values[f.ref] = rows.map((r) => r.values?.[f.ref] ?? null);
  return {
    generation: extra.generation ?? 1,
    total: rows.length,
    more: extra.more ?? false,
    today: extra.today ?? 20_400,
    workingWeek: extra.workingWeek ?? [true, true, true, true, true, false, false],
    fields: [...fields],
    rows: {
      ticket: rows.map((r) => r.ticket),
      key: rows.map((r) => r.key ?? (r.ticket > 0 ? `T-${r.ticket}` : '')),
      parent: rows.map((r) => r.parent),
      depth,
      level: rows.map((r) => r.level ?? 0),
      track: rows.map((r) => r.track ?? 1),
      inPlan: rows.map((r) => r.inPlan ?? true),
      via: rows.map((r) => r.via ?? (r.parent === -1 ? 0 : 1)),
      closed: rows.map((r) => r.closed ?? false),
      notShown: rows.map((r) => r.notShown ?? 0),
      elsewhere: rows.map((r) => r.elsewhere ?? 0),
    },
    groups: rows.flatMap((r, i) =>
      r.ticket > 0
        ? []
        : [
            {
              row: i,
              field: 'status',
              value: r.value !== undefined ? r.value : (r.label ?? `Group ${i}`),
              label: r.label !== undefined ? r.label : `Group ${i}`,
            },
          ],
    ),
    values,
  };
}

/**
 * A large made-up skeleton, built straight into columns: `count` rows of tickets with a fixed
 * fan-out (`fanOut` children each, `levels` deep under each top row), an estimate on each leaf
 * and every third ticket closed. For the page's 100,000-row tests and stories.
 */
export function bigSkeleton(count: number, fanOut = 4, levels = 3): GridSkeleton {
  const ticket: number[] = [];
  const parent: number[] = [];
  const depth: number[] = [];
  const estimate: (number | null)[] = [];
  const add = (p: number, d: number) => {
    if (ticket.length >= count) return;
    const i = ticket.length;
    ticket.push(i + 1);
    parent.push(p);
    depth.push(d);
    estimate.push(d === levels - 1 ? 3600 * ((i % 8) + 1) : null);
    if (d < levels - 1) for (let k = 0; k < fanOut; k++) add(i, d + 1);
  };
  while (ticket.length < count) add(-1, 0);
  const n = ticket.length;
  return {
    generation: 1,
    total: n,
    more: false,
    today: 20_400,
    workingWeek: [true, true, true, true, true, false, false],
    fields: [{ ref: 'originalEstimate', type: 'duration' }],
    rows: {
      ticket,
      key: ticket.map((t) => `BIG-${t}`),
      parent,
      depth,
      level: depth.map((d) => levels - 2 - d),
      track: ticket.map(() => 1),
      inPlan: ticket.map(() => true),
      via: parent.map((p) => (p === -1 ? 0 : 1)),
      closed: ticket.map((t) => t % 3 === 0),
      notShown: ticket.map(() => 0),
      elsewhere: ticket.map(() => 0),
    },
    groups: [],
    values: { originalEstimate: estimate },
  };
}
