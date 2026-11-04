import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRAG_START, followPointerDrag, type PointerDragHandlers } from './pointerDrag';

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
  const at = (x: number, y: number, pointerId = 7) => ({ clientX: x, clientY: y, pointerId });
  return { handle, calls, stop, at };
}

afterEach(() => {
  document.body.replaceChildren();
  document.body.className = '';
});

describe('a press that may become a drag (T-162)', () => {
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
