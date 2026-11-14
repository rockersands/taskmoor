import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { Status } from './definition';
import { fakeWorkflowsClient, STATUSES } from './fixtures';
import { StatusesSection } from './StatusesSection';

/** The section with its own list, as the Workflows page holds it. */
function Holder({ initial, failed = false }: { initial: Status[] | null; failed?: boolean }) {
  const [statuses, setStatuses] = useState(initial);
  return (
    <StatusesSection
      statuses={statuses}
      failed={failed}
      client={fakeWorkflowsClient({ statuses: initial ?? [] })}
      onChanged={setStatuses}
      refuse={() => false}
    />
  );
}

const meta = {
  title: 'Workflows/StatusesSection',
  component: Holder,
  args: { initial: STATUSES },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 900 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Holder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Statuses: Story = {};

/**
 * The rows' buttons stand in columns: the first status has no Up and the last no Down, and their
 * places stay, so every Edit and every Delete starts at the same x.
 */
export const ButtonsInColumns: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const left = (name: RegExp) =>
      new Set(canvas.getAllByRole('button', { name }).map((b) => b.getBoundingClientRect().left));
    await expect(canvas.queryAllByRole('button', { name: /^Move .* up$/ }).length).toBe(
      STATUSES.length - 1,
    );
    await expect(left(/^Edit /).size).toBe(1);
    await expect(left(/^Delete /).size).toBe(1);
  },
};

export const Loading: Story = { args: { initial: null } };

export const Failed: Story = { args: { initial: null, failed: true } };

export const AddingAStatus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'New status' }));
    await userEvent.keyboard('Waiting for parts');
    await userEvent.click(canvas.getByRole('radio', { name: 'New' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Add status' }));
    await expect(await canvas.findByText('Added Waiting for parts.')).toBeVisible();
  },
};

export const EditingAStatus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit Active' }));
    await expect(canvas.getByRole('form', { name: 'Edit Active' })).toBeVisible();
  },
};
