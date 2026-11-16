import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { StageProgress } from './StageProgress';

const counted = (stage: string, count: number, exact = true) => ({
  query: `crossTrackRelease = 5 AND stage = ${stage}`,
  count,
  exact,
});

const meta = {
  title: 'Releases/StageProgress',
  component: StageProgress,
  args: {
    stages: { new: counted('new', 4), active: counted('active', 2), closed: counted('closed', 6) },
  },
} satisfies Meta<typeof StageProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One bar and a legend, each number opening the search that finds those tickets. */
export const SomeOfEach: Story = {
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole('link', { name: /Active/ });
    await expect(link.getAttribute('href')).toContain('stage');
  },
};

/** Nothing to count: an empty bar, and the numbers still say so. */
export const Empty: Story = {
  args: {
    stages: { new: counted('new', 0), active: counted('active', 0), closed: counted('closed', 0) },
  },
};

/** A count stopped at its limit reads as "at least". */
export const AtLeast: Story = {
  args: {
    stages: {
      new: counted('new', 10000, false),
      active: counted('active', 2),
      closed: counted('closed', 6),
    },
  },
};

/** A finger reaches each number (ADR-033). */
export const OnATouchScreen: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(tooSmallForAFinger(canvasElement, ['.release-legend a'])).toEqual([]);
  },
};
