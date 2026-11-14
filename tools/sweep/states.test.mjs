import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openGrip } from './states.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { chromium } = createRequire(join(ROOT, 'apps', 'web', 'package.json'))('@playwright/test');

/**
 * A page like the layout editor on a phone: the administration list folded away, its current
 * group's button still marked open, then a grip whose menu opens on a press. Nothing is fetched.
 */
const FOLDED_ADMIN_LIST = `
  <details><summary>Pages</summary>
    <button aria-expanded="true">Work settings</button>
  </details>
  <div class="layout-grip">
    <button aria-haspopup="menu" aria-expanded="false" aria-label="Move Summary">::</button>
  </div>
  <script>
    const grip = document.querySelector('.layout-grip button');
    grip.addEventListener('click', () => {
      grip.setAttribute('aria-expanded', 'true');
      grip.setAttribute('aria-controls', 'grip-menu');
      const menu = document.createElement('div');
      menu.id = 'grip-menu';
      menu.setAttribute('role', 'menu');
      menu.innerHTML = '<button role="menuitem">Move up</button>';
      grip.after(menu);
    });
  </script>`;

/**
 * The layout editor on a desktop: the current group's button in sight and marked open, then a
 * grip whose press opens nothing (as when its menu fails). Nothing is fetched.
 */
const OPEN_ADMIN_LIST_DEAD_GRIP = `
  <nav><button aria-expanded="true">Work settings</button></nav>
  <div class="layout-grip">
    <button aria-haspopup="menu" aria-expanded="false" aria-label="Move Summary">::</button>
  </div>`;

describe('the sweep states (UI-T22)', () => {
  let browser;
  let page;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({
      viewport: { width: 375, height: 812 },
      hasTouch: true,
      isMobile: true,
    });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('[NFR-007] opens a grip menu on a phone page that hides another open control (AD-6)', async () => {
    await page.setContent(FOLDED_ADMIN_LIST);
    await openGrip('.layout-grip button')(page);
    await expect(page.getByRole('menu').isVisible()).resolves.toBe(true);
  });

  it("[NFR-007] waits for the pressed grip's own menu, not another control marked open (AD-6)", async () => {
    await page.setContent(OPEN_ADMIN_LIST_DEAD_GRIP);
    await expect(openGrip('.layout-grip button', { wait: 500 })(page)).rejects.toThrow(/Timeout/);
  });

  it('[NFR-007] says so when no grip can be seen', async () => {
    await page.setContent('<div class="layout-grip"><button hidden>::</button></div>');
    await expect(openGrip('.layout-grip button')(page)).rejects.toThrow('no grip could be seen');
  });
});
