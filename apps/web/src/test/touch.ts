import { expect, waitFor } from 'storybook/test';
import type { GRIP_SELECTORS } from './grips';

/**
 * Measuring a story as on a touch screen (ADR-033). The stories' browser has a mouse, so the page's
 * touch rules are put in force by hand: the rules inside its `(pointer: coarse)` blocks, as they are
 * written. Returns how to take them away, which is what a story's `beforeEach` wants.
 */
export function asOnATouchScreen(): () => void {
  const style = document.createElement('style');
  style.textContent = Array.from(document.styleSheets)
    .flatMap((sheet) => Array.from(sheet.cssRules))
    .filter(
      (rule): rule is CSSMediaRule =>
        rule instanceof CSSMediaRule && rule.media.mediaText.includes('pointer: coarse'),
    )
    .flatMap((rule) => Array.from(rule.cssRules, (inner) => inner.cssText))
    .join('\n');
  document.head.append(style);
  return () => style.remove();
}

const FINGER = 44;

/**
 * What matches a selector and is too small for a finger, as `text: width x height`: nothing, on a
 * page that keeps its promise. A selector with no match is named too, so a check cannot pass by
 * looking for something the page no longer draws.
 */
export function tooSmallForAFinger(root: Element, selectors: readonly string[]): string[] {
  return selectors.flatMap((selector) => {
    const found = Array.from(root.querySelectorAll(selector));
    if (found.length === 0) return [`${selector}: nothing matches`];
    return found.flatMap((element) => {
      const { width, height } = element.getBoundingClientRect();
      // Half a pixel of rounding is no finger's business.
      if (width >= FINGER - 0.5 && height >= FINGER - 0.5) return [];
      const text = element.textContent?.trim().slice(0, 24) ?? '';
      return [`${selector} "${text}": ${Math.round(width)} x ${Math.round(height)}`];
    });
  });
}

export type GripSelector = (typeof GRIP_SELECTORS)[number];

/** A grip, or one in a place of its own: `.sprint-ticket-grip .move-grip-handle`. */
export type GripIn = GripSelector | `${string} ${GripSelector}`;

/**
 * The grips that are too small for a finger, as `tooSmallForAFinger` names them, once each of
 * `selectors` is drawn (a page may still be loading). For a story on a real touch screen
 * (`onARealTouchScreen`): with a mouse a grip is smaller, as it should be.
 */
export async function gripsTooSmall(
  root: Element,
  selectors: readonly GripIn[],
): Promise<string[]> {
  await waitFor(() =>
    expect(selectors.filter((selector) => !root.querySelector(selector))).toEqual([]),
  );
  return tooSmallForAFinger(root, selectors);
}

/** What a story that needs a touch screen says when its browser has a mouse. */
export const NOT_ON_A_TOUCH_SCREEN =
  "This story needs a real touch screen, but its browser has a mouse: give it tags: ['touch'] " +
  'so it runs in the stories-touch projects (T-328).';

/**
 * A story's `beforeEach` for a page on a real touch screen. A story that uses it carries
 * `tags: ['touch']`, which runs it in the touch projects, whose browsers are touch screens from
 * the start (T-328): `(pointer: coarse)` matches and every touch rule stays where its sheet has
 * it, so a later rule outside a media block can override a touch rule, as on a phone.
 * `asOnATouchScreen` cannot show that, since it appends the touch rules after every sheet
 * (T-255). In a story test without the tag it fails, rather than measure under a mouse;
 * Storybook's own page, which is no story test, falls back to `asOnATouchScreen`.
 */
export async function onARealTouchScreen(): Promise<() => Promise<void>> {
  if (!(globalThis as { taskmoorStoryTest?: boolean }).taskmoorStoryTest) {
    const takeAway = asOnATouchScreen();
    return async () => takeAway();
  }
  if (!matchMedia('(pointer: coarse)').matches) throw new Error(NOT_ON_A_TOUCH_SCREEN);
  return async () => {};
}

/**
 * What matches a selector and is not `size` pixels each way, as `name: width x height`; a
 * selector with no match is named too. For a check box the size is a promise, not a minimum: one
 * box drawn larger than its neighbours is as wrong as a smaller one.
 */
export function notSized(root: Element, selector: string, size: number): string[] {
  const found = Array.from(root.querySelectorAll(selector));
  if (found.length === 0) return [`${selector}: nothing matches`];
  return found.flatMap((element) => {
    const { width, height } = element.getBoundingClientRect();
    if (Math.abs(width - size) <= 0.5 && Math.abs(height - size) <= 0.5) return [];
    const label = element instanceof HTMLInputElement ? element.labels?.[0] : element;
    const name = label?.textContent?.trim().slice(0, 32) || selector;
    return [`${name}: ${Math.round(width)} x ${Math.round(height)}`];
  });
}
