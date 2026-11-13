import { expect, type Page, test } from '@playwright/test';

/**
 * Links from the tracker an import came from (M1-128; IMP-011), on the backend serving the built
 * frontend in both routing modes (web-server.ts): hash routing (4176) and clean URLs (4177).
 * Each instance holds what an import leaves behind: ABC-42, NEW-9 that was OLD-5 before it moved,
 * and the import's external ids of a saved filter (10010) and a board (12).
 */
const ADMIN = { email: 'rui@routes.test', password: 'lantern harbour meadow 4521' };
const MODES = [
  { name: 'hash routing', base: 'http://localhost:4176', route: (r: string) => `/#/${r}` },
  { name: 'clean URLs', base: 'http://localhost:4177', route: (r: string) => `/${r}` },
];

async function signIn(page: Page, base: string, route: (r: string) => string) {
  await page.goto(`${base}${route('sign-in')}`);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${base}${route('home')}`);
}

for (const mode of MODES) {
  test(`[IMP-011] ${mode.name}: old links open the imported tickets, filter and board`, async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'one browser is enough for redirects');
    const { base, route } = mode;
    await signIn(page, base, route);

    // /browse/ABC-42, with what the old tracker adds after it, opens the imported ABC-42.
    await page.goto(`${base}/browse/ABC-42?focusedCommentId=10101`);
    await expect(page).toHaveURL(`${base}${route('tickets/ABC-42')}`);
    await expect(page.getByRole('heading', { level: 1, name: /Imported answer/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: /Imported answer/ })).toBeVisible();

    // A ticket moved from OLD-5 to NEW-9 opens by both keys.
    for (const key of ['OLD-5', 'NEW-9']) {
      await page.goto(`${base}/browse/${key}`);
      await expect(
        page.getByRole('heading', { level: 1, name: /Moved before the import/ }),
      ).toBeVisible();
    }

    // The old filter link, in both of its forms, opens the imported saved search.
    for (const link of [
      '/issues/?filter=10010',
      '/secure/IssueNavigator.jspa?mode=hide&requestId=10010',
    ]) {
      await page.goto(`${base}${link}`);
      await expect(page).toHaveURL(/search\?savedSearch=\d+$/);
      await expect(
        page.getByRole('combobox', { name: 'Saved searches you can see' }),
      ).toBeVisible();
    }

    // The old board link opens the board: titled by its section, under its track's name.
    await page.goto(`${base}/secure/RapidBoard.jspa?rapidView=12`);
    await expect(page).toHaveURL(/\/boards\/\d+$/);
    const board = page.getByRole('region', { name: 'Board' });
    await expect(board.getByRole('heading', { level: 1, name: 'Board' })).toBeVisible();
    await expect(board.locator('.page-eyebrow')).toHaveText('Routes');

    // A filter no import brought says so.
    await page.goto(`${base}/issues/?filter=99999`);
    await expect(page.getByRole('alert')).toContainText('Nothing that was imported matches');
  });
}
