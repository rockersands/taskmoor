// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  // No pseudo-element draws a press area here: what a press finds is all there is.
  const real = window.getComputedStyle.bind(window);
  vi.stubGlobal('getComputedStyle', (el, which) => (which ? { content: 'none' } : real(el)));
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
  vi.unstubAllGlobals();
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

describe('the sweep probe: a press area drawn by a pseudo-element (T-296)', () => {
  /**
   * The timeline bar on touch (T-293): a button 28 x 24, placed absolutely in its row, with an
   * `::after` a finger's size centred on it by `translate(-50%, -50%)`, which a browser gives as a
   * matrix. `after` changes that style; `row` is the row's own style. A press finds the bar in
   * `press` (left, top, width, height), as a browser finds an element through its pseudo-element:
   * by default the `::after`'s 44 x 44 around the bar. `over` is a box another element lies over
   * it in, such as the sticky ticket column.
   */
  function bar({ after = {}, row = '', press = [92, 190, 44, 44], over = null } = {}) {
    document.body.innerHTML = `<div style="position: relative; ${row}"><button style="position: absolute">Bar</button></div><div id="over"></div>`;
    const [div, button] = [document.body.firstElementChild, document.querySelector('button')];
    const rect = (left, top, width, height) => () => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
    });
    div.getBoundingClientRect = rect(0, 190, 400, 44);
    button.getBoundingClientRect = rect(100, 200, 28, 24);
    for (const [el, width, height] of [
      [div, 400, 44],
      [button, 28, 24],
    ]) {
      Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
    }
    const pseudo = {
      content: '""',
      display: 'block',
      position: 'absolute',
      pointerEvents: 'auto',
      visibility: 'visible',
      boxSizing: 'border-box',
      top: '12px',
      left: '14px',
      right: '-30px',
      bottom: '-32px',
      width: '44px',
      height: '44px',
      marginLeft: '0px',
      marginRight: '0px',
      marginTop: '0px',
      marginBottom: '0px',
      transform: 'matrix(1, 0, 0, 1, -22, -22)',
      transformOrigin: '22px 22px',
      translate: 'none',
      ...after,
    };
    const real = window.getComputedStyle.bind(window);
    vi.stubGlobal('getComputedStyle', (el, which) => {
      if (!which) return real(el);
      return el === button && which === '::after' ? pseudo : { content: 'none' };
    });
    const inside = ([left, top, width, height], x, y) =>
      x >= left && x < left + width && y >= top && y < top + height;
    document.elementFromPoint = (x, y) => {
      if (over && inside(over, x, y)) return document.getElementById('over');
      return inside(press, x, y) ? button : document.body;
    };
    Element.prototype.scrollIntoView = () => {};
    Element.prototype.checkVisibility = () => true;
    window.scrollTo = () => {};
    window.axe = {
      setup() {},
      teardown() {},
      commons: {
        aria: { getRole: () => 'button' },
        text: { accessibleText: (el) => el.textContent },
      },
    };
  }

  const small = () => measureControls(44).small.map(({ width, height }) => [width, height]);

  it('[NFR-005] counts the bar with its press area, as a finger presses it (ADR-033)', () => {
    bar();
    expect(small()).toEqual([]);
    // Placed by its right and bottom, or by `translate`, it is the same press area.
    bar({ after: { top: 'auto', left: 'auto', translate: '-50% -50%', transform: 'none' } });
    expect(small()).toEqual([]);
  });

  /** A row 30 px tall around the bar whose overflow is `overflow`: it cuts the press area. */
  function clippedRow(overflow) {
    bar({ row: `overflow-x: ${overflow}; overflow-y: ${overflow}`, press: [92, 197, 44, 30] });
    const row = document.body.firstElementChild;
    Object.defineProperty(row, 'clientHeight', { value: 30 });
    row.getBoundingClientRect = () => ({
      left: 0,
      top: 197,
      width: 400,
      height: 30,
      right: 400,
      bottom: 227,
      x: 0,
      y: 197,
    });
  }

  it('[NFR-005] lists a bar whose press area another element lies over, by its own size', () => {
    // The sticky ticket column over the press area's left half: a press there finds the column.
    bar({ over: [0, 190, 112, 44] });
    expect(measureControls(44).small).toEqual([
      { role: 'button', name: 'Bar', width: 28, height: 24, covered: true },
    ]);
  });

  it('[NFR-005] cuts a press area where a scrolling box clips it, as where it hides it', () => {
    for (const overflow of ['hidden', 'clip', 'auto', 'scroll']) {
      clippedRow(overflow);
      expect(small(), overflow).toEqual([[44, 30]]);
    }
  });

  it('[NFR-005] still lists a bar whose pseudo-element no finger presses', () => {
    // No press area: none drawn, none taking presses, one in the flow, one placed apart.
    for (const after of [
      { content: 'none' },
      { pointerEvents: 'none' },
      { visibility: 'hidden' },
      { position: 'static' },
      { top: '200px', left: '200px' },
    ]) {
      bar({ after, press: [100, 200, 28, 24] });
      expect(small(), JSON.stringify(after)).toEqual([[28, 24]]);
    }
    // A press area a row's hidden overflow cuts to 30 px: it reaches 3 px over and under the bar.
    clippedRow('hidden');
    expect(small()).toEqual([[44, 30]]);
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
