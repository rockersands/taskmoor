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
