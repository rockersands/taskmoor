import { expect, test } from '@playwright/test';

test('the pseudo-locale reaches every string in the shell', async ({ page }) => {
  await page.goto('./?locale=en-XA');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^\[.+\]$/);
  const texts = await page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('[aria-hidden="true"]')) continue;
      const text = node.textContent?.trim();
      if (text) out.push(text);
    }
    for (const el of document.querySelectorAll('[aria-label], [title]')) {
      for (const attr of ['aria-label', 'title']) {
        const value = el.getAttribute(attr);
        if (value) out.push(value);
      }
    }
    return out;
  });
  expect(texts.length).toBeGreaterThanOrEqual(5); // the phone layout shows fewer strings
  const untranslated = texts.filter((t) => !/^\[.+\]$/s.test(t));
  expect(untranslated).toEqual([]);
});

test('[NFR-006] the app speaks Spanish when Spanish is chosen', async ({ page }) => {
  // Signed out, the reduced frame (D8): the sign-in page, in Spanish.
  await page.goto('./?locale=es');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Inicia sesión para continuar' }),
  ).toBeVisible();
  // Signed in, the app frame in Spanish too. It uses the attachments database (preview 4174)
  // and its administrator (Ada Attach).
  const base = 'http://localhost:4174';
  const admin = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
  expect((await page.request.post(`${base}/api/v1/session`, { data: admin })).status()).toBe(200);
  await page.goto(`${base}/?locale=es`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('link', { name: 'Saltar al contenido' })).toBeAttached();
});
