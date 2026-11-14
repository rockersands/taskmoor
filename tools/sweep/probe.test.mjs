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

describe('the sweep probe: names that leave out visible words (WCAG 2.5.3)', () => {
  /** Radios drawn as the appearance choices are: a label holding the name and a hint. */
  function radios(options) {
    document.body.innerHTML = options
      .map(
        ({ id, name, hint, describedBy }) => `
          <label for="${id}">
            <input id="${id}" type="radio" name="skin" aria-labelledby="${id}-name"
              ${describedBy ? `aria-describedby="${id}-hint"` : ''} />
            <span><span id="${id}-name">${name}</span> <span id="${id}-hint">${hint}</span></span>
          </label>`,
      )
      .join('');
    Element.prototype.getBoundingClientRect = () => ({
      left: 0,
      top: 100,
      width: 300,
      height: 60,
      right: 300,
      bottom: 160,
      x: 0,
      y: 100,
    });
    Element.prototype.checkVisibility = () => true;
    window.axe = {
      setup() {},
      teardown() {},
      commons: {
        aria: { getRole: (el) => el.getAttribute('type') ?? el.tagName.toLowerCase() },
        text: {
          accessibleText: (el) =>
            document.getElementById(el.getAttribute('aria-labelledby'))?.textContent ?? '',
        },
      },
    };
  }

  it('[NFR-005] leaves out a hint the control names as its description, even inside its label (T-287)', () => {
    radios([
      { id: 'glass', name: 'Glass', hint: 'Frosted panels over a soft wash', describedBy: true },
      // The same kind of hint, not named as a description: its words are left out of the name.
      { id: 'plain', name: 'Plain', hint: 'Flat solid panels', describedBy: false },
    ]);
    const { names } = measureControls(44);
    expect(names).toEqual([
      {
        role: 'radio',
        name: 'Plain',
        visible: 'plain flat solid panels',
        leftOut: ['flat', 'solid', 'panels'],
      },
    ]);
  });
});
