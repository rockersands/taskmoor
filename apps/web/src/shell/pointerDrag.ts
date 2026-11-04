import type { PointerEvent as ReactPointerEvent } from 'react';

/** How far a press moves before it becomes a drag, in pixels (as the Tracks page's groups). */
export const DRAG_START = 6;
/** How near the top or bottom of the scrolling area the pointer starts to scroll it, in pixels. */
const EDGE = 56;
/** The most one frame scrolls, in pixels, with the pointer at the very edge. */
const STEP = 16;

export interface PointerDragHandlers {
  /** The press has moved far enough: the drag begins here. */
  start(x: number, y: number): void;
  /** The pointer moved, or the page scrolled under it: show where a drop would land. */
  move(x: number, y: number): void;
  /** Let go over this point. */
  drop(x: number, y: number): void;
  /** Escape, a cancelled touch or a lost pointer: nothing moves. */
  cancel(): void;
  /** The press is over, whether it became a drag or stayed a press: a new one may begin. */
  end?(): void;
}

/** The next frame, or a moment later where there are no frames (a page not drawn). */
const nextFrame = (run: () => void): number =>
  typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame(run)
    : window.setTimeout(run, 16);
const cancelFrame = (frame: number) =>
  typeof window.cancelAnimationFrame === 'function'
    ? window.cancelAnimationFrame(frame)
    : window.clearTimeout(frame);

/** The nearest ancestor that scrolls up and down, or the page itself. */
function scrollerOf(element: Element | null): Element | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return document.scrollingElement;
}

/** How far to scroll this frame: towards the edge the pointer is near, faster the nearer. */
function edgeStep(scroller: Element | null, y: number): number {
  if (!scroller) return 0;
  const page = scroller === document.scrollingElement;
  const box = page ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
  const top = Math.max(box.top, 0);
  const bottom = Math.min(box.bottom, window.innerHeight);
  if (y < top + EDGE) return -Math.ceil(STEP * Math.min(1, (top + EDGE - y) / EDGE));
  if (y > bottom - EDGE) return Math.ceil(STEP * Math.min(1, (y - (bottom - EDGE)) / EDGE));
  return 0;
}

/**
 * Follows one press into a drag with pointer events, so a mouse, a pen and a finger work alike
 * (T-162; ADR-114, section 12; the Tracks page's groups work the same way, CORE-034). The press
 * becomes a drag once it has moved `DRAG_START` pixels; until then it is a press, and its click
 * goes through. During the drag:
 *
 * - Escape cancels it, and goes no further, so it does not also close a dialog or a menu;
 * - the pointer near the top or bottom of the scrolling area scrolls it, so a place off the screen
 *   can be reached with a finger, whose drag cannot scroll the page itself;
 * - the page carries `is-pointer-dragging`, so no text is selected on the way.
 *
 * The click a drag ends with belongs to the drag and is swallowed: a link or a button under the
 * drop does nothing. A handle that a finger drags needs `touch-action: none`, or the browser
 * scrolls instead. Returns a function that stops following, for a page that goes mid-drag.
 */
export function followPointerDrag(
  event: ReactPointerEvent | PointerEvent,
  handlers: PointerDragHandlers,
): () => void {
  const pointerId = event.pointerId;
  const origin = { x: event.clientX, y: event.clientY };
  const scroller = scrollerOf(event.target instanceof Element ? event.target : null);
  let at = origin;
  let dragging = false;
  /** Escape ended the drag; the press is still down, and its click is still the drag's. */
  let cancelled = false;
  let frame = 0;

  const scroll = () => {
    frame = 0;
    if (!dragging || cancelled) return;
    const step = edgeStep(scroller, at.y);
    if (step === 0) return;
    const before = scroller?.scrollTop ?? 0;
    scroller?.scrollBy?.({ top: step });
    // The page moved under a still pointer: what lies under it changed.
    if ((scroller?.scrollTop ?? 0) !== before) handlers.move(at.x, at.y);
    frame = nextFrame(scroll);
  };

  let following = true;
  /** Lets go of the press: no more listening, and the page is told it is over. */
  const stop = (then?: () => void) => {
    if (!following) return;
    following = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    if (frame) cancelFrame(frame);
    frame = 0;
    document.body.classList.remove('is-pointer-dragging');
    try {
      then?.();
    } finally {
      handlers.end?.();
    }
  };

  /** The click that follows the release, in the same task, is the drag's. */
  const swallowClick = () => {
    const swallow = (click: Event) => {
      click.preventDefault();
      click.stopPropagation();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
  };

  function onMove(e: PointerEvent) {
    if (e.pointerId !== pointerId || cancelled) return;
    at = { x: e.clientX, y: e.clientY };
    if (!dragging) {
      if (Math.hypot(at.x - origin.x, at.y - origin.y) < DRAG_START) return;
      dragging = true;
      document.body.classList.add('is-pointer-dragging');
      window.getSelection?.()?.removeAllRanges();
      handlers.start(at.x, at.y);
    }
    e.preventDefault();
    handlers.move(at.x, at.y);
    if (!frame && edgeStep(scroller, at.y) !== 0) frame = nextFrame(scroll);
  }

  function onUp(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    if (dragging) swallowClick();
    stop(() => {
      if (dragging && !cancelled) handlers.drop(e.clientX, e.clientY);
    });
  }

  function onCancel(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    stop(() => {
      if (dragging && !cancelled) handlers.cancel();
    });
  }

  function onKey(e: KeyboardEvent) {
    // Before the press has become a drag, Escape is the page's as usual.
    if (e.key !== 'Escape' || !dragging || cancelled) return;
    e.preventDefault();
    e.stopPropagation();
    cancelled = true;
    if (frame) cancelFrame(frame);
    frame = 0;
    document.body.classList.remove('is-pointer-dragging');
    // The release still to come ends the press, and its click is swallowed with it.
    handlers.cancel();
  }

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
  return () => stop();
}
