import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setBackgroundAttachment } from './probe.mjs';
import { fakedMeta, openGrip } from './states.mjs';

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

/**
 * A stand-alone page taller than the window, as setup is at 1280 by 800: its canvas and waves on
 * layers fixed to the window, as standalone.css draws them, under a content security policy that
 * refuses style elements, as the app's does. Nothing is fetched.
 */
const TALL_STANDALONE = `
  <style>
    body { margin: 0; }
    .standalone { position: relative; z-index: 0; min-height: 100vh; }
    .standalone::before { content: ""; position: fixed; inset: 0; z-index: -2; }
    .setup { position: relative; padding-bottom: 200px; }
    .setup > div { height: 1600px; }
    .setup::after { content: ""; position: fixed; inset: auto 0 0; height: 120px; z-index: -1; }
  </style>
  <meta http-equiv="Content-Security-Policy" content="style-src 'self'">
  <div class="standalone"><main class="setup"><div></div></main></div>`;

describe('the sweep pictures (UI-T22)', () => {
  let browser;
  let page;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("[NFR-007] lets a stand-alone page's canvas and waves scroll for a full-page picture, and puts them back (AC-4)", async () => {
    await page.setContent(TALL_STANDALONE);
    const layers = () =>
      page.evaluate(() => {
        const frame = document.querySelector('.standalone');
        const setup = document.querySelector('.setup');
        const after = getComputedStyle(setup, '::after');
        return {
          canvas: getComputedStyle(frame, '::before').position,
          waves: after.position,
          setup: getComputedStyle(setup).position,
        };
      });
    expect(await layers()).toMatchObject({ canvas: 'fixed', waves: 'fixed', setup: 'relative' });
    await page.evaluate(setBackgroundAttachment, 'scroll');
    // Placed against the whole frame, as tall as the page, not against the window.
    expect(await layers()).toMatchObject({
      canvas: 'absolute',
      waves: 'absolute',
      setup: 'static',
    });
    // Twice does no harm, and the page is as it was afterwards.
    await page.evaluate(setBackgroundAttachment, 'scroll');
    await page.evaluate(setBackgroundAttachment, '');
    expect(await layers()).toMatchObject({ canvas: 'fixed', waves: 'fixed', setup: 'relative' });
  });

  it('[NFR-007] fakes a backend whose own version could ask for the window it names (AD-42)', () => {
    const body = { version: '0.0.0-dev', frontend: { minimum: null, recommended: null }, x: 1 };
    expect(fakedMeta(body, { minimum: '99.0.0', recommended: '99.0.0' })).toEqual({
      version: '99.0.0',
      frontend: { minimum: '99.0.0', recommended: '99.0.0' },
      x: 1,
    });
    expect(fakedMeta(body, { minimum: null, recommended: '99.0.0' }).version).toBe('99.0.0');
    expect(fakedMeta(body, { minimum: null, recommended: null }).version).toBe('0.0.0-dev');
  });
});
