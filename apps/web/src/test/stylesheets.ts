import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A stylesheet of `src/styles`, put in the document for one test (the web project turns CSS
 * imports off, so it is read from disk, as motion.test.ts does). With `within`, only the rules of
 * the `@media` blocks whose condition contains it are put in force, as on that screen: jsdom
 * applies no media query itself. Returns how to take it away again.
 *
 * jsdom has no layout: this tells which rule an element meets (`getComputedStyle` gives the
 * declared value, a token's `var(...)` included), not how it is drawn; the stories measure that.
 */
export function applyStylesheet(name: string, within?: string): () => void {
  const dir = ['apps/web/src/styles', 'src/styles'].find((d) => existsSync(d)) ?? 'src/styles';
  const text = readFileSync(join(dir, name), 'utf8');
  const style = document.createElement('style');
  if (!within) {
    style.textContent = text;
  } else {
    const probe = document.createElement('style');
    probe.textContent = text;
    document.head.append(probe);
    const sheet = probe.sheet as CSSStyleSheet;
    style.textContent = [...sheet.cssRules]
      .filter(
        (rule): rule is CSSMediaRule =>
          'media' in rule && (rule as CSSMediaRule).media.mediaText.includes(within),
      )
      .flatMap((rule) => [...rule.cssRules].map((inner) => inner.cssText))
      .join('\n');
    probe.remove();
  }
  document.head.append(style);
  return () => style.remove();
}
