// What the sweep (tools/sweep/routes.mjs) measures inside a page. These functions run in the
// browser, so they use nothing from this file's scope. Roles and accessible names come from axe,
// which the sweep has already evaluated in the page.

/** The window-fixed background of the skins, as the picture needs it (routes.mjs). */
export function setBackgroundAttachment(value) {
  document.documentElement.style.backgroundAttachment = value;
  document.body.style.backgroundAttachment = value;
}

/** Sideways scroll at the width the page was asked for, and which element reaches furthest. */
export function measureSideways(viewport) {
  const describe = (el) => {
    const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/) : [];
    const name = [el.tagName.toLowerCase(), ...classes.slice(0, 2).filter(Boolean)].join('.');
    return `${name}${el.id ? `#${el.id}` : ''}`;
  };
  // On a phone the browser may widen innerWidth to fit what overflows, so the width asked for is
  // what scrollWidth is held against; innerWidth is reported beside it.
  const scrollWidth = document.documentElement.scrollWidth;
  const clipped = (el) => {
    for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
      if (getComputedStyle(up).overflowX !== 'visible') return true;
    }
    return false;
  };
  let widest = null;
  let furthest = viewport;
  if (scrollWidth > viewport) {
    for (const el of document.body.querySelectorAll('*')) {
      const right = el.getBoundingClientRect().right + window.scrollX;
      if (right > furthest + 0.5 && !clipped(el)) {
        furthest = right;
        widest = {
          element: describe(el),
          right: Math.round(right),
          text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60),
        };
      }
    }
  }
  return {
    viewport,
    innerWidth: window.innerWidth,
    scrollWidth,
    over: Math.max(0, scrollWidth - viewport),
    widest,
  };
}

/** The serious and critical axe findings, with the rules of the project's own check. */
export async function runAxe() {
  const { violations } = await window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  });
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    }));
}

/**
 * Controls under 44 px, and controls whose accessible name leaves out words they show (WCAG 2.5.3,
 * T-212). Links inside running text are left out of the first list, as the rule allows, and so is
 * a control whose box is smaller but whose press area holds a 44 px square a press is found to
 * reach (`pressArea`). A size listed is the press area drawn (`target`): the box with what its
 * `::before` or `::after` draws over it (T-296), cut where its boxes clip it. When another element
 * lies over part of it, what is judged and listed is the part left (T-355): its largest rectangle
 * a press reaches, with `partlyCovered`. One a press reaches nowhere is listed with its own size
 * and `covered`. With a `minimum` of 0 no control is too small, and only the names are measured.
 */
export function measureControls(minimum) {
  const CONTROLS = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[contenteditable="true"]',
    ...[
      'button',
      'link',
      'checkbox',
      'radio',
      'switch',
      'tab',
      'menuitem',
      'menuitemradio',
      'menuitemcheckbox',
      'option',
      'combobox',
      'textbox',
      'searchbox',
      'slider',
      'spinbutton',
    ].map((role) => `[role="${role}"]`),
  ].join(',');

  const shown = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    if (box.right <= 0 || box.bottom + window.scrollY <= 0) return false;
    if (el.closest('[inert]')) return false;
    // Also false inside a closed <details>, whose content still has a box to measure.
    return el.checkVisibility({ visibilityProperty: true });
  };
  const disabled = (el) => el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true';

  /** A link in a sentence: it sits inline among words that are not its own. */
  const inText = (el) => {
    if (el.tagName !== 'A' || !getComputedStyle(el).display.startsWith('inline')) return false;
    let block = el.parentElement;
    while (block && getComputedStyle(block).display.startsWith('inline')) {
      block = block.parentElement;
    }
    if (!block) return false;
    const around = (block.textContent ?? '').replace(el.textContent ?? '', '');
    return around.trim().split(/\s+/).filter(Boolean).length >= 3;
  };

  /** A length in pixels, a percentage of `basis`, or null for anything else (auto, normal). */
  const length = (value, basis) => {
    if (typeof value !== 'string') return null;
    const px = /^(-?[\d.]+(?:e-?\d+)?)px$/.exec(value.trim());
    if (px) return Number(px[1]);
    const percent = /^(-?[\d.]+)%$/.exec(value.trim());
    return percent ? (Number(percent[1]) * basis) / 100 : null;
  };
  /** Whether a box is the containing block of what is placed absolutely (or, `fixed`, fixed) in it. */
  const contains = (style, fixed) =>
    (!fixed && style.position !== 'static') ||
    (style.transform && style.transform !== 'none') ||
    (style.filter && style.filter !== 'none') ||
    (style.perspective && style.perspective !== 'none') ||
    /\b(paint|layout|strict|content)\b/.test(style.contain ?? '') ||
    /\b(transform|filter|perspective)\b/.test(style.willChange ?? '');
  /** The element whose padding box something placed in `from` (itself included) is set against. */
  const containingBlock = (from, fixed) => {
    for (let up = from; up && up !== document.documentElement; up = up.parentElement) {
      if (contains(getComputedStyle(up), fixed)) return up;
    }
    return null;
  };
  /** The padding box of a containing block in the window, as its contents scroll in it. */
  const paddingBox = (block, fixed) => {
    if (!block) {
      return fixed
        ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
        : {
            left: -window.scrollX,
            top: -window.scrollY,
            width: document.documentElement.clientWidth,
            height: document.documentElement.clientHeight,
          };
    }
    const box = block.getBoundingClientRect();
    return {
      left: box.left + block.clientLeft - block.scrollLeft,
      top: box.top + block.clientTop - block.scrollTop,
      width: block.clientWidth,
      height: block.clientHeight,
    };
  };
  /** The six numbers of a 2D transform matrix (a 3D one's 2D part), or null when there is none. */
  const matrixOf = (transform) => {
    const m = /^matrix(3d)?\(([^)]*)\)$/.exec((transform ?? '').trim());
    if (!m) return null;
    const n = m[2].split(',').map(Number);
    return m[1] ? [n[0], n[1], n[4], n[5], n[12], n[13]] : n;
  };
  const meet = (a, b) => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });

  /**
   * The boxes of an element's `::before` and `::after` that a finger presses it through (T-296): a
   * press area drawn over a control that keeps its look, such as the timeline bar's on touch
   * (T-293). One counts when it is drawn (content), placed out of the flow (absolute or fixed) and
   * takes presses (pointer-events, visibility). Its place comes from its computed style, whose
   * offsets and size a browser gives in pixels for a placed box, moved by its 2D transform and its
   * `translate`, and cut by every box on its way up that clips what it does not hold: overflow
   * hidden, clip, auto or scroll, at the box's padding edge as it is in the window (a scroller's
   * own scroll moves what is in it, not where it cuts).
   */
  const pseudoBoxes = (el) => {
    const boxes = [];
    for (const which of ['::before', '::after']) {
      const s = getComputedStyle(el, which);
      if (!s?.content || s.content === 'none' || s.content === 'normal') continue;
      if (s.display === 'none' || s.pointerEvents === 'none' || s.visibility === 'hidden') continue;
      const fixed = s.position === 'fixed';
      if (s.position !== 'absolute' && !fixed) continue;
      const block = containingBlock(el, fixed);
      const pad = paddingBox(block, fixed);
      const px = (value, basis) => length(value, basis) ?? 0;
      const [ml, mr, mt, mb] = ['marginLeft', 'marginRight', 'marginTop', 'marginBottom'].map(
        (side) => px(s[side], pad.width),
      );
      // Padding and border, added to a size given for the content box.
      const extra = (a, b, c, d) =>
        s.boxSizing === 'content-box'
          ? px(s[a], pad.width) + px(s[b], pad.width) + px(s[c], 0) + px(s[d], 0)
          : 0;
      const across = (start, end, size, from, span, m1, m2, more) => {
        const a = length(s[start], span);
        const b = length(s[end], span);
        let w = length(s[size], span);
        w = w === null ? (a !== null && b !== null ? span - a - b - m1 - m2 : null) : w + more;
        if (w === null) return null;
        if (a !== null) return [from + a + m1, w];
        if (b !== null) return [from + span - b - m2 - w, w];
        return null;
      };
      const x = across(
        'left',
        'right',
        'width',
        pad.left,
        pad.width,
        ml,
        mr,
        extra('paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'),
      );
      const y = across(
        'top',
        'bottom',
        'height',
        pad.top,
        pad.height,
        mt,
        mb,
        extra('paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'),
      );
      if (!x || !y || x[1] <= 0 || y[1] <= 0) continue;
      let corners = [
        [x[0], y[0]],
        [x[0] + x[1], y[0]],
        [x[0], y[0] + y[1]],
        [x[0] + x[1], y[0] + y[1]],
      ];
      const [ox = x[1] / 2, oy = y[1] / 2] = (s.transformOrigin ?? '')
        .split(/\s+/)
        .map((v, i) => length(v, i === 0 ? x[1] : y[1]) ?? undefined);
      const m = matrixOf(s.transform);
      if (m) {
        const [a, b, c, d, e, f] = m;
        const [cx, cy] = [x[0] + ox, y[0] + oy];
        corners = corners.map(([px0, py0]) => {
          const [dx, dy] = [px0 - cx, py0 - cy];
          return [cx + a * dx + c * dy + e, cy + b * dx + d * dy + f];
        });
      }
      if (s.translate && s.translate !== 'none') {
        const [tx = '0px', ty = '0px'] = s.translate.split(/\s+/);
        const [dx, dy] = [length(tx, x[1]) ?? 0, length(ty, y[1]) ?? 0];
        corners = corners.map(([cx, cy]) => [cx + dx, cy + dy]);
      }
      let box = {
        left: Math.min(...corners.map(([cx]) => cx)),
        top: Math.min(...corners.map(([, cy]) => cy)),
        right: Math.max(...corners.map(([cx]) => cx)),
        bottom: Math.max(...corners.map(([, cy]) => cy)),
      };
      // What clips overflow cuts it, from its containing block up; a box placed in another skips
      // those between.
      for (let up = block; up && up !== document.documentElement && up !== document.body; ) {
        const style = getComputedStyle(up);
        const outer = up.getBoundingClientRect();
        const left = outer.left + up.clientLeft;
        const top = outer.top + up.clientTop;
        const edge = { left, top, right: left + up.clientWidth, bottom: top + up.clientHeight };
        // Only `visible` lets what is drawn past the edge be seen and pressed.
        const hides = (v) => Boolean(v) && v !== 'visible';
        const cut = meet(box, edge);
        if (hides(style.overflowX)) box = { ...box, left: cut.left, right: cut.right };
        if (hides(style.overflowY)) box = { ...box, top: cut.top, bottom: cut.bottom };
        if (style.position === 'fixed') break;
        up =
          style.position === 'absolute'
            ? containingBlock(up.parentElement, false)
            : up.parentElement;
      }
      if (box.right > box.left && box.bottom > box.top) boxes.push(box);
    }
    return boxes;
  };

  /**
   * What a finger can press, as drawn: a control hidden behind its label is pressed through the
   * label (`own`), and a control smaller than a finger also through the press area its `::before`
   * or `::after` draws over it, together with its own box (`drawn`, `pseudoBoxes`, T-296). What is
   * drawn is not yet what a press reaches: another element may lie over it, so a control whose
   * `own` is under a finger is still pressed (`pressArea`), and `drawn` only sizes what is listed.
   * `area` is the rectangle around all of it in the window, where `pressArea` looks (T-355).
   */
  const target = (el) => {
    const own = el.getBoundingClientRect();
    let width = own.width;
    let height = own.height;
    let area = { left: own.left, top: own.top, right: own.right, bottom: own.bottom };
    const grow = (box) => {
      area = {
        left: Math.min(area.left, box.left),
        top: Math.min(area.top, box.top),
        right: Math.max(area.right, box.right),
        bottom: Math.max(area.bottom, box.bottom),
      };
    };
    for (const label of el.labels ?? []) {
      const box = label.getBoundingClientRect();
      width = Math.max(width, box.width);
      height = Math.max(height, box.height);
      grow(box);
    }
    const round = (n) => Math.round(n * 10) / 10;
    const labelled = { width: round(width), height: round(height) };
    if (width < minimum || height < minimum) {
      const mine = { left: own.left, top: own.top, right: own.right, bottom: own.bottom };
      for (const box of pseudoBoxes(el)) {
        const both = meet(mine, box);
        // Only a press area that meets the box: one placed elsewhere is no part of this target.
        if (both.left > both.right + 0.5 || both.top > both.bottom + 0.5) continue;
        width = Math.max(width, Math.max(mine.right, box.right) - Math.min(mine.left, box.left));
        height = Math.max(height, Math.max(mine.bottom, box.bottom) - Math.min(mine.top, box.top));
        grow(box);
      }
    }
    return { own: labelled, drawn: { width: round(width), height: round(height) }, area };
  };

  /** Whether a press at this point of the window reaches the control, itself or by its label. */
  const reaches = (el, x, y) => {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
    const found = document.elementFromPoint(x, y);
    if (!found) return false;
    if (found === el || el.contains(found)) return true;
    return [...(el.labels ?? [])].some((label) => label === found || label.contains(found));
  };

  /** The largest rectangle of `true` in rows of booleans, as [columns, rows]. */
  const largestRectangle = (grid) => {
    const heights = new Array(grid[0]?.length ?? 0).fill(0);
    let best = [0, 0];
    for (const row of grid) {
      row.forEach((hit, i) => {
        heights[i] = hit ? heights[i] + 1 : 0;
      });
      // The widest run at each height, with a stack of rising heights.
      const stack = [];
      for (let i = 0; i <= heights.length; i += 1) {
        const h = i < heights.length ? heights[i] : 0;
        let from = i;
        while (stack.length > 0 && stack[stack.length - 1][1] >= h) {
          const [start, height] = stack.pop();
          if ((i - start) * height > best[0] * best[1]) best = [i - start, height];
          from = start;
        }
        stack.push([from, h]);
      }
    }
    return best;
  };
  /** The side of the largest square of `true` in rows of booleans. */
  const largestSquare = (grid) => {
    let above = new Array(grid[0]?.length ?? 0).fill(0);
    let side = 0;
    for (const row of grid) {
      const here = row.map(() => 0);
      row.forEach((hit, i) => {
        if (!hit) return;
        here[i] = 1 + (i === 0 ? 0 : Math.min(above[i], here[i - 1], above[i - 1]));
        side = Math.max(side, here[i]);
      });
      above = here;
    }
    return side;
  };

  /**
   * What a finger can press of a control, however it is drawn: a box smaller than a finger can
   * still be pressed over more, through a pseudo-element (the timeline's key links and one-day
   * bars, TR-21) or a label, and a part another element lies over cannot be pressed (T-355). The
   * control is scrolled into the window and its press area sampled a pixel apart with
   * elementFromPoint: the area drawn (`target`), with what a press is found to reach out from the
   * control's centre along both axes. `pressable` says a whole `minimum` square is reached;
   * `reached` whether all, part or none of the area drawn is; `uncovered` is the largest rectangle
   * reached (not measured for one found pressable at once). Every scroll position it changed is
   * put back.
   */
  const pressArea = (el) => {
    const scrolled = [];
    for (let up = el.parentElement; up; up = up.parentElement) {
      scrolled.push([up, up.scrollLeft, up.scrollTop]);
    }
    const [windowX, windowY] = [window.scrollX, window.scrollY];
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const { area } = target(el);
      const box = el.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const out = (dx, dy) => {
        let d = 0;
        while (d < minimum && reaches(el, cx + (d + 1) * dx, cy + (d + 1) * dy)) d += 1;
        return d;
      };
      // Where a press reaches past the area drawn (one no pseudo-element's style accounts for).
      const [left, right, up, down] = reaches(el, cx, cy)
        ? [out(-1, 0), out(1, 0), out(0, -1), out(0, 1)]
        : [0, 0, 0, 0];
      // Most controls a finger can press are found so quickly: a square of that size inside what
      // the centre reaches, sampled on a 5 x 5 grid. Only the others are sampled all over.
      const side = minimum - 1;
      if (left + right >= side && up + down >= side) {
        const start = (centre, before, after) =>
          Math.min(Math.max(centre - side / 2, centre - before), centre + after - side);
        const [x0, y0] = [start(cx, left, right), start(cy, up, down)];
        let whole = true;
        for (let i = 0; whole && i <= 4; i += 1) {
          for (let j = 0; whole && j <= 4; j += 1) {
            whole = reaches(el, x0 + (i * side) / 4, y0 + (j * side) / 4);
          }
        }
        if (whole) return { pressable: true, reached: 'all', uncovered: null };
      }
      // What is outside the window is not pressed: only what is inside it is looked at.
      const look = {
        left: Math.max(0, Math.min(area.left, cx - left)),
        top: Math.max(0, Math.min(area.top, cy - up)),
        right: Math.min(window.innerWidth, Math.max(area.right, cx + right + 1)),
        bottom: Math.min(window.innerHeight, Math.max(area.bottom, cy + down + 1)),
      };
      const [width, height] = [look.right - look.left, look.bottom - look.top];
      if (width <= 0 || height <= 0) {
        return { pressable: false, reached: 'none', uncovered: { width: 0, height: 0 } };
      }
      // A pixel apart, or further apart over a large area so that it stays quick.
      const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / 10_000)));
      const [columns, rows] = [Math.ceil(width / step), Math.ceil(height / step)];
      let [drawn, drawnReached, anyReached] = [0, 0, false];
      const grid = [];
      for (let j = 0; j < rows; j += 1) {
        const y = look.top + (j + 0.5) * step;
        const row = [];
        for (let i = 0; i < columns; i += 1) {
          const x = look.left + (i + 0.5) * step;
          const hit = reaches(el, x, y);
          row.push(hit);
          anyReached ||= hit;
          if (x >= area.left && x < area.right && y >= area.top && y < area.bottom) {
            drawn += 1;
            if (hit) drawnReached += 1;
          }
        }
        grid.push(row);
      }
      const [across, tall] = largestRectangle(grid);
      let reached = 'part';
      if (!anyReached) reached = 'none';
      else if (drawn === 0 || drawnReached === drawn) reached = 'all';
      return {
        // Sampled a pixel apart, an area `minimum` across is hit `minimum` times, give or take one.
        pressable: (largestSquare(grid) + 1) * step >= minimum,
        reached,
        uncovered: { width: across * step, height: tall * step },
      };
    } finally {
      for (const [up, left, top] of scrolled) {
        up.scrollLeft = left;
        up.scrollTop = top;
      }
      window.scrollTo(windowX, windowY);
    }
  };

  /**
   * What the control's aria-describedby names: a hint there describes it and is no part of its
   * name, even inside its label (the appearance radios' hints, T-287).
   */
  const described = (el) =>
    (el.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter((hint) => hint !== null);
  /**
   * Text a person can read on the element: not what is hidden, not a select's options, not what
   * is inside one of `left` (the control's descriptions).
   */
  const readable = (el, left = []) => {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('select, textarea, option')) continue;
      if (left.some((hint) => hint.contains(parent))) continue;
      const box = parent.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue;
      if (!parent.checkVisibility({ visibilityProperty: true })) continue;
      parts.push(node.nodeValue ?? '');
    }
    return parts.join(' ');
  };
  const visibleWords = (el) => {
    if (el.matches('input[type="button"], input[type="submit"], input[type="reset"]')) {
      return el.value;
    }
    const hints = described(el);
    // What a field holds is its value, not its label: only its label is held against its name.
    if (
      el.matches(
        'input, select, textarea, [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="slider"], [role="spinbutton"]',
      )
    ) {
      return [...(el.labels ?? [])].map((label) => readable(label, hints)).join(' ');
    }
    return readable(el, hints);
  };
  const words = (text) =>
    (text ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .match(/[\p{L}\p{N}]+/gu) ?? [];

  const { axe } = window;
  axe.setup(document.documentElement);
  const small = [];
  const names = [];
  try {
    for (const el of document.querySelectorAll(CONTROLS)) {
      if (!shown(el) || disabled(el)) continue;
      const role = axe.commons.aria.getRole(el) ?? el.tagName.toLowerCase();
      let name = '';
      try {
        name = axe.commons.text.accessibleText(el) ?? '';
      } catch {
        continue;
      }
      // axe gives a button with the combobox role no name from its label; browsers do.
      if (!name.trim() && el.labels?.length) {
        name = [...el.labels].map((label) => label.textContent ?? '').join(' ');
      }
      name = name.trim().replace(/\s+/g, ' ');
      const { own, drawn } = target(el);
      if ((own.width < minimum || own.height < minimum) && !inText(el)) {
        const press = pressArea(el);
        if (!press.pressable) {
          // Listed by what a press reaches: the area drawn when it reaches all of it, the largest
          // part left when something lies over the rest (T-355), its own size when none is left.
          const size = {
            all: drawn,
            part: { ...press.uncovered, partlyCovered: true },
            none: { ...own, covered: true },
          }[press.reached];
          small.push({ role, name: name.slice(0, 80), ...size });
        }
      }
      const seen = words(visibleWords(el));
      const said = words(name).join(' ');
      const left = seen.filter((w) => !said.includes(w));
      if (left.length > 0) {
        names.push({
          role,
          name: name.slice(0, 80),
          visible: seen.join(' ').slice(0, 80),
          leftOut: [...new Set(left)].slice(0, 8),
        });
      }
    }
  } finally {
    axe.teardown();
  }
  return { small, names };
}

/** The page in a line or two: what it says it is, in what language and skin, and how long. */
export function describePage() {
  const heading = document.querySelector('h1');
  const alerts = [...document.querySelectorAll('[role="alert"]')]
    .map((a) => (a.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120))
    .filter(Boolean);
  return {
    h1: (heading?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120),
    lang: document.documentElement.lang,
    skin: document.documentElement.dataset.skin ?? '',
    height: document.documentElement.scrollHeight,
    alerts: alerts.slice(0, 3),
  };
}

/** Whether the page has stopped saying it is loading. */
export function looksSettled() {
  if (document.querySelector('[aria-busy="true"]')) return false;
  const text = document.body?.innerText ?? '';
  return !/^\s*(Loading|Cargando|Checking|Comprobando)\b/m.test(text);
}

/**
 * How much of the window bars stuck to its top and bottom cover, for stepping a phone picture
 * through the page (plan.mjs windowStops). Wide fixed or sticky elements only; one taller than half
 * the window is a backdrop or a veil, not a bar.
 */
export function stuckEdges() {
  const height = window.innerHeight;
  const width = window.innerWidth;
  let top = 0;
  let bottom = 0;
  for (const el of document.body.querySelectorAll('*')) {
    const { position } = getComputedStyle(el);
    if (position !== 'fixed' && position !== 'sticky') continue;
    const box = el.getBoundingClientRect();
    if (box.width < width / 2 || box.height <= 0 || box.height > height / 2) continue;
    if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    if (box.top <= 1 && box.bottom > 0) top = Math.max(top, box.bottom);
    if (box.bottom >= height - 1 && box.top < height) bottom = Math.max(bottom, height - box.top);
  }
  return {
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: height,
    stuckTop: Math.ceil(top),
    stuckBottom: Math.ceil(bottom),
  };
}

/** Scrolls the window at once (no smooth scrolling) and waits for two frames to be drawn. */
export async function scrollWindowTo(y) {
  window.scrollTo({ top: y, left: 0, behavior: 'instant' });
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  return window.scrollY;
}

/** What the page believes about its pointer and window: a phone's touch, or a mouse. */
export function pointerState() {
  return {
    coarse: window.matchMedia('(pointer: coarse)').matches,
    touchPoints: navigator.maxTouchPoints,
    innerWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio,
  };
}
