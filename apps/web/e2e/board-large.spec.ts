import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, type Route, test } from '@playwright/test';
import { expectWithinBudget } from './budget';

/**
 * A 5,000-card column in a real browser (T-193; AGL-013, ADR-049 "Large columns"): frames a
 * second while the page scrolls down the column, and the time from a card's drop to the board
 * settled, with the longest frame in between. The board, its page and its moves are the real
 * ones; the server's answer is multiplied in the browser's network layer, so the measure is the
 * page's own work (the server's side is `routes/boards.large.test.ts`). Run with
 *   TASKMOOR_LARGE_BOARD=1 npx playwright test e2e/board-large.spec.ts --project=desktop
 * Each run appends its numbers to `.verify/board-large.jsonl`.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
const CARDS = 5000;
const LOG = fileURLToPath(new URL('../../../.verify/board-large.jsonl', import.meta.url));

interface Card {
  id: number;
  key: string;
  summary: string;
  status: { id: number; name: string };
  columnId: string;
  laneId: string;
  rank: string;
  [field: string]: unknown;
}
interface Column {
  id: string;
  name: string;
  statusIds: number[];
  count: number;
  shown: number;
  wip: string | null;
}
interface Data {
  columns: Column[];
  cards: Card[];
  [field: string]: unknown;
}

/** The board's answer with its one card multiplied into a column of `CARDS`, kept as moves go. */
function largeBoard(page: Page, track: string) {
  let data: Data | null = null;
  const statusName = new Map<number, string>();
  const answer = (route: Route) => {
    const board = data as Data;
    for (const column of board.columns) {
      column.count = board.cards.filter((c) => c.columnId === column.id).length;
      column.shown = column.count;
      column.wip = null;
    }
    return route.fulfill({ json: board });
  };
  return {
    install: async () => {
      await page.route(/\/api\/v1\/boards\/\d+\/data/, async (route) => {
        if (data) return answer(route);
        const real = (await (await route.fetch()).json()) as Data;
        const [template] = real.cards;
        if (!template) throw new Error('the board has no card to multiply');
        for (const card of real.cards) statusName.set(card.status.id, card.status.name);
        data = {
          ...real,
          cards: Array.from({ length: CARDS }, (_, i) => ({
            ...template,
            id: 9_000_000 + i,
            key: `${track}-${i + 1}`,
            summary: `Generated card ${i + 1} of a long column`,
            rank: `a${String(i).padStart(6, '0')}`,
          })),
        };
        return answer(route);
      });
      // A move as the server would make it: the card's column and place change.
      await page.route(/\/api\/v1\/boards\/\d+\/moves/, async (route) => {
        const move = route.request().postDataJSON() as {
          ticket: number;
          columnId: string;
          before?: number;
          after?: number;
        };
        const board = data as Data;
        const card = board.cards.find((c) => c.id === move.ticket) as Card;
        const column = board.columns.find((c) => c.id === move.columnId) as Column;
        const statusId = column.statusIds[0] as number;
        const moved = {
          ...card,
          columnId: column.id,
          status: { id: statusId, name: statusName.get(statusId) ?? column.name },
        };
        const rest = board.cards.filter((c) => c.id !== card.id);
        const anchor = move.before ?? move.after;
        const found = rest.findIndex((c) => c.id === anchor);
        const at =
          anchor === undefined ? rest.length : move.after !== undefined ? found + 1 : found;
        // Only the moved card's rank changes, as on the server: one between its new neighbours.
        moved.rank = `${rest[at - 1]?.rank ?? 'a'}m`;
        rest.splice(at, 0, moved);
        board.cards = rest;
        return route.fulfill({ json: { moved: true } });
      });
      await page.route(/\/api\/v1\/tickets\/subticket-progress/, (route) =>
        route.fulfill({ json: { progress: {} } }),
      );
    },
  };
}

test('[AGL-013] a 5,000-card column scrolls and takes a drop without holding the page', async ({
  page,
}, testInfo) => {
  test.skip(!process.env.TASKMOOR_LARGE_BOARD, 'a measurement: TASKMOOR_LARGE_BOARD=1');
  test.skip(testInfo.project.name !== 'desktop', 'measured on the desktop project');
  test.setTimeout(180_000);
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const key = `L${Date.now().toString(36).toUpperCase().slice(-7)}`;
  const track = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Large ${key}`, mode: 'shared' },
  });
  expect(track.status(), await track.text()).toBe(201);
  const made = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: key, summary: 'The card to multiply', assigneeId: null },
  });
  expect(made.ok(), await made.text()).toBe(true);

  await largeBoard(page, key).install();
  await page.goto(`${BASE}/#/tracks/${key}/board`);
  const first = page.getByRole('list', { name: 'New', exact: true });
  await expect(first.getByRole('link', { name: new RegExp(`^${key}-1 `) })).toBeVisible();
  // Whatever the page still draws after the first cards (05b: the rest may follow) is done:
  // the number of cards on the page holds for a second.
  const drawn = await page.evaluate(async () => {
    const count = () => document.querySelectorAll('.board-card').length;
    let before = -1;
    for (let tries = 0; tries < 60 && count() !== before; tries += 1) {
      before = count();
      await new Promise((done) => setTimeout(done, 1000));
    }
    return count();
  });

  // Scrolling: a steady 60 px a frame for three seconds, down the column, timed alone; then the
  // same again, looking for frames with no card at the middle of the screen. First, the pace of
  // this browser with nothing to do, to read the rest against.
  const scrollDown = (probe: boolean) =>
    page.evaluate(async (probe) => {
      window.scrollTo(0, 0);
      await new Promise((done) => setTimeout(done, 500));
      const frames: number[] = [];
      let blank = 0;
      const cell = document.querySelector('.board-cell') as HTMLElement;
      const x = cell.getBoundingClientRect().left + 40;
      // A frame is blank when neither of two points, further apart than the gap between two
      // cards, is on a card inside the column.
      const blankAt = (y: number) => {
        const under = document.elementFromPoint(x, y);
        return cell.contains(under) && !under?.closest('.board-card');
      };
      await new Promise<void>((done) => {
        let last = 0;
        const start = performance.now();
        const step = (now: number) => {
          if (last) frames.push(now - last);
          last = now;
          if (probe && blankAt(innerHeight / 2) && blankAt(innerHeight / 2 + 24)) blank += 1;
          if (now - start > 3000) return done();
          window.scrollBy(0, 60);
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      const sorted = [...frames].sort((a, b) => a - b);
      const total = frames.reduce((sum, f) => sum + f, 0);
      return {
        fps: (frames.length / total) * 1000,
        p95: sorted[Math.floor(sorted.length * 0.95)] as number,
        longest: sorted.at(-1) as number,
        frames: frames.length,
        blank,
        scrolled: window.scrollY,
      };
    }, probe);
  const idle = await page.evaluate(async () => {
    let frames = 0;
    const start = performance.now();
    await new Promise<void>((done) => {
      const step = (now: number) => {
        frames += 1;
        if (now - start > 1000) return done();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    return (frames / (performance.now() - start)) * 1000;
  });
  const scroll = await scrollDown(false);
  const probed = await scrollDown(true);
  await page.evaluate(() => window.scrollTo(0, 0));

  // A drop: the first card into the next column, from the drop to the card drawn there.
  await page.evaluate((moved) => {
    const w = window as unknown as { dropWatch: { start: number; longest: number; end: number } };
    w.dropWatch = { start: 0, longest: 0, end: 0 };
    const frames = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (w.dropWatch.start && entry.startTime + entry.duration >= w.dropWatch.start) {
          w.dropWatch.longest = Math.max(w.dropWatch.longest, entry.duration);
        }
      }
    });
    // A long frame where the browser reports them (Chromium), else a long task.
    try {
      frames.observe({ type: 'long-animation-frame', buffered: false });
    } catch {
      frames.observe({ type: 'longtask', buffered: false });
    }
    // The drop is the release of the pointer that drags the card (T-162b).
    document.addEventListener(
      'pointerup',
      () => {
        w.dropWatch.start = performance.now();
        const settled = () => {
          const there = [...document.querySelectorAll('.board-cell')]
            .find((cell) => cell.getAttribute('aria-label') === 'Active')
            ?.querySelector(`a[title^="${moved} "]`);
          if (!there) {
            requestAnimationFrame(settled);
            return;
          }
          // Drawn: the frame that shows it, and the next one.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              w.dropWatch.end = performance.now();
            }),
          );
        };
        requestAnimationFrame(settled);
      },
      { capture: true, once: true },
    );
  }, `${key}-1`);
  await page
    .getByRole('link', { name: new RegExp(`^${key}-1 `) })
    .dragTo(page.getByRole('list', { name: 'Active', exact: true }), {
      targetPosition: { x: 60, y: 30 },
    });
  await page.waitForFunction(
    () => (window as unknown as { dropWatch: { end: number } }).dropWatch.end > 0,
  );
  const drop = await page.evaluate(() => {
    const w = window as unknown as { dropWatch: { start: number; longest: number; end: number } };
    // The board's new answer, read after the drop: what follows it is the page's own work.
    const answer = performance
      .getEntriesByType('resource')
      .filter((e) => /\/boards\/\d+\/data/.test(e.name) && e.startTime >= w.dropWatch.start)
      .at(-1) as PerformanceResourceTiming | undefined;
    return {
      settled: w.dropWatch.end - w.dropWatch.start,
      afterAnswer: answer ? w.dropWatch.end - answer.responseEnd : Number.NaN,
      longest: w.dropWatch.longest,
    };
  });
  await expect(
    page
      .getByRole('list', { name: 'Active', exact: true })
      .getByRole('link', { name: new RegExp(`^${key}-1 `) }),
  ).toBeVisible();

  const result = {
    cards: CARDS,
    drawn,
    idleFps: Math.round(idle * 10) / 10,
    fps: Math.round(scroll.fps * 10) / 10,
    frameP95: Math.round(scroll.p95 * 10) / 10,
    frameLongest: Math.round(scroll.longest),
    frames: scroll.frames,
    // The same scroll with a hit test each frame, as a pointer resting over the column makes.
    probedFps: Math.round(probed.fps * 10) / 10,
    blankFrames: probed.blank,
    scrolled: scroll.scrolled,
    dropSettled: Math.round(drop.settled),
    dropAfterAnswer: Math.round(drop.afterAnswer),
    dropLongestFrame: Math.round(drop.longest),
  };
  testInfo.annotations.push({ type: 'board-large', description: JSON.stringify(result) });
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
  } catch {
    // The log is a convenience.
  }
  expect(scroll.scrolled).toBeGreaterThan(3000);
  // This headless browser's own compositor holds the p95 near 33 ms before and after (ADR-049),
  // so the limits are the mean frame and the drop.
  expectWithinBudget(
    testInfo,
    1000 / probed.fps,
    22,
    '5,000-card column: mean frame scrolling under the pointer (ms)',
  );
  expectWithinBudget(testInfo, drop.settled, 500, '5,000-card column: drop to settled (ms)');
  expectWithinBudget(
    testInfo,
    drop.longest,
    100,
    '5,000-card column: longest frame after a drop (ms)',
  );
});
