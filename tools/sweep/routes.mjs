// pnpm sweep --out <dir> [--url http://localhost:8090] [--only=<text>] [--width=1280|375] [--demo]
//
// Shows every route of the real app signed in, for the page sweep (UI-T22), without a person's
// browser: pictures at 1280x800 (the whole page) and at 375x812 with touch, in the light and dark
// skins, plus measurements.json with sideways scroll (also at 360 px), controls under 44 px, axe's
// serious and critical findings, console errors, failed requests and accessible names that leave
// out visible words (WCAG 2.5.3, T-212). It also opens the states a route alone does not show.
//
// A phone picture is what the phone's window shows: Chromium's whole-page capture drops the touch
// emulation, so the window is scrolled through the page and pictured each time (<slug>--375--light
// .png, then --2, --3 ...), each window overlapping the last by the bars stuck to its edges.
//
// It needs a private `pnpm demo`: --demo starts one on the --url's port and stops it afterwards,
// keeping its data; or start one yourself with its output in .cache/sweep/demo.log. The
// administrator's one-time link is kept in memory (or read from that log), a password made here is
// set and forgotten, and the browser's state is kept in .cache/sweep/state.json (git ignores
// .cache). Sample data the demo lacks is added through the API (seed.mjs). Nothing here prints or
// writes a link, password or token: every line that leaves goes through redact.mjs.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startDemo } from './demo.mjs';
import {
  addressOf,
  allRoutes,
  choose,
  combosFor,
  DESKTOP,
  GROUPS,
  imageName,
  laterWindowsIn,
  notCovered,
  PHONE,
  parseSweepArgs,
  route,
  spanishChoice,
  windowStops,
} from './plan.mjs';
import {
  describePage,
  looksSettled,
  measureControls,
  measureSideways,
  pointerState,
  runAxe,
  scrollWindowTo,
  setBackgroundAttachment,
  stuckEdges,
} from './probe.mjs';
import { firstLine, pngSize, redact } from './redact.mjs';
import { seedDemo } from './seed.mjs';
import { ensureSignedIn } from './session.mjs';
import { summarise } from './summary.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

let args;
try {
  args = parseSweepArgs(process.argv.slice(2), {
    defaultLog: join(ROOT, '.cache', 'sweep', 'demo.log'),
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const fromWeb = createRequire(join(ROOT, 'apps', 'web', 'package.json'));
const { chromium } = fromWeb('@playwright/test');
const AXE = readFileSync(fromWeb.resolve('axe-core/axe.min.js'), 'utf8');

const URL_BASE = args.url;
const OUT = args.out;
const STATE = join(ROOT, '.cache', 'sweep', 'state.json');
const REPORT = join(OUT, 'measurements.json');
const COMBOS = combosFor(args.widths);
const MINIMUM_TARGET = 44;
const SETTLE_MS = 8000;

const source = (file) => readFileSync(join(ROOT, 'apps', 'web', 'src', file), 'utf8');

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
  return { opened: redact(opened, 80) };
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
    if (why !== 'net::ERR_ABORTED') seen.failed.push(redact(`${why} ${request.url()}`));
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      seen.failed.push(
        redact(`${response.status()} ${response.request().method()} ${response.url()}`),
      );
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') seen.console.push(redact(message.text()));
  });
  page.on('pageerror', (error) => seen.console.push(redact(`uncaught: ${error.message}`)));
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

const SHOT = { animations: 'disabled', caret: 'hide' };

/**
 * Removes an earlier run's later window pictures of this route, so the folder holds only what this
 * capture takes: a page that got shorter, or a state now pictured in one window, leaves none behind.
 */
function removeLaterWindows(slug, combo) {
  for (const file of laterWindowsIn(readdirSync(OUT), slug, combo.width, combo.skin)) {
    rmSync(join(OUT, file), { force: true });
  }
}

/**
 * The phone's window, scrolled through the page and pictured each time. Chromium's whole-page
 * capture resizes the page without its touch emulation, so controls lost their 44 px and the
 * skin's fixed background ended in a flat band; a window picture keeps both as a phone shows them.
 */
async function phoneWindows(page, slug, combo) {
  let edges = await page.evaluate(stuckEdges);
  if (edges.scrollHeight > edges.innerHeight) {
    // Measured a window down, where a sticky bar is stuck to the top.
    await page.evaluate(
      scrollWindowTo,
      Math.min(edges.innerHeight, edges.scrollHeight - edges.innerHeight),
    );
    edges = await page.evaluate(stuckEdges);
  }
  const { stops, step, cut } = windowStops(edges);
  const images = [];
  for (const [index, top] of stops.entries()) {
    await page.evaluate(scrollWindowTo, top);
    await page.waitForTimeout(100);
    const image = imageName(slug, combo.width, combo.skin, index + 1);
    await page.screenshot({ path: join(OUT, image), ...SHOT });
    images.push(image);
  }
  await page.evaluate(scrollWindowTo, 0);
  return {
    images,
    windows: {
      count: images.length,
      step,
      stuckTop: edges.stuckTop,
      stuckBottom: edges.stuckBottom,
      cut,
    },
  };
}

/** Why a phone picture is not what a phone shows, or null when it is. */
function phoneProblem(pointer, file) {
  const size = pngSize(readFileSync(file));
  const wanted = PHONE.width * PHONE.scale;
  if (!pointer.coarse) return 'the page did not see a touch pointer';
  if (pointer.innerWidth !== PHONE.width) return `the window was ${pointer.innerWidth} px wide`;
  if (size?.width !== wanted) return `the picture is ${size?.width} px wide, not ${wanted}`;
  return null;
}

async function capture(pages, entry, combo, locale, slug) {
  const page = pages[entry.anon ? 'anon' : 'signedIn'][combo.phone ? 'phone' : 'desktop'];
  const { seen } = page;
  const image = imageName(slug, combo.width, combo.skin);
  const record = {
    id: image.replace(/\.png$/, ''),
    slug,
    route: entry.route.startsWith('file:')
      ? 'the Builder page, from its file'
      : redact(entry.route),
    group: GROUPS[entry.group],
    width: combo.width,
    skin: combo.skin,
    locale,
    image,
    images: [image],
  };
  try {
    await page.goto('about:blank');
    seen.console.length = 0;
    seen.failed.length = 0;
    seen.pending.clear();
    await page.emulateMedia({ colorScheme: combo.skin, media: 'screen' });
    if (entry.before) await entry.before(page);
    await page.goto(addressOf(entry, locale, URL_BASE), { waitUntil: 'load', timeout: 45_000 });
    record.settled = await settle(page);
    if (entry.act) {
      try {
        const said = await entry.act(page);
        if (said) record.acted = said;
        record.settled = (await settle(page)) && record.settled;
      } catch (error) {
        record.stateFailed = firstLine(error);
      }
    }
    if (entry.print) await page.emulateMedia({ media: 'print' });
    // A state over the page is pictured as the window shows it: a dialog's veil, a stuck bar and a
    // menu scrolled to are drawn for the window, and a full-page picture misplaces them.
    const inWindow = Boolean(entry.act) && !entry.anon;
    record.final = entry.external
      ? ''
      : redact(new URL(page.url()).pathname + new URL(page.url()).search);
    if (combo.phone) {
      record.pointer = await page.evaluate(pointerState);
      removeLaterWindows(slug, combo);
      if (inWindow) {
        await page.screenshot({ path: join(OUT, image), ...SHOT });
      } else {
        Object.assign(record, await phoneWindows(page, slug, combo));
      }
      const problem = phoneProblem(record.pointer, join(OUT, image));
      if (problem) record.pictureProblem = problem;
    } else {
      // The skin's background is fixed to the window, so a full-page picture would stop it at the
      // window's height with a hard line no person ever sees. In the picture only, it scrolls. Set
      // here because the page's content security policy refuses a style element (and logs it).
      await page.evaluate(setBackgroundAttachment, 'scroll');
      await page.screenshot({ path: join(OUT, image), fullPage: !inWindow, ...SHOT });
      await page.evaluate(setBackgroundAttachment, '');
    }
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
      await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    }
  } catch (error) {
    record.error = firstLine(error);
  }
  record.console = [...new Set(seen.console)];
  record.failed = [...new Set(seen.failed)];
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  return record;
}

// ------------------------------------------------------------------------------------------- run

const say = (line) => process.stdout.write(`${redact(line, 2000)}\n`);

mkdirSync(OUT, { recursive: true });
mkdirSync(join(ROOT, '.cache', 'sweep'), { recursive: true });
const demo = args.demo ? await startDemo({ root: ROOT, url: URL_BASE, logFile: args.log }) : null;
const browser = await chromium.launch();
try {
  await ensureSignedIn(browser, {
    url: URL_BASE,
    link: demo?.link ?? null,
    logFile: args.log,
    stateFile: STATE,
  });

  const shared = { reducedMotion: 'reduce', locale: 'en-US' };
  const desktop = { ...shared, viewport: DESKTOP };
  const phone = {
    ...shared,
    viewport: { width: PHONE.width, height: PHONE.height },
    deviceScaleFactor: PHONE.scale,
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
  for (const problem of problems) say(`seed: ${redact(problem)}`);
  const { routes, missing } = allRoutes(ids, source);
  const states = allStates(ids);
  if (!states.some((s) => s.slug === 'builder-page')) {
    missing.push({
      slug: 'builder-page',
      why: 'not built: corepack pnpm --filter @taskmoor/web build:builder',
    });
  }
  const everything = [...routes, ...states];
  const uncovered = notCovered(everything, source);
  const chosen = choose(everything, args.only);

  let captures = [];
  if (args.only && existsSync(REPORT)) {
    captures = JSON.parse(readFileSync(REPORT, 'utf8')).captures ?? [];
  }
  const save = () => {
    const inGroup = (group) => captures.filter((c) => c.group === group);
    const seenSlugs = (group) => [
      ...new Map(inGroup(group).map((c) => [c.slug.replace(/-es$/, ''), c.route])).entries(),
    ];
    writeFileSync(
      REPORT,
      `${JSON.stringify(
        {
          url: URL_BASE,
          summary: summarise(captures),
          seedProblems: problems.map((p) => redact(p)),
          routesWithoutData: missing,
          routesNotInTheList: uncovered,
          groups: Object.values(GROUPS).map((name) => ({
            name,
            routes: seenSlugs(name).map(([slug, address]) => ({ slug, route: address })),
            images: inGroup(name).flatMap((c) => c.images ?? [c.image]),
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
    for (const said of [made.error, made.stateFailed, made.pictureProblem]) {
      if (said) say(`${made.id}: ${said}`);
    }
    return made;
  };

  const started = Date.now();
  let done = 0;
  for (const entry of chosen) {
    for (const combo of COMBOS) {
      if (entry.phoneOnly && !combo.phone) continue;
      await take(entry, combo, 'en', entry.slug);
    }
    done += 1;
    save();
    const minutes = ((Date.now() - started) / 60_000).toFixed(1);
    say(`${done}/${chosen.length} ${entry.slug} (${minutes} min)`);
  }

  // Spanish: the main sections, and the pages that came out longest in English.
  for (const entry of spanishChoice(chosen, captures)) {
    for (const combo of COMBOS.filter((c) => c.skin === 'light')) {
      if (entry.phoneOnly && !combo.phone) continue;
      await take(entry, combo, 'es', `${entry.slug}-es`);
    }
    save();
    say(`es ${entry.slug}`);
  }

  save();
  const { counts } = summarise(captures);
  const pictures = captures.filter((c) => !c.error).flatMap((c) => c.images ?? [c.image]).length;
  say(
    `Routes and states: ${chosen.length} of ${everything.length}. Pictures in the report: ${pictures}.`,
  );
  say(JSON.stringify(counts));
  say(`Written to ${REPORT}`);
} finally {
  await browser.close();
  if (demo) await demo.stop();
}
