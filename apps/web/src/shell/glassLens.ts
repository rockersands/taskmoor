/**
 * Refraction for the glass surfaces (ADR-114): a thick slab bends what lies behind it near its
 * rim and leaves the middle clear. Each surface gets an SVG displacement filter drawn for its
 * size and corner radius, used through `backdrop-filter: url(#...)` by way of `--glass-lens`.
 *
 * Only Chromium draws such a filter on a backdrop. Everywhere else, and when a person asked for
 * less transparency or forced colours, nothing here runs and `--glass-lens` stays unset, so the
 * surfaces keep their blur and sheen. Board cards are never in the list: a board can hold
 * thousands of them. Nor is the sidebar or a panel: nothing but the smooth canvas lies behind
 * them, so a filter there would cost time and show nothing. A surface inside another blurred
 * surface is left out too (see `insideGlass`).
 */
const LENS_SURFACES = [
  '.shell-topbar',
  '.shell-drawer',
  '.help-tip-body',
  '.user-menu-popup',
  '.palette',
  '.ticket-dialog',
].join(',');

/** Past this many surfaces on one page the rest keep their plain blur. */
const MAX_SURFACES = 48;
const MAX_FILTERS = 64;

interface Strength {
  /** How far the rim bends the backdrop, in pixels. */
  bend: number;
  /** How far in from the edge the bending reaches, in pixels. */
  rim: number;
  /** How much further blue bends than red: the faint colour at the edge. */
  dispersion: number;
}

const STRENGTH: Strength = { bend: 30, rim: 26, dispersion: 0.18 };

/**
 * How far a point of a rounded slab bends, as a fraction of the full bend along each axis: no
 * bend past `rim` from the edge, the most at the edge, pointing into the slab.
 */
export function rimDisplacement(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  rim: number,
): [number, number] {
  const r = Math.min(radius, width / 2, height / 2);
  const px = x - width / 2;
  const py = y - height / 2;
  const qx = Math.abs(px) - (width / 2 - r);
  const qy = Math.abs(py) - (height / 2 - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const corner = Math.hypot(ox, oy);
  const inside = r - (corner + Math.min(Math.max(qx, qy), 0));
  const depth = 1 - inside / rim;
  if (depth <= 0) return [0, 0];
  // A slab's edge curves away fast: most of the bend sits right at the rim.
  const amount = Math.min(depth, 1) ** 2.4;
  let nx: number;
  let ny: number;
  if (corner > 0) {
    nx = ox / corner;
    ny = oy / corner;
  } else if (qx > qy) {
    nx = 1;
    ny = 0;
  } else {
    nx = 0;
    ny = 1;
  }
  return [-Math.sign(px) * nx * amount, -Math.sign(py) * ny * amount];
}

/** The displacement map as an image: red is sideways, green is up and down, grey is no bend. */
function drawMap(width: number, height: number, radius: number, rim: number): string {
  const w = Math.max(2, Math.ceil(width / 2));
  const h = Math.max(2, Math.ceil(height / 2));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const image = context.createImageData(w, h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [dx, dy] = rimDisplacement(
        ((i + 0.5) / w) * width,
        ((j + 0.5) / h) * height,
        width,
        height,
        radius,
        rim,
      );
      const at = (j * w + i) * 4;
      image.data[at] = 128 + dx * 127;
      image.data[at + 1] = 128 + dy * 127;
      image.data[at + 2] = 128;
      image.data[at + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

const SVG = 'http://www.w3.org/2000/svg';

function element(name: string, attributes: Record<string, string | number>, parent: Element) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  parent.append(node);
  return node;
}

const CHANNEL = {
  r: '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0',
  g: '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0',
  b: '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0',
};

function addFilter(
  parent: Element,
  id: string,
  width: number,
  height: number,
  radius: number,
  strength: Strength,
) {
  const rim = Math.min(strength.rim, Math.max(6, Math.min(width, height) * 0.45));
  // A small pill bends less than a wide bar, or its label's backdrop would fold over.
  const bend = Math.min(strength.bend, Math.max(5, Math.min(width, height) * 0.4)) * 2;
  const filter = element(
    'filter',
    {
      id,
      x: 0,
      y: 0,
      width: '100%',
      height: '100%',
      'color-interpolation-filters': 'sRGB',
    },
    parent,
  );
  element(
    'feImage',
    {
      href: drawMap(width, height, radius, rim),
      x: 0,
      y: 0,
      width,
      height,
      preserveAspectRatio: 'none',
      result: 'map',
    },
    filter,
  );
  (['r', 'g', 'b'] as const).forEach((channel, index) => {
    element(
      'feDisplacementMap',
      {
        in: 'SourceGraphic',
        in2: 'map',
        scale: bend * (1 + strength.dispersion * index),
        xChannelSelector: 'R',
        yChannelSelector: 'G',
        result: `${channel}0`,
      },
      filter,
    );
    element(
      'feColorMatrix',
      { in: `${channel}0`, type: 'matrix', values: CHANNEL[channel], result: channel },
      filter,
    );
  });
  element('feBlend', { in: 'r', in2: 'g', mode: 'screen', result: 'rg' }, filter);
  element('feBlend', { in: 'rg', in2: 'b', mode: 'screen' }, filter);
}

/** Whether this browser draws a filter on a backdrop and the person wants the effect. */
export function lensAvailable(
  brands: readonly { brand: string }[] | undefined,
  matches: (query: string) => boolean,
  supports: (property: string, value: string) => boolean,
): boolean {
  if (!brands?.some((b) => b.brand === 'Chromium')) return false;
  if (matches('(prefers-reduced-transparency: reduce)')) return false;
  if (matches('(forced-colors: active)')) return false;
  return supports('backdrop-filter', 'url(#a)');
}

/**
 * Inside a surface with a backdrop filter, a backdrop stops at that surface. Chromium then paints
 * the displacement filter as solid grey where nothing lies behind, so such a surface goes without.
 */
function insideGlass(surface: HTMLElement): boolean {
  for (let at = surface.parentElement; at; at = at.parentElement) {
    if (getComputedStyle(at).backdropFilter !== 'none') return true;
  }
  return false;
}

/** Starts the lenses for this page; returns how to stop them. Does nothing where unavailable. */
export function startGlassLens(): () => void {
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } })
    .userAgentData?.brands;
  const matches = (query: string) => window.matchMedia?.(query).matches === true;
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return () => {};
  if (!lensAvailable(brands, matches, (p, v) => CSS.supports(p, v))) return () => {};

  const holder = document.createElementNS(SVG, 'svg');
  holder.setAttribute('aria-hidden', 'true');
  holder.setAttribute('width', '0');
  holder.setAttribute('height', '0');
  holder.style.position = 'absolute';
  document.body.append(holder);

  const filters = new Map<string, string>();
  let timer = 0;

  const resize = new ResizeObserver(() => schedule());

  const update = () => {
    if (filters.size > MAX_FILTERS) {
      holder.replaceChildren();
      filters.clear();
    }
    const surfaces = [...document.querySelectorAll<HTMLElement>(LENS_SURFACES)].slice(
      0,
      MAX_SURFACES,
    );
    for (const surface of surfaces) {
      if (insideGlass(surface)) continue;
      resize.observe(surface);
      const box = surface.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) continue;
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      const radius = Math.min(
        Number.parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 0,
        width / 2,
        height / 2,
      );
      const key = `${width}x${height}r${Math.round(radius)}`;
      let id = filters.get(key);
      if (!id) {
        id = `glass-lens-${filters.size}`;
        filters.set(key, id);
        addFilter(holder, id, width, height, radius, STRENGTH);
      }
      surface.style.setProperty('--glass-lens', `url(#${id})`);
    }
  };

  function schedule() {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => window.requestAnimationFrame(update), 120);
  }

  // A page change adds surfaces and moves the current place; a page's own updates stay cheap,
  // because this only looks for the short list above, after the page has settled.
  const changes = new MutationObserver(schedule);
  changes.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-current', 'aria-selected'],
  });
  schedule();

  return () => {
    window.clearTimeout(timer);
    changes.disconnect();
    resize.disconnect();
    holder.remove();
  };
}
