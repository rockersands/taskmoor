import { describe, expect, it } from 'vitest';
import { everyPage } from './pages';

describe('reading a list a page at a time (T-305)', () => {
  it('[CORE-001] follows every page until the last says there is no next', async () => {
    const pages: Record<string, { items: string[]; next: string | null }> = {
      start: { items: ['a', 'b'], next: 'b' },
      b: { items: [], next: 'c' },
      c: { items: ['d'], next: null },
    };
    const asked: (string | null)[] = [];
    const all = await everyPage<string, string>(async (after) => {
      asked.push(after);
      return pages[after ?? 'start'] as { items: string[]; next: string | null };
    });
    expect(all).toEqual(['a', 'b', 'd']);
    // A page left empty (its items hidden from the reader) does not end the list.
    expect(asked).toEqual([null, 'b', 'c']);
  });

  it('[CORE-001] stops at the most it holds, against a list that never ends', async () => {
    let calls = 0;
    const all = await everyPage<number, number>(async (after) => {
      calls += 1;
      const from = after ?? 0;
      return { items: [from + 1, from + 2], next: from + 2 };
    }, 5);
    expect(all).toEqual([1, 2, 3, 4, 5, 6]);
    expect(calls).toBe(3);
  });
});
