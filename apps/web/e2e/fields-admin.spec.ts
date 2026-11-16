import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import { chooseTrack } from './pickers';
import { uniqueKey } from './unique';

/**
 * The Fields page's controls (T-320; UI-T21): a two-level list gets options, child options and
 * their order, its context is narrowed to one track and given a default, and the create form of
 * that track starts with it; a number field shows as euros on the ticket page; a formula field is
 * checked as it is typed and says where a mistake is. Each field covers its test's own track, so
 * other tests' forms do not change. No serious axe issue, no sideways scroll. It uses the
 * attachments database (preview 4174), whose site administrator the API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
async function seriousAxeViolations(page: Page): Promise<string[]> {
  // Evaluated, not a script element, which the app's content security policy refuses (M1-107).
  await page.evaluate(readFileSync(AXE, 'utf8'));
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (context: Document) => Promise<{
            violations: { id: string; impact?: string | null; nodes: unknown[] }[];
          }>;
        };
      }
    ).axe;
    const { violations } = await axe.run(document);
    return violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} (${v.nodes.length})`);
  });
}

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

async function setUp(page: Page, prefix: string, testInfo: Parameters<typeof uniqueKey>[1]) {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  const api = async (method: 'post' | 'get', path: string, data?: unknown) => {
    const res = await page.request[method](`${BASE}/api/v1${path}`, data ? { data } : {});
    expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
    return res.json();
  };
  const key = uniqueKey(prefix, testInfo);
  const name = `Fields ${key}`;
  await api('post', '/tracks', { key, name, mode: 'shared' });
  return { api, key, name };
}

/** Narrows a field's first context, Default, to one track (`KEY Name` in the list). */
async function onlyIn(page: Page, key: string, name: string) {
  await page.getByRole('button', { name: 'Change context Default' }).click();
  const form = page.getByRole('form', { name: 'Change context Default' });
  await form.getByLabel('Only these tracks').check();
  await form.getByLabel(`${key} ${name}`, { exact: true }).check();
  await form.getByRole('button', { name: 'Save the context' }).click();
  await expect(page.getByText('The context Default was saved.')).toBeVisible();
  await expect(page.getByText(`Tracks: ${name}; every ticket type`)).toBeVisible();
}

test('[CORE-009] a two-level list: child options, their order, one track and a default the create form starts with', async ({
  page,
}, testInfo) => {
  const { api, key, name } = await setUp(page, 'F', testInfo);
  const field = `Region ${key}`;
  await page.goto(`${BASE}/#/admin/fields`);
  await expect(page.getByRole('heading', { level: 1, name: 'Fields' })).toBeVisible();
  await page.getByRole('button', { name: 'New field' }).click();
  const add = page.getByRole('form', { name: 'Add a field' });
  await add.getByLabel('Field name').fill(field);
  await add.getByLabel('Type').selectOption('cascading-select');
  await add.getByRole('button', { name: 'Add a field' }).click();
  await expect(page.getByText(`${field} was added.`)).toBeVisible();
  await onlyIn(page, key, name);

  const options = page.getByRole('form', { name: 'Add an option to Default' });
  for (const value of ['Europe', 'Americas']) {
    await options.getByLabel('New option').fill(value);
    await options.getByRole('button', { name: 'Add the option' }).click();
    await expect(page.getByText(`${value} was added.`)).toBeVisible();
  }
  const children = page.getByRole('form', { name: 'Add a child option to Europe' });
  for (const value of ['Madrid', 'Lisbon']) {
    await children.getByLabel('New child option').fill(value);
    await children.getByRole('button', { name: 'Add the child option' }).click();
    await expect(page.getByText(`${value} was added under Europe.`)).toBeVisible();
  }
  await page.getByRole('button', { name: 'Move Americas up' }).click();
  await expect(page.getByText('Americas was moved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move Americas up' })).toBeDisabled();
  await page.getByRole('button', { name: 'Move Lisbon up' }).click();
  await expect(page.getByText('Lisbon was moved.')).toBeVisible();

  const byDefault = page.getByRole('form', { name: 'Default value in Default' });
  await byDefault.getByLabel('Default value').selectOption({ label: 'Europe' });
  await byDefault.getByLabel('Default child option').selectOption({ label: 'Lisbon' });
  await byDefault.getByRole('button', { name: 'Save the default' }).click();
  await expect(page.getByText('The default in Default was saved.')).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // The create form of that track starts with the default, and the ticket gets it.
  await page.goto(`${BASE}/#/home`);
  await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible();
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'Create ticket' });
  await chooseTrack(dialog, key);
  await expect(dialog.getByLabel(field, { exact: true }).locator('option:checked')).toHaveText(
    'Europe',
  );
  await expect(dialog.getByLabel(`${field}: second level`).locator('option:checked')).toHaveText(
    'Lisbon',
  );
  await dialog.getByLabel('Summary (required)').fill(`Regional ${testInfo.project.name}`);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const made = dialog.getByText(new RegExp(`^${key}-\\d+ was created\\.$`));
  await expect(made).toBeVisible();
  const ticketKey = ((await made.textContent()) ?? '').split(' ')[0];
  const { fields } = await api('get', '/fields');
  const id = (fields as { id: number; name: string }[]).find((f) => f.name === field)?.id;
  const { ticket } = await api('get', `/tickets/${ticketKey}`);
  expect(ticket.fields[String(id)]).toMatchObject({ value: 'Europe', child: { value: 'Lisbon' } });
});

test('[CORE-010] [CORE-011] a number shown in euros and a formula checked as it is typed', async ({
  page,
}, testInfo) => {
  const { api, key, name } = await setUp(page, 'N', testInfo);
  const cost = `Cost ${key}`;
  const spend = `Spend ${key}`;
  await page.goto(`${BASE}/#/admin/fields`);
  await expect(page.getByRole('heading', { level: 1, name: 'Fields' })).toBeVisible();
  await page.getByRole('button', { name: 'New field' }).click();
  let add = page.getByRole('form', { name: 'Add a field' });
  await add.getByLabel('Field name').fill(cost);
  await add.getByLabel('Type').selectOption('number');
  await add.getByLabel('Shows as').selectOption('currency');
  await add.getByLabel('Decimals').selectOption('2');
  await add.getByLabel('Currency code').fill('EUR');
  await expect(add.getByText('1,234.5 shows as €1,234.50 on tickets and in lists.')).toBeVisible();
  await add.getByRole('button', { name: 'Add a field' }).click();
  await expect(page.getByText(`${cost} was added.`)).toBeVisible();
  await onlyIn(page, key, name);

  await page.getByRole('button', { name: 'New field' }).click();
  add = page.getByRole('form', { name: 'Add a field' });
  await add.getByLabel('Field name').fill(spend);
  await add.getByLabel('Type').selectOption('formula');
  const expression = add.getByLabel('Expression');
  await expression.fill('{Nothing by this name} * 2');
  // Where the mistake is, in the page's words.
  await expect(
    add.getByText(
      'Line 1, column 1: No field is called {Nothing by this name}, or a formula here cannot see it.',
    ),
  ).toBeVisible();
  await expression.fill(`{${cost}} * 2`);
  await expect(add.getByText(`It gives a number. It reads {${cost}}.`)).toBeVisible();
  await add.getByLabel('Output').selectOption('currency');
  await add.getByLabel('Currency code').fill('EUR');
  expect(await seriousAxeViolations(page)).toEqual([]);
  await add.getByRole('button', { name: 'Add a field' }).click();
  await expect(page.getByText(`${spend} was added.`)).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  // Computed on this track's tickets only, so the other tests' tickets are not recomputed.
  await onlyIn(page, key, name);

  // On the ticket page the number reads as euros under its box.
  const { fields } = await api('get', '/fields');
  const id = (fields as { id: number; name: string }[]).find((f) => f.name === cost)?.id;
  const { ticketTypes } = await api('get', `/tracks/${key}/ticket-types`);
  const { ticket } = await api('post', '/tickets', {
    track: key,
    ticketTypeId: (ticketTypes as { id: number }[])[0]?.id,
    summary: `Priced ${testInfo.project.name}`,
    fields: { [String(id)]: 1234.5 },
  });
  await page.goto(`${BASE}/#/tickets/${ticket.key}`);
  const box = page.getByRole('spinbutton', { name: cost });
  await expect(box).toHaveValue('1234.5');
  await expect(box).toHaveAccessibleDescription('€1,234.50');
});
