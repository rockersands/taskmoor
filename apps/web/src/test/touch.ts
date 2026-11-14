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

/** What the story tests' setup lends a story: the browser's own touch emulation, on or off. */
type TouchScreenSwitch = (on: boolean) => Promise<void>;

/**
 * A story's `beforeEach` that puts the page on a real touch screen. In the story tests the
 * browser's touch emulation is switched on, so `(pointer: coarse)` matches and every touch rule
 * stays where its sheet has it: a later rule outside a media block can then override a touch
 * rule, as on a phone. `asOnATouchScreen` cannot show that, since it appends the touch rules after
 * every sheet (T-255). Storybook's own page has no switch and falls back to `asOnATouchScreen`.
 */
export async function onARealTouchScreen(): Promise<() => Promise<void>> {
  const turn = (globalThis as { taskmoorTouchScreen?: TouchScreenSwitch }).taskmoorTouchScreen;
  if (!turn) {
    const takeAway = asOnATouchScreen();
    return async () => takeAway();
  }
  await turn(true);
  if (!matchMedia('(pointer: coarse)').matches) {
    await turn(false);
    throw new Error('The touch emulation did not make the pointer coarse.');
  }
  return () => turn(false);
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
