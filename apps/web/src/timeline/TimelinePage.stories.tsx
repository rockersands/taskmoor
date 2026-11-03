import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { expectWithinBudget } from '../test/budget';
import { fakeTimelineClient, manyItems } from './fixtures';
import { TimelinePage } from './TimelinePage';

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
    await expect(await canvas.findByRole('heading', { name: 'Timeline of Launch' })).toBeVisible();
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
