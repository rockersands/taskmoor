import { describe, expect, it } from 'vitest';
import { stableJson } from '../golden';
import { fc } from '../property';
import { createDataset, spaceKey } from './generate';
import { type GenHistory, type GenItem, scaleConfig } from './model';
import { Rng, ZipfSampler } from './rng';

function collect(items: number, overrides = {}) {
  const ds = createDataset(scaleConfig(items, overrides));
  const rows: { item: GenItem; history: GenHistory[] }[] = [...ds.items()];
  return { ds, rows };
}

describe('Rng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = new Rng(7);
    const b = new Rng(7);
    const c = new Rng(8);
    const seqA = Array.from({ length: 5 }, () => a.nextUint32());
    expect(Array.from({ length: 5 }, () => b.nextUint32())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.nextUint32())).not.toEqual(seqA);
  });

  it('keeps int() within bounds and next() in [0, 1)', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer({ min: -1000, max: 1000 }),
        fc.nat(1000),
        (seed, min, width) => {
          const rng = new Rng(seed);
          for (let i = 0; i < 20; i++) {
            const v = rng.int(min, min + width);
            expect(v).toBeGreaterThanOrEqual(min);
            expect(v).toBeLessThanOrEqual(min + width);
            const f = rng.next();
            expect(f >= 0 && f < 1).toBe(true);
          }
        },
      ),
    );
  });

  it('derives independent streams per label and index', () => {
    expect(Rng.derive(1, 'item', 5).nextUint32()).toBe(Rng.derive(1, 'item', 5).nextUint32());
    expect(Rng.derive(1, 'item', 5).nextUint32()).not.toBe(Rng.derive(1, 'item', 6).nextUint32());
    expect(Rng.derive(1, 'item', 5).nextUint32()).not.toBe(Rng.derive(1, 'user', 5).nextUint32());
  });

  it('samples a Zipf skew: the first tenth of 1,000 slots gets most draws', () => {
    const zipf = new ZipfSampler(1000);
    const rng = new Rng(1);
    let head = 0;
    for (let i = 0; i < 20_000; i++) if (zipf.sample(rng) < 100) head++;
    expect(head / 20_000).toBeGreaterThan(0.6);
  });
});

describe('spaceKey', () => {
  it('produces unique keys of two or more letters', () => {
    expect([0, 1, 25, 26, 675, 676].map(spaceKey)).toEqual(['AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
    const keys = new Set(Array.from({ length: 5000 }, (_, i) => spaceKey(i)));
    expect(keys.size).toBe(5000);
  });
});

describe('createDataset', () => {
  it('is reproducible: the first items match the reviewed sample', async () => {
    const { rows } = collect(400, { seed: 42 });
    await expect(stableJson(rows.slice(0, 3))).toMatchFileSnapshot(
      './__golden__/sample-items.json',
    );
  });

  it('produces the requested counts and valid references', () => {
    const { ds, rows } = collect(3_000);
    const { users, spaces, fields } = ds;
    expect(users).toHaveLength(ds.config.users);
    expect(spaces).toHaveLength(ds.config.spaces);
    expect(fields).toHaveLength(ds.config.fields);
    expect(rows).toHaveLength(3_000);

    // Plain checks collected into one list: thousands of expect() calls would be slow.
    const problems: string[] = [];
    const check = (ok: boolean, what: string) => {
      if (!ok && problems.length < 20) problems.push(what);
    };
    const fieldById = new Map(fields.map((f) => [f.id, f]));
    const itemById = new Map(rows.map((r) => [r.item.id, r.item]));
    for (const { item, history } of rows) {
      const at = `item ${item.id}`;
      check(item.spaceId >= 1 && item.spaceId <= spaces.length, `${at}: space out of range`);
      check(item.reporterId >= 1 && item.reporterId <= users.length, `${at}: reporter`);
      check(item.assigneeId === null || item.assigneeId <= users.length, `${at}: assignee`);
      check(item.updatedAt >= item.createdAt, `${at}: updated before created`);
      check((item.resolvedAt !== null) === (item.statusCategory === 'done'), `${at}: resolution`);

      if (item.parentId !== null) {
        const parent = itemById.get(item.parentId);
        check(parent?.spaceId === item.spaceId, `${at}: parent in another space`);
        check(item.parentId < item.id, `${at}: parent created later`);
        check(
          item.type === 'Subtask' ? parent?.type !== 'Subtask' : parent?.type === 'Epic',
          `${at}: ${item.type} under ${parent?.type}`,
        );
      } else {
        check(item.type !== 'Subtask', `${at}: subtask without parent`);
      }

      for (const [fieldId, value] of Object.entries(item.fields)) {
        const field = fieldById.get(Number(fieldId));
        check(field !== undefined, `${at}: unknown field ${fieldId}`);
        if (!field) continue;
        check(field.spaceId === null || field.spaceId === item.spaceId, `${at}: foreign field`);
        if (field.type === 'select') check(field.options.includes(String(value)), `${at}: option`);
        if (field.type === 'user') check(Number(value) <= users.length, `${at}: user value`);
        if (field.type === 'number') check(typeof value === 'number', `${at}: number value`);
      }

      let last = item.createdAt.getTime();
      for (const h of history) {
        check(h.itemId === item.id, `${at}: history for another item`);
        check(h.at.getTime() >= last && h.at <= item.updatedAt, `${at}: history out of order`);
        last = h.at.getTime();
      }
    }
    expect(problems).toEqual([]);
  });

  it('numbers items 1, 2, 3, ... within each space', () => {
    const { rows } = collect(2_000);
    const bySpace = new Map<number, number[]>();
    for (const { item } of rows) {
      const list = bySpace.get(item.spaceId) ?? [];
      list.push(item.number);
      bySpace.set(item.spaceId, list);
      expect(item.key).toMatch(/^[A-Z]{2,}-\d+$/);
    }
    for (const numbers of bySpace.values()) {
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    }
  });

  it('skews work towards a few large spaces, like real sites', () => {
    const { ds, rows } = collect(20_000, { spaces: 100 });
    const counts = new Array(ds.config.spaces).fill(0);
    for (const { item } of rows) counts[item.spaceId - 1]++;
    const sorted = [...counts].sort((a, b) => b - a);
    const top10 = sorted.slice(0, 10).reduce((a, b) => a + b, 0);
    expect(top10 / rows.length).toBeGreaterThan(0.4);
  });

  it('gives items about the configured number of custom field values', () => {
    const { rows } = collect(1_000, { fields: 1_500, fieldsPerItem: 25 });
    const mean = rows.reduce((sum, r) => sum + Object.keys(r.item.fields).length, 0) / rows.length;
    expect(mean).toBeGreaterThan(20);
    expect(mean).toBeLessThan(30);
  });
});
