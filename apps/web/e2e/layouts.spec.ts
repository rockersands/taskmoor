import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The layout sets page end to end (UI-T15; ADR-114 section 8; CORE-008, CORE-013): a site
 * administrator adds a set and makes a layout for the create form; places fields from each
 * grip's menu with the keyboard, drags one between sections (a mouse on a desktop, a real finger
 * on a phone) and another in from the list of fields not placed, and steps one back with Alt and
 * an arrow; sees the preview follow before saving; saves, and the server holds exactly that; then
 * deletes the set. Every grip's menu is on the screen and not under the cards after it; no serious
 * axe issue and no sideways scroll. It uses the attachments database (preview 4174), whose site
 * administrator the API server made.
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

/** What reaches past the right of the window, so a failure names it; empty when nothing does. */
const sideways = (page: Page) =>
  page.evaluate(() => {
    if (document.documentElement.scrollWidth <= innerWidth) return [];
    return [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5)
      .filter(
        (el) => ![...el.children].some((c) => c.getBoundingClientRect().right > innerWidth + 0.5),
      )
      .slice(0, 8)
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
  });

const centre = async (locator: Locator) => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 };
};

/** A drag from a grip to a place: a mouse on a desktop, a finger on a phone. */
async function drag(page: Page, from: Locator, to: Locator, touch: boolean) {
  await to.scrollIntoViewIfNeeded();
  await from.scrollIntoViewIfNeeded();
  const a = await centre(from);
  const b = await centre(to);
  const steps = 12;
  if (!touch) {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps });
    await page.mouse.up();
    return;
  }
  // Real touch input, which the browser turns into pointer events of type "touch".
  const cdp = await page.context().newCDPSession(page);
  const touchAt = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }],
    });
  await touchAt('touchStart', a.x, a.y);
  for (let i = 1; i <= steps; i++) {
    await touchAt('touchMove', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  }
  await touchAt('touchEnd', b.x, b.y);
  await cdp.detach();
}

/** Whether every item of the open menu is on the screen and is what a press at its centre hits. */
async function menuReachable(page: Page): Promise<string[]> {
  await expect(page.getByRole('menu')).toBeVisible();
  return page.evaluate(() => {
    const problems: string[] = [];
    for (const item of document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')) {
      item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const box = item.getBoundingClientRect();
      if (box.left < 0 || box.right > innerWidth) problems.push(`${item.textContent}: off screen`);
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (hit?.closest('[role="menuitem"]') !== item) problems.push(`${item.textContent}: covered`);
    }
    return problems;
  });
}

const MAIN = 'Details, section 1: main column';
const SIDE = 'Details, section 2: side column';

test('[CORE-008] [CORE-013] a layout set: fields placed by keyboard and by drag, previewed, saved and deleted', async ({
  page,
  browserName,
}, testInfo) => {
  test.setTimeout(90_000);
  const touch = testInfo.project.name !== 'desktop';
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const name = `Layouts ${testInfo.project.name} ${Date.now().toString(36)}`;

  await page.goto(`${BASE}/#/admin/layouts`);
  await expect(page.getByRole('heading', { level: 1, name: 'Layout sets' })).toBeVisible();
  await page.getByRole('button', { name: 'New layout set' }).click();
  const add = page.getByRole('form', { name: 'Add a layout set' });
  await add.getByLabel('New set name').fill(name);
  await add.getByRole('button', { name: 'Add a layout set' }).click();
  await expect(page.getByText(`${name} was added.`)).toBeVisible();
  const editor = page.getByRole('form', { name: `Layouts of ${name}` });
  await editor.getByRole('button', { name: 'Make a layout for this form' }).click();
  const main = editor.getByRole('group', { name: MAIN });
  const side = editor.getByRole('group', { name: SIDE });
  // Dropped on a section's title, a field goes last in it.
  const sideTitle = side.getByRole('heading', { name: 'Section 2: side column' });
  const fieldsIn = (section: Locator) => section.locator('.layout-field-name').allTextContents();

  // The keyboard path: a grip's menu opens on Enter, its first move puts the field in place.
  for (const field of ['Description', 'Summary']) {
    await editor.getByRole('button', { name: `Place ${field}` }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: `Put in ${MAIN}` })).toBeFocused();
    expect(await menuReachable(page)).toEqual([]);
    await page.keyboard.press('Enter');
    await expect(editor.getByRole('button', { name: `Move ${field}` })).toBeFocused();
  }
  expect(await fieldsIn(main)).toEqual(['Description', 'Summary']);
  await expect(
    page.getByText('Summary: place 2 of 2 in Details, section 1: main column.'),
  ).toBeAttached();

  // The drag path: a field from one section to the other, by mouse or by finger. Safari's phone
  // has no touch input to drive here; its menu makes the same move.
  if (touch && browserName !== 'chromium') {
    await editor.getByRole('button', { name: 'Move Summary' }).click();
    await page.getByRole('menuitem', { name: `Move to ${SIDE}` }).click();
  } else {
    await drag(page, editor.getByRole('button', { name: 'Move Summary' }), sideTitle, touch);
  }
  await expect.poll(() => fieldsIn(side)).toEqual(['Summary']);
  expect(await fieldsIn(main)).toEqual(['Description']);
  // On a desktop, one more from the list of fields not placed, dropped on the side column.
  if (!touch) {
    await drag(page, editor.getByRole('button', { name: 'Place Labels' }), sideTitle, false);
    await expect.poll(() => fieldsIn(side)).toEqual(['Summary', 'Labels']);
  }
  // Alt and an arrow: from the top of the side column back to the end of the main one.
  await editor.getByRole('button', { name: 'Move Summary' }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => fieldsIn(main)).toEqual(['Description', 'Summary']);
  await expect(editor.getByRole('button', { name: 'Move Summary' })).toBeFocused();

  await side.getByLabel('Hide when empty').check();
  await editor.getByLabel('Show only the fields I placed').check();
  // The preview follows the draft before it is saved.
  const preview = editor.getByRole('region', { name: 'Preview' });
  await expect
    .poll(() => preview.locator('.layout-preview-label').allTextContents())
    .toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Description/),
        expect.stringMatching(/^Summary/),
      ]),
    );
  await expect(preview.getByText('Left out on view while empty.')).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await sideways(page)).toEqual([]);

  await editor.getByRole('button', { name: 'Save the layouts' }).click();
  await expect(page.getByText(`${name} was saved.`)).toBeVisible();
  const list = await (await page.request.get(`${BASE}/api/v1/layout-sets`)).json();
  const id = (list.layoutSets as { id: number; name: string }[]).find((s) => s.name === name)?.id;
  const saved = await (await page.request.get(`${BASE}/api/v1/layout-sets/${id}`)).json();
  expect(saved.layoutSet.layouts).toEqual([
    {
      ticketTypeId: null,
      operation: 'create',
      definition: {
        tabs: [
          {
            name: 'Details',
            sections: [
              { kind: 'main', hideWhenEmpty: false, fields: ['description', 'summary'] },
              { kind: 'context', hideWhenEmpty: true, fields: touch ? [] : ['labels'] },
            ],
          },
        ],
        others: 'omit',
      },
    },
  ]);

  await editor.getByRole('button', { name: `Delete set ${name}` }).click();
  // Asks first, saying what will happen (D13).
  await editor
    .getByRole('group', { name: new RegExp(`^Delete ${name}\\?`) })
    .getByRole('button', { name: `Delete set ${name}` })
    .click();
  await expect(page.getByText(`${name} was deleted.`)).toBeVisible();
  expect(await sideways(page)).toEqual([]);
});
