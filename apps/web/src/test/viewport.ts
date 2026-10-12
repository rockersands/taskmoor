// jsdom has no layout engine and no matchMedia. This stand-in evaluates width queries against a
// viewport width the test sets, and fires change events like a browser when it changes.

type ChangeListener = (event: MediaQueryListEvent) => void;

interface TrackedList {
  query: string;
  matches: boolean;
  listeners: Set<ChangeListener>;
}

let width = 1440;
const lists = new Set<TrackedList>();

function evaluate(query: string, viewportWidth: number): boolean {
  return query.split(/\s+and\s+/).every((part) => {
    const match = /\((min|max)-width:\s*(\d+)px\)/.exec(part);
    if (!match) return false;
    const limit = Number(match[2]);
    return match[1] === 'min' ? viewportWidth >= limit : viewportWidth <= limit;
  });
}

export function installMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList => {
    const tracked: TrackedList = { query, matches: evaluate(query, width), listeners: new Set() };
    lists.add(tracked);
    const list = {
      media: query,
      get matches() {
        return tracked.matches;
      },
      onchange: null,
      addEventListener: (_type: string, listener: ChangeListener) =>
        tracked.listeners.add(listener),
      removeEventListener: (_type: string, listener: ChangeListener) =>
        tracked.listeners.delete(listener),
      addListener: (listener: ChangeListener) => tracked.listeners.add(listener),
      removeListener: (listener: ChangeListener) => tracked.listeners.delete(listener),
      dispatchEvent: () => false,
    };
    return list as unknown as MediaQueryList;
  };
}

/** Changes the simulated viewport width. Wrap in act() when components are mounted. */
export function setViewportWidth(next: number): void {
  width = next;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: next });
  for (const list of lists) {
    const matches = evaluate(list.query, next);
    if (matches === list.matches) continue;
    list.matches = matches;
    const event = { matches, media: list.query } as MediaQueryListEvent;
    for (const listener of list.listeners) listener(event);
  }
  window.dispatchEvent(new Event('resize'));
}
