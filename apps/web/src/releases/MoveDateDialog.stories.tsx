import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { fakeCrossTrackClient } from './crossTrackFixtures';
import { MoveDateDialog } from './MoveDateDialog';

const meta = {
  title: 'Releases/MoveDateDialog',
  component: MoveDateDialog,
  args: {
    id: 5,
    name: 'Spring launch',
    date: '2026-12-01',
    client: fakeCrossTrackClient(),
    onMoved: () => {},
    onClose: () => {},
  },
} satisfies Meta<typeof MoveDateDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const listChanges = async () => {
  const dialog = await within(document.body).findByRole('dialog');
  const day = within(dialog).getByLabelText('New date');
  await userEvent.clear(day);
  await userEvent.type(day, '2026-12-20');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Show what changes' }));
  await within(dialog).findByRole('button', { name: 'Move 1 release' });
  return dialog;
};

/** The day, before anything is listed. */
export const Asking: Story = {};

/** What a move would do: one moves, one stays and reads out of step, one is only counted. */
export const ChangeList: Story = {
  play: async () => {
    const dialog = await listChanges();
    await expect(within(dialog).getByText(/you do not administer its track/)).toBeVisible();
  },
};

/** After the move: it stays open with what happened, and its heading has the focus. */
export const Moved: Story = {
  play: async () => {
    const dialog = await listChanges();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move 1 release' }));
    const heading = await within(dialog).findByRole('heading', { name: /now ends on/ });
    await expect(heading).toHaveFocus();
  },
};

/** All shipped: its date no longer moves. */
export const AlreadyShipped: Story = {
  args: { client: fakeCrossTrackClient({ shipped: true }) },
  play: async () => {
    const dialog = await within(document.body).findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Show what changes' }));
    await expect(await within(dialog).findByRole('alert')).toBeVisible();
  },
};
