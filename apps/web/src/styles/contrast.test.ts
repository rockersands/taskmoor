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
  ['color-blue', ['color-blue-soft']],
  ['color-blush', ['color-blush-soft']],
  ['color-butter', ['color-butter-soft']],
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
});
