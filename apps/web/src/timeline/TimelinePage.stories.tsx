import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import { expectWithinBudget } from '../test/budget';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakeTimelineClient, manyItems, timelineFixture } from './fixtures';
import { TimelinePage } from './TimelinePage';

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
};

const meta = {
  title: 'Timeline/TimelinePage',
  component: TimelinePage,
  args: {
    trackKey: 'LCH',
    client: fakeTimelineClient(),
    now: () => new Date('2026-11-04T09:00:00Z'),
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof TimelinePage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An outcome rolled up from its features, a sprint-dated ticket, a dependency and markers. */
export const Timeline: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Timeline', level: 1 })).toBeVisible();
    await expect(canvas.getByText('1 of 3 closed')).toBeVisible();
  },
};

/** Zoomed out to quarters. */
export const Quarters: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    (await canvas.findByRole('button', { name: 'Quarters' })).click();
    await expect(await canvas.findByText('Q4 2026')).toBeInTheDocument();
  },
};

/** When the timeline arrived, for the render budget below. */
const arrival = { at: 0 };

/**
 * The render budget (M1-048): 2,000 tickets, every one dated, on screen within 1.5 s of their
 * arrival. Past 200 rows only those in view are drawn (ADR-122), so the grid holds the height of
 * all 2,000 and the page far fewer rows. Axe is off here only: it would time the checks, not the
 * timeline.
 */
export const TwoThousandTickets: Story = {
  args: {
    client: (() => {
      const inner = fakeTimelineClient({ data: manyItems(2000) });
      return {
        ...inner,
        timeline: async (key: string) => {
          const data = await inner.timeline(key);
          arrival.at = performance.now();
          return data;
        },
      };
    })(),
  },
  parameters: { a11y: { test: 'off' } },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => expect(canvasElement.querySelectorAll('.timeline-row').length).toBeGreaterThan(10),
      { timeout: 10_000, interval: 10 },
    );
    const took = performance.now() - arrival.at;
    const grid = canvasElement.querySelector<HTMLElement>('.timeline-grid');
    await expect(grid?.style.height).toBe(`${2000 * 44}px`);
    await expect(canvasElement.querySelectorAll('.timeline-row').length).toBeLessThan(200);
    await expectWithinBudget(took, 1500, '2,000 timeline rows on screen (ms)');
  },
};

/** At a phone's width: the lanes scroll inside their own glass, the page never sideways. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Timeline', level: 1 })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** A track that is not there, or not for this person: the page still says what it is. */
export const NotFound: Story = {
  args: {
    client: {
      ...fakeTimelineClient(),
      timeline: async () => {
        throw new Error('not found');
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Timeline', level: 1 })).toBeVisible();
  },
};

/** A finger reaches each ticket's key, which fills its row (ADR-033). */
export const OnATouchScreen: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findAllByRole('link', { name: /^[A-Z]+-\d+$/ });
    await expect(tooSmallForAFinger(canvasElement, ['.timeline-key'])).toEqual([]);
  },
};

/** The head's rows never cross: months, ticks, sprints, then releases, each readable whole. */
export const HeadInRows: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findAllByRole('link', { name: /^[A-Z]+-\d+$/ });
    const boxes = (selector: string) =>
      Array.from(canvasElement.querySelectorAll(selector), (e) => e.getBoundingClientRect());
    const rows = [
      '.timeline-month',
      '.timeline-tick',
      '.timeline-sprint-label',
      '.timeline-release-label',
    ];
    for (const [i, row] of rows.entries()) {
      await expect(boxes(row).length).toBeGreaterThan(0);
      for (const later of rows.slice(i + 1)) {
        for (const a of boxes(row)) {
          for (const b of boxes(later)) await expect(a.bottom).toBeLessThanOrEqual(b.top);
        }
      }
    }
    const scale = canvasElement.querySelector('.timeline-scale')?.getBoundingClientRect();
    if (!scale) throw new Error('the timeline draws its scale');
    for (const box of boxes(rows.at(-1) as string)) {
      await expect(box.bottom).toBeLessThanOrEqual(scale.bottom);
    }
  },
};

/** The fixture with long summaries and a one-day ticket: what cut keys and thin bars came from. */
const crowded = (() => {
  const data = timelineFixture();
  return {
    ...data,
    items: [
      ...data.items.map((i) => ({
        ...i,
        summary: `${i.summary}: add keyboard shortcuts to every list, board and dialog of the app`,
      })),
      {
        ...(data.items[3] as (typeof data.items)[number]),
        id: 7,
        key: 'LCH-7',
        parentId: null,
        summary: 'A one-day task',
        start: '2026-11-05',
        due: '2026-11-05',
      },
    ],
  };
})();

/**
 * ADR-033, TR-21: on a phone's touch screen the key sits over its summary and is one line tall,
 * but a finger anywhere on the name presses it: the press area is the whole name cell, a row
 * (44 px) tall, and the toggle beside it still takes its own presses. This is the nested
 * phone-and-touch block of timeline.css, which only the browser's own touch emulation applies.
 */
export const KeyPressAreaOnAPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  args: { client: fakeTimelineClient({ data: crowded }) },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(window.innerWidth).toBeLessThan(768);
    const keys = await within(canvasElement).findAllByRole('link', { name: /^LCH-\d+$/ });
    const toggled = keys.find((key) => key.closest('.timeline-label')?.querySelector('button'));
    if (!toggled) throw new Error('a row with children has a toggle');
    for (const key of [toggled, keys.at(-1) as HTMLElement]) {
      key.scrollIntoView({ block: 'center' });
      const cell = key.closest('.timeline-label')?.getBoundingClientRect();
      const own = key.getBoundingClientRect();
      if (!cell) throw new Error('a key sits in its name cell');
      // The key's own box is a line of text; its press area is not.
      await expect(own.height).toBeLessThan(44);
      await expect(cell.height).toBeGreaterThanOrEqual(43.5);
      const points = [
        [own.left + 2, cell.top + 2],
        [own.left + 2, cell.bottom - 2],
        [cell.right - 4, cell.top + 2],
        [cell.right - 4, cell.bottom - 2],
      ] as const;
      for (const [x, y] of points) {
        const hit = document.elementFromPoint(x, y)?.closest('.timeline-key');
        await expect({ x, y, key: hit?.textContent }).toEqual({ x, y, key: key.textContent });
      }
    }
    const toggle = toggled.closest('.timeline-label')?.querySelector('button');
    if (!toggle) throw new Error('the row has its toggle');
    const box = toggle.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    await expect(hit?.closest('button')).toBe(toggle);
  },
};

/** TR-9: a long summary is cut, never the key, which reads whole in its column. */
export const KeysNeverCut: Story = {
  args: { client: fakeTimelineClient({ data: crowded }) },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findAllByRole('link', { name: /^LCH-\d+$/ });
    for (const key of canvasElement.querySelectorAll<HTMLElement>('.timeline-key')) {
      await expect(key.scrollWidth).toBeLessThanOrEqual(key.clientWidth);
    }
    const summary = canvasElement.querySelector<HTMLElement>('.timeline-summary');
    await expect(summary?.scrollWidth).toBeGreaterThan(summary?.clientWidth ?? 0);
  },
};

/** TR-9: scrolled sideways, the month's name stays whole beside the ticket column. */
export const MonthStaysInView: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findAllByRole('link', { name: /^LCH-\d+$/ });
    const chart = canvasElement.querySelector<HTMLElement>('.timeline-scroll');
    const corner = canvasElement.querySelector<HTMLElement>('.timeline-corner');
    if (!chart || !corner) throw new Error('the timeline draws its chart');
    // Into the first month's days, past where its name started.
    chart.scrollLeft = 300;
    await waitFor(() => expect(chart.scrollLeft).toBe(300));
    const edge = corner.getBoundingClientRect().right;
    const shown = Array.from(
      canvasElement.querySelectorAll<HTMLElement>('.timeline-month-name'),
      (m) => m.getBoundingClientRect(),
    ).filter((r) => r.right > edge);
    await expect(shown.length).toBeGreaterThan(0);
    for (const r of shown) await expect(r.left).toBeGreaterThanOrEqual(edge - 0.5);
  },
};

/** Whether a surface hides what is behind it: a fill with no transparency. */
const opaque = (element: Element) => {
  const parts = getComputedStyle(element).backgroundColor.match(/[\d.]+/g) ?? [];
  return parts.length === 3 || (parts.length === 4 && Number(parts[3]) === 1);
};

/**
 * TR-9: today's line never runs through a "No dates" chip, nor along its edge: the chip sits a
 * gap after it and above it, so its glass fill has no line of today's behind its words.
 */
export const TodayClearOfNoDates: Story = {
  play: async ({ canvasElement }) => {
    const chip = await within(canvasElement).findByRole('button', {
      name: 'No dates: schedule LCH-6',
    });
    const line = canvasElement.querySelector('.timeline-today')?.getBoundingClientRect();
    if (!line) throw new Error('the timeline marks today');
    const box = chip.getBoundingClientRect();
    await expect(box.left - line.right).toBeGreaterThanOrEqual(3.5);
    await expect(Number(getComputedStyle(chip).zIndex)).toBeGreaterThan(0);
  },
};

/** TR-10: with no side panel open, the chart's card reaches the page's right edge. */
export const ReachesTheEdge: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findAllByRole('link', { name: /^LCH-\d+$/ });
    const body = canvasElement.querySelector('.timeline-body')?.getBoundingClientRect();
    const card = canvasElement.querySelector('.timeline-scroll')?.getBoundingClientRect();
    if (!body || !card) throw new Error('the timeline draws its card');
    await expect(Math.abs(card.right - body.right)).toBeLessThan(1);
  },
};

/**
 * TR-21: on a touch screen a one-day bar still takes a finger: a finger's height, and past its own
 * ends. The grip check cannot see the ends (`DRAGGED_WHOLE` in test/grips.ts), so this story does.
 */
export const ThinBarOnATouchScreen: Story = {
  args: { client: fakeTimelineClient({ data: crowded }) },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const bar = await within(canvasElement).findByRole('button', { name: /^LCH-7: / });
    bar.scrollIntoView({ block: 'center', inline: 'center' });
    const box = bar.getBoundingClientRect();
    await expect(box.width).toBeLessThan(44);
    await expect(box.height).toBeGreaterThanOrEqual(44);
    const y = box.top + box.height / 2;
    for (const x of [box.left - 6, box.right + 6]) {
      await expect(document.elementFromPoint(x, y)?.closest('.timeline-bar')).toBe(bar);
    }
  },
};

/** A narrow chart, about ten days of lanes: from the range's start every bar lies after them. */
const narrow = (Story: () => ReactElement) => (
  <div style={{ width: 640 }}>
    <Story />
  </div>
);

/** Scrolls the chart to its start or its end and waits for that edge's markers. */
const scrolledTo = async (canvasElement: HTMLElement, end: 'start' | 'end') => {
  await within(canvasElement).findAllByRole('link', { name: /^LCH-\d+$/ });
  const chart = canvasElement.querySelector<HTMLElement>('.timeline-scroll');
  if (!chart) throw new Error('the timeline draws its chart');
  chart.scrollLeft = end === 'start' ? 0 : chart.scrollWidth;
  const name = end === 'start' ? /^Later: / : /^Earlier: /;
  const markers = await waitFor(async () => {
    const found = within(canvasElement).getAllByRole('button', { name });
    await expect(found.length).toBeGreaterThan(0);
    return found;
  });
  return { chart, markers };
};

/** PL-6: the Earlier markers sit beside the ticket column, the Later ones at the card's right. */
export const EdgeMarkersAtTheEdges: Story = {
  decorators: [narrow],
  play: async ({ canvasElement }) => {
    const { chart, markers: earlier } = await scrolledTo(canvasElement, 'end');
    const corner = canvasElement.querySelector('.timeline-corner')?.getBoundingClientRect();
    if (!corner) throw new Error('the timeline draws its ticket column');
    for (const marker of earlier) {
      const box = marker.getBoundingClientRect();
      await expect(box.left).toBeGreaterThanOrEqual(corner.right);
      await expect(box.left).toBeLessThan(corner.right + 12);
    }
    const { markers: later } = await scrolledTo(canvasElement, 'start');
    const card = chart.getBoundingClientRect();
    const right = card.left + chart.clientLeft + chart.clientWidth;
    for (const marker of later) {
      const box = marker.getBoundingClientRect();
      await expect(box.right).toBeLessThanOrEqual(right + 0.5);
      await expect(box.right).toBeGreaterThan(right - 12);
    }
  },
};

/**
 * TR-9, PL-6: today's line may fall anywhere under an Earlier or Later marker (on a phone it ran
 * through every "Earlier"), so each marker lies above the lines and hides them behind its words.
 */
export const EdgeMarkersHideTodaysLine: Story = {
  decorators: [narrow],
  play: async ({ canvasElement }) => {
    const { markers } = await scrolledTo(canvasElement, 'end');
    for (const marker of markers) {
      await expect(opaque(marker)).toBe(true);
      await expect(Number(getComputedStyle(marker).zIndex)).toBeGreaterThan(0);
    }
  },
};

/** The fixture and a ticket done in early October: with today's line in view, its row has an Earlier marker. */
const doneInOctober = (() => {
  const data = timelineFixture();
  return {
    ...data,
    items: [
      ...data.items,
      {
        ...(data.items[5] as (typeof data.items)[number]),
        id: 8,
        key: 'LCH-8',
        summary: 'Pick the caterer',
        status: { name: 'Closed', stage: 'closed' as const },
        start: '2026-10-01',
        due: '2026-10-09',
        dated: 'own' as const,
      },
    ],
  };
})();

/**
 * Scrolls the chart until today's line runs through the words of LCH-8's Earlier marker, beside
 * the ticket column, then checks that the marker is what shows there: an opaque fill, drawn over
 * the line. The lanes take no pointer, so for the look they are let take one, and the browser
 * names what it draws on top where the two cross.
 */
async function earlierMarkerOverTodaysLine(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await canvas.findAllByRole('link', { name: /^LCH-\d+$/ });
  const chart = canvasElement.querySelector<HTMLElement>('.timeline-scroll');
  const corner = canvasElement.querySelector<HTMLElement>('.timeline-corner');
  const lanes = canvasElement.querySelector<HTMLElement>('.timeline-lanes');
  const line = canvasElement.querySelector<HTMLElement>('.timeline-today');
  if (!chart || !corner || !lanes || !line)
    throw new Error('the timeline draws today in its lanes');
  const into = corner.getBoundingClientRect().right + 30;
  chart.scrollLeft += line.getBoundingClientRect().left - into;
  const marker = await canvas.findByRole('button', { name: /^Earlier: LCH-8 ends/ });
  // In the window, where the browser can say what it draws.
  marker.scrollIntoView({ block: 'center', inline: 'nearest' });
  const box = marker.getBoundingClientRect();
  const at = line.getBoundingClientRect();
  const x = at.left + at.width / 2;
  // A real crossing: the line runs through the marker, not beside it.
  await expect({ left: box.left < x, right: x < box.right }).toEqual({ left: true, right: true });
  await expect(opaque(marker)).toBe(true);
  lanes.style.pointerEvents = 'auto';
  try {
    const top = document.elementFromPoint(x, box.top + box.height / 2);
    await expect(top?.closest('.timeline-edge')).toBe(marker);
  } finally {
    lanes.style.pointerEvents = '';
  }
}

/**
 * AGL-015, PL-6: today's line falls under an Earlier marker beside the ticket column and runs
 * behind its words, at a desktop's width (T-274: Plans' fix, kept by every timeline).
 */
export const TodaysLineUnderEarlier: Story = {
  args: { client: fakeTimelineClient({ data: doneInOctober }) },
  decorators: [narrow],
  play: ({ canvasElement }) => earlierMarkerOverTodaysLine(canvasElement),
};

/** AGL-015, PL-6, ADR-033: the same on a phone's touch screen, where the marker is a finger tall. */
export const TodaysLineUnderEarlierOnAPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  args: { client: fakeTimelineClient({ data: doneInOctober }) },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(window.innerWidth).toBeLessThan(768);
    await earlierMarkerOverTodaysLine(canvasElement);
  },
};

/** ADR-033: on a touch screen the Earlier and Later markers take a finger. */
export const EdgeMarkersOnATouchScreen: Story = {
  decorators: [narrow],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await scrolledTo(canvasElement, 'end');
    await expect(tooSmallForAFinger(canvasElement, ['.timeline-edge'])).toEqual([]);
    await scrolledTo(canvasElement, 'start');
    await expect(tooSmallForAFinger(canvasElement, ['.timeline-edge'])).toEqual([]);
  },
};

/**
 * PLN-012: rows waiting below fade out at the foot of the rows in view, not over the card's own
 * scrollbar: the card is not masked, and the fade stays inside its scrollport, scrolled sideways too.
 */
export const FadeLeavesTheScrollbar: Story = {
  args: { client: fakeTimelineClient({ data: manyItems(60) }) },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findAllByRole('link', { name: /^LCH-\d+$/ });
    const chart = canvasElement.querySelector<HTMLElement>('.timeline-scroll');
    if (!chart) throw new Error('the timeline draws its chart');
    chart.scrollLeft = 300;
    const fade = await waitFor(() => {
      const found = chart.querySelector<HTMLElement>('.timeline-fade');
      if (!found) throw new Error('rows wait below, so the chart fades');
      return found;
    });
    await waitFor(() => expect(chart.scrollLeft).toBe(300));
    const style = getComputedStyle(chart);
    await expect(style.maskImage === '' || style.maskImage === 'none').toBe(true);
    const card = chart.getBoundingClientRect();
    const port = {
      left: card.left + chart.clientLeft,
      bottom: card.top + chart.clientTop + chart.clientHeight,
    };
    const box = fade.getBoundingClientRect();
    await expect(Math.abs(box.bottom - port.bottom)).toBeLessThan(1);
    await expect(Math.abs(box.left - port.left)).toBeLessThan(1);
    await expect(box.right).toBeLessThanOrEqual(port.left + chart.clientWidth + 0.5);
  },
};
