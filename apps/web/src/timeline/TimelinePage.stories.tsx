import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import { expectWithinBudget } from '../test/budget';
import { asOnATouchScreen, tooSmallForAFinger } from '../test/touch';
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
  beforeEach: asOnATouchScreen,
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

/** TR-9: today's line passes under a "No dates" chip, which is opaque over it. */
export const TodayUnderNoDates: Story = {
  play: async ({ canvasElement }) => {
    const chip = await within(canvasElement).findByRole('button', {
      name: 'No dates: schedule LCH-6',
    });
    const style = getComputedStyle(chip);
    await expect(Number(style.zIndex)).toBeGreaterThan(0);
    const probe = document.createElement('canvas').getContext('2d');
    if (!probe) throw new Error('a canvas to read the colour');
    probe.fillStyle = style.backgroundColor;
    probe.fillRect(0, 0, 1, 1);
    await expect(probe.getImageData(0, 0, 1, 1).data[3]).toBe(255);
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

/** TR-21: on a touch screen a one-day bar still takes a finger, past its own ends. */
export const ThinBarOnATouchScreen: Story = {
  args: { client: fakeTimelineClient({ data: crowded }) },
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    const bar = await within(canvasElement).findByRole('button', { name: /^LCH-7: / });
    bar.scrollIntoView({ block: 'center', inline: 'center' });
    const box = bar.getBoundingClientRect();
    await expect(box.width).toBeLessThan(44);
    const y = box.top + box.height / 2;
    for (const x of [box.left - 6, box.right + 6]) {
      await expect(document.elementFromPoint(x, y)?.closest('.timeline-bar')).toBe(bar);
    }
  },
};
