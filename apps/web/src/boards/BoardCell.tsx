import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import type { BoardCard } from './client';

/**
 * A board draws every card up to this many; past it, each cell draws the cards near the screen
 * and the ones someone is working with, and keeps room for the rest (T-193, ADR-049).
 */
export const WINDOW_FROM = 100;
/** A card's height until one has been drawn and measured, in pixels. */
const CARD_GUESS = 104;

/** How a card sits in its cell: whether it is the cell's tab stop, and the room above it. */
export interface CardSlot {
  tabbable: boolean;
  skipBefore: number;
}

/** A cell's look at the screen after a scroll: what to change, or nothing. */
type Check = () => (() => void) | null;

/**
 * One listener for every cell of a board: on a scroll or a resize each cell reads where it is,
 * then the cells that must draw other cards do so together, in the same frame (T-193).
 */
export interface Windowing {
  add(check: Check): () => void;
}

export function createWindowing(): Windowing {
  const checks = new Set<Check>();
  const run = () => {
    // Every read first, then every change: one layout for all cells.
    const updates = [...checks].map((check) => check()).filter((u) => u !== null);
    if (updates.length > 0) {
      flushSync(() => {
        for (const update of updates) update();
      });
    }
  };
  return {
    add(check) {
      checks.add(check);
      if (checks.size === 1) {
        document.addEventListener('scroll', run, { capture: true, passive: true });
        window.addEventListener('resize', run, { passive: true });
      }
      return () => {
        checks.delete(check);
        if (checks.size === 0) {
          document.removeEventListener('scroll', run, { capture: true });
          window.removeEventListener('resize', run);
        }
      };
    },
  };
}

export interface BoardCellProps {
  cards: readonly BoardCard[];
  label: string;
  className: string;
  /** Draw only the cards near the screen (a board of more than `WINDOW_FROM` cards). */
  windowed: boolean;
  /** Cards drawn wherever they are: dragged, edited, with a menu or a question open, landing. */
  keep: readonly (number | null | undefined)[];
  windowing: Windowing;
  /**
   * The column and lane this cell is: a drag asks the page what is under the pointer, and the
   * cell says it is a place to drop on with these (`data-drop-column`, `data-drop-lane`; T-162b).
   */
  columnId: string;
  laneId: string;
  renderCard(card: BoardCard, place: number, slot: CardSlot): ReactNode;
}

/** The first index whose offset is at least `value` (offsets rise). */
function firstAtLeast(offsets: Float64Array, value: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((offsets[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A board cell (M1-043): its cards in rank order, as a list a screen reader counts ("12 of
 * 5,000"). One card is its tab stop; Up and Down go from card to card, Home and End to the first
 * and last, and the card reached is drawn and scrolled into view. On a large board the cell draws
 * the cards near the screen, the current one and those in use, and keeps the room of the rest,
 * measured once drawn (T-193).
 */
export function BoardCell({
  cards,
  label,
  className,
  windowed,
  keep,
  windowing,
  columnId,
  laneId,
  renderCard,
}: BoardCellProps) {
  const list = useRef<HTMLUListElement>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const indexOf = useMemo(() => new Map(cards.map((card, i) => [card.id, i])), [cards]);
  const currentId = current !== null && indexOf.has(current) ? current : (cards[0]?.id ?? null);

  // Heights of the cards drawn so far, the gap between two cards and the padding above the first.
  const heights = useRef(new Map<number, number>());
  const box = useRef({ gap: 0, pad: 0 });
  const [measured, setMeasured] = useState(0);
  const offsets = useMemo(() => {
    void measured;
    if (!windowed) return null;
    let sum = 0;
    for (const h of heights.current.values()) sum += h;
    const guess = heights.current.size > 0 ? sum / heights.current.size : CARD_GUESS;
    const out = new Float64Array(cards.length + 1);
    for (let i = 0; i < cards.length; i += 1) {
      const card = cards[i] as BoardCard;
      out[i + 1] = (out[i] as number) + (heights.current.get(card.id) ?? guess) + box.current.gap;
    }
    return out;
  }, [windowed, cards, measured]);
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;

  // The cards drawn, as [from, to): the screen and as much again above and below.
  const [span, setSpan] = useState<[number, number]>([0, 0]);
  const spanRef = useRef(span);
  spanRef.current = span;

  const check = useCallback((): (() => void) | null => {
    const el = list.current;
    const at = offsetsRef.current;
    if (!el || !at) return null;
    const style = getComputedStyle(el);
    const gap = Number.parseFloat(style.rowGap) || 0;
    const pad = Number.parseFloat(style.paddingTop) || 0;
    if (gap !== box.current.gap || pad !== box.current.pad) {
      box.current = { gap, pad };
      return () => setMeasured((m) => m + 1);
    }
    const screen = window.innerHeight || 800;
    // A cell that scrolls inside itself (a phone's column) adds how far it has scrolled.
    const top = el.scrollTop - el.getBoundingClientRect().top - pad;
    const around = (margin: number): [number, number] => {
      const from = Math.max(0, firstAtLeast(at, top - margin) - 1);
      const to = firstAtLeast(at, top + screen + margin);
      return [Math.min(from, to), to];
    };
    const [needFrom, needTo] = around(screen / 4);
    const [from, to] = spanRef.current;
    if (needFrom >= from && needTo <= to) return null;
    const next = around(screen);
    return () => setSpan(next);
  }, []);

  // Where the cell is after each drawing (new cards, new heights), and on every scroll after.
  useLayoutEffect(() => {
    if (windowed) check()?.();
  });
  useLayoutEffect(
    () => (windowed ? windowing.add(check) : undefined),
    [windowed, windowing, check],
  );

  // Each card drawn is measured once it has a size, and again when it changes (a menu opens).
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef(new WeakSet<Element>());
  useLayoutEffect(() => {
    if (!windowed || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        if (!el.isConnected) {
          watch.unobserve(el);
          observed.current.delete(el);
          continue;
        }
        const id = Number(el.dataset.cardId);
        const height = entry.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height;
        if (height > 0 && Math.abs((heights.current.get(id) ?? -1) - height) > 0.5) {
          heights.current.set(id, height);
          changed = true;
        }
      }
      if (changed) setMeasured((m) => m + 1);
    });
    observer.current = watch;
    return () => {
      watch.disconnect();
      observer.current = null;
      observed.current = new WeakSet();
    };
  }, [windowed]);
  useLayoutEffect(() => {
    const watch = observer.current;
    if (!watch || !list.current) return;
    for (const child of list.current.children) {
      if (!observed.current.has(child)) {
        observed.current.add(child);
        watch.observe(child);
      }
    }
  });

  function onFocus(event: FocusEvent<HTMLUListElement>) {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-card-id]');
    const id = Number(item?.dataset.cardId);
    if (Number.isFinite(id) && id !== current) setCurrent(id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const link = event.target as HTMLElement;
    if (!link.classList.contains('board-card-link')) return;
    const at = indexOf.get(Number(link.closest<HTMLElement>('[data-card-id]')?.dataset.cardId));
    if (at === undefined) return;
    const steps: Record<string, number> = {
      ArrowUp: at - 1,
      ArrowDown: at + 1,
      Home: 0,
      End: cards.length - 1,
    };
    const to = steps[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const target = cards[to];
    if (!target || to === at) return;
    // Drawn first, wherever it is, then focused and brought into view.
    flushSync(() => setCurrent(target.id));
    const item = list.current?.querySelector<HTMLElement>(`[data-card-id="${target.id}"]`);
    item?.querySelector<HTMLElement>('.board-card-link')?.focus({ preventScroll: true });
    item?.scrollIntoView?.({ block: 'nearest' });
  }

  const drawn: ReactNode[] = [];
  let after = 0;
  if (!windowed || !offsets) {
    cards.forEach((card, i) => {
      drawn.push(renderCard(card, i + 1, { tabbable: card.id === currentId, skipBefore: 0 }));
    });
  } else {
    const show = new Set<number>();
    for (let i = span[0]; i < Math.min(span[1], cards.length); i += 1) show.add(i);
    for (const id of [currentId, ...keep]) {
      const i = id === null || id === undefined ? undefined : indexOf.get(id);
      if (i !== undefined) show.add(i);
    }
    let next = 0;
    for (const i of [...show].sort((a, b) => a - b)) {
      const card = cards[i] as BoardCard;
      drawn.push(
        renderCard(card, i + 1, {
          tabbable: card.id === currentId,
          skipBefore: (offsets[i] as number) - (offsets[next] as number),
        }),
      );
      next = i + 1;
    }
    after = (offsets[cards.length] as number) - (offsets[next] as number);
  }

  return (
    <ul
      ref={list}
      className={className}
      aria-label={label}
      data-drop-column={columnId}
      data-drop-lane={laneId}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      style={after > 0 ? ({ '--cell-skip-after': `${after}px` } as CSSProperties) : undefined}
    >
      {drawn}
    </ul>
  );
}
