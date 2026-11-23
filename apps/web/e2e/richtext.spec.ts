import { randomBytes } from 'node:crypto';
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import { chooseTrack } from './pickers';

/**
 * Rich text end to end (M1-017): two browsers co-editing one description, opening one without
 * changing it, and the create form's editor. Uses the attachments backend on 4174 (its administrator and the ATT track
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

/**
 * Bea, a Member of the ATT track, made for this run: a second person, as the same person in
 * two pages is no one else editing.
 */
async function secondPerson(request: APIRequestContext, project: string) {
  const bea = {
    email: `bea-richtext-${project}-${Date.now()}@attach.test`,
    name: `Bea Richtext ${project}`,
    password: `bea-${randomBytes(18).toString('base64url')}`,
  };
  const created = await request.post(`${BASE}/api/v1/users`, { data: bea });
  expect(created.status(), await created.text()).toBe(201);
  const id = (await created.json()).user.id as number;
  const roles = (await (await request.get(`${BASE}/api/v1/roles`)).json()).roles as {
    id: number;
    name: string;
  }[];
  const members = roles.find((r) => r.name === 'Members')?.id;
  const track = (await (await request.get(`${BASE}/api/v1/tracks/ATT`)).json()).track.id;
  const joined = await request.put(`${BASE}/api/v1/tracks/${track}/roles/${members}/users/${id}`);
  expect(joined.status()).toBeLessThan(300);
  return bea;
}

test('[NTF-008] two people typing in one description at once both keep their text', async ({
  browser,
}, testInfo) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const [a, b] = [await first.newPage(), await second.newPage()];
    await signIn(a.request);
    const bea = await secondPerson(a.request, testInfo.project.name);
    const signedIn = await b.request.post(`${BASE}/api/v1/session`, {
      data: { email: bea.email, password: bea.password },
    });
    expect(signedIn.status()).toBe(200);
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
    await expect(a.getByText(`Also editing: ${bea.name}`)).toBeVisible();
    await expect(b.getByText('Also editing: Ada Attach')).toBeVisible();

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

test('[NTF-008] [CORE-022] opening a ticket changes nothing in it, in one page or two', async ({
  page,
}) => {
  await signIn(page.request);
  // MOB-50's description in the page review's demo (T-250), which used to be saved again,
  // with a new Updated time, by whoever only opened it: it ends in a code block.
  const created = await page.request.post(`${BASE}/api/v1/tickets?format=markdown`, {
    data: {
      track: 'ATT',
      summary: 'Only looked at',
      description:
        '## What this is\n\nPeople **sign in once** and stay signed in without a connection. ' +
        'See [the notes](https://example.com/notes).\n\n- First point of the list\n' +
        '- Second point, a little longer than the first so it wraps on a phone\n\n' +
        '```\nconst retries = 3;\n```',
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const key = (await created.json()).ticket.key as string;
  const state = async () => {
    const ticket = (await (await page.request.get(`${BASE}/api/v1/tickets/${key}`)).json()).ticket;
    const history = await (await page.request.get(`${BASE}/api/v1/tickets/${key}/history`)).json();
    return {
      version: ticket.version,
      updatedAt: ticket.updatedAt,
      description: ticket.description,
      history: history.changes,
    };
  };
  const before = await state();

  const editor = await openDescription(page, key);
  await expect(editor).toContainText('const retries = 3;');
  // The same person in a second page: no one else is editing.
  const again = await page.context().newPage();
  await expect(await openDescription(again, key)).toContainText('const retries = 3;');
  for (const shown of [page, again]) {
    const field = shown.getByRole('region', { name: 'Description' });
    await expect(field.getByText('Changes are saved as you type.')).toBeVisible();
    await expect(field.getByText(/Also editing/)).toHaveCount(0);
  }
  // Longer than the pause after which an edit is saved (two seconds), then both leave, which
  // saves anything still pending.
  await page.waitForTimeout(3_000);
  await again.close();
  await page.goto(`${BASE}/#/`);
  await page.waitForTimeout(500);
  expect(await state()).toEqual(before);
});

test('[NTF-006] the create form writes rich text with Markdown shortcuts and the toolbar', async ({
  page,
}) => {
  await signIn(page.request);
  await page.goto(`${BASE}/#/create`);
  // Other tests add tracks on this site, some listed before ATT: the form starts on the first.
  await chooseTrack(page, 'ATT');
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
    // A plain event carrying the data: Firefox drops the clipboardData given to new ClipboardEvent.
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: transfer });
    element.dispatchEvent(paste);
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
