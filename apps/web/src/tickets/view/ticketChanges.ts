import { useEffect, useRef, useState } from 'react';

/**
 * An edit in the ticket pop-up reaches the page beneath at once, socket or no socket. The pages
 * that list tickets read their lists again where they stand, with no loading state in between, so
 * their scroll stays where it was.
 */
const CHANGED = 'taskmoor:ticket-changed';

export function announceTicketChange() {
  window.dispatchEvent(new Event(CHANGED));
}

/** Calls `refresh`, the latest one given, after every edit in the pop-up. */
export function useTicketChanges(refresh: () => void) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    const listener = () => latest.current();
    window.addEventListener(CHANGED, listener);
    return () => window.removeEventListener(CHANGED, listener);
  }, []);
}

/** A number that moves on with every edit in the pop-up, for an effect that reads a list. */
export function useTicketChangeCount(): number {
  const [count, setCount] = useState(0);
  useTicketChanges(() => setCount((n) => n + 1));
  return count;
}

/**
 * A paged list read again as far as it was showing, so more rows brought in by hand stay. The
 * first page's other fields, such as a total, are kept.
 */
export async function readShownPages<Page extends { tickets: unknown[]; next: string | null }>(
  read: (cursor?: string) => Promise<Page>,
  shown: number,
): Promise<Page> {
  const first = await read();
  const tickets = [...first.tickets];
  let next = first.next;
  while (next !== null && tickets.length < shown) {
    const page = await read(next);
    tickets.push(...page.tickets);
    next = page.next;
  }
  return { ...first, tickets, next };
}
