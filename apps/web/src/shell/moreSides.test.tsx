import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as TrackLayout from '../tracks/TrackLayout';
import { moreSides, useMoreSides } from './moreSides';

/** A scroller of the given widths, scrolled to `left`. */
function scroller(left: number, client: number, scroll: number): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperties(element, {
    scrollLeft: { value: left },
    clientWidth: { value: client },
    scrollWidth: { value: scroll },
  });
  return element;
}

describe('which ends of a sideways scroller hide more (TR-4, D17)', () => {
  it('[NFR-005] says none, the end, both or the start as the strip scrolls', () => {
    expect(moreSides(scroller(0, 300, 300))).toBe('none');
    expect(moreSides(scroller(0, 300, 450))).toBe('end');
    expect(moreSides(scroller(75, 300, 450))).toBe('both');
    expect(moreSides(scroller(150, 300, 450))).toBe('start');
    // A pixel of rounding is no more.
    expect(moreSides(scroller(1, 300, 301))).toBe('none');
  });

  it('[NFR-005] is one helper, here: the track tab bar has no copy of its own', () => {
    expect(Object.keys(TrackLayout)).not.toContain('useMoreSides');
    expect(Object.keys(TrackLayout)).not.toContain('moreSides');
  });
});

/** jsdom has no ResizeObserver: this one reports a size change when a test says so. */
class SizeWatcher {
  static live = new Set<SizeWatcher>();
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    SizeWatcher.live.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    SizeWatcher.live.delete(this);
  }
}

/** `target` changed size, as a browser would report it to whoever watches it. */
function resized(target: Element) {
  act(() => {
    for (const watcher of SizeWatcher.live) {
      if (watcher.targets.has(target)) {
        watcher.callback([], watcher as unknown as ResizeObserver);
      }
    }
  });
}

/** The strip's widths as laid out; jsdom lays nothing out. */
function laidOut(element: HTMLElement, widths: { client: number; scroll: number; left?: number }) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: widths.client },
    scrollWidth: { configurable: true, value: widths.scroll },
    scrollLeft: { configurable: true, value: widths.left ?? 0 },
  });
}

let renders = 0;

/** A strip whose `contents` never change, so only watching can see the table grow. */
function Strip({ second = false }: { second?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const more = useMoreSides(ref, 'the same contents');
  renders += 1;
  return (
    <div ref={ref} data-testid="strip" data-more={more}>
      <table data-testid="first" />
      {second && <table data-testid="second" />}
    </div>
  );
}

describe('the fade follows what the strip holds (T-275)', () => {
  beforeEach(() => {
    SizeWatcher.live.clear();
    renders = 0;
    vi.stubGlobal('ResizeObserver', SizeWatcher);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[NFR-005] fades the end when the table inside grows wider than its card after the first paint', () => {
    render(<Strip />);
    const strip = screen.getByTestId('strip');
    expect(strip).toHaveAttribute('data-more', 'none');
    // Longer values arrive: the table grows, the strip keeps its own size.
    laidOut(strip, { client: 300, scroll: 450 });
    resized(screen.getByTestId('first'));
    expect(strip).toHaveAttribute('data-more', 'end');
    // And it shrinks back: the fade goes.
    laidOut(strip, { client: 300, scroll: 300 });
    resized(screen.getByTestId('first'));
    expect(strip).toHaveAttribute('data-more', 'none');
  });

  it('[NFR-005] measures again when an element is added inside, and watches it from then on', async () => {
    const { rerender } = render(<Strip />);
    const strip = screen.getByTestId('strip');
    laidOut(strip, { client: 300, scroll: 450 });
    rerender(<Strip second />);
    await waitFor(() => expect(strip).toHaveAttribute('data-more', 'end'));
    laidOut(strip, { client: 300, scroll: 300 });
    resized(screen.getByTestId('second'));
    expect(strip).toHaveAttribute('data-more', 'none');
  });

  it('[NFR-005] sets no state while a scroll leaves the answer as it was, and lets go when gone', () => {
    const { unmount } = render(<Strip />);
    const strip = screen.getByTestId('strip');
    laidOut(strip, { client: 300, scroll: 900, left: 200 });
    fireEvent.scroll(strip);
    expect(strip).toHaveAttribute('data-more', 'both');
    const before = renders;
    for (const left of [210, 220, 230, 240, 250]) {
      laidOut(strip, { client: 300, scroll: 900, left });
      fireEvent.scroll(strip);
    }
    expect(renders).toBe(before);
    expect(strip).toHaveAttribute('data-more', 'both');
    unmount();
    expect(SizeWatcher.live.size).toBe(0);
  });
});
