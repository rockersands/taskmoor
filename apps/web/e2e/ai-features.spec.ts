import { expect, type Page, test } from '@playwright/test';

/**
 * No AI key (M1-079; NFR-011 (2), AI-016 (2)): on a backend with no AI provider at all (preview
 * 4187, api-server.ts), no AI control shows anywhere: not on the ticket page, the search page
 * or the create dialog. Duplicate suggestions still appear while a summary is typed, from the
 * bundled embedding model, which needs no key.
 */
const BASE = 'http://localhost:4187';
const ADMIN = { email: 'ada@no-ai.test', password: process.env.TASKMOOR_E2E_AI_PASSWORD };

async function signIn(page: Page) {
  const res = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(res.status()).toBe(200);
}

/** Waits for the page to have asked which AI features exist, so an absent control is absent. */
const featuresAsked = (page: Page) =>
  page.waitForResponse((r) => r.url().includes('/api/v1/ai/features'));

test('[NFR-011] [AI-016] with no AI provider no AI control shows, and duplicates come from embeddings', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const word = `${testInfo.project.name}${Date.now()}`;
  const made = await page.request.post(`${BASE}/api/v1/tickets?format=markdown`, {
    data: {
      track: 'AIF',
      summary: `Checkout page stays blank when the card has expired ${word}`,
      description: 'Paying with an expired card shows an empty page instead of an error.',
    },
  });
  expect(made.status()).toBe(201);
  const ticket = (await made.json()).ticket as { key: string };
  // The server says no feature is available, for the track and outside one.
  const features = await (await page.request.get(`${BASE}/api/v1/ai/features`)).json();
  for (const state of Object.values(features.features) as { available: boolean }[]) {
    expect(state.available).toBe(false);
  }

  // The ticket page: no summary, no breakdown.
  const asked = featuresAsked(page);
  await page.goto(`${BASE}/#/tickets/${ticket.key}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(ticket.key);
  await asked;
  await expect(page.getByRole('button', { name: 'Clone' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Summarise ticket' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Break down' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'AI summary' })).toHaveCount(0);

  // The search page: no plain-language asking.
  const searched = featuresAsked(page);
  await page.goto(`${BASE}/#/search`);
  await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
  await searched;
  await expect(page.getByRole('heading', { name: 'Ask in plain language' })).toHaveCount(0);

  // The create page: no drafting, yet duplicates from embeddings while the summary is typed.
  const creating = featuresAsked(page);
  await page.goto(`${BASE}/#/create`);
  const summary = page.getByLabel('Summary (required)');
  await expect(summary).toBeVisible();
  await creating;
  await expect(page.getByRole('button', { name: 'Draft from text' })).toHaveCount(0);
  // The indexer runs after the ticket is written: retype until it is found (a few seconds).
  const suggestion = page.getByRole('link', { name: new RegExp(`^${ticket.key}: `) });
  await expect(async () => {
    await summary.fill('');
    await summary.fill('Blank checkout page with an expired card');
    await expect(suggestion).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Possible duplicates' })).toBeVisible();
  await expect(page.getByText(/Ordered by AI/)).toHaveCount(0);
  // Nothing AI was asked for on the way.
  expect(page.url()).toContain('#/create');
});
