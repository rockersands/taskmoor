import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/**
 * The ticket's tools end to end (ADR-120): links from a picker in the same track, a subticket with
 * its progress, a checklist reading 75%, and the slash menu putting a block in a comment. It uses
 * the attachments database (preview 4174), whose administrator and ATT track the API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

async function makeTicket(request: APIRequestContext, summary: string) {
  const res = await request.post(`${BASE}/api/v1/tickets`, {
    data: { track: 'ATT', summary },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).ticket as { id: number; key: string };
}

async function open(page: Page, key: string) {
  await page.goto(`${BASE}/#/tickets/${key}`);
  const signIn = page.getByRole('textbox', { name: 'Email' });
  if (await signIn.isVisible().catch(() => false)) {
    await signIn.fill(ADMIN.email);
    await page.getByRole('textbox', { name: 'Password' }).fill(ADMIN.password ?? '');
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(key) })).toBeVisible();
}

test.beforeEach(async ({ context }) => {
  const res = await context.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(res.status()).toBe(200);
});

test('[CORE-031] links a ticket of the track, found by name, and removes it', async ({
  context,
  page,
}) => {
  const stamp = Date.now();
  const here = await makeTicket(context.request, `Tools home ${stamp}`);
  const other = await makeTicket(context.request, `Pickable zebra${stamp}`);
  await open(page, here.key);
  const links = page.getByRole('region', { name: 'Links' });
  await links.getByRole('button', { name: 'Add a link' }).click();
  const picker = links.getByRole('combobox', { name: 'Ticket number or name' });
  await picker.click();
  await page.keyboard.type(`zebra${stamp}`);
  await expect(links.getByRole('option', { name: new RegExp(other.key) })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(links.getByRole('link', { name: other.key })).toBeVisible();
  await links.getByRole('button', { name: 'Done' }).click();
  await links.getByRole('button', { name: new RegExp(`Remove the link: .* ${other.key}`) }).click();
  await expect(links.getByRole('link', { name: other.key })).toHaveCount(0);
});

test('[CORE-032] adds a subticket and shows its progress', async ({ context, page }) => {
  const here = await makeTicket(context.request, `Parent ${Date.now()}`);
  await open(page, here.key);
  const section = page.getByRole('region', { name: 'Subtickets' });
  await section.getByRole('textbox', { name: 'New subticket' }).fill('A small part');
  await page.keyboard.press('Enter');
  await expect(section.getByText('A small part')).toBeVisible();
  await expect(section.getByText('0 of 1 closed (0%)')).toBeVisible();
});

test('[CORE-033] (1) a checklist with 3 done, 1 open and 1 rejected reads 75%', async ({
  context,
  page,
}) => {
  const here = await makeTicket(context.request, `Checks ${Date.now()}`);
  await open(page, here.key);
  const section = page.getByRole('region', { name: 'Checklists' });
  await section.getByRole('button', { name: 'Add a checklist' }).click();
  await page.keyboard.type('Steps');
  await page.keyboard.press('Enter');
  const field = section.getByRole('textbox', { name: 'Add an item to Steps' });
  for (const text of ['One', 'Two', 'Three', 'Four', 'Five']) {
    await field.fill(text);
    await page.keyboard.press('Enter');
    await expect(section.getByRole('checkbox', { name: text })).toBeVisible();
  }
  for (const text of ['One', 'Two', 'Three']) {
    await section.getByRole('checkbox', { name: text }).check();
    await expect(section.getByRole('checkbox', { name: text })).toBeChecked();
  }
  await section.getByRole('combobox', { name: 'State of Five' }).selectOption('rejected');
  await expect(section.getByText('3 of 4 done (75%)')).toBeVisible();
  // It is in the ticket's history, and still there after a reload.
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Checklists' }).getByText('3 of 4 done (75%)'),
  ).toBeVisible();
});

test('[NTF-013] the slash menu puts a panel in a comment, and it reads back', async ({
  context,
  page,
}) => {
  const here = await makeTicket(context.request, `Slash ${Date.now()}`);
  await open(page, here.key);
  const editor = page.locator('.comment-composer [contenteditable]');
  await editor.click();
  await page.keyboard.type('/warning');
  await expect(page.getByRole('listbox', { name: 'Blocks to add' })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Mind the gap');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('.comment-body [data-panel="warning"]')).toHaveText('Mind the gap');
});

// The ticket tools' follow-ups (ADR-120, T-196).

test('[CORE-032] moves a subticket through its workflow from its parent’s list (TT-6)', async ({
  context,
  page,
}) => {
  const here = await makeTicket(context.request, `Parent of moves ${Date.now()}`);
  await open(page, here.key);
  const section = page.getByRole('region', { name: 'Subtickets' });
  await section.getByRole('textbox', { name: 'New subticket' }).fill('Part to move');
  await page.keyboard.press('Enter');
  const link = section.getByRole('link', { name: /^ATT-\d+$/ });
  await expect(link).toBeVisible();
  const key = (await link.textContent()) ?? '';
  // Somewhere its workflow lets it go without asking for anything.
  const found = await context.request.get(`${BASE}/api/v1/tickets/${key}`);
  const child = (await found.json()).ticket as { id: number; status: { id: number } };
  const offered = await context.request.get(`${BASE}/api/v1/tickets/${child.id}/transitions`);
  const to = (
    (await offered.json()).transitions as { to: { id: number; name: string }; layout: string[] }[]
  ).find((move) => move.layout.length === 0 && move.to.id !== child.status.id);
  if (!to) throw new Error('the workflow offers no move without fields');
  const status = section.getByRole('button', { name: new RegExp(`^Status of ${key}: `) });
  await status.focus();
  await page.keyboard.press('ArrowDown');
  await section.getByRole('menuitem', { name: to.to.name, exact: true }).click();
  await expect(
    section.getByRole('button', { name: `Status of ${key}: ${to.to.name}` }),
  ).toBeVisible();
  await expect(section.getByText(`${key} is now ${to.to.name}.`)).toBeAttached();
  // The ticket's own page agrees.
  const after = await context.request.get(`${BASE}/api/v1/tickets/${key}`);
  expect((await after.json()).ticket.status.name).toBe(to.to.name);
});

test('[CORE-033] drags a checklist item by its grip to another place (TT-5)', async ({
  context,
  page,
}) => {
  const here = await makeTicket(context.request, `Drag checks ${Date.now()}`);
  await open(page, here.key);
  const section = page.getByRole('region', { name: 'Checklists' });
  await section.getByRole('button', { name: 'Add a checklist' }).click();
  await page.keyboard.type('Order');
  await page.keyboard.press('Enter');
  const field = section.getByRole('textbox', { name: 'Add an item to Order' });
  for (const text of ['First', 'Second', 'Third']) {
    await field.fill(text);
    await page.keyboard.press('Enter');
    await expect(section.getByRole('checkbox', { name: text })).toBeVisible();
  }
  const row = (text: string) =>
    section.locator('li', { has: page.getByRole('checkbox', { name: text }) });
  // Both ends of the drag on the screen, where the pointer can reach them: rows are tall on a phone.
  await row('Second').evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const grip = await row('Third').locator('.checklist-grip').boundingBox();
  const target = await row('First').boundingBox();
  if (!grip || !target) throw new Error('nothing laid out');
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, target.y + 6, { steps: 8 });
  await expect(row('First')).toHaveAttribute('data-landing', 'before');
  await page.mouse.up();
  const order = () =>
    section
      .getByRole('checkbox')
      .evaluateAll((boxes) =>
        boxes.map((box) => (box as HTMLInputElement).labels?.[0]?.textContent),
      );
  await expect.poll(order).toEqual(['Third', 'First', 'Second']);
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Checklists' }).getByRole('checkbox', { name: 'First' }),
  ).toBeVisible();
  await expect.poll(order).toEqual(['Third', 'First', 'Second']);
});

test('[CORE-033] lines its items up, and on a phone gives each two rows with More (S3-WK-2, PL-44)', async ({
  context,
  page,
}) => {
  const here = await makeTicket(context.request, `Rows ${Date.now()}`);
  await open(page, here.key);
  const section = page.getByRole('region', { name: 'Checklists' });
  await section.getByRole('button', { name: 'Add a checklist' }).click();
  await page.keyboard.type('Before it ships');
  await page.keyboard.press('Enter');
  const field = section.getByRole('textbox', { name: 'Add an item to Before it ships' });
  for (const text of ['Tried on an old phone', 'Tried with no connection', 'Tried offline']) {
    await field.fill(text);
    await page.keyboard.press('Enter');
    await expect(section.getByRole('checkbox', { name: text })).toBeVisible();
  }
  const items = section.locator('.checklist-item');
  const lefts = (selector: string) =>
    items.evaluateAll(
      (rows, inner) =>
        rows.map((row) => Math.round(row.querySelector(inner)?.getBoundingClientRect().left ?? -1)),
      selector,
    );
  // Every row's grip and state start at one line, whichever moves the row offers.
  for (const selector of ['.checklist-grip', 'select']) {
    expect(new Set(await lefts(selector)).size).toBe(1);
  }
  const phone = await page.evaluate(() => matchMedia('(max-width: 40rem)').matches);
  if (!phone) {
    await expect(
      section.getByRole('button', { name: 'Move down Tried on an old phone' }),
    ).toBeVisible();
    return;
  }
  // On a phone: the name, then grip, state and More on one row; the rest is in More.
  await expect(section.getByRole('button', { name: /^Move / })).toHaveCount(0);
  for (const row of await items.all()) {
    const tops = await row.evaluate((li) =>
      ['.checklist-grip', 'select', '.checklist-item-menu button'].map((s) =>
        Math.round(li.querySelector(s)?.getBoundingClientRect().top ?? -1),
      ),
    );
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(2);
  }
  const more = section.getByRole('button', { name: 'More options for Tried on an old phone' });
  await more.click();
  await page.getByRole('menuitem', { name: 'Move down' }).click();
  await expect(more).toBeFocused();
  const order = () =>
    section
      .getByRole('checkbox')
      .evaluateAll((boxes) =>
        boxes.map((box) => (box as HTMLInputElement).labels?.[0]?.textContent),
      );
  await expect
    .poll(order)
    .toEqual(['Tried with no connection', 'Tried on an old phone', 'Tried offline']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('[NTF-014] a section hides its text while a comment is written, and reads back closed (TT-1)', async ({
  context,
  page,
}) => {
  const here = await makeTicket(context.request, `Sections ${Date.now()}`);
  await open(page, here.key);
  const editor = page.locator('.comment-composer [contenteditable]');
  await editor.click();
  await page.keyboard.type('/collaps');
  await expect(page.getByRole('listbox', { name: 'Blocks to add' })).toBeVisible();
  await page.keyboard.press('Enter');
  const title = page.locator('.comment-composer').getByRole('textbox', { name: 'Section title' });
  await expect(title).toBeFocused();
  await page.keyboard.type('Steps');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Hidden detail');
  // Up on the section's first line goes back to its title.
  await page.keyboard.press('ArrowUp');
  await expect(title).toBeFocused();
  const toggle = page.getByRole('button', { name: 'Text of the section “Steps”' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.comment-composer').getByText('Hidden detail')).toBeHidden();
  // Down from the title goes past the hidden text, and writing goes on there.
  await title.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('After it');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const shown = page.locator('.comment-body details');
  await expect(shown.locator('summary')).toHaveText('Steps');
  await expect(shown).not.toHaveAttribute('open', '');
  await expect(page.locator('.comment-body')).toContainText('After it');
});

test('[NTF-014] columns take the widths chosen, and a code block a language from the list (TT-2, TT-8)', async ({
  context,
  page,
}) => {
  const here = await makeTicket(context.request, `Widths ${Date.now()}`);
  await open(page, here.key);
  const editor = page.locator('.comment-composer [contenteditable]');
  await editor.click();
  await page.keyboard.type('/code');
  await expect(page.getByRole('listbox', { name: 'Blocks to add' })).toBeVisible();
  await page.keyboard.press('Enter');
  const language = page.getByRole('combobox', { name: 'Code language (optional)' });
  await expect(language).toBeFocused();
  await page.keyboard.type('pyth');
  const languages = page.getByRole('listbox', { name: 'Common languages' });
  await expect(languages.getByRole('option')).toHaveText(['Python']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  // The block goes in, and the caret with it.
  await expect(editor).toBeFocused();
  await page.keyboard.type('print(1)');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('.comment-body code.language-python')).toHaveText('print(1)');
  // Then columns, in another comment.
  await editor.click();
  await page.keyboard.type('/two');
  await expect(page.getByRole('listbox', { name: 'Blocks to add' })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Narrow /width');
  await expect(page.getByRole('option', { name: 'Column widths' })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.getByRole('combobox', { name: 'Widths of the 2 columns' }).selectOption('25%, 75%');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const body = page.locator('.comment-body').last();
  const columns = body.locator('[data-columns] > [data-column]');
  await expect(columns).toHaveCount(2);
  const [left, right] = [await columns.nth(0).boundingBox(), await columns.nth(1).boundingBox()];
  if (!left || !right) throw new Error('nothing laid out');
  // Side by side on a wide screen, the second three times the first; one under the other on a phone.
  if (left.y === right.y) expect(right.width / left.width).toBeCloseTo(3, 0);
  else expect(right.y).toBeGreaterThan(left.y);
});

test('[NTF-014] a reference to one of two files of one name opens that one (TT-4)', async ({
  context,
  page,
}) => {
  const here = await makeTicket(context.request, `Same names ${Date.now()}`);
  const upload = async (text: string) => {
    const res = await context.request.post(`${BASE}/api/v1/tickets/${here.id}/attachments`, {
      multipart: { file: { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(text) } },
    });
    expect(res.status()).toBe(201);
    return (await res.json()).attachment as { id: number };
  };
  await upload('the first notes');
  const second = await upload('the second, longer notes');
  await open(page, here.key);
  const editor = page.locator('.comment-composer [contenteditable]');
  await editor.click();
  await page.keyboard.type('/image');
  await expect(page.getByRole('listbox', { name: 'Blocks to add' })).toBeVisible();
  await page.keyboard.press('Enter');
  const files = page.getByRole('listbox', { name: 'Image or file from this ticket' });
  await expect(files.getByRole('option', { name: /^notes\.txt \(/ })).toHaveCount(2);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const link = page.locator('.comment-body').last().getByRole('link', { name: 'notes.txt' });
  await expect(link).toHaveAttribute('href', new RegExp(`/attachments/${second.id}/content`));
});
