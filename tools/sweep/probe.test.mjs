// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureControls } from './probe.mjs';

/**
 * A page drawn by hand, since jsdom lays nothing out: each element has the box given here, and a
 * press anywhere inside its press area (its box, unless one is given) finds it, as
 * elementFromPoint would in a browser. A `round` press area is the ellipse inside it, as a browser
 * hit-tests a box with a border-radius of 50%. A checkbox is labelled by a label after it, in the
 * box `label`. `after` is the box of a cell the control sits in, positioned, which its `::after`
 * fills, as the timeline's key links draw over their name cell.
 */
function drawn(controls) {
  document.body.innerHTML = controls
    .map(({ tag, name, after }, index) => {
      if (after) {
        return `<div style="position: relative"><a href="#${name}" style="position: static">${name}</a></div>`;
      }
      if (tag === 'a') return `<div><a href="#${name}">${name}</a></div>`;
      if (tag === 'checkbox') {
        return `<div><input type="checkbox" id="c${index}"><label for="c${index}">${name}</label></div>`;
      }
      return `<div><button>${name}</button></div>`;
    })
    .join('');
  const elements = [...document.body.querySelectorAll('a, button, input')];
  const labelled = controls.flatMap(({ label }, index) =>
    label ? [{ el: elements[index].labels[0], box: label }] : [],
  );
  const areas = [...controls.map(({ box }, index) => ({ el: elements[index], box })), ...labelled];
  for (const { el, box } of areas) {
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
  }
  const presses = [
    ...controls.flatMap(({ box, press = box, round = false }, index) => [
      { el: elements[index], press: box, round },
      { el: elements[index], press, round },
    ]),
    ...labelled.map(({ el, box }) => ({ el, press: box, round: false })),
  ];
  const within = ({ press: [left, top, width, height], round }, x, y) => {
    if (!round) return x >= left && x < left + width && y >= top && y < top + height;
    const [dx, dy] = [(x - left - width / 2) / (width / 2), (y - top - height / 2) / (height / 2)];
    return dx * dx + dy * dy < 1;
  };
  // A later element lies over an earlier one.
  document.elementFromPoint = (x, y) =>
    presses.findLast((hit) => within(hit, x, y))?.el ?? document.body;
  const pseudo = new Map(
    controls.flatMap(({ after }, index) => {
      if (!after) return [];
      const cell = elements[index].parentElement;
      const [x, y, w, h] = after;
      cell.getBoundingClientRect = () => ({
        ...{ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y },
      });
      Object.defineProperty(cell, 'clientWidth', { value: w, configurable: true });
      Object.defineProperty(cell, 'clientHeight', { value: h, configurable: true });
      const [left, top, width, height] = ['0px', '0px', `${w}px`, `${h}px`];
      const style = {
        content: '""',
        display: 'block',
        position: 'absolute',
        pointerEvents: 'auto',
        visibility: 'visible',
        boxSizing: 'border-box',
        ...{ left, top, width, height, right: 'auto', bottom: 'auto' },
        ...{ marginLeft: '0px', marginRight: '0px', marginTop: '0px', marginBottom: '0px' },
        transform: 'none',
      };
      return [[elements[index], style]];
    }),
  );
  const real = window.getComputedStyle.bind(window);
  vi.stubGlobal('getComputedStyle', (el, which) => {
    if (!which) return real(el);
    return (which === '::after' && pseudo.get(el)) || { content: 'none' };
  });
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.checkVisibility = () => true;
  window.scrollTo = () => {};
  window.axe = {
    setup() {},
    teardown() {},
    commons: {
      aria: {
        getRole: (el) => ({ A: 'link', INPUT: 'checkbox' })[el.tagName] ?? 'button',
      },
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

  it('[NFR-005] still counts a control whose press area another element covers, by the part left', () => {
    drawn([
      { tag: 'a', name: 'Covered', box: [10, 100, 90, 20], press: [0, 100, 152, 44] },
      // Over the key's whole cell but its first 30 px, as a toggle with a z-index would be.
      { tag: 'button', name: 'Over it', box: [30, 100, 122, 44] },
    ]);
    const { small } = measureControls(44);
    // Its centre is under the other: what is left of it is its first 20 px across (T-355).
    expect(small).toEqual([
      { role: 'link', name: 'Covered', width: 20, height: 20, partlyCovered: true },
    ]);
  });

  it('[NFR-005] lists a wide control a little short of a finger, however far apart it is pressed', () => {
    // Over 10,000 px², their press areas are pressed 2 or 3 px apart; still none is a finger tall.
    drawn([
      { tag: 'button', name: 'Wide', box: [10, 100, 300, 42] },
      { tag: 'button', name: 'Full width', box: [16, 200, 343, 42] },
      { tag: 'button', name: 'Wider', box: [10, 300, 1000, 41] },
    ]);
    expect(measureControls(44).small).toEqual([
      { role: 'button', name: 'Wide', width: 300, height: 42 },
      { role: 'button', name: 'Full width', width: 343, height: 42 },
      { role: 'button', name: 'Wider', width: 1000, height: 41 },
    ]);
  });

  it('[NFR-005] lists a round control, or one apart from its label, whole when nothing lies over it', () => {
    drawn([
      // A round icon button: a press at its corners finds what it lies inside.
      { tag: 'button', name: 'Round', box: [10, 100, 32, 32], round: true },
      // A checkbox and its label 10 px apart: a press between them finds the page.
      { tag: 'checkbox', name: 'Remember me', box: [10, 200, 20, 20], label: [40, 200, 100, 20] },
      // A checkbox with its label below it, and a button beside it over neither.
      { tag: 'checkbox', name: 'Stay', box: [10, 300, 20, 20], label: [10, 330, 100, 20] },
      { tag: 'button', name: 'Help', box: [40, 300, 60, 20] },
    ]);
    expect(measureControls(44).small).toEqual([
      { role: 'button', name: 'Round', width: 32, height: 32 },
      { role: 'checkbox', name: 'Remember me', width: 100, height: 20 },
      { role: 'checkbox', name: 'Stay', width: 100, height: 20 },
      { role: 'button', name: 'Help', width: 60, height: 20 },
    ]);
  });

  /**
   * The phone timeline (T-355): the key link "WEB-1", 87 x 20, pressed over its whole name cell
   * (152 x 44) through its `::after`, with the expand toggle above the cell's left and the sticky
   * timeline head above its top `headOver` px, as the sweep found them at 375 px.
   */
  function phoneTimelineKey(headOver) {
    drawn([
      {
        tag: 'a',
        name: 'WEB-1',
        box: [69, 395.6, 87, 20],
        press: [0, 391.6, 152, 44],
        after: [0, 391.6, 152, 44],
      },
      { tag: 'button', name: 'Expand', box: [8, 391.6, 44, 44] },
      { tag: 'button', name: 'Head', box: [0, 0, 375, 391.6 + headOver] },
    ]);
    return measureControls(44).small;
  }

  it('[NFR-005] judges the part of a press area left uncovered, not all or nothing (T-355)', () => {
    // The head over the cell's top pixel leaves 100 x 43 beside the toggle: a finger's size.
    expect(phoneTimelineKey(1)).toEqual([]);
    // Over its top 4 px, 100 x 40 is left beside the toggle: listed by that part.
    expect(phoneTimelineKey(4)).toEqual([
      { role: 'link', name: 'WEB-1', width: 100, height: 40, partlyCovered: true },
    ]);
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

  it('[NFR-005] lists a bar whose press area another element lies over by the part left (T-355)', () => {
    // The sticky ticket column over the press area's left 20 px: a press there finds the column,
    // and 24 x 44 is left of it.
    bar({ over: [0, 190, 112, 44] });
    expect(measureControls(44).small).toEqual([
      { role: 'button', name: 'Bar', width: 24, height: 44, partlyCovered: true },
    ]);
    // Over all of it, nothing is left: listed by its own size.
    bar({ over: [0, 190, 200, 44] });
    expect(measureControls(44).small).toEqual([
      { role: 'button', name: 'Bar', width: 28, height: 24, covered: true },
    ]);
  });

  it('[NFR-005] finds the part left away from the control, over a wide press area (T-355)', () => {
    // A press area 300 x 44 from x 92, sampled 2 px apart for its size; the bar itself, at 100 to
    // 128, is under the other element each time.
    const wide = (over) => {
      bar({ after: { width: '300px' }, press: [92, 190, 300, 44], over: [0, 190, over, 44] });
      return measureControls(44).small;
    };
    // 62 x 44 left at its far end: a finger's size, though not where the bar is drawn.
    expect(wide(330)).toEqual([]);
    // 22 x 44 left.
    expect(wide(370)).toEqual([
      { role: 'button', name: 'Bar', width: 22, height: 44, partlyCovered: true },
    ]);
  });

  it('[NFR-005] judges a wide press area pressed 2 px apart to the pixel (T-355)', () => {
    // A press area 300 x 44, pressed 2 px apart for its size, with another element over its top
    // `over` px, along all of it.
    const wide = (over) => {
      bar({ after: { width: '300px' }, press: [92, 190, 300, 44], over: [0, 190, 400, over] });
      return measureControls(44).small;
    };
    // 42.5 px left, a finger's size give or take one, as pressed a pixel apart.
    expect(wide(1.5)).toEqual([]);
    // 42 px left: not.
    expect(wide(2)).toEqual([
      { role: 'button', name: 'Bar', width: 300, height: 42, partlyCovered: true },
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
