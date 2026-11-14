import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { CloneDialog } from './CloneDialog';
import { copied, FORBIDDEN, fakeCloneClient, OUTCOME, SUBTICKET } from './fixtures';

const meta = {
  title: 'Tickets/CloneDialog',
  component: CloneDialog,
  args: {
    ticket: OUTCOME,
    client: fakeCloneClient().client,
    onClose: () => {},
    onCloned: () => {},
    pollMs: 10,
  },
} satisfies Meta<typeof CloneDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An outcome: its subtickets, attachments and links ticked, and a deep clone on offer. */
export const Outcome: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(await canvas.findByRole('dialog', { name: 'Clone SHOP-7' })).toBeVisible();
    await expect(canvas.getByLabelText('Summary of the copy')).toHaveValue('Checkout in one step');
    await expect(canvas.getByLabelText('Subtickets')).toBeChecked();
    await expect(
      canvas.getByLabelText('Everything below it, at every level (deep clone)'),
    ).not.toBeChecked();
  },
};

/** A subticket stays in its track. */
export const Subticket: Story = {
  args: { ticket: SUBTICKET },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(await canvas.findByRole('combobox', { name: 'Track' })).toBeDisabled();
    await expect(canvas.queryByLabelText('Subtickets')).toBeNull();
  },
};

/** Copying into another track, part way through. */
export const Copying: Story = {
  args: { client: fakeCloneClient({ total: 12, step: 0 }).client, pollMs: 60_000 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const track = await canvas.findByRole('combobox', { name: 'Track' });
    await waitFor(() => expect(track).toBeEnabled());
    await userEvent.click(track);
    await userEvent.click(canvas.getByRole('option', { name: 'PAY: Payments' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Clone' }));
    await expect(await canvas.findByText('Copying…')).toBeVisible();
    await expect(canvas.getByLabelText('0 of 12 tickets finished')).toBeVisible();
  },
};

/** Done, with tickets not copied and values the copy is without. */
export const PartlyCopied: Story = {
  args: {
    client: fakeCloneClient({ total: 5, failed: 2, first: copied(['assigneeId', 'fields.12']) })
      .client,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Clone' }));
    await expect(await canvas.findByText('Copied 3 of 5 tickets.')).toBeVisible();
    await expect(await canvas.findByRole('link', { name: 'Open PAY-40' })).toBeVisible();
  },
};

/** The track refuses: the person may not create tickets there. */
export const Refused: Story = {
  args: { client: fakeCloneClient({ refuse: FORBIDDEN }).client },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Clone' }));
    await expect(
      await canvas.findByText('You may not create tickets in that track.'),
    ).toBeVisible();
  },
};
