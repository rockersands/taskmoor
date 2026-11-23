import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { BaselineCompare } from './BaselineCompare';
import { fakeBaselineClient } from './baselineFixtures';

/** "Kick-off" against the days now (PLN-011; ADR-122 stage 9). */
const meta = {
  title: 'Plans/BaselineCompare',
  component: BaselineCompare,
  args: {
    planId: 12,
    planName: 'Spring launch',
    client: fakeBaselineClient({ notShown: 4 }),
    baseline: {
      id: 1,
      name: 'Kick-off',
      source: 'live',
      scenarioName: null,
      tickets: 6,
      createdAt: '2026-11-01T09:00:00Z',
      createdBy: { id: 7, name: 'Ana Ruiz' },
      version: 1,
    },
    filters: {},
    closeHref: '#/plans/12/baselines',
  },
} satisfies Meta<typeof BaselineCompare>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The sentence first, then the tickets that end later, largest delay first. */
export const Later: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/4 tickets in this baseline are not shown to you\.$/),
    ).toBeVisible();
    await expect(canvas.getByText('14 days later: due Dec 4, was Nov 20')).toBeVisible();
  },
};

/** Every ticket, closed ones marked. */
export const All: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'All' }));
    await expect(await canvas.findByRole('list', { name: 'Tickets: All' })).toBeVisible();
    await expect(canvas.getByText(/\(closed\)$/)).toBeVisible();
  },
};

/** A page at a time. */
export const Paged: Story = {
  args: { client: fakeBaselineClient({ page: 2 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Show more' })).toBeVisible();
  },
};
