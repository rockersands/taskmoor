import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The AI features with a provider (M1-079; AI-013, AI-014, AI-015, NFR-011): a backend of its
 * own (preview 4186, api-server.ts) has AI set up on the fake provider of 127.0.0.1:8796, which
 * answers each feature as a scripted model and streams summaries a few words at a time. The
 * first use shows the AI notice; a summary streams in and links the comment it cites; a German
 * question becomes an editable query that runs only on Run; and a breakdown proposes children
 * that are created only when the person confirms, the deselected one not at all.
 */
const BASE = 'http://localhost:4186';
const ADMIN = { email: 'ada@ai.test', password: process.env.TASKMOOR_E2E_AI_PASSWORD };

async function signIn(page: Page) {
  const res = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(res.status()).toBe(200);
}

/**
 * The AI notice on a first use, then what the feature shows: the other project may have read
 * the notice already, so whichever comes first.
 */
async function readNoticeThen(page: Page, outcome: Locator) {
  const understand = page.getByRole('button', { name: 'I understand' });
  await expect(understand.or(outcome).first()).toBeVisible({ timeout: 20_000 });
  if (await understand.isVisible()) await understand.click();
  await expect(outcome).toBeVisible({ timeout: 20_000 });
}

test('[AI-013] [AI-014] [AI-015] summary, plain-language query and breakdown with confirmation', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const api = async (path: string, data: unknown) => {
    const res = await page.request.post(`${BASE}/api/v1${path}`, { data });
    expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
    return res.json();
  };
  const word = `${testInfo.project.name}${Date.now()}`;
  const { ticket } = await api('/tickets?format=markdown', {
    track: 'AIF',
    summary: `Checkout stays blank with an expired card ${word}`,
    description: 'Paying with an expired card shows an empty page.',
  });
  const { comment } = await api(`/tickets/${ticket.key}/comments`, {
    body: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reproduced on staging.' }] }],
    },
  });

  // AI-013: the summary streams in and links the comment it cites.
  await page.goto(`${BASE}/#/tickets/${ticket.key}`);
  await page.getByRole('button', { name: 'Summarise ticket' }).click();
  const cite = page.getByRole('link', { name: 'Comment 1, by Ada Ai' });
  await readNoticeThen(page, cite);
  await expect(cite).toHaveAttribute('href', new RegExp(`comment=${comment.id}`));
  await expect(page.getByText(`${ticket.key} is about a blank checkout page`)).toBeVisible();
  await expect(page.getByText(/Written by AI/)).toBeVisible();
  await cite.click();
  await expect(page.locator(`#comment-${comment.id}`)).toBeVisible();

  // AI-014: a German question, an editable query with its explanation, run only on Run.
  await page.goto(`${BASE}/#/search`);
  await page.getByRole('textbox', { name: 'Your question' }).fill('meine offenen Tickets');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const query = page.getByRole('textbox', { name: 'Query to run (you can edit it)' });
  await readNoticeThen(page, query);
  await expect(query).toHaveValue('assignee = currentUser() AND stage != closed');
  await expect(page.getByText('Open tickets assigned to you.')).toBeVisible();
  expect(page.url()).not.toContain('q=');
  await query.fill('track = AIF AND stage != closed');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page).toHaveURL(/q=track/);
  await expect(page.getByRole('link', { name: ticket.key }).first()).toBeVisible();

  // AI-015: break an Outcome down; edit, deselect, then create in one action.
  const types = (await (await page.request.get(`${BASE}/api/v1/tracks/AIF/ticket-types`)).json())
    .ticketTypes as { id: number; name: string }[];
  const outcome = await api('/tickets', {
    track: 'AIF',
    ticketTypeId: types.find((t) => t.name === 'Outcome')?.id,
    summary: `Customers can pay with saved cards ${word}`,
  });
  await page.goto(`${BASE}/#/tickets/${outcome.ticket.key}`);
  await page.getByRole('button', { name: 'Break down' }).click();
  const dialog = page.getByRole('dialog', { name: `Break down ${outcome.ticket.key}` });
  await readNoticeThen(page, dialog);
  await expect(dialog.getByRole('button', { name: 'Create 3 tickets' })).toBeVisible();
  // Nothing exists yet.
  const before = await (
    await page.request.get(
      `${BASE}/api/v1/search?q=${encodeURIComponent(`parent = ${outcome.ticket.key}`)}`,
    )
  ).json();
  expect(before.tickets).toEqual([]);
  await dialog.getByRole('checkbox', { name: 'Create child 3' }).uncheck();
  await dialog.getByRole('textbox', { name: 'Summary of child 1' }).fill(`Vault cards ${word}`);
  await dialog.getByRole('button', { name: 'Create 2 tickets' }).click();
  await expect(dialog.getByRole('link', { name: /^Created AIF-/ })).toHaveCount(2);
  const after = await (
    await page.request.get(
      `${BASE}/api/v1/search?q=${encodeURIComponent(`parent = ${outcome.ticket.key}`)}`,
    )
  ).json();
  const summaries = (after.tickets as { summary: string }[]).map((t) => t.summary).sort();
  expect(summaries).toEqual([`Vault cards ${word}`, 'Pick a saved card at checkout'].sort());
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
});
