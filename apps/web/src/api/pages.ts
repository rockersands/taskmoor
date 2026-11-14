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
