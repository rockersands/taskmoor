// jsdom has no layout engine and no matchMedia. This stand-in evaluates width and pointer queries
// against a viewport width and a pointer the test sets, and fires change events like a browser
// when either changes. A comma list matches when any of its queries does.

type ChangeListener = (event: MediaQueryListEvent) => void;

interface TrackedList {
  query: string;
  matches: boolean;
  listeners: Set<ChangeListener>;
}

let width = 1440;
/** Whether the main pointer is a finger: `(pointer: coarse)`. A mouse unless a test says so. */
let coarse = false;
const lists = new Set<TrackedList>();

function evaluateOne(query: string): boolean {
  return query.split(/\s+and\s+/).every((part) => {
    const pointer = /\((any-)?pointer:\s*(coarse|fine)\)/.exec(part);
    if (pointer) return (pointer[2] === 'coarse') === coarse;
    const match = /\((min|max)-width:\s*(\d+)px\)/.exec(part);
    if (!match) return false;
    const limit = Number(match[2]);
    return match[1] === 'min' ? width >= limit : width <= limit;
  });
}

const evaluate = (query: string) => query.split(',').some((one) => evaluateOne(one.trim()));

export function installMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList => {
    const tracked: TrackedList = { query, matches: evaluate(query), listeners: new Set() };
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
  refresh();
  window.dispatchEvent(new Event('resize'));
}

/** Makes the main pointer a finger (true) or a mouse (false). Wrap in act() when components are mounted. */
export function setCoarsePointer(next: boolean): void {
  coarse = next;
  refresh();
}

function refresh(): void {
  for (const list of lists) {
    const matches = evaluate(list.query);
    if (matches === list.matches) continue;
    list.matches = matches;
    const event = { matches, media: list.query } as MediaQueryListEvent;
    for (const listener of list.listeners) listener(event);
  }
}
