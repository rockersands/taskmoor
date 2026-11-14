// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { measureControls } from './probe.mjs';

/**
 * A page drawn by hand, since jsdom lays nothing out: each element has the box given here, and a
 * press anywhere inside its press area (its box, unless one is given) finds it, as
 * elementFromPoint would in a browser.
 */
function drawn(controls) {
  document.body.innerHTML = controls
    .map(({ tag, name }) =>
      tag === 'a'
        ? `<div><a href="#${name}">${name}</a></div>`
        : `<div><button>${name}</button></div>`,
    )
    .join('');
  const elements = [...document.body.querySelectorAll('a, button')];
  const areas = controls.map(({ box, press = box }, index) => {
    const el = elements[index];
    const [left, top, width, height] = box;
    el.getBoundingClientRect = () => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
    });
    return { el, press };
  });
  // A later element lies over an earlier one.
  document.elementFromPoint = (x, y) => {
    const hit = areas.findLast(
      ({ press: [left, top, width, height] }) =>
        x >= left && x < left + width && y >= top && y < top + height,
    );
    return hit?.el ?? document.body;
  };
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.checkVisibility = () => true;
  window.scrollTo = () => {};
  window.axe = {
    setup() {},
    teardown() {},
    commons: {
      aria: { getRole: (el) => (el.tagName === 'A' ? 'link' : 'button') },
      text: { accessibleText: (el) => el.textContent },
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  delete window.axe;
});

describe('the sweep probe: controls too small for a finger (ADR-033)', () => {
  it('[NFR-005] counts a press area that a pseudo-element widens, as on the phone timeline', () => {
    drawn([
      // A timeline key: its words are 20 px tall, its press area the whole 152 x 44 name cell.
      { tag: 'a', name: 'LCH-1', box: [10, 100, 90, 20], press: [0, 100, 152, 44] },
      // A one-day bar: 28 px wide, pressed over 44 (TR-21).
      { tag: 'button', name: 'One day', box: [208, 200, 28, 44], press: [200, 200, 44, 44] },
      // A link as small as its words, with nothing more to press.
      { tag: 'a', name: 'Small', box: [10, 300, 90, 20] },
      // Pressable over 44 px across but only 30 down.
      { tag: 'button', name: 'Flat', box: [10, 400, 30, 30], press: [0, 400, 80, 30] },
    ]);
    const { small } = measureControls(44);
    expect(small.map(({ name, width, height }) => [name, width, height])).toEqual([
      ['Small', 90, 20],
      ['Flat', 30, 30],
    ]);
  });

  it('[NFR-005] still counts a control whose press area another element covers', () => {
    drawn([
      { tag: 'a', name: 'Covered', box: [10, 100, 90, 20], press: [0, 100, 152, 44] },
      // Over the key's whole cell but its first 30 px, as a toggle with a z-index would be.
      { tag: 'button', name: 'Over it', box: [30, 100, 122, 44] },
    ]);
    const { small } = measureControls(44);
    expect(small.map(({ name }) => name)).toEqual(['Covered']);
  });
});
