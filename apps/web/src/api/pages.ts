/** Items a list read in full holds at most, a backstop against a list that never ends. */
export const MOST_ITEMS = 10_000;

/** One page of a list: its items and where the next page starts, `null` after the last. */
export interface Page<T, C> {
  items: T[];
  next: C | null | undefined;
}

/**
 * Every item of a list the API answers a page at a time (T-305): `read` asks for the page that
 * starts after `after` (`null` for the first) and says where the next one starts. A picker or a
 * list that read the first page alone silently left out everything past it. Holds at most
 * `most` items, the first ones of the list. A page may be empty (its items hidden from the
 * reader) without ending the list, so it also stops when a page names a start it was already
 * asked for, and after `most` requests: a list that never ends always stops.
 */
export async function everyPage<T, C>(
  read: (after: C | null) => Promise<Page<T, C>>,
  most = MOST_ITEMS,
): Promise<T[]> {
  const all: T[] = [];
  const asked = new Set<C | null>();
  let after: C | null = null;
  do {
    asked.add(after);
    const page: Page<T, C> = await read(after);
    all.push(...page.items.slice(0, most - all.length));
    const next: C | null = page.next ?? null;
    after = next !== null && !asked.has(next) ? next : null;
  } while (after !== null && all.length < most && asked.size < most);
  return all;
}

/** How far a list paged by offset has been read: the rows read and the id of the last one. */
export interface OffsetRead {
  read: number;
  lastId: number | null;
}

/**
 * The next page of a list paged by offset (People, API tokens; T-307, T-308), read from the last
 * row already read, again. Such a list moves while it is read: when a row ahead of the offset
 * leaves it (an expiry, another administrator, the directory), the next page starts a row late
 * and one row is never shown; when one comes, a row is repeated. So the page starts at the last
 * row read, and when that row is not its first the list moved: the answer is `null`, for the
 * caller to read the list again from its start. Otherwise `rows` are the page's rows after it.
 * With `check` false the page is read from the offset as it is, for a list that keeps moving.
 */
export async function pageAfter<P, T extends { id: number }>(
  from: OffsetRead,
  read: (offset: number) => Promise<P>,
  rowsOf: (page: P) => readonly T[],
  check = true,
): Promise<{ page: P; rows: T[] } | null> {
  const again = check && from.read > 0 && from.lastId !== null ? 1 : 0;
  const page = await read(from.read - again);
  const rows = rowsOf(page);
  if (again === 1 && rows[0]?.id !== from.lastId) return null;
  return { page, rows: rows.slice(again) };
}
