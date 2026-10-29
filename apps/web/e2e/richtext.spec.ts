import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Rich text end to end (M1-017): two browsers co-editing one description, and the create
 * form's editor. Uses the attachments backend on 4174 (its administrator and the ATT track
 * are made by the API server; it also has the realtime role); each test makes its own ticket.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

async function signIn(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(res.status()).toBe(200);
}

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** The text an editor holds, without the other people's cursors drawn in it. */
const textOf = (editor: Locator) =>
  editor.evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    for (const caret of copy.querySelectorAll('.rt-caret')) caret.remove();
    return copy.textContent;
  });

/**
 * The keys that put the caret at the start and the end of a document. Chromium on macOS only
 * scrolls on Home and End, with or without a modifier; there it is Command with an arrow.
 */
const [DOC_START, DOC_END] =
  process.platform === 'darwin'
    ? ['Meta+ArrowUp', 'Meta+ArrowDown']
    : ['Control+Home', 'Control+End'];

/** The description editor of the ticket page, once the shared document is live. */
async function openDescription(page: Page, key: string) {
  await page.goto(`${BASE}/#/tickets/${key}`);
  const section = page.getByRole('region', { name: 'Description' });
  await expect(section.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
  return section.getByRole('textbox', { name: 'Description' });
}

test('[NTF-008] two people typing in one description at once both keep their text', async ({
  browser,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const [a, b] = [await first.newPage(), await second.newPage()];
    await signIn(a.request);
    await signIn(b.request);
    const created = await a.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: 'ATT', summary: 'Co-edited', description: paragraph('The login fails.') },
    });
    expect(created.status()).toBe(201);
    const key = (await created.json()).ticket.key as string;

    const editorA = await openDescription(a, key);
    const editorB = await openDescription(b, key);
    await expect(editorA).toHaveText('The login fails.');
    await expect(editorB).toHaveText('The login fails.');
    // Each sees the other there.
    await expect(a.getByText('Also editing: Ada Attach')).toBeVisible();

    // Both type at once: one at the start, one at the end.
    await editorA.click();
    await editorB.click();
    await a.keyboard.press(DOC_START);
    await b.keyboard.press(DOC_END);
    await Promise.all([
      a.keyboard.type('Since Monday: ', { delay: 15 }),
      b.keyboard.type(' Only on Safari.', { delay: 15 }),
    ]);
    const merged = 'Since Monday: The login fails. Only on Safari.';
    await expect.poll(() => textOf(editorA)).toBe(merged);
    await expect.poll(() => textOf(editorB)).toBe(merged);
    // Each sees where the other is.
    await expect(editorA.locator('.rt-caret')).toHaveCount(1);

    // Saved to the ticket as people type.
    await expect
      .poll(
        async () => {
          const res = await a.request.get(`${BASE}/api/v1/tickets/${key}?format=markdown`);
          return (await res.json()).ticket.description;
        },
        { timeout: 15_000 },
      )
      .toBe(`${merged}\n`);

    // A third look, after reloading, starts from what was saved.
    await a.reload();
    const again = await openDescription(a, key);
    await expect.poll(() => textOf(again)).toBe(merged);
  } finally {
    await first.close();
    await second.close();
  }
});

test('[NTF-006] the create form writes rich text with Markdown shortcuts and the toolbar', async ({
  page,
}) => {
  await signIn(page.request);
  await page.goto(`${BASE}/#/create`);
  await page.getByLabel('Summary (required)').fill('Created with rich text');
  const description = page.getByRole('textbox', { name: 'Description' });
  await description.click();
  await page.keyboard.type('## Steps');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- open the cart');
  await page.keyboard.press('Enter');
  await page.keyboard.type('pay');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('[] check the receipt');
  await expect(description.getByRole('heading', { level: 2, name: 'Steps' })).toBeVisible();
  await expect(description.getByRole('checkbox')).toBeVisible();
  // Pasted Markdown turns into a table (NTF-006 (2)).
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await description.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', '| Card | Result |\n| - | - |\n| expired | refused |\n');
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(description.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const made = page.getByText(/^ATT-\d+ was created\.$/);
  await expect(made).toBeVisible();
  const key = ((await made.textContent()) ?? '').split(' ')[0];

  const res = await page.request.get(`${BASE}/api/v1/tickets/${key}`);
  const doc = (await res.json()).ticket.description as {
    content: { type: string; content?: unknown[] }[];
  };
  expect(doc.content.map((node) => node.type).filter((type) => type !== 'paragraph')).toEqual([
    'heading',
    'bulletList',
    'taskList',
    'table',
  ]);
  const markdown = await page.request.get(`${BASE}/api/v1/tickets/${key}?format=markdown`);
  const text = (await markdown.json()).ticket.description as string;
  expect(text).toContain('## Steps');
  expect(text).toContain('[ ] check the receipt');
  expect(text).toMatch(/\| expired \| refused \|/);
});
