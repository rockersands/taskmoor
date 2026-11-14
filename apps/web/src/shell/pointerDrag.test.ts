import { createEvent, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRAG_BEGAN,
  DRAG_START,
  followPointerDrag,
  HOLD,
  type PointerDragHandlers,
} from './pointerDrag';

/** A handle on the page, pressed by pointer 7 at (10, 10). */
function press(pointerType: 'mouse' | 'touch' = 'mouse') {
  const handle = document.createElement('button');
  document.body.append(handle);
  const calls: string[] = [];
  const handlers: PointerDragHandlers = {
    start: (x, y) => calls.push(`start ${x},${y}`),
    move: (x, y) => calls.push(`move ${x},${y}`),
    drop: (x, y) => calls.push(`drop ${x},${y}`),
    cancel: () => calls.push('cancel'),
    end: () => calls.push('end'),
  };
  const down = new PointerEvent('pointerdown', { clientX: 10, clientY: 10, pointerId: 7 });
  Object.defineProperty(down, 'target', { value: handle });
  Object.defineProperty(down, 'pointerType', { value: pointerType });
  const stop = followPointerDrag(down, handlers);
  // While it is down, a pointer reports a button held.
  const at = (x: number, y: number, pointerId = 7) => ({
    clientX: x,
    clientY: y,
    pointerId,
    buttons: 1,
  });
  return { handle, calls, stop, at };
}

afterEach(async () => {
  // A drag that ended takes its click until the next task: not into the next test.
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.body.replaceChildren();
  document.body.className = '';
  vi.unstubAllGlobals();
});

describe('a press that may become a drag (T-162)', () => {
  it('[NFR-005] keeps the page styled for a drag until the drop has read what lies under the pointer', () => {
    // Without them a phone's columns snap back as the drop looks, and it lands on another column.
    const seen: boolean[] = [];
    const handle = document.createElement('button');
    document.body.append(handle);
    const stop = followPointerDrag(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 10, clientY: 10 }),
      {
        start: () => {},
        move: () => {},
        drop: () => seen.push(document.body.classList.contains('is-pointer-dragging')),
        cancel: () => {},
      },
    );
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 40, clientY: 10, buttons: 1 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 10 });
    stop();
    handle.remove();
    expect(seen).toEqual([true]);
    expect(document.body).not.toHaveClass('is-pointer-dragging');
  });

  it('[NFR-005] stays a press until it moves far enough, and its click goes through', () => {
    const { handle, calls, at } = press();
    fireEvent.pointerMove(window, at(10 + DRAG_START - 1, 10));
    fireEvent.pointerUp(window, at(10 + DRAG_START - 1, 10));
    const clicked = vi.fn();
    handle.addEventListener('click', clicked);
    fireEvent.click(handle);
    expect(calls).toEqual(['end']);
    expect(clicked).toHaveBeenCalledOnce();
    expect(document.body).not.toHaveClass('is-pointer-dragging');
  });

  it('[NFR-005] becomes a drag, follows the pointer, drops where it is let go and swallows that click', () => {
    const { handle, calls, at } = press('touch');
    fireEvent.pointerMove(window, at(30, 10));
    expect(document.body).toHaveClass('is-pointer-dragging');
    fireEvent.pointerMove(window, at(30, 60));
    // Another pointer, such as a second finger, is not this drag's.
    fireEvent.pointerMove(window, at(300, 300, 9));
    fireEvent.pointerUp(window, at(30, 80));
    expect(calls).toEqual(['start 30,10', 'move 30,10', 'move 30,60', 'drop 30,80', 'end']);
    expect(document.body).not.toHaveClass('is-pointer-dragging');
    const clicked = vi.fn();
    handle.addEventListener('click', clicked);
    fireEvent.click(handle);
    expect(clicked).not.toHaveBeenCalled();
  });

  it('[NFR-005] Escape cancels the drag and goes no further; letting go then drops nothing', () => {
    const { calls, at } = press();
    fireEvent.pointerMove(window, at(40, 40));
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    document.removeEventListener('keydown', outside);
    expect(outside).not.toHaveBeenCalled();
    expect(document.body).not.toHaveClass('is-pointer-dragging');
    fireEvent.pointerMove(window, at(80, 80));
    fireEvent.pointerUp(window, at(80, 80));
    expect(calls).toEqual(['start 40,40', 'move 40,40', 'cancel', 'end']);
  });

  it('[NFR-005] leaves Escape to the page before the press has become a drag', () => {
    const { calls } = press();
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    document.removeEventListener('keydown', outside);
    expect(outside).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
  });

  it('[NFR-007] a touch the browser takes back cancels the drag', () => {
    const { calls, at } = press('touch');
    fireEvent.pointerMove(window, at(10, 40));
    fireEvent.pointerCancel(window, at(10, 40));
    expect(calls).toEqual(['start 10,40', 'move 10,40', 'cancel', 'end']);
  });

  it('[NFR-007] near the left or right edge of an area that scrolls sideways, scrolls it along', () => {
    // A board's columns (T-162b): 400 px of a 2,000 px row, scrolled by the pointer at an edge.
    const columns = document.createElement('div');
    columns.style.overflowX = 'auto';
    let left = 0;
    Object.defineProperties(columns, {
      scrollWidth: { value: 2000 },
      clientWidth: { value: 400 },
      scrollLeft: { get: () => left },
    });
    columns.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
    columns.scrollBy = ((options: ScrollToOptions) => {
      left = Math.min(1600, Math.max(0, left + (options.left ?? 0)));
    }) as Element['scrollBy'];
    const handle = document.createElement('button');
    columns.append(handle);
    document.body.append(columns);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => frames.push(run));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const calls: string[] = [];
    const down = new PointerEvent('pointerdown', { clientX: 200, clientY: 150, pointerId: 4 });
    Object.defineProperty(down, 'target', { value: handle });
    const stop = followPointerDrag(down, {
      start: () => calls.push('start'),
      move: (x) => calls.push(`move ${x}`),
      drop: () => calls.push('drop'),
      cancel: () => calls.push('cancel'),
    });
    const at = (x: number) => ({ clientX: x, clientY: 150, pointerId: 4, buttons: 1 });
    // At the right edge: each frame scrolls right, and what is under the still pointer is asked again.
    fireEvent.pointerMove(window, at(395));
    frames.shift()?.(0);
    frames.shift()?.(16);
    expect(left).toBeGreaterThan(0);
    expect(calls).toEqual(['start', 'move 395', 'move 395', 'move 395']);
    // In the middle it stops; at the left edge it scrolls back.
    fireEvent.pointerMove(window, at(200));
    frames.shift()?.(32);
    expect(frames).toHaveLength(0);
    const scrolled = left;
    fireEvent.pointerMove(window, at(5));
    frames.shift()?.(48);
    expect(left).toBeLessThan(scrolled);
    stop();
  });

  it('[NFR-005] scrolls nothing sideways where nothing scrolls sideways', () => {
    const { calls, at } = press('touch');
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => frames.push(run));
    // At the far right of the page, which never scrolls sideways, and well clear of top and bottom.
    fireEvent.pointerMove(window, at(window.innerWidth - 2, 300));
    expect(frames).toHaveLength(0);
    fireEvent.pointerUp(window, at(window.innerWidth - 2, 300));
    expect(calls.at(-2)).toBe(`drop ${window.innerWidth - 2},300`);
  });

  it('[NFR-005] a mouse that let go unheard, in another window, cancels on its next move and drops nothing', () => {
    const { calls, at } = press();
    fireEvent.pointerMove(window, at(40, 40));
    // Back on the page with no button held: the drag is over, not carried along.
    fireEvent.pointerMove(window, { ...at(90, 90), buttons: 0 });
    expect(calls).toEqual(['start 40,40', 'move 40,40', 'cancel', 'end']);
    expect(document.body).not.toHaveClass('is-pointer-dragging');
    // The next ordinary click is that click: it moves nothing, and it goes through.
    const target = document.body.appendChild(document.createElement('button'));
    const clicked = vi.fn();
    target.addEventListener('click', clicked);
    fireEvent.pointerDown(window, at(90, 90));
    fireEvent.pointerUp(window, at(90, 90));
    fireEvent.click(target);
    expect(clicked).toHaveBeenCalledOnce();
    expect(calls).toEqual(['start 40,40', 'move 40,40', 'cancel', 'end']);
  });

  it('[NFR-005] a mouse that let go unheard before it dragged never starts a drag', () => {
    const { calls, at } = press();
    fireEvent.pointerMove(window, { ...at(90, 90), buttons: 0 });
    fireEvent.pointerMove(window, at(120, 120));
    expect(calls).toEqual(['end']);
    expect(document.body).not.toHaveClass('is-pointer-dragging');
  });

  it('[NFR-005] a new press by the same mouse with no move between cancels, before the page sees it', () => {
    const { handle, calls, at } = press();
    fireEvent.pointerMove(window, at(40, 40));
    // The page's own handler on the new press finds the old one over, so it can begin another.
    const seen: string[] = [];
    handle.addEventListener('pointerdown', () => seen.push(calls.join(' | ')));
    fireEvent.pointerDown(handle, at(40, 40));
    fireEvent.pointerUp(window, at(40, 40));
    expect(seen).toEqual(['start 40,40 | move 40,40 | cancel | end']);
    expect(calls).toEqual(['start 40,40', 'move 40,40', 'cancel', 'end']);
  });

  it('[NFR-005] another pointer pressing leaves the drag under way', () => {
    const { calls, at } = press();
    fireEvent.pointerMove(window, at(40, 40));
    fireEvent.pointerDown(window, at(40, 40, 9));
    fireEvent.pointerUp(window, at(50, 50));
    expect(calls).toEqual(['start 40,40', 'move 40,40', 'drop 50,50', 'end']);
  });

  it('[NFR-005] Escape, then a release unheard: the press is over and the next click goes through', () => {
    const { handle, calls, at } = press();
    fireEvent.pointerMove(window, at(40, 40));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.pointerMove(window, { ...at(90, 90), buttons: 0 });
    expect(calls).toEqual(['start 40,40', 'move 40,40', 'cancel', 'end']);
    fireEvent.pointerUp(window, at(90, 90));
    const clicked = vi.fn();
    handle.addEventListener('click', clicked);
    fireEvent.click(handle);
    expect(clicked).toHaveBeenCalledOnce();
  });

  it('[NFR-007] a finger is not asked about buttons: it stays in hand', () => {
    const { calls, at } = press('touch');
    fireEvent.pointerMove(window, { ...at(40, 40), buttons: 0 });
    fireEvent.pointerUp(window, { ...at(50, 50), buttons: 0 });
    expect(calls).toEqual(['start 40,40', 'move 40,40', 'drop 50,50', 'end']);
  });

  it('[NFR-005] stops following when the page goes mid-drag', () => {
    const { calls, stop, at } = press();
    fireEvent.pointerMove(window, at(40, 10));
    stop();
    fireEvent.pointerMove(window, at(80, 10));
    fireEvent.pointerUp(window, at(80, 10));
    expect(calls).toEqual(['start 40,10', 'move 40,10', 'end']);
    expect(document.body).not.toHaveClass('is-pointer-dragging');
  });
});

/** The presses below still followed, let go of after each test. */
const following: Array<() => void> = [];

/**
 * A press by pointer 7 at (10, 10) at time 1,000 on a handle that leaves scrolling up and down to
 * the page (T-228), and its moves at times of the test's choosing.
 */
function pressScrollFirst(pointerType: 'mouse' | 'touch' = 'touch') {
  const box = document.createElement('div');
  const handle = document.createElement('button');
  box.append(handle);
  document.body.append(box);
  const calls: string[] = [];
  const down = new PointerEvent('pointerdown', { clientX: 10, clientY: 10, pointerId: 7 });
  Object.defineProperty(down, 'target', { value: handle });
  Object.defineProperty(down, 'pointerType', { value: pointerType });
  Object.defineProperty(down, 'timeStamp', { value: 1_000 });
  const stop = followPointerDrag(
    down,
    {
      start: (x, y) => calls.push(`start ${x},${y}`),
      move: () => {},
      drop: (x, y) => calls.push(`drop ${x},${y}`),
      cancel: () => calls.push('cancel'),
      end: () => calls.push('end'),
    },
    { scrollFirst: true },
  );
  following.push(stop);
  const moveTo = (x: number, y: number, time: number) => {
    const move = createEvent.pointerMove(window, {
      clientX: x,
      clientY: y,
      pointerId: 7,
      buttons: 1,
    });
    Object.defineProperty(move, 'timeStamp', { value: time });
    fireEvent(window, move);
  };
  /** Whether the page would hold still under the finger's next move. */
  const touchMoveHeld = () => {
    const touch = new Event('touchmove', { cancelable: true });
    window.dispatchEvent(touch);
    return touch.defaultPrevented;
  };
  return { box, calls, moveTo, touchMoveHeld };
}

describe('a finger on a handle that lets the page scroll (T-228)', () => {
  afterEach(() => {
    for (const stop of following.splice(0)) stop();
  });

  it('[NFR-007] a quick flick up or down is the page’s scroll: no drag, and the page is left to scroll', () => {
    const { calls, moveTo, touchMoveHeld } = pressScrollFirst();
    moveTo(12, 40, 1_050);
    expect(touchMoveHeld()).toBe(false);
    moveTo(60, 60, 1_500);
    fireEvent.pointerUp(window, { clientX: 60, clientY: 60, pointerId: 7 });
    expect(calls).toEqual(['end']);
    expect(document.body).not.toHaveClass('is-pointer-dragging');
  });

  it('[NFR-007] after a rest, a move up or down drags, and the page holds still under it', () => {
    const { calls, moveTo, touchMoveHeld } = pressScrollFirst();
    const menu = new Event('contextmenu', { cancelable: true });
    window.dispatchEvent(menu);
    // A finger resting is a drag about to begin, not a call for the browser's own menu.
    expect(menu.defaultPrevented).toBe(true);
    moveTo(10, 40, 1_000 + HOLD);
    expect(touchMoveHeld()).toBe(true);
    fireEvent.pointerUp(window, { clientX: 10, clientY: 60, pointerId: 7 });
    expect(calls).toEqual(['start 10,40', 'drop 10,60', 'end']);
    // Over: the page scrolls as usual again.
    expect(touchMoveHeld()).toBe(false);
  });

  it('[NFR-007] a move at least as far sideways as up or down drags at once', () => {
    const { calls, moveTo, touchMoveHeld } = pressScrollFirst();
    moveTo(30, 28, 1_020);
    expect(touchMoveHeld()).toBe(true);
    expect(calls).toEqual(['start 30,28']);
  });

  it('[NFR-005] a mouse drags at once in any direction', () => {
    const { calls, moveTo } = pressScrollFirst('mouse');
    moveTo(10, 40, 1_010);
    expect(calls).toEqual(['start 10,40']);
  });

  it('[NFR-005] a press that becomes a drag says so on the element pressed, once', () => {
    const { box, moveTo } = pressScrollFirst();
    const began = vi.fn();
    box.addEventListener(DRAG_BEGAN, began);
    moveTo(30, 10, 1_020);
    moveTo(60, 10, 1_040);
    expect(began).toHaveBeenCalledOnce();
  });
});
