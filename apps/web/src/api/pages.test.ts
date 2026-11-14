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
    // The cap holds even where it falls inside a page: the first five, from three pages.
    expect(all).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toBe(3);
  });

  it('[CORE-001] stops at a page that names the start it was asked for', async () => {
    const asked: (string | null)[] = [];
    const all = await everyPage<string, string>(async (after) => {
      asked.push(after);
      return after === null ? { items: ['a'], next: 'x' } : { items: [], next: 'x' };
    });
    expect(all).toEqual(['a']);
    expect(asked).toEqual([null, 'x']);
  });

  it('[CORE-001] stops when empty pages lead back to a start already read', async () => {
    const asked: (number | null)[] = [];
    const all = await everyPage<number, number>(async (after) => {
      asked.push(after);
      // 1 -> 2 -> 3 -> 1 -> ... with every page empty.
      return { items: [], next: ((after ?? 0) % 3) + 1 };
    });
    expect(all).toEqual([]);
    expect(asked).toEqual([null, 1, 2, 3]);
  });

  it('[CORE-001] stops after `most` requests when empty pages never end', async () => {
    let calls = 0;
    const all = await everyPage<number, number>(async (after) => {
      calls += 1;
      return { items: [], next: (after ?? 0) + 1 };
    }, 7);
    expect(all).toEqual([]);
    expect(calls).toBe(7);
  });
});
