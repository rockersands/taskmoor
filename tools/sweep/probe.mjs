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
 * T-212). Links inside running text are left out of the first list, as the rule allows.
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

  /** What a finger can press: a control hidden behind its label is pressed through the label. */
  const target = (el) => {
    const own = el.getBoundingClientRect();
    let width = own.width;
    let height = own.height;
    for (const label of el.labels ?? []) {
      const box = label.getBoundingClientRect();
      width = Math.max(width, box.width);
      height = Math.max(height, box.height);
    }
    return { width: Math.round(width * 10) / 10, height: Math.round(height * 10) / 10 };
  };

  /** Text a person can read on the element: not what is hidden, not a select's options. */
  const readable = (el) => {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('select, textarea, option')) continue;
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
    // What a field holds is its value, not its label: only its label is held against its name.
    if (
      el.matches(
        'input, select, textarea, [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="slider"], [role="spinbutton"]',
      )
    ) {
      return [...(el.labels ?? [])].map(readable).join(' ');
    }
    return readable(el);
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
      const size = target(el);
      if ((size.width < minimum || size.height < minimum) && !inText(el)) {
        small.push({ role, name: name.slice(0, 80), ...size });
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
