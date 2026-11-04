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

/** Up and down, or sideways. */
type Axis = 'y' | 'x';

/**
 * The nearest ancestor that scrolls along `axis`: up and down, or else the page itself; sideways,
 * such as a board's columns, or else nothing, since a page never scrolls sideways (ADR-033).
 */
function scrollerOf(element: Element | null, axis: Axis): Element | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const overflow = axis === 'y' ? style.overflowY : style.overflowX;
    const room =
      axis === 'y' ? node.scrollHeight > node.clientHeight : node.scrollWidth > node.clientWidth;
    if ((overflow === 'auto' || overflow === 'scroll') && room) return node;
  }
  return axis === 'y' ? document.scrollingElement : null;
}

/**
 * How far to scroll this frame along `axis`: towards the edge the pointer is near, faster the
 * nearer. Sideways means the physical left and right in either writing direction, as the
 * pointer's own coordinates and `scrollBy` do.
 */
function edgeStep(scroller: Element | null, at: number, axis: Axis): number {
  if (!scroller) return 0;
  const screen = axis === 'y' ? window.innerHeight : window.innerWidth;
  const box = scroller === document.scrollingElement ? null : scroller.getBoundingClientRect();
  const low = Math.max((axis === 'y' ? box?.top : box?.left) ?? 0, 0);
  const high = Math.min((axis === 'y' ? box?.bottom : box?.right) ?? screen, screen);
  if (at < low + EDGE) return -Math.ceil(STEP * Math.min(1, (low + EDGE - at) / EDGE));
  if (at > high - EDGE) return Math.ceil(STEP * Math.min(1, (at - (high - EDGE)) / EDGE));
  return 0;
}

/** How far a scrolling area has scrolled along `axis`. */
const offsetOf = (scroller: Element, axis: Axis) =>
  axis === 'y' ? scroller.scrollTop : scroller.scrollLeft;

/**
 * Follows one press into a drag with pointer events, so a mouse, a pen and a finger work alike
 * (T-162; ADR-114, section 12; the Tracks page's groups work the same way, CORE-034). The press
 * becomes a drag once it has moved `DRAG_START` pixels; until then it is a press, and its click
 * goes through. During the drag:
 *
 * - Escape cancels it, and goes no further, so it does not also close a dialog or a menu;
 * - the pointer near the top or bottom of the scrolling area scrolls it, and near the left or right
 *   edge of an area that scrolls sideways (a board's columns) scrolls that, so a place off the
 *   screen can be reached with a finger, whose drag cannot scroll the page itself;
 * - the page carries `is-pointer-dragging`, so no text is selected on the way.
 *
 * A release the page never heard of ends the press with nothing moved: a mouse let go in another
 * window, or under the browser's own menu. The next move shows no button held, or the next press
 * comes from the same pointer, and neither is read as a drop. A finger has no such gap: the browser
 * always says its touch ended or was taken back, and it reports a button held while it touches.
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
  const byTouch = event.pointerType === 'touch';
  const origin = { x: event.clientX, y: event.clientY };
  const pressed = event.target instanceof Element ? event.target : null;
  const scrollers = { y: scrollerOf(pressed, 'y'), x: scrollerOf(pressed, 'x') };
  let at = origin;
  let dragging = false;
  /** Escape ended the drag; the press is still down, and its click is still the drag's. */
  let cancelled = false;
  let frame = 0;
  /** This frame's scroll along each axis, from where the pointer is. */
  const steps = () => ({
    y: edgeStep(scrollers.y, at.y, 'y'),
    x: edgeStep(scrollers.x, at.x, 'x'),
  });

  const scroll = () => {
    frame = 0;
    if (!dragging || cancelled) return;
    const step = steps();
    if (step.y === 0 && step.x === 0) return;
    let moved = false;
    for (const axis of ['y', 'x'] as const) {
      const scroller = scrollers[axis];
      if (step[axis] === 0 || !scroller) continue;
      const before = offsetOf(scroller, axis);
      scroller.scrollBy?.(axis === 'y' ? { top: step.y } : { left: step.x });
      if (offsetOf(scroller, axis) !== before) moved = true;
    }
    // The page moved under a still pointer: what lies under it changed.
    if (moved) handlers.move(at.x, at.y);
    frame = nextFrame(scroll);
  };

  let following = true;
  /** Lets go of the press: no more listening, and the page is told it is over. */
  const stop = (then?: () => void) => {
    if (!following) return;
    following = false;
    window.removeEventListener('pointerdown', onPress, true);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    if (frame) cancelFrame(frame);
    frame = 0;
    // The page's drop reads what is under the finger, so the drag's styles stay until it has:
    // without them a phone's columns snap back and the column under the finger is another one.
    try {
      then?.();
    } finally {
      document.body.classList.remove('is-pointer-dragging');
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

  /** The release never reached the page: the press is over, nothing moves, and no click is ours. */
  const releaseMissed = () =>
    stop(() => {
      if (dragging && !cancelled) handlers.cancel();
    });

  /** The same pointer pressing again has let go unheard; this new press is the page's own. */
  function onPress(e: PointerEvent) {
    if (e.pointerId === pointerId) releaseMissed();
  }

  function onMove(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    if (!byTouch && e.buttons === 0) {
      releaseMissed();
      return;
    }
    if (cancelled) return;
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
    const step = steps();
    if (!frame && (step.y !== 0 || step.x !== 0)) frame = nextFrame(scroll);
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

  // On the way down, ahead of the page, so the page can begin the new press. This press is past it.
  window.addEventListener('pointerdown', onPress, true);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
  return () => stop();
}
