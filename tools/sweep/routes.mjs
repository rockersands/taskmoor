// pnpm sweep --out <dir> [--url http://localhost:8090] [--only=<route substring>] [--demo]
//
// Shows every route of the real app signed in, for the page sweep (UI-T22), without a person's
// browser: full-page screenshots at 1280x800 and at 375x812 with touch, in the light and dark
// skins, plus measurements.json with sideways scroll (also at 360 px), controls under 44 px, axe's
// serious and critical findings, console errors, failed requests and accessible names that leave
// out visible words (WCAG 2.5.3, T-212). It also opens the states a route alone does not show.
//
// It needs a private `pnpm demo`: --demo starts one on the --url's port and stops it afterwards,
// keeping its data; or start one yourself with its output in .cache/sweep/demo.log. The
// administrator's one-time link is read from that log, a password made here is set and forgotten,
// and the browser's state is kept in .cache/sweep/state.json (git ignores .cache). Sample data the
// demo lacks is added through the API (seed.mjs). Nothing here prints a link, password or token.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { startDemo } from './demo.mjs';
import {
  describePage,
  looksSettled,
  measureControls,
  measureSideways,
  runAxe,
  setBackgroundAttachment,
} from './probe.mjs';
import { seedDemo } from './seed.mjs';
import { ensureSignedIn } from './session.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const fromWeb = createRequire(join(ROOT, 'apps', 'web', 'package.json'));
const { chromium } = fromWeb('@playwright/test');
const AXE = readFileSync(fromWeb.resolve('axe-core/axe.min.js'), 'utf8');

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8090' },
    out: { type: 'string' },
    only: { type: 'string' },
    demo: { type: 'boolean', default: false },
    log: { type: 'string', default: join(ROOT, '.cache', 'sweep', 'demo.log') },
  },
});
if (!args.out) {
  process.stderr.write('Usage: pnpm sweep --out <dir> [--url <url>] [--only=<text>] [--demo]\n');
  process.exit(2);
}
const URL_BASE = args.url.replace(/\/+$/, '');
const OUT = args.out;
const STATE = join(ROOT, '.cache', 'sweep', 'state.json');
const REPORT = join(OUT, 'measurements.json');

const GROUPS = {
  track: 'track sections',
  work: 'your work and planning',
  admin: 'administration and setup',
  other: 'account, stand-alone and states',
};
const COMBOS = [1280, 375].flatMap((width) =>
  ['light', 'dark'].map((skin) => ({ width, skin, phone: width < 768 })),
);
/** Sections shown in Spanish as well, beside the longest pages of the run. */
const SPANISH = [
  'home',
  'tracks',
  'track-summary',
  'track-board',
  'track-backlog',
  'ticket',
  'search-results',
  'dashboard',
  'plan-summary',
  'settings',
  'admin',
  'account',
];
const SPANISH_LONGEST = 6;
const MINIMUM_TARGET = 44;
const SETTLE_MS = 8000;

const scrub = (text) =>
  String(text)
    .replace(/(token|request|code)=[^\s&"'#)]+/gi, '$1=...')
    .slice(0, 300);

// ---------------------------------------------------------------------------------------- routes

const source = (file) => readFileSync(join(ROOT, 'apps', 'web', 'src', file), 'utf8');
/** The names in a list such as `const FLOW_REPORTS = ['a', 'b']`. */
function namesIn(file, list) {
  const found = new RegExp(`${list}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(source(file));
  if (!found)
    throw new Error(`${list} is gone from ${file}: the sweep's route list needs updating`);
  return [...found[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
}
/** A section list of the shape `{ id: 'board', path: '/board', ... }`. */
const sectionsIn = (file) =>
  [...source(file).matchAll(/id: '([a-z]+)', path: '([^']*)'/g)].map((m) => ({
    id: m[1],
    path: m[2],
  }));

const route = (group, slug, hash, more = {}) => ({ group, slug, route: hash, ...more });

/** Every route of the app, from the router and its section lists, with real ids. */
function allRoutes(ids) {
  const reports = [
    ...namesIn('reports/BoardReportsPage.tsx', 'FLOW_REPORTS'),
    ...namesIn('tracks/TrackStatisticsPage.tsx', 'SPRINT_REPORTS'),
    ...namesIn('reports/ScopeReports.tsx', 'SCOPE_REPORTS'),
    ...namesIn('tracks/TrackStatisticsPage.tsx', 'TICKET_REPORTS'),
    ...namesIn('tracks/TrackStatisticsPage.tsx', 'TIME_REPORTS'),
  ];
  const planning = new Set([
    ...namesIn('tracks/TrackStatisticsPage.tsx', 'TICKET_REPORTS'),
    ...namesIn('tracks/TrackStatisticsPage.tsx', 'TIME_REPORTS'),
  ]);
  const track = `#/tracks/${ids.track}`;
  const board = `#/boards/${ids.board}`;
  const list = [
    ...sectionsIn('tracks/TrackLayout.tsx').map((s) =>
      route('track', `track-${s.id}`, `${track}${s.path}`),
    ),
    route('track', 'track-templates', `${track}/templates`),
    route('track', 'track-kanban-summary', `#/tracks/${ids.kanbanTrack}`),
    route('track', 'track-kanban-board', `#/tracks/${ids.kanbanTrack}/board`),
    route('track', 'track-kanban-statistics', `#/tracks/${ids.kanbanTrack}/statistics`),
    route('track', 'track-local-summary', `#/tracks/${ids.localTrack}`),
    route('track', 'boards-index', '#/boards'),
    route('track', 'board-by-id', board),
    route('track', 'board-settings', `${board}/settings`),
    route('track', 'board-backlog', `${board}/backlog`),
    route('track', 'board-reports', `${board}/reports`),
    route('track', 'board-sprint-report', `${board}/sprints/${ids.closedSprint}/report`),
    route('track', 'release', `#/releases/${ids.release}`),
    ...reports.map((r) =>
      route(
        planning.has(r) ? 'work' : 'track',
        `track-statistics-${r}`,
        `${track}/statistics/${r}`,
      ),
    ),
    route(
      'track',
      'track-statistics-sprint-report-closed',
      `${track}/statistics/sprint-report/${ids.closedSprint}`,
    ),

    route('work', 'home', '#/home'),
    route('work', 'inbox', '#/inbox'),
    route('work', 'tracks', '#/tracks'),
    route('work', 'tracks-new', '#/tracks?new'),
    route('work', 'search', '#/search'),
    route('work', 'search-results', `#/search?q=${encodeURIComponent(`track = ${ids.track}`)}`),
    route('work', 'search-saved', `#/search?savedSearch=${ids.savedSearch}`),
    route('work', 'dashboards', '#/dashboards'),
    route('work', 'dashboard', `#/dashboards/${ids.dashboard}`),
    route('work', 'dashboard-wallboard', `#/dashboards/${ids.dashboard}/wallboard`),
    route('work', 'plans', '#/plans'),
    ...sectionsIn('plans/address.ts').map((s) =>
      route('work', `plan-${s.id}`, `#/plans/${ids.plan}${s.path}`),
    ),
    route('work', 'ticket', `#/tickets/${ids.ticket}`),
    route('work', 'ticket-outcome', `#/tickets/${ids.outcome}`),
    route('work', 'create', '#/create'),
    route('work', 'bulk', `#/bulk/${ids.bulk}`),

    route('admin', 'admin', '#/admin'),
    ...[...source('admin/sections.ts').matchAll(/id: '([a-z]+)',\s*labelId: 'admin\.group\./g)].map(
      (m) => route('admin', `admin-group-${m[1]}`, `#/admin/group/${m[1]}`),
    ),
    ...[...source('admin/sections.ts').matchAll(/id: '([a-z-]+)',\s*href: '([^']+)'/g)].map((m) =>
      route('admin', `admin-${m[1]}`, m[2]),
    ),
    route('admin', 'admin-workflow-published', `#/admin/workflows/${ids.workflow}`),
    route('admin', 'admin-workflow-draft', `#/admin/workflows/${ids.workflowDraft}`),
    route('admin', 'admin-layouts-set', `#/admin/layouts?set=${ids.layoutSet}`),
    route('admin', 'admin-track-sets-track', `#/admin/track-sets?track=${ids.trackId}`),
    route('admin', 'manage-track', `#/manage/tracks/${ids.localTrackId}`),
    route('admin', 'manage-track-layouts', `#/manage/tracks/${ids.localTrackId}/layouts`),
    route(
      'admin',
      'manage-track-configuration-sets',
      `#/manage/tracks/${ids.localTrackId}/configuration-sets`,
    ),

    route('other', 'account', '#/account'),
    route('other', 'account-notifications', '#/account/notifications'),
    route('other', 'settings', '#/settings'),
    route('other', 'settings-tutorials', '#/settings/tutorials'),
    route('other', 'imported-link-unknown', '#/imported/filter/999999'),
    route('other', 'unknown-route', '#/no-such-page'),
    route('other', 'ticket-not-found', `#/tickets/${ids.track}-999999`),
    route('other', 'track-not-found', '#/tracks/NOSUCH'),
    route('other', 'board-not-found', '#/boards/999999'),
    route('other', 'release-not-found', '#/releases/999999'),
    route('other', 'dashboard-not-found', '#/dashboards/999999'),
    route('other', 'plan-not-found', '#/plans/999999'),
    route('other', 'bulk-not-found', '#/bulk/999999'),
    route('other', 'workflow-not-found', '#/admin/workflows/999999'),
    route('other', 'signed-out-home', '#/home', { anon: true }),
    route('other', 'signed-out-tracks', '#/tracks', { anon: true }),
    route('other', 'signed-out-guarded', '#/inbox', { anon: true }),
    route('other', 'sign-in', '#/sign-in', { anon: true }),
    route('other', 'sign-in-password', '#/sign-in?method=password', { anon: true }),
    route('other', 'sign-in-sso-error', '#/sign-in?sso_error=no_account', { anon: true }),
    route('other', 'setup-no-link', '#/setup', { anon: true }),
    route('other', 'setup-invalid-link', '#/setup?token=not-a-real-link', { anon: true }),
    route('other', 'password-no-link', '#/password', { anon: true }),
    route('other', 'password-invalid-link', '#/password?token=not-a-real-link', { anon: true }),
    route('other', 'invite-no-link', '#/invite', { anon: true }),
    route('other', 'invite-invalid-link', '#/invite?token=not-a-real-link', { anon: true }),
    route('other', 'unsubscribe-no-link', '#/unsubscribe', { anon: true }),
    route('other', 'unsubscribe-invalid-link', '#/unsubscribe?token=not-a-real-link', {
      anon: true,
    }),
    route('other', 'oauth-consent-no-request', '#/oauth/consent', { anon: true }),
    route('other', 'oauth-consent-invalid', '#/oauth/consent?request=not-a-real-one', {
      anon: true,
    }),
  ];
  // Without the id a route needs there is nothing to open: it is reported, not captured.
  const missing = [];
  const usable = list.filter((r) => {
    if (r.route.includes('undefined') || r.route.includes('null')) {
      missing.push({ slug: r.slug, why: 'the sample data for its id could not be made' });
      return false;
    }
    return true;
  });
  return { routes: usable, missing };
}

/** Routes the router and the admin list name that the list above does not reach. */
function notCovered(routes) {
  const literals = new Set();
  for (const file of ['App.tsx', 'admin/sections.ts']) {
    for (const m of source(file).matchAll(/'(#\/[a-z/-]+)'/g)) literals.add(m[1]);
  }
  return [...literals].filter((l) => !routes.some((r) => r.route.split('?')[0].startsWith(l)));
}

// ---------------------------------------------------------------------------------------- states

const openBoardTicket = async (page) => {
  const link = page.locator('.board-card-link').first();
  await link.waitFor({ timeout: 10_000 });
  await link.click();
  await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
};
const openCreate = async (page) => {
  await page.locator('.create-open').click({ timeout: 10_000 });
  await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
};
/** Presses the first grip that can be seen (some show only on focus), and waits for its menu. */
const openGrip = (grip) => async (page) => {
  await page.locator(grip).first().waitFor({ state: 'attached', timeout: 10_000 });
  for (const handle of (await page.locator(grip).all()).slice(0, 12)) {
    await handle.focus().catch(() => {});
    const box = await handle.boundingBox();
    if (!box || box.width < 1 || box.height < 1) continue;
    await handle.scrollIntoViewIfNeeded({ timeout: 3000 });
    await handle.click({ force: true });
    await page.locator('[role="menu"], [aria-expanded="true"]').first().waitFor({ timeout: 5000 });
    return;
  }
  throw new Error('no grip could be seen');
};
/** Opens the first thing of this kind inside the dialog: a menu, a list or a tip. */
const openInDialog = (kind) => async (page) => {
  const opener = page.locator('[role="dialog"]').first().locator(kind).first();
  await opener.waitFor({ timeout: 10_000 });
  const opened = (await opener.getAttribute('aria-label')) ?? (await opener.innerText());
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  await page.waitForTimeout(200);
  return { opened: scrub(opened).slice(0, 80) };
};
/** The backend says another frontend is wanted; nothing changes on the server. */
const metaSays = (frontend) => async (page) => {
  await page.route('**/api/meta*', async (call) => {
    const answer = await call.fetch();
    const body = await answer.json();
    await call.fulfill({ response: answer, json: { ...body, frontend } });
  });
};
/** Asked about a link, the backend answers as for a good one, so the form shows (never sent). */
const linkLooksGood = (path, json) => async (page) => {
  await page.route(`**/api/v1/${path}`, (call) =>
    call.request().method() === 'POST' || path === 'setup'
      ? call.fulfill({ json })
      : call.continue(),
  );
};

function allStates(ids) {
  const track = `#/tracks/${ids.track}`;
  const person = { name: 'Sweep Person', email: 'sweep.person@example.com' };
  const states = [
    route('other', 'state-ticket-popup-over-board', `${track}/board`, { act: openBoardTicket }),
    route('other', 'state-create-dialog', '#/home', { act: openCreate }),
    route('other', 'state-list-in-create-dialog', '#/home', {
      act: async (page) => {
        await openCreate(page);
        return openInDialog('button[aria-haspopup]')(page);
      },
    }),
    route('other', 'state-tip-in-ticket-popup', `${track}/board`, {
      act: async (page) => {
        await openBoardTicket(page);
        return openInDialog('button[aria-expanded="false"]:not([aria-haspopup])')(page);
      },
    }),
    route('other', 'state-menu-in-ticket-popup', `${track}/board`, {
      act: async (page) => {
        await openBoardTicket(page);
        return openInDialog('button[aria-haspopup]')(page);
      },
    }),
    route('other', 'state-grip-menu-board', `${track}/board`, {
      act: openGrip('[data-card-grip]'),
    }),
    route('other', 'state-grip-menu-backlog', `${track}/backlog`, {
      act: openGrip('[data-handle]'),
    }),
    route('other', 'state-grip-menu-calendar', `${track}/calendar`, {
      act: openGrip('.calendar-grip .move-grip-handle'),
    }),
    route('other', 'state-grip-menu-layout', `#/admin/layouts?set=${ids.layoutSet}`, {
      act: async (page) => {
        // A layout begun here and never saved: the page shows its grips once there is one.
        await page.getByRole('button', { name: 'Make a layout for this form' }).first().click();
        await openGrip('.layout-grip button')(page);
      },
    }),
    route('other', 'state-update-notice', '#/home', {
      before: metaSays({ minimum: null, recommended: '99.0.0' }),
    }),
    route('other', 'state-update-required', '#/home', {
      before: metaSays({ minimum: '99.0.0', recommended: '99.0.0' }),
    }),
    route('other', 'state-sign-in-wrong-password', '#/sign-in?method=password', {
      anon: true,
      act: async (page) => {
        await page
          .locator('input[autocomplete="username"], input[type="email"]')
          .first()
          .fill(`nobody-${Date.now()}@example.com`);
        await page.locator('input[type="password"]').first().fill('not the password');
        await page.locator('form button[type="submit"]').first().click();
        await page.locator('[role="alert"]').first().waitFor({ timeout: 10_000 });
      },
    }),
    route('other', 'state-setup-form', '#/setup?token=not-a-real-link', {
      anon: true,
      before: linkLooksGood('setup', { needed: true }),
    }),
    route('other', 'state-password-form', '#/password?token=not-a-real-link', {
      anon: true,
      before: linkLooksGood('password-links/inspect', { purpose: 'activate', ...person }),
    }),
    route('other', 'state-invite-form', '#/invite?token=not-a-real-link', {
      anon: true,
      before: linkLooksGood('invitations/inspect', {
        ...person,
        track: { key: ids.track, name: 'Mobile apps' },
        trackKey: ids.track,
        trackName: 'Mobile apps',
        role: 'Members',
        invitedBy: 'Eval Admin',
      }),
    }),
    route('other', 'state-ticket-print', `#/tickets/${ids.ticket}`, { print: true }),
    route('other', 'state-phone-navigation', '#/home', {
      phoneOnly: true,
      act: async (page) => {
        await page
          .locator('.topbar button[aria-expanded], header button[aria-expanded]')
          .first()
          .click();
        await page.waitForTimeout(200);
      },
    }),
    route('other', 'state-command-palette', '#/home', {
      act: async (page) => {
        await page.keyboard.press('Control+k');
        await page.locator('[role="dialog"], [role="combobox"]').first().waitFor({ timeout: 5000 });
      },
    }),
  ];
  const builder = join(ROOT, 'apps', 'web', 'dist-builder', 'index.html');
  if (existsSync(builder)) {
    states.push(
      route('other', 'builder-page', pathToFileURL(builder).href, { anon: true, external: true }),
    );
  }
  return states;
}

// --------------------------------------------------------------------------------------- capture

/** The address for a route, in a language: `?locale=` wins over the account's without saving. */
function addressOf(entry, locale) {
  if (entry.external) return entry.route;
  const joiner = entry.route.includes('?') ? '&' : '?';
  return `${URL_BASE}/${entry.route}${joiner}locale=${locale}`;
}

/** A page that keeps what goes wrong, and knows when the network has gone quiet. */
function watch(page) {
  const seen = { console: [], failed: [], pending: new Set(), last: Date.now() };
  const counts = (request) => !['eventsource', 'websocket'].includes(request.resourceType());
  const done = (request) => {
    seen.pending.delete(request);
    seen.last = Date.now();
  };
  page.on('request', (request) => {
    if (counts(request)) {
      seen.pending.add(request);
      seen.last = Date.now();
    }
  });
  page.on('requestfinished', done);
  page.on('requestfailed', (request) => {
    done(request);
    const why = request.failure()?.errorText ?? 'failed';
    if (why !== 'net::ERR_ABORTED') seen.failed.push(scrub(`${why} ${request.url()}`));
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      seen.failed.push(
        scrub(`${response.status()} ${response.request().method()} ${response.url()}`),
      );
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') seen.console.push(scrub(message.text()));
  });
  page.on('pageerror', (error) => seen.console.push(scrub(`uncaught: ${error.message}`)));
  page.seen = seen;
  return page;
}

async function settle(page) {
  const deadline = Date.now() + SETTLE_MS;
  const { seen } = page;
  while (Date.now() < deadline) {
    if (seen.pending.size === 0 && Date.now() - seen.last > 350) break;
    await page.waitForTimeout(80);
  }
  const quiet = await page
    .waitForFunction(looksSettled, null, { timeout: Math.max(500, deadline - Date.now()) })
    .then(
      () => true,
      () => false,
    );
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(120);
  return quiet && seen.pending.size === 0;
}

const atMost = (ms, work) =>
  Promise.race([
    work,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`took over ${ms / 1000} s`)), ms)),
  ]);

async function capture(pages, entry, combo, locale, slug) {
  const page = pages[entry.anon ? 'anon' : 'signedIn'][combo.phone ? 'phone' : 'desktop'];
  const { seen } = page;
  const image = `${slug}--${combo.width}--${combo.skin}.png`;
  const record = {
    id: image.replace(/\.png$/, ''),
    slug,
    route: entry.route.startsWith('file:') ? 'the Builder page, from its file' : scrub(entry.route),
    group: GROUPS[entry.group],
    width: combo.width,
    skin: combo.skin,
    locale,
    image,
  };
  try {
    await page.goto('about:blank');
    seen.console.length = 0;
    seen.failed.length = 0;
    seen.pending.clear();
    await page.emulateMedia({ colorScheme: combo.skin, media: 'screen' });
    if (entry.before) await entry.before(page);
    await page.goto(addressOf(entry, locale), { waitUntil: 'load', timeout: 45_000 });
    record.settled = await settle(page);
    if (entry.act) {
      try {
        const said = await entry.act(page);
        if (said) record.acted = said;
        record.settled = (await settle(page)) && record.settled;
      } catch (error) {
        record.stateFailed = scrub(String(error.message).split('\n')[0]);
      }
    }
    if (entry.print) await page.emulateMedia({ media: 'print' });
    // A state over the page is pictured as the window shows it: a dialog's veil, a stuck bar and a
    // menu scrolled to are drawn for the window, and a full-page picture misplaces them.
    const inWindow = Boolean(entry.act) && !entry.anon;
    record.final = entry.external
      ? ''
      : scrub(new URL(page.url()).pathname + new URL(page.url()).search);
    // The skin's background is fixed to the window, so a full-page picture would stop it at the
    // window's height with a hard line no person ever sees. In the picture only, it scrolls. Set
    // here because the page's content security policy refuses a style element (and logs it).
    await page.evaluate(setBackgroundAttachment, 'scroll');
    await page.screenshot({
      path: join(OUT, image),
      fullPage: !inWindow,
      animations: 'disabled',
      caret: 'hide',
    });
    await page.evaluate(setBackgroundAttachment, '');
    Object.assign(record, await page.evaluate(describePage));
    record.sideways = await page.evaluate(measureSideways, combo.width);
    await page.evaluate(AXE);
    record.axe = await atMost(90_000, page.evaluate(runAxe));
    const controls = await atMost(30_000, page.evaluate(measureControls, MINIMUM_TARGET));
    record.names = controls.names;
    if (combo.phone && !entry.print) record.small = controls.small;
    if (combo.phone && combo.skin === 'light') {
      await page.setViewportSize({ width: 360, height: 740 });
      await page.waitForTimeout(150);
      record.sideways360 = await page.evaluate(measureSideways, 360);
      await page.setViewportSize({ width: combo.width, height: 812 });
    }
  } catch (error) {
    record.error = scrub(String(error.message).split('\n')[0]);
  }
  record.console = [...new Set(seen.console)];
  record.failed = [...new Set(seen.failed)];
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  return record;
}

// --------------------------------------------------------------------------------------- summary

const top = (map, n = 30) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([what, count]) => ({ what, count }));
const add = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

function summarise(captures) {
  const sideways375 = new Map();
  const sideways360 = new Map();
  const sidewaysDesktop = new Map();
  const small = new Map();
  const smallPages = new Map();
  const axeRules = new Map();
  const axePages = new Map();
  const consoleErrors = new Map();
  const failed = new Map();
  const names = new Map();
  const namePages = new Map();
  const uniqueSmall = new Set();
  const uniqueNames = new Set();
  for (const c of captures) {
    if (c.sideways?.over > 0) {
      add(c.width === 375 ? sideways375 : sidewaysDesktop, c.slug, 0);
      (c.width === 375 ? sideways375 : sidewaysDesktop).set(c.slug, c.sideways.over);
    }
    if (c.sideways360?.over > 0) sideways360.set(c.slug, c.sideways360.over);
    for (const s of c.small ?? []) {
      if (c.skin !== 'light') continue;
      add(smallPages, c.slug);
      add(small, `${s.role} "${s.name}" ${s.width}x${s.height}`);
      uniqueSmall.add(`${s.role}|${s.name}`);
    }
    for (const v of c.axe ?? []) {
      add(axeRules, `${v.id} (${v.impact})`, v.nodes);
      add(axePages, c.slug, v.nodes);
    }
    for (const line of c.console ?? []) add(consoleErrors, line);
    for (const line of c.failed ?? []) add(failed, line);
    for (const n of c.names ?? []) {
      if (c.skin !== 'light' || c.width !== 1280) continue;
      add(names, `${n.role} named "${n.name}" shows "${n.visible}"`);
      add(namePages, c.slug);
      uniqueNames.add(`${n.role}|${n.name}|${n.visible}`);
    }
  }
  return {
    captures: captures.length,
    errors: captures.filter((c) => c.error).length,
    statesThatFailed: captures.filter((c) => c.stateFailed).length,
    notSettled: captures.filter((c) => c.settled === false).length,
    counts: {
      sidewaysAt375: sideways375.size,
      sidewaysAt360: sideways360.size,
      sidewaysAt1280: sidewaysDesktop.size,
      smallControlsDistinct: uniqueSmall.size,
      axeRules: axeRules.size,
      axeNodes: [...axeRules.values()].reduce((a, b) => a + b, 0),
      consoleErrorsDistinct: consoleErrors.size,
      failedRequestsDistinct: failed.size,
      namesLeavingOutWordsDistinct: uniqueNames.size,
    },
    worst: {
      sidewaysAt375: top(sideways375),
      sidewaysAt360: top(sideways360),
      sidewaysAt1280: top(sidewaysDesktop),
      smallControlsByPage: top(smallPages),
      smallControls: top(small),
      axeByRule: top(axeRules),
      axeByPage: top(axePages),
      consoleErrors: top(consoleErrors),
      failedRequests: top(failed),
      namesLeavingOutWords: top(names),
      namesByPage: top(namePages),
    },
  };
}

// ------------------------------------------------------------------------------------------- run

mkdirSync(OUT, { recursive: true });
mkdirSync(join(ROOT, '.cache', 'sweep'), { recursive: true });
const stopDemo = args.demo
  ? await startDemo({ root: ROOT, url: URL_BASE, logFile: args.log })
  : null;
const browser = await chromium.launch();
try {
  await ensureSignedIn(browser, { url: URL_BASE, logFile: args.log, stateFile: STATE });

  const shared = { reducedMotion: 'reduce', locale: 'en-US' };
  const desktop = { ...shared, viewport: { width: 1280, height: 800 } };
  const phone = {
    ...shared,
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  };
  const open = async (options) => watch(await (await browser.newContext(options)).newPage());
  const signedIn = { storageState: STATE };
  const pages = {
    signedIn: {
      desktop: await open({ ...desktop, ...signedIn }),
      phone: await open({ ...phone, ...signedIn }),
    },
    anon: { desktop: await open(desktop), phone: await open(phone) },
  };

  const { ids, problems } = await seedDemo(pages.signedIn.desktop.context().request, URL_BASE);
  for (const problem of problems) process.stdout.write(`seed: ${scrub(problem)}\n`);
  const { routes, missing } = allRoutes(ids);
  const states = allStates(ids);
  if (!states.some((s) => s.slug === 'builder-page')) {
    missing.push({
      slug: 'builder-page',
      why: 'not built: corepack pnpm --filter @taskmoor/web build:builder',
    });
  }
  const everything = [...routes, ...states];
  const uncovered = notCovered(everything);
  const chosen = args.only
    ? everything.filter((r) => r.slug.includes(args.only) || r.route.includes(args.only))
    : everything;

  let captures = [];
  if (args.only && existsSync(REPORT)) {
    captures = JSON.parse(readFileSync(REPORT, 'utf8')).captures ?? [];
  }
  const save = () => {
    const images = (group) => captures.filter((c) => c.group === group).map((c) => c.image);
    const seenSlugs = (group) => [
      ...new Map(
        captures.filter((c) => c.group === group).map((c) => [c.slug.replace(/-es$/, ''), c.route]),
      ).entries(),
    ];
    writeFileSync(
      REPORT,
      `${JSON.stringify(
        {
          url: URL_BASE,
          summary: summarise(captures),
          seedProblems: problems.map(scrub),
          routesWithoutData: missing,
          routesNotInTheList: uncovered,
          groups: Object.values(GROUPS).map((name) => ({
            name,
            routes: seenSlugs(name).map(([slug, address]) => ({ slug, route: address })),
            images: images(name),
          })),
          captures,
        },
        null,
        1,
      )}\n`,
    );
  };
  const take = async (entry, combo, locale, slug) => {
    const made = await capture(pages, entry, combo, locale, slug);
    captures = captures.filter((c) => c.id !== made.id);
    captures.push(made);
    return made;
  };

  const started = Date.now();
  let done = 0;
  for (const entry of chosen) {
    for (const combo of COMBOS) {
      if (entry.phoneOnly && !combo.phone) continue;
      const made = await take(entry, combo, 'en', entry.slug);
      if (made.error) process.stdout.write(`${made.id}: ${made.error}\n`);
      if (made.stateFailed) process.stdout.write(`${made.id}: ${made.stateFailed}\n`);
    }
    done += 1;
    save();
    const minutes = ((Date.now() - started) / 60_000).toFixed(1);
    process.stdout.write(`${done}/${chosen.length} ${entry.slug} (${minutes} min)\n`);
  }

  // Spanish: the main sections, and the pages that came out longest in English.
  const longest = captures
    .filter((c) => c.width === 375 && c.skin === 'light' && c.locale === 'en' && c.height)
    .sort((a, b) => b.height - a.height)
    .map((c) => c.slug)
    .filter((s) => !s.startsWith('state-') && !SPANISH.includes(s))
    .slice(0, SPANISH_LONGEST);
  const spanish = chosen.filter((e) => SPANISH.includes(e.slug) || longest.includes(e.slug));
  for (const entry of spanish) {
    for (const combo of COMBOS.filter((c) => c.skin === 'light')) {
      const made = await take(entry, combo, 'es', `${entry.slug}-es`);
      if (made.error) process.stdout.write(`${made.id}: ${made.error}\n`);
    }
    save();
    process.stdout.write(`es ${entry.slug}\n`);
  }

  save();
  const { counts } = summarise(captures);
  process.stdout.write(
    `Routes and states: ${chosen.length} of ${everything.length}. Images: ${captures.filter((c) => !c.error).length}.\n${JSON.stringify(counts)}\nWritten to ${REPORT}\n`,
  );
} finally {
  await browser.close();
  if (stopDemo) await stopDemo();
}
