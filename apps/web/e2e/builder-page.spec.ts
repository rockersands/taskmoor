import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import {
  KIT_FILE_NAMES,
  type KitOutput,
  readZip,
  saveProject,
  validateInputs,
} from '@taskmoor/builder-core';
import { expectWithinBudget } from './budget';

/**
 * The Builder page (M1-112; OPS-014, OPS-016): the one-file page served alone on 4184, with
 * every request that is not the page itself refused and the browser offline once it has
 * loaded. It makes both kits from a project file or a filled form, saves and loads the project
 * file, and its downloads are byte for byte what `pnpm builder` writes from the same project
 * file and seed (or the secrets the project keeps).
 */
const BUILDER = 'http://localhost:4184';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEB = fileURLToPath(new URL('../dist', import.meta.url));
const OUTPUTS = Object.keys(KIT_FILE_NAMES) as KitOutput[];
const LINKS: Record<KitOutput, string> = {
  backend: 'Download the backend kit',
  frontend: 'Download the frontend kit',
  single: 'Download the frontend as one file',
};

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Seeds and passphrases are made per run, never written down. */
const fresh = () => randomBytes(24).toString('base64url');

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskmoor-builder-e2e-'));
  dirs.push(dir);
  return dir;
};
test.afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** `pnpm builder` itself on a project file: the SHA-256 of each file it writes. */
function cli(project: string, args: string[], env: Record<string, string> = {}) {
  const dir = temp();
  writeFileSync(join(dir, 'project.json'), project);
  execFileSync(
    process.execPath,
    [
      join(ROOT, 'node_modules/tsx/dist/cli.mjs'),
      join(ROOT, 'packages/devtools/src/cli/builder.ts'),
      '--project',
      join(dir, 'project.json'),
      '--web',
      WEB,
      '--out',
      join(dir, 'out'),
      ...args,
    ],
    { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'pipe' },
  );
  return Object.fromEntries(
    OUTPUTS.map((k) => [k, sha256(readFileSync(join(dir, 'out', KIT_FILE_NAMES[k])))]),
  ) as Record<KitOutput, string>;
}

/**
 * Opens the page with nothing allowed but its own address, then takes the browser offline.
 * Returns what was asked of the page's host and of anywhere else, and the console's errors
 * (a request the page's policy refused shows there).
 */
async function openOffline(context: BrowserContext, page: Page) {
  const own: string[] = [];
  const outside: string[] = [];
  const errors: string[] = [];
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === BUILDER) {
      own.push(url.pathname);
      return route.continue();
    }
    outside.push(url.href);
    return route.abort('blockedbyclient');
  });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BUILDER}/`);
  await expect(page.getByRole('heading', { level: 1, name: 'Taskmoor Builder' })).toBeVisible();
  await context.setOffline(true);
  return { own, outside, errors };
}

/** Makes the kits and downloads each: its SHA-256 and bytes. */
async function makeKits(page: Page) {
  await page.getByRole('button', { name: 'Make the kits' }).click();
  await expect(page.getByRole('link', { name: LINKS.backend })).toBeVisible({ timeout: 30_000 });
  const files = {} as Record<KitOutput, Buffer>;
  for (const key of OUTPUTS) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: LINKS[key] }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(KIT_FILE_NAMES[key]);
    files[key] = readFileSync(await download.path());
  }
  const hashes = Object.fromEntries(OUTPUTS.map((k) => [k, sha256(files[k])])) as Record<
    KitOutput,
    string
  >;
  return { files, hashes };
}

test('[OPS-016] (1) (2) a project file and seed make the CLI bytes with no request', async ({
  context,
  page,
}, testInfo) => {
  const form = validateInputs({
    backendUrl: 'https://api.example.com',
    frontendUrl: 'https://tracker.example.com/tracker/',
    instanceName: 'Acme tracker',
    smtp: { host: 'mail.example.com', port: 587, user: 'tracker', from: 'tracker@example.com' },
    ai: { provider: 'anthropic' },
  });
  if (!form.ok) throw new Error('inputs');
  const project = await saveProject(form.inputs, { builderVersion: 'e2e' });
  const seed = fresh();
  const net = await openOffline(context, page);

  await page.getByLabel('Load a project file').setInputFiles({
    name: 'acme.json',
    mimeType: 'application/json',
    buffer: Buffer.from(project),
  });
  await expect(page.getByRole('status')).toContainText('Loaded acme.json');
  await expect(page.getByLabel('Backend address')).toHaveValue('https://api.example.com');
  await expect(page.getByLabel('SMTP host')).toHaveValue('mail.example.com');
  await page.getByText('Reproducible secrets').click();
  await page.getByLabel('Seed (optional)').fill(seed);
  const started = Date.now();
  const { files, hashes } = await makeKits(page);
  expectWithinBudget(testInfo, Date.now() - started, 15_000, 'Builder page: both kits');

  // One argument: a seed may start with a dash, which the parser would take for an option.
  expect(hashes).toEqual(cli(project, [`--seed=${seed}`]));
  // The page shows each file's hash, the same as the download's.
  for (const key of OUTPUTS) await expect(page.getByText(hashes[key])).toBeVisible();
  expect(Object.keys(readZip(files.backend))).toContain('install.sh');
  expect(Object.keys(readZip(files.frontend))).toContain('.htaccess');
  // Nothing but the page itself was asked for, and nothing was refused by its policy.
  expect(net.own).toEqual(['/']);
  expect(net.outside).toEqual([]);
  expect(net.errors).toEqual([]);
});

test('[OPS-016] a filled form saved with a passphrase rebuilds the same kits, as the CLI does', async ({
  context,
  page,
}) => {
  const net = await openOffline(context, page);
  const passphrase = fresh();
  const smtpPassword = fresh();

  // Problems first: the core's checks, in the page's words.
  await page.getByLabel('Backend address').fill('http://api.example.com');
  await page.getByLabel('Frontend address').fill('https://tracker.example.com');
  await page.getByRole('button', { name: 'Make the kits' }).click();
  await expect(page.getByRole('alert')).toContainText('Some settings need a change');
  await expect(page.getByLabel('Backend address')).toHaveAttribute('aria-invalid', 'true');

  await page.getByLabel('Backend address').fill('https://api.example.com');
  await page.getByLabel('Frontend address').fill('https://tracker.example.com/');
  await page.getByLabel('Instance name (optional)').fill('Acme tracker');
  await page.getByLabel('Addresses inside the app').selectOption('hash');
  await page.getByLabel('Send email through an SMTP server').check();
  await page.getByLabel('SMTP host').fill('mail.example.com');
  await page.getByLabel('SMTP password (optional)').fill(smtpPassword);
  await page.getByLabel('Passphrase (optional)').fill(passphrase);
  const first = await makeKits(page);
  const env = readZip(first.files.backend)['.env'];
  expect(Buffer.from(env ?? new Uint8Array()).toString()).toContain(
    `TASKMOOR_SMTP_PASSWORD=${smtpPassword}`,
  );
  expect(first.files.single.toString()).not.toContain(smtpPassword);

  const [saved] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save project file' }).click(),
  ]);
  expect(saved.suggestedFilename()).toBe('taskmoor-project.json');
  const project = readFileSync(await saved.path(), 'utf8');
  expect(project).not.toContain(smtpPassword);

  // A fresh page, still offline: the project and its passphrase give the same kits back.
  await context.setOffline(false);
  await page.goto(`${BUILDER}/`);
  await context.setOffline(true);
  await page.getByLabel('Passphrase (optional)').fill(passphrase);
  await page.getByLabel('Load a project file').setInputFiles({
    name: 'taskmoor-project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(project),
  });
  await expect(page.getByLabel('SMTP password (optional)')).toHaveValue(smtpPassword);
  const again = await makeKits(page);
  expect(again.hashes).toEqual(first.hashes);

  // The CLI opens the same secrets with the passphrase from its environment.
  expect(
    cli(project, ['--passphrase-env', 'TASKMOOR_E2E_BUILDER_PASSPHRASE'], {
      TASKMOOR_E2E_BUILDER_PASSPHRASE: passphrase,
    }),
  ).toEqual(first.hashes);
  expect(net.outside).toEqual([]);
  expect(net.errors).toEqual([]);
});

test('[OPS-014] the page fits a phone: no sideways scrolling, 44px targets', async ({
  context,
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'the phone layout');
  await openOffline(context, page);
  await page.getByLabel('Send email through an SMTP server').check();
  await page.getByLabel('AI provider').selectOption('anthropic');
  await page.getByText('Reproducible secrets').click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const targets = page.locator(
    'main button, main select, main summary, main label.builder-file, main input:not([type="checkbox"]):not([type="file"])',
  );
  for (const target of await targets.all()) {
    const box = await target.boundingBox();
    expect(
      box?.height,
      await target.evaluate((e) => e.outerHTML.slice(0, 80)),
    ).toBeGreaterThanOrEqual(44);
  }
  for (const box of await page.locator('main .form-field-inline').all()) {
    expect((await box.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
});
