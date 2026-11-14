import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Read from disk: the web project turns CSS imports off. Tests run from the repository or from apps/web.
const file = ['apps/web/src/styles/tokens.css', 'src/styles/tokens.css'].find((f) => existsSync(f));
const css = file ? readFileSync(file, 'utf8') : '';

/**
 * Contrast of the design tokens (M1-115; NFR-005, WCAG 2.1 AA 1.4.3 and 1.4.11), in both skins:
 * every text colour on every background it is used on reaches 4.5:1, and field borders and the
 * focus ring reach 3:1 against the surfaces they sit on. A token change that breaks a pair fails
 * here before any page shows it.
 */
function skin(name: 'light' | 'dark'): Record<string, string> {
  const block =
    new RegExp(`\\[data-skin="${name}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? '';
  return Object.fromEntries(
    [...block.matchAll(/--(color-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [
      m[1] as string,
      m[2] as string,
    ]),
  );
}

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
};
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

const SURFACES = ['color-canvas', 'color-surface', 'color-surface-raised', 'color-surface-sunken'];
const TEXT: [string, string[]][] = [
  [
    'color-text',
    [
      ...SURFACES,
      'color-accent-soft',
      'color-danger-soft',
      'color-warning-soft',
      'color-success-soft',
    ],
  ],
  ['color-text-muted', SURFACES],
  ['color-accent', ['color-surface', 'color-surface-raised']],
  ['color-on-accent', ['color-accent']],
  ['color-on-primary', ['color-primary']],
  ['color-danger', ['color-danger-soft', 'color-surface', 'color-surface-raised']],
  ['color-warning', ['color-warning-soft', 'color-surface-raised']],
  ['color-success', ['color-success-soft', 'color-surface-raised']],
  ['color-surface', ['color-danger']],
  ['color-blue', ['color-blue-soft']],
  ['color-blush', ['color-blush-soft']],
  ['color-butter', ['color-butter-soft']],
  // Google's sign-in button (T-061): its label on its own fill.
  ['color-google-text', ['color-google-fill']],
];
const NON_TEXT: [string, string[]][] = [
  ['color-field-border', ['color-surface', 'color-surface-raised']],
  ['color-focus', SURFACES],
];

describe('design token contrast (M1-115)', () => {
  for (const name of ['light', 'dark'] as const) {
    it(`[NFR-005] reaches WCAG 2.1 AA in the ${name} skin`, () => {
      const tokens = skin(name);
      const short: string[] = [];
      const check = (pairs: [string, string[]][], minimum: number) => {
        for (const [fore, backs] of pairs) {
          for (const back of backs) {
            const a = tokens[fore];
            const b = tokens[back];
            if (!a || !b) {
              short.push(`${fore} on ${back}: missing`);
              continue;
            }
            const ratio = contrast(a, b);
            if (ratio < minimum) short.push(`${fore} on ${back}: ${ratio.toFixed(2)} < ${minimum}`);
          }
        }
      };
      check(TEXT, 4.5);
      check(NON_TEXT, 3);
      expect(short).toEqual([]);
    });
  }

  it("[CORE-022] prints the tones in the light skin's values, whatever the skin (PL-27, D37)", () => {
    const sheet = file ? readFileSync(file.replace('tokens.css', 'print.css'), 'utf8') : '';
    const printed = Object.fromEntries(
      [...sheet.matchAll(/--(color-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]),
    );
    const light = skin('light');
    const tones = ['danger', 'warning', 'success', 'blue', 'blush', 'butter'].flatMap((tone) => [
      `color-${tone}`,
      `color-${tone}-soft`,
    ]);
    expect(Object.fromEntries(tones.map((tone) => [tone, printed[tone]]))).toEqual(
      Object.fromEntries(tones.map((tone) => [tone, light[tone]])),
    );
    // And so they keep their contrast on the white paper.
    for (const tone of ['danger', 'warning', 'success', 'blue']) {
      expect(contrast(printed[`color-${tone}`] ?? '#ffffff', '#ffffff')).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });
});

/**
 * Text over the canvas picture and over glass (UI-T02, ADR-114). Glass makes a surface's colour
 * depend on what is behind it, so these composite the real layers at every cell of a grid over
 * the picture (`canvas-samples.json`, from `build/canvas-samples.mjs`): the dim layer, then for
 * glass the blurred and saturated backdrop, the tint and the sheen at its weakest and strongest.
 * Text directly on the canvas is held against the lightest and darkest pixel of each cell.
 */
type Rgb = [number, number, number];
type Layer = { colour: Rgb; alpha: number };

const samplesFile = [
  'apps/web/src/styles/canvas-samples.json',
  'src/styles/canvas-samples.json',
].find((f) => existsSync(f));
const samples = JSON.parse(samplesFile ? readFileSync(samplesFile, 'utf8') : '{}') as {
  skins: Record<
    'light' | 'dark',
    {
      file: string;
      sha256: string;
      cells: { mean: Rgb; lightest: Rgb; darkest: Rgb }[];
    }
  >;
};

function block(name: 'light' | 'dark'): string {
  return new RegExp(String.raw`\[data-skin="${name}"\]\s*\{([\s\S]*?)\n\}`).exec(css)?.[1] ?? '';
}

function layer(name: 'light' | 'dark', token: string): Layer {
  const m = new RegExp(String.raw`--${token}:\s*rgb\((\d+) (\d+) (\d+) / (\d+)%\)`).exec(
    block(name),
  );
  if (!m) throw new Error(`${token} is not an rgb() with an alpha in the ${name} skin`);
  return {
    colour: [Number(m[1]), Number(m[2]), Number(m[3])],
    alpha: Number(m[4]) / 100,
  };
}

/** The strongest stop of a white gradient token, such as the sheen. */
function strongestWhite(name: 'light' | 'dark', token: string): number {
  const value = new RegExp(String.raw`--${token}:([\s\S]*?);`).exec(block(name))?.[1] ?? '';
  const stops = [...value.matchAll(/rgb\(255 255 255 \/ (\d+)%\)/g)].map((m) => Number(m[1]));
  if (stops.length === 0) throw new Error(`${token} has no white stops in the ${name} skin`);
  return Math.max(...stops) / 100;
}

const over = (top: Layer, under: Rgb): Rgb =>
  under.map((v, i) => (top.colour[i] as number) * top.alpha + v * (1 - top.alpha)) as Rgb;

/** The saturate() filter, as CSS defines it, for a backdrop. */
function saturate([r, g, b]: Rgb, s: number): Rgb {
  const clamp = (v: number) => Math.min(255, Math.max(0, v));
  return [
    clamp((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b),
    clamp((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b),
    clamp((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b),
  ];
}

const luminanceOf = ([r, g, b]: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratioOf = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminanceOf(a), luminanceOf(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
const hexToRgb = (hex: string): Rgb => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const saturation = Number(/--glass-saturate:\s*(\d+)%/.exec(css)?.[1] ?? '100') / 100;

describe('text on the canvas picture and on glass (UI-T02)', () => {
  for (const name of ['light', 'dark'] as const) {
    const sample = samples.skins[name];
    const tokens = skin(name);
    const dim = layer(name, 'canvas-dim');
    const sheen = strongestWhite(name, 'glass-sheen');
    const textOf = (token: string) => hexToRgb(tokens[token] as string);
    /** The worst ratio of a text colour on a tint over the whole canvas, sheen off and on. */
    const worstOnGlass = (fore: string, tint: Layer, saturation: number) => {
      let worst = Number.POSITIVE_INFINITY;
      for (const cell of sample.cells) {
        // The blur is low now, so a cell's extremes count, not only its average.
        for (const pixel of [cell.mean, cell.lightest, cell.darkest]) {
          const glass = over(tint, saturate(over(dim, pixel), saturation));
          worst = Math.min(
            worst,
            ratioOf(textOf(fore), glass),
            ratioOf(textOf(fore), over({ colour: [255, 255, 255], alpha: sheen }, glass)),
          );
        }
      }
      return worst;
    };

    it(`[NFR-005] measures the picture the ${name} skin really uses`, () => {
      const picture = ['apps/web/src/assets/glass/', 'src/assets/glass/']
        .map((dir) => `${dir}${sample.file}`)
        .find((f) => existsSync(f));
      const bytes = readFileSync(picture ?? sample.file);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sample.sha256);
      expect(block(name)).toContain(`assets/glass/${sample.file}`);
    });

    it(`[NFR-005] keeps text directly on the canvas at AA in the ${name} skin`, () => {
      const short: string[] = [];
      for (const fore of ['color-text', 'color-text-muted', 'color-accent', 'color-danger']) {
        let worst = Number.POSITIVE_INFINITY;
        for (const cell of sample.cells) {
          for (const pixel of [cell.lightest, cell.darkest]) {
            worst = Math.min(worst, ratioOf(textOf(fore), over(dim, pixel)));
          }
        }
        if (worst < 4.5) short.push(`${fore} on the canvas: ${worst.toFixed(2)} < 4.5`);
      }
      expect(short).toEqual([]);
    });

    {
      const tintOf = (token: string) => layer(name, token);
      const amount = saturation;

      it(`[NFR-005] keeps text on glass at AA over the whole canvas in the ${name} skin`, () => {
        const short: string[] = [];
        for (const surface of [
          'glass-surface',
          'glass-surface-chrome',
          'glass-surface-sunken',
          'glass-surface-strong',
        ]) {
          for (const fore of ['color-text', 'color-text-muted', 'color-accent']) {
            const worst = worstOnGlass(fore, tintOf(surface), amount);
            if (worst < 4.5) short.push(`${fore} on ${surface}: ${worst.toFixed(2)} < 4.5`);
          }
        }
        expect(short).toEqual([]);
      });

      it(`[NFR-005] keeps the top bar's text at AA over what scrolls under it, ${name}`, () => {
        // The strongest fill that passes under it, at full strength, as if the blur mixed nothing.
        const chrome = tintOf('glass-surface-chrome');
        const short: string[] = [];
        for (const under of ['color-primary', 'color-surface-raised']) {
          const back = over(chrome, saturate(textOf(under), amount));
          // The top bar's labels and its search field use the full text colour for this reason.
          const ratio = ratioOf(textOf('color-text'), back);
          if (ratio < 4.5) short.push(`color-text over ${under}: ${ratio.toFixed(2)} < 4.5`);
        }
        expect(short).toEqual([]);
      });
    }

    it(`[NFR-005] keeps a label on the clear part of a control at AA in the ${name} skin`, () => {
      // The current place and the selected tab: their label on the clear part, on chrome or a card.
      const lens = layer(name, 'glass-lens-fill');
      const short: string[] = [];
      for (const surface of ['glass-surface-chrome', 'glass-surface']) {
        for (const fore of ['color-text', 'color-accent']) {
          let worst = Number.POSITIVE_INFINITY;
          for (const cell of sample.cells) {
            for (const pixel of [cell.lightest, cell.darkest]) {
              const glass = over(layer(name, surface), saturate(over(dim, pixel), saturation));
              worst = Math.min(worst, ratioOf(textOf(fore), over(lens, glass)));
            }
          }
          if (worst < 4.5) short.push(`${fore} on the lens over ${surface}: ${worst.toFixed(2)}`);
        }
      }
      expect(short).toEqual([]);
    });

    it(`[NFR-005] keeps a chip that is on readable over the canvas in the ${name} skin`, () => {
      // `.filter-chip[aria-pressed="true"]`: its label at 4.5:1, its tick at 3:1.
      const tint = layer(name, 'glass-tint-accent');
      expect(worstOnGlass('color-text', tint, saturation)).toBeGreaterThanOrEqual(4.5);
      expect(worstOnGlass('color-accent', tint, saturation)).toBeGreaterThanOrEqual(3);
    });

    it(`[NFR-005] keeps the shared field readable, with an edge of 3:1, in the ${name} skin`, () => {
      // `:where(input, select, textarea)` in forms.css, wherever a field can sit: straight on the
      // canvas, on any glass surface and on an opaque one (a dialog).
      const field = layer(name, 'field-surface');
      const unders: { label: string; pixels: Rgb[] }[] = [
        {
          label: 'the canvas',
          pixels: sample.cells.flatMap((c) => [c.lightest, c.darkest].map((p) => over(dim, p))),
        },
        ...['glass-surface', 'glass-surface-chrome', 'glass-surface-strong'].map((surface) => ({
          label: surface,
          pixels: sample.cells.flatMap((c) =>
            [c.lightest, c.darkest].map((p) =>
              over(layer(name, surface), saturate(over(dim, p), saturation)),
            ),
          ),
        })),
        ...['color-surface', 'color-surface-raised', 'color-surface-sunken'].map((surface) => ({
          label: surface,
          pixels: [textOf(surface)],
        })),
      ];
      const short: string[] = [];
      for (const { label, pixels } of unders) {
        let text = Number.POSITIVE_INFINITY;
        let hint = Number.POSITIVE_INFINITY;
        let edgeOnField = Number.POSITIVE_INFINITY;
        let edgeOnUnder = Number.POSITIVE_INFINITY;
        for (const pixel of pixels) {
          const back = over(field, pixel);
          text = Math.min(text, ratioOf(textOf('color-text'), back));
          hint = Math.min(hint, ratioOf(textOf('color-text-muted'), back));
          edgeOnField = Math.min(edgeOnField, ratioOf(textOf('color-field-border'), back));
          edgeOnUnder = Math.min(edgeOnUnder, ratioOf(textOf('color-field-border'), pixel));
        }
        if (text < 4.5) short.push(`text on a field over ${label}: ${text.toFixed(2)}`);
        if (hint < 4.5) short.push(`muted text on a field over ${label}: ${hint.toFixed(2)}`);
        if (edgeOnField < 3) short.push(`edge on a field over ${label}: ${edgeOnField.toFixed(2)}`);
        if (edgeOnUnder < 3) short.push(`edge beside ${label}: ${edgeOnUnder.toFixed(2)}`);
      }
      expect(short).toEqual([]);
    });

    /** The worst ratio of a text colour on layers of glass, the last on top, sheen off and on. */
    const worstOnStack = (fore: string, tints: Layer[], under: Layer[] = []) => {
      let worst = Number.POSITIVE_INFINITY;
      for (const cell of sample.cells) {
        for (const pixel of [cell.mean, cell.lightest, cell.darkest]) {
          const canvas = under.reduce((back, top) => over(top, back), over(dim, pixel));
          const glass = tints.reduce(
            (back, tint) => over(tint, back),
            saturate(canvas, saturation),
          );
          worst = Math.min(
            worst,
            ratioOf(textOf(fore), glass),
            ratioOf(textOf(fore), over({ colour: [255, 255, 255], alpha: sheen }, glass)),
          );
        }
      }
      return worst;
    };
    const STATES = ['color-danger', 'color-success', 'color-warning', 'color-blue'];

    it(`[NFR-005] keeps state colours readable on glass in the ${name} skin`, () => {
      // `.status-bad`, `.status-warn`, a link in a card: words that sit straight on glass.
      const short: string[] = [];
      for (const surface of ['glass-surface', 'glass-surface-sunken', 'glass-surface-strong']) {
        for (const fore of STATES) {
          const worst = worstOnStack(fore, [layer(name, surface)]);
          if (worst < 4.5) short.push(`${fore} on ${surface}: ${worst.toFixed(2)} < 4.5`);
        }
      }
      expect(short).toEqual([]);
    });

    it(`[NFR-005] keeps a glass table readable in the ${name} skin`, () => {
      // `.data-table` in shared.css on a card: its rows, its head and a row under the pointer, and
      // the same table on a dialog. The head and the hover are a well over the card.
      const short: string[] = [];
      const well = layer(name, 'glass-surface-sunken');
      const parts: [string, Layer[], string[]][] = [
        [
          'a row',
          [layer(name, 'glass-surface')],
          ['color-text', 'color-text-muted', 'color-accent', ...STATES],
        ],
        ['the head', [layer(name, 'glass-surface'), well], ['color-text-muted']],
        [
          'a hovered row',
          [layer(name, 'glass-surface'), well],
          ['color-text', 'color-text-muted', 'color-accent', ...STATES],
        ],
        [
          'a row on a dialog',
          [layer(name, 'glass-surface-strong')],
          ['color-text', 'color-text-muted', 'color-accent', ...STATES],
        ],
        ['the head on a dialog', [layer(name, 'glass-surface-strong'), well], ['color-text-muted']],
      ];
      for (const [part, tints, fores] of parts) {
        for (const fore of fores) {
          const worst = worstOnStack(fore, tints);
          if (worst < 4.5) short.push(`${fore} in ${part}: ${worst.toFixed(2)} < 4.5`);
        }
      }
      expect(short).toEqual([]);
    });

    it(`[NFR-005] keeps a row tinted by a format rule readable in the ${name} skin`, () => {
      // The tones of `[data-tone]` in views.css are opaque, so the glass under the table does not
      // matter: the row's text, its link and a rule's mark over the tone are read on their own.
      const short: string[] = [];
      for (const tone of [
        'color-danger-soft',
        'color-warning-soft',
        'color-success-soft',
        'color-accent-soft',
      ]) {
        for (const fore of ['color-text', 'color-text-muted', 'color-accent']) {
          const ratio = ratioOf(textOf(fore), textOf(tone));
          if (ratio < 4.5) short.push(`${fore} on ${tone}: ${ratio.toFixed(2)} < 4.5`);
        }
      }
      expect(short).toEqual([]);
    });

    it(`[NFR-005] keeps a badge readable, on any glass, in the ${name} skin`, () => {
      // `.badge` with no variant is a well on whatever holds it; the variants are opaque soft tints.
      const well = layer(name, 'glass-surface-sunken');
      for (const surface of ['glass-surface', 'glass-surface-strong']) {
        expect(worstOnStack('color-text', [layer(name, surface), well])).toBeGreaterThanOrEqual(
          4.5,
        );
      }
      for (const [fore, back] of [
        ['color-text', 'color-accent-soft'],
        ['color-blue', 'color-blue-soft'],
        ['color-success', 'color-success-soft'],
        ['color-warning', 'color-warning-soft'],
        ['color-danger', 'color-danger-soft'],
      ] as const) {
        expect(ratioOf(textOf(fore), textOf(back))).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`[NFR-005] keeps floating glass over the page's dim layer at AA in the ${name} skin`, () => {
      // A dialog: `--color-backdrop` over the page, then the strong glass, and a group of fields as
      // a well inside it. The page under it is at most as dark as the canvas here; what a page draws
      // under a dialog is only seen in the browser.
      const short: string[] = [];
      const backdrop = layer(name, 'color-backdrop');
      const strong = layer(name, 'glass-surface-strong');
      const well = layer(name, 'glass-surface-sunken');
      for (const fore of ['color-text', 'color-text-muted', 'color-accent', 'color-danger']) {
        for (const [part, tints] of [
          ['a dialog', [strong]],
          ['a group of fields in a dialog', [strong, well]],
        ] as const) {
          const worst = worstOnStack(fore, [...tints], [backdrop]);
          if (worst < 4.5) short.push(`${fore} on ${part}: ${worst.toFixed(2)} < 4.5`);
        }
      }
      expect(short).toEqual([]);
    });

    it(`[NFR-005] keeps a quiet pill that is on readable in the ${name} skin`, () => {
      // `.button-secondary[aria-pressed="true"]`, hovered or on, on a card and on a dialog: the word
      // at 4.5:1, the accent edge that marks it at 3:1 beside the tint.
      const tint = layer(name, 'glass-tint-accent');
      for (const surface of ['glass-surface', 'glass-surface-strong']) {
        const stack = [layer(name, surface), tint];
        expect(worstOnStack('color-text', stack)).toBeGreaterThanOrEqual(4.5);
        expect(worstOnStack('color-accent', stack)).toBeGreaterThanOrEqual(3);
      }
    });

    it(`[NFR-005] keeps a filled pill's text at AA under its gloss in the ${name} skin`, () => {
      const fill = textOf('color-primary');
      const text = textOf('color-on-primary');
      // The dome's lightest and darkest layers, `--pill-gloss`, on `.button-primary` in surfaces.css.
      const lightest = over({ colour: [255, 255, 255], alpha: 0.6 }, fill);
      const darkest = over({ colour: [0, 0, 0], alpha: 0.05 }, fill);
      expect(ratioOf(text, lightest)).toBeGreaterThanOrEqual(4.5);
      expect(ratioOf(text, darkest)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
