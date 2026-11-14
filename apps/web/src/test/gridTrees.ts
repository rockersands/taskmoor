import { isoOfDay } from '@taskmoor/formula';
import { fc } from '@taskmoor/testkit/property';
import type { FixtureRow } from '../plans/grid/fixtures';
import type { GridField } from '../plans/grid/types';

/** The fields random trees carry: a number, a duration and a date (sent as ISO text). */
export const TREE_FIELDS: GridField[] = [
  { ref: 'cf[1]', type: 'number' },
  { ref: 'originalEstimate', type: 'duration' },
  { ref: 'due', type: 'date' },
];

/**
 * Random rows in preorder for the Grid's property tests: each row's parent is a row on the path
 * above the row before it, or none; a row at the top may be a group row. Ticket rows carry
 * whole-number values (so sums compare exactly), some empty, and some are closed.
 */
export const treeRows = (max = 40) =>
  fc
    .array(
      fc.record({
        up: fc.nat({ max: 4 }),
        group: fc.boolean(),
        level: fc.integer({ min: -1, max: 2 }),
        track: fc.integer({ min: 1, max: 2 }),
        notShown: fc.nat({ max: 3 }),
        closed: fc.boolean(),
        number: fc.option(fc.integer({ min: -1_000, max: 1_000 }), { freq: 4 }),
        seconds: fc.option(fc.integer({ min: 0, max: 360_000 }), { freq: 4 }),
        day: fc.option(fc.integer({ min: 19_000, max: 21_000 }), { freq: 4 }),
      }),
      { maxLength: max },
    )
    .map((specs) => {
      const rows: FixtureRow[] = [];
      let path: number[] = [];
      specs.forEach((s, i) => {
        path = path.slice(0, Math.max(0, path.length - s.up));
        const parent = path.length === 0 ? -1 : (path[path.length - 1] as number);
        const group = s.group && parent === -1;
        rows.push(
          group
            ? { ticket: 0, parent }
            : {
                ticket: i + 1,
                parent,
                level: s.level,
                track: s.track,
                notShown: s.notShown,
                closed: s.closed,
                values: {
                  'cf[1]': s.number,
                  originalEstimate: s.seconds,
                  due: s.day === null ? null : isoOfDay(s.day),
                },
              },
        );
        path.push(i);
      });
      return rows;
    });
