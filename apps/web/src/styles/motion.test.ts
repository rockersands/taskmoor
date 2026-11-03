import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The motion rules (ADR-114, section 11; NFR-005): every animation and transition reads its duration
 * and easing from the tokens, moves only what stays smooth on a big board, and stops with the one
 * rule in tokens.css. Read from disk, as contrast.test.ts does: the web project turns CSS imports off.
 *
 * What this does not catch: an inline style built in a variable away from `style=`, a duration passed
 * to a timer in JavaScript, a value hidden in another custom property, and CSS from a dependency.
 * It reads the source, so it cannot say whether anything looks watery; Motion.stories.tsx shows that.
 */
const SRC = ['apps/web/src', 'src'].find((d) => existsSync(join(d, 'styles/tokens.css'))) ?? 'src';

function filesUnder(dir: string, wanted: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path, wanted);
    return wanted(entry.name) ? [path] : [];
  });
}

/** Transforms and opacity: all a composited animation needs. */
const MOVES = ['transform', 'translate', 'scale', 'rotate', 'opacity'];

/** The only other things that may change over time, each with its reason. */
const EXCEPTIONS: Record<string, string> = {
  'background-color': 'a small control or one column fading colour: paint only, on one element',
  color: 'a small control fading its text, as above',
  'border-color': 'a small control fading its edge, as above',
  'outline-color': 'a board column showing it is a drop place, as above',
  'content-visibility': 'a native fold stays open while it settles; a discrete step, with no curve',
};
const TRANSITIONS = [...MOVES, ...Object.keys(EXCEPTIONS)];

/** Keyframes that may step another property, each with its reason. */
const KEYFRAME_EXCEPTIONS: Record<string, { property: string; reason: string }> = {
  'rt-gapcursor-blink': { property: 'visibility', reason: 'a caret blinks; it does not move' },
};

const LITERAL_TIME = /^-?[\d.]+m?s$/;
const LITERAL_EASING =
  /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|(cubic-bezier|steps|linear)\(.*)$/;

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Splits on a separator that is outside any brackets. */
function topLevel(value: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = '';
  for (const c of value) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && separator.test(c)) {
      if (part.trim()) parts.push(part.trim());
      part = '';
    } else {
      part += c;
    }
  }
  if (part.trim()) parts.push(part.trim());
  return parts;
}

function shorthandProblems(name: 'transition' | 'animation', value: string): string[] {
  const problems: string[] = [];
  for (const segment of topLevel(value, /,/)) {
    if (segment === 'none') continue;
    const tokens = topLevel(segment, /\s/);
    for (const token of tokens) {
      if (LITERAL_TIME.test(token)) problems.push(`literal time ${token}`);
      if (LITERAL_EASING.test(token)) problems.push(`literal easing ${token}`);
    }
    if (!tokens.some((t) => t.startsWith('var(--motion-'))) {
      problems.push(`no --motion- duration in "${segment}"`);
    }
    const property = tokens[0] ?? '';
    const discrete = name === 'transition' && property === 'content-visibility';
    if (!discrete && !tokens.some((t) => t.startsWith('var(--ease-'))) {
      problems.push(`no --ease- curve in "${segment}"`);
    }
    if (name === 'transition' && !TRANSITIONS.includes(property)) {
      problems.push(`transition of ${property}`);
    }
  }
  return problems;
}

/** Every broken rule in one stylesheet. */
export function motionProblems(source: string): string[] {
  const css = withoutComments(source);
  const problems: string[] = [];
  for (const m of css.matchAll(
    /(?:^|[;{\s])((?:transition|animation)(?:-[a-z-]+)?)\s*:\s*([^;{}]+)/g,
  )) {
    const name = m[1] as string;
    const value = (m[2] as string).trim();
    if (name === 'transition' || name === 'animation') {
      problems.push(...shorthandProblems(name, value));
    } else if (/-(duration|delay)$/.test(name)) {
      if (!value.startsWith('var(--motion-')) problems.push(`${name}: ${value}`);
    } else if (name.endsWith('-timing-function')) {
      if (!value.startsWith('var(--ease-')) problems.push(`${name}: ${value}`);
    } else if (name === 'transition-property') {
      for (const p of topLevel(value, /,/)) {
        if (!TRANSITIONS.includes(p)) problems.push(`transition of ${p}`);
      }
    }
  }
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    const name = m[1] as string;
    let depth = 1;
    let at = (m.index ?? 0) + m[0].length;
    const start = at;
    while (depth > 0 && at < css.length) {
      if (css[at] === '{') depth++;
      if (css[at] === '}') depth--;
      at++;
    }
    for (const d of css.slice(start, at).matchAll(/([a-z-]+)\s*:/g)) {
      const property = d[1] as string;
      if (MOVES.includes(property)) continue;
      if (KEYFRAME_EXCEPTIONS[name]?.property === property) continue;
      problems.push(`keyframes ${name} animates ${property}`);
    }
  }
  if (/(?:^|[;{\s])will-change\s*:/.test(css)) problems.push('will-change');
  return problems;
}

const stylesheets = filesUnder(SRC, (n) => n.endsWith('.css'));
const tokens = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');

/** Where JavaScript may ask about reduced motion: to skip making a copy of a surface at all. */
const MOTION_HELPER = join(SRC, 'shell/motion.ts');
const scripts = filesUnder(SRC, (n) => /\.tsx?$/.test(n) && !/\.(test|stories)\.tsx?$/.test(n));

describe('motion comes from the tokens (ADR-114)', () => {
  it('[NFR-005] finds a broken rule, so the checks below cannot pass by reading nothing', () => {
    expect(motionProblems('a { transition: width 200ms ease; }')).toEqual([
      'literal time 200ms',
      'literal easing ease',
      'no --motion- duration in "width 200ms ease"',
      'no --ease- curve in "width 200ms ease"',
      'transition of width',
    ]);
    expect(
      motionProblems('a { transition: box-shadow var(--motion-fast) var(--ease-soft); }'),
    ).toEqual(['transition of box-shadow']);
    expect(motionProblems('@keyframes x { from { height: 0; } }')).toEqual([
      'keyframes x animates height',
    ]);
    expect(motionProblems('a { will-change: transform; }')).toEqual(['will-change']);
    expect(motionProblems('a { animation: x var(--motion-fast) var(--ease-soft); }')).toEqual([]);
  });

  it('[NFR-005] reads a real set of stylesheets', () => {
    expect(stylesheets.length).toBeGreaterThan(20);
    expect(stylesheets.some((f) => f.endsWith('motion.css'))).toBe(true);
  });

  it.each(stylesheets)('[NFR-005] %s follows the motion rules', (file) => {
    expect(motionProblems(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('[NFR-005] sets no animation or transition inline in a component', () => {
    const inline = [
      /style=\{\{[^}]*\b(transition|animation)[A-Za-z]*\s*:/,
      /\.style\.(transition|animation)/,
      /setProperty\(\s*['"`](transition|animation|will-change)/,
      /\.animate\(/,
      /\bwillChange\b/,
      /<animate/,
    ];
    const found = scripts.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return inline.some((pattern) => pattern.test(source));
    });
    expect(found).toEqual([]);
  });

  it('[NFR-005] durations stay quick, and the curves overshoot with a plain fallback', () => {
    const root = /:root \{([\s\S]*?)\n\}/.exec(tokens)?.[1] ?? '';
    const durations = [...root.matchAll(/--(motion-[a-z]+):\s*(\d+)ms/g)].map(
      (m) => [m[1] as string, Number(m[2])] as const,
    );
    expect(durations.map(([name]) => name)).toEqual([
      'motion-fast',
      'motion-base',
      'motion-slow',
      'motion-caret',
    ]);
    for (const [name, ms] of durations) {
      if (name === 'motion-caret') continue; // A caret's blink, not part of the look.
      expect(ms).toBeGreaterThanOrEqual(120);
      expect(ms).toBeLessThanOrEqual(280);
    }
    for (const curve of ['--ease-settle', '--ease-swell']) {
      expect(root).toMatch(new RegExp(`${curve}: cubic-bezier\\(`));
      const fine = new RegExp(`${curve}: linear\\(([^)]*)\\)`).exec(tokens)?.[1] ?? '';
      const stops = fine.split(',').map(Number);
      expect(stops[0]).toBe(0);
      expect(stops.at(-1)).toBe(1);
      expect(Math.max(...stops)).toBeGreaterThan(1);
      expect(Math.max(...stops)).toBeLessThan(1.25);
    }
  });
});

describe('reduced motion has one switch (ADR-114)', () => {
  it('[NFR-005] sets every duration to 0ms, and the lifts to nothing, in one rule', () => {
    const rule = /@media \(prefers-reduced-motion: reduce\), print \{\s*:root \{([\s\S]*?)\}/.exec(
      tokens,
    )?.[1];
    expect(rule).toBeDefined();
    for (const name of ['fast', 'base', 'slow', 'caret']) {
      expect(rule).toContain(`--motion-${name}: 0ms;`);
    }
    expect(rule).toContain('--lift-small: 0px;');
    expect(rule).toContain('--lift: 0px;');
  });

  it('[NFR-005] has no other rule for it, in any stylesheet or component', () => {
    const others = stylesheets
      .filter((f) => !f.endsWith('tokens.css'))
      .filter((f) => readFileSync(f, 'utf8').includes('prefers-reduced-motion'));
    expect(others).toEqual([]);
    const inScripts = scripts
      .filter((f) => f !== MOTION_HELPER)
      .filter((f) => readFileSync(f, 'utf8').includes('prefers-reduced-motion'));
    expect(inScripts).toEqual([]);
    expect(tokens.match(/prefers-reduced-motion/g)).toHaveLength(1);
  });

  it('[NFR-005] keeps the glass fallback for reduced transparency', () => {
    expect(tokens).toContain('@media (prefers-reduced-transparency: reduce)');
  });
});
