import { describe, expect, it } from 'vitest';
import * as TrackLayout from '../tracks/TrackLayout';
import { moreSides } from './moreSides';

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
