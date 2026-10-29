import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CommentsPanel } from './CommentsPanel';
import { COMMENTS, fakeCommentClient, STATUS_LOCK } from './fixtures';

const meta = {
  title: 'Tickets/CommentsPanel',
  component: CommentsPanel,
  args: { ticket: 41, ticketKey: 'SHOP-41', client: fakeCommentClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 960 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof CommentsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A discussion: a mention, reactions, an edited comment and one kept to Administrators. */
export const Discussion: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText('Only the Administrators role can see this')).toBeVisible();
    expect(canvas.getByText(/^Edited /)).toBeVisible();
    expect(canvas.getByRole('button', { name: '👍: 2 reactions, yours included' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  },
};

export const NoComments: Story = {
  args: { client: fakeCommentClient({ comments: [] }) },
};

/** Writing one: the editor, whom it is for, and the button. */
export const Writing: Story = {
  args: { client: fakeCommentClient({ comments: COMMENTS.slice(0, 1) }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const select = await canvas.findByRole('combobox', { name: 'Who can see it' });
    await userEvent.selectOptions(select, 'role:7');
    expect(select).toHaveValue('role:7');
  },
};

/** Reacting: the picker open on the first comment. */
export const Reacting: Story = {
  args: { client: fakeCommentClient({ comments: COMMENTS.slice(0, 1) }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Add a reaction' }));
    expect(canvas.getByRole('button', { name: 'React with 🎉' })).toBeVisible();
  },
};

/** In a status that reserves commenting to Administrators (WF-007): the panel says why. */
export const LockedByStatus: Story = {
  args: {
    client: fakeCommentClient({
      comments: COMMENTS.map((c) => ({ ...c, can: { edit: false, delete: false } })),
      can: { add: false, react: true },
      lock: STATUS_LOCK,
    }),
  },
};

/** Read only: someone who may read but not comment. */
export const ReadOnly: Story = {
  args: {
    client: fakeCommentClient({
      comments: COMMENTS.map((c) => ({ ...c, can: { edit: false, delete: false } })),
      can: { add: false, react: false },
    }),
  },
};
