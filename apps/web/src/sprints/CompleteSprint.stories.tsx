import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { CompleteSprintDialog } from './CompleteSprint';
import type { Sprint } from './client';

const sprint = (id: number, name: string, state: Sprint['state']): Sprint => ({
  id,
  boardId: 7,
  name,
  goal: '',
  state,
  sequence: id,
  startAt: null,
  endAt: null,
  startedAt: null,
  completedAt: null,
  version: 1,
});

const meta = {
  title: 'Sprints/CompleteSprintDialog',
  component: CompleteSprintDialog,
  args: {
    sprint: sprint(11, 'Checkout Sprint 1', 'active'),
    futures: [sprint(12, 'Checkout Sprint 2', 'future')],
    counts: { done: 3, open: 2 },
    client: { complete: async () => {} },
    onCompleted: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof CompleteSprintDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three tickets done and two open; the open ones go to the backlog unless chosen otherwise. */
export const Counted: Story = {
  play: async () => {
    // The dialog is drawn at the end of the page's body (shell/OverlayLayer.tsx).
    const canvas = within(document.body);
    await expect(canvas.getByText('3 tickets are done and 2 are open.')).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: 'Open tickets go to' })).toHaveValue(
      'backlog',
    );
  },
};

/** Every ticket is done: nothing to move, so no choice. */
export const AllDone: Story = {
  args: { counts: { done: 4, open: 0 } },
  play: async () => {
    // The dialog is drawn at the end of the page's body (shell/OverlayLayer.tsx).
    const canvas = within(document.body);
    await expect(canvas.getByText('All 4 tickets are done, so nothing moves.')).toBeVisible();
    await expect(canvas.queryByRole('combobox')).toBeNull();
  },
};

/** The server refused: the reason in plain words, and Complete can be pressed again. */
export const Refused: Story = {
  args: {
    client: {
      complete: async () => {
        throw new ApiError(403, { error: 'forbidden', permission: 'manage_sprints' });
      },
    },
  },
  play: async ({ args }) => {
    // The dialog is drawn at the end of the page's body (shell/OverlayLayer.tsx).
    const canvas = within(document.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Complete sprint' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'Only people who manage this board’s sprints can complete them.',
    );
    await expect(args.onCompleted).not.toHaveBeenCalled();
  },
};
