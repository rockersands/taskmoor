import { expect, type Page, test } from '@playwright/test';

/**
 * The AI settings page (M1-076; AI-001, AI-006, IAM-019, IAM-020; ADR-099), on the attachments
 * backend (preview 4174) and its administrator. api-server.ts gives that backend a master key
 * and runs a provider on 127.0.0.1:8796 that answers like the Anthropic API from the recorded
 * fixtures and accepts one key, made per run by playwright.config.ts. Nothing leaves the machine.
 *
 * One journey on the desktop project: the settings are the workspace's, shared by every test.
 */
const BASE = 'http://localhost:4174';
const PROVIDER = 'http://127.0.0.1:8796';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
const KEY = process.env.TASKMOOR_E2E_AI_KEY ?? '';

async function trackId(page: Page, key: string): Promise<number> {
  const res = await page.request.get(`${BASE}/api/v1/tracks`);
  const body = await res.json();
  const tracks = (body.tracks ?? body.items ?? body) as { id: number; key: string }[];
  const found = tracks.find((t) => t.key === key);
  if (!found) throw new Error(`no track ${key}`);
  return found.id;
}

async function summaries(page: Page, track: number) {
  const res = await page.request.get(`${BASE}/api/v1/ai/features?trackId=${track}`);
  expect(res.status()).toBe(200);
  return (await res.json()).features.summarize as { available: boolean; reason?: string };
}

test('[AI-001] test connection lists the fixture models; switches and strict mode hide AI and block it', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'one settings journey: the settings are shared');
  expect(KEY).not.toBe('');
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const att = await trackId(page, 'ATT');
  // From a known start, so a retry begins where the first attempt did.
  await page.request.put(`${BASE}/api/v1/admin/ai`, {
    data: { enabled: false, strict: false, provider: null, features: {} },
  });
  await page.request.put(`${BASE}/api/v1/admin/ai/tracks/${att}`, { data: { enabled: null } });
  await page.request.delete(`${BASE}/api/v1/admin/ai/credentials/apiKey`);
  const answers: string[] = [];
  page.on('response', async (res) => {
    if (res.url().includes('/api/')) answers.push(await res.text().catch(() => ''));
  });

  await page.goto(`${BASE}/#/admin`);
  await page.getByRole('link', { name: 'AI', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'AI', level: 1 })).toBeVisible();

  // The provider: the Anthropic API at the local fake, with AI on.
  await page.getByRole('checkbox', { name: 'Use AI on this site' }).check();
  await page.getByRole('combobox', { name: 'Provider' }).selectOption('anthropic');
  await page.getByLabel('Address (leave empty for the provider’s own)').fill(PROVIDER);
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await expect(page.getByText('The AI settings were saved.')).toBeVisible();

  // AI-006 (1): every feature on claude-opus-5-5 by default.
  const models = page.getByRole('combobox', { name: 'Model' });
  await expect(models).toHaveCount(4);
  for (const model of await models.all()) await expect(model).toHaveValue('claude-opus-5-5');

  // A wrong key fails the test with the provider's message, the key scrubbed out of it.
  const wrong = `fake-ai-key-wrong-${Date.now()}`;
  await page.getByLabel('API key').fill(wrong);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid x-api-key [redacted]');

  // The right key, saved write-only: only its last four characters come back.
  await page.getByLabel('API key').fill(KEY);
  await page.getByRole('button', { name: 'Save API key' }).click();
  await expect(page.getByText('The key was saved. New AI calls use it from now on.')).toBeVisible();
  await expect(page.getByLabel('API key')).toHaveValue('');
  await expect(page.getByText(`Stored, ending in ${KEY.slice(-4)}.`)).toBeVisible();

  // Test connection lists the fixture models, fetched from the provider.
  await page.getByRole('button', { name: 'Test connection' }).click();
  const listed = page.getByRole('list', { name: 'Available models' });
  await expect(listed.getByRole('listitem')).toHaveText([
    'claude-opus-5-5 Claude Opus 5.5',
    'claude-haiku-5-5 Claude Haiku 5.5',
  ]);
  await expect.poll(() => summaries(page, att)).toEqual({ available: true });

  // The track switch: off there, its AI hidden.
  const trackBox = page.getByRole('checkbox', { name: 'ATT Attachments' });
  await trackBox.uncheck();
  await expect(page.getByText('The track’s AI switch was saved.')).toBeVisible();
  await expect.poll(() => summaries(page, att)).toEqual({ available: false, reason: 'track_off' });
  await trackBox.check();
  await expect(trackBox).toBeChecked();

  // Strict mode: off everywhere until the track is opted in.
  await page.getByRole('checkbox', { name: 'Strict mode' }).check();
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await expect(
    page.getByText('Strict mode is on: AI runs only in the tracks turned on here.'),
  ).toBeVisible();
  // Back to the track's default, which strict mode turns off: hidden until it is opted in.
  const reset = await page.request.put(`${BASE}/api/v1/admin/ai/tracks/${att}`, {
    data: { enabled: null },
  });
  expect(reset.status()).toBe(200);
  await page.reload();
  await expect(trackBox).not.toBeChecked();
  await expect.poll(() => summaries(page, att)).toEqual({ available: false, reason: 'strict' });
  await trackBox.check();
  await expect(trackBox).toBeChecked();
  await expect.poll(() => summaries(page, att)).toEqual({ available: true });

  // The workspace switch: the per-feature and per-track controls go, and AI is off everywhere.
  await page.getByRole('checkbox', { name: 'Strict mode' }).uncheck();
  await page.getByRole('checkbox', { name: 'Use AI on this site' }).uncheck();
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await expect(page.getByText('The AI settings were saved.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tracks' })).toHaveCount(0);
  await expect.poll(() => summaries(page, att)).toEqual({ available: false, reason: 'disabled' });

  // The key never came back in any answer the page received.
  expect(answers.some((text) => text.includes(KEY))).toBe(false);
});
