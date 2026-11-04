import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { PlanningPanels } from './PlanningPanels';

const meta = {
  title: 'Sprints/PlanningPanels',
  component: PlanningPanels,
  args: {
    panels: {
      outcomes: [
        {
          id: 40,
          key: 'CHK-40',
          summary: 'Faster checkout',
          status: 'Active',
          tickets: 6,
          closed: 2,
        },
        { id: 41, key: 'CHK-41', summary: 'Wallets', status: 'New', tickets: 0, closed: 0 },
      ],
      releases: [
        { id: 50, name: 'Checkout 2.0', trackId: 1, releaseDate: '2026-12-01', tickets: 4 },
        { id: 51, name: 'Checkout 2.1', trackId: 1, releaseDate: null, tickets: 1 },
      ],
    },
    failed: false,
    filter: { kind: 'release', id: 50 },
    onFilter: fn(),
    over: null,
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 320 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof PlanningPanels>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Outcomes and releases with their counts; the backlog is filtered by a release. */
export const Panels: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: /Checkout 2\.0/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(canvas.getByRole('button', { name: /Faster checkout/ })).toHaveTextContent(
      '6 tickets, 2 closed',
    );
  },
};

/** Tickets dragged over an outcome: the place they would go is outlined (T-162). */
export const DropOver: Story = {
  args: { over: { kind: 'outcome', id: 41 }, filter: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('button', { name: /Wallets/ }).closest('li')?.className ?? '',
    ).toContain('is-drop-target');
  },
};

/** Nothing to plan against yet. */
export const Empty: Story = {
  args: { panels: { outcomes: [], releases: [] }, filter: null },
};

/** The panels could not be read. */
export const Failed: Story = {
  args: { panels: null, failed: true, filter: null },
};
