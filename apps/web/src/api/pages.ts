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
 * list that read the first page alone silently left out everything past it. Stops at `most`.
 */
export async function everyPage<T, C>(
  read: (after: C | null) => Promise<Page<T, C>>,
  most = MOST_ITEMS,
): Promise<T[]> {
  const all: T[] = [];
  let after: C | null = null;
  do {
    const page: Page<T, C> = await read(after);
    all.push(...page.items);
    after = page.next ?? null;
  } while (after !== null && all.length < most);
  return all;
}
