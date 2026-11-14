import { describe, expect, it } from 'vitest';
import { everyPage, pageAfter } from './pages';

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

describe('a list paged by offset that moves while it is read (T-307, T-308)', () => {
  const list = (ids: number[]) => async (offset: number) => ({
    rows: ids.slice(offset, offset + 3).map((id) => ({ id })),
  });
  const rowsOf = (page: { rows: { id: number }[] }) => page.rows;

  it('[IAM-008] reads the next page from the last row read, and gives the rows after it', async () => {
    const first = await pageAfter({ read: 0, lastId: null }, list([1, 2, 3, 4, 5]), rowsOf);
    expect(first?.rows.map((r) => r.id)).toEqual([1, 2, 3]);
    const next = await pageAfter({ read: 3, lastId: 3 }, list([1, 2, 3, 4, 5]), rowsOf);
    expect(next?.rows.map((r) => r.id)).toEqual([4, 5]);
  });

  it('[IAM-008] says the list moved when a row ahead of the offset left it', async () => {
    // Rows 1 to 3 were read, then 2 left: an offset of 3 would start at 5 and skip 4.
    expect(await pageAfter({ read: 3, lastId: 3 }, list([1, 3, 4, 5, 6]), rowsOf)).toBeNull();
    // One came ahead of it, or the last row read left: moved too.
    expect(await pageAfter({ read: 3, lastId: 3 }, list([0, 1, 2, 3, 4]), rowsOf)).toBeNull();
    expect(await pageAfter({ read: 3, lastId: 3 }, list([1, 2, 4, 5]), rowsOf)).toBeNull();
    // Unchecked, the page is read from the offset as it is.
    const as = await pageAfter({ read: 3, lastId: 3 }, list([1, 3, 4, 5, 6]), rowsOf, false);
    expect(as?.rows.map((r) => r.id)).toEqual([5, 6]);
  });
});
