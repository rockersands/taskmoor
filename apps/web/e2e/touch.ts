import type { Page } from '@playwright/test';

/** A point on the page, in CSS pixels from the top left of the viewport. */
export interface Point {
  x: number;
  y: number;
}

/**
 * One finger on a phone through the DevTools protocol (T-162b): real touch input, which the
 * browser turns into pointer events of type "touch" and into its own scrolling where the page
 * lets it, as the Tracks page's groups and the backlog are tested (e2e/track-groups.spec.ts,
 * e2e/drag-and-drop.spec.ts). Put it down, move it in small steps, and lift it.
 */
export async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  let at: Point = { x: 0, y: 0 };
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', to: Point) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(to.x), y: Math.round(to.y) }],
    });
  return {
    async down(to: Point) {
      at = to;
      await send('touchStart', to);
    },
    async moveTo(to: Point, steps = 10) {
      const from = at;
      for (let i = 1; i <= steps; i++) {
        await send('touchMove', {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        });
      }
      at = to;
    },
    async up() {
      await send('touchEnd', at);
      await cdp.detach();
    },
  };
}
