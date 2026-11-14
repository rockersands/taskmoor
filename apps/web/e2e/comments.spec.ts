import { expect, test } from '@playwright/test';

/**
 * Comments end to end (M1-018, CORE-020): write one on the ticket page, keep it to a role, react,
 * edit, follow a link to it and delete it. It uses the attachments database (preview 4174),
 * where the API server made an administrator and the ATT track, which she administers.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

test('[CORE-020] writes, restricts, reacts to, edits, links and deletes a comment', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  const created = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: 'ATT', summary: `Talk it over on ${testInfo.project.name}` },
  });
  expect(created.status()).toBe(201);
  const key = (await created.json()).ticket.key as string;

  await page.goto(`${BASE}/#/tickets/${key}`);
  const comments = page.getByRole('region', { name: 'Comments' });
  await expect(comments.getByText('No comments yet.')).toBeVisible();

  // Write one, kept to the Administrators role.
  await comments.getByRole('textbox', { name: 'Add a comment' }).click();
  await page.keyboard.type('Reproduced on staging with an expired card');
  await comments.getByRole('combobox', { name: 'Who can see it' }).selectOption({
    label: 'Administrators',
  });
  await comments.getByRole('button', { name: 'Comment' }).click();
  const item = comments.getByRole('listitem').filter({ hasText: 'Reproduced on staging' });
  await expect(item).toBeVisible();
  await expect(item.getByText('Only the Administrators role can see this')).toBeVisible();
  await expect(comments.getByText('1 comment')).toBeVisible();
  // The editor is empty again.
  await expect(comments.getByRole('textbox', { name: 'Add a comment' })).toHaveText('');

  // React.
  await item.getByRole('button', { name: 'Add a reaction' }).click();
  await item.getByRole('button', { name: 'React with 🎉' }).click();
  await expect(
    item.getByRole('button', { name: '🎉: 1 reaction, yours included' }),
  ).toHaveAttribute('aria-pressed', 'true');

  // Edit: the comment says it was edited.
  await item.getByRole('button', { name: /^Edit the comment by Ada Attach/ }).click();
  await item.getByRole('textbox', { name: /^Edit the comment by Ada Attach/ }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' and a Mastercard');
  await item.getByRole('button', { name: 'Save' }).click();
  await expect(item).toContainText('and a Mastercard');
  await expect(item.getByText(/^Edited /)).toBeVisible();

  // A link to the comment brings it into view, focused, after a reload.
  const listed = await page.request.get(`${BASE}/api/v1/tickets/${key}/comments`);
  const id = (await listed.json()).comments[0].id as number;
  await page.goto(`${BASE}/#/tickets/${key}?comment=${id}`);
  await page.reload();
  const linked = page.locator(`#comment-${id}`);
  await expect(linked).toBeFocused();
  await expect(linked).toBeInViewport();

  // Nothing scrolls sideways, on a phone either.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Delete.
  await linked.getByRole('button', { name: /^Delete the comment by Ada Attach/ }).click();
  // Asks first, saying what will happen (D13).
  await linked
    .getByRole('group', { name: /^Delete this comment\?/ })
    .getByRole('button', { name: /^Delete the comment by Ada Attach/ })
    .click();
  await expect(
    page.getByRole('region', { name: 'Comments' }).getByText('No comments yet.'),
  ).toBeVisible();
});
