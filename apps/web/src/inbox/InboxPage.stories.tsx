import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ALERT_ITEM, CHECKLIST_ITEM, fakeInboxClient, GROUP_ITEM, ITEMS, NOW } from './fixtures';
import { InboxPage } from './InboxPage';

const meta = {
  title: 'Notifications/InboxPage',
  component: InboxPage,
  args: { client: fakeInboxClient(), now: () => NOW },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof InboxPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Mentions and changes, newest first; unread ones stand out. */
export const Inbox: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Ana Ruiz mentioned you in a comment')).toBeVisible();
    await expect(canvas.getByText('3 unread')).toBeVisible();
  },
};

/** Only direct asks: mentions and tickets assigned to the reader. */
export const Priority: Story = {
  args: { client: fakeInboxClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /^Priority/ }));
    await expect(await canvas.findByText('Mi Rivera assigned it to you')).toBeVisible();
    await expect(canvas.queryByText('Jo Park: Comment added')).toBeNull();
  },
};

/** The snooze choices of one item, open. */
export const Snooze: Story = {
  args: { client: fakeInboxClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Snooze SHOP-19' }));
    await expect(canvas.getByRole('button', { name: 'Until tomorrow' })).toBeVisible();
  },
};

export const Empty: Story = {
  args: { client: fakeInboxClient([]) },
};

/** All read: nothing stands out, and there is nothing to mark. */
export const AllRead: Story = {
  args: { client: fakeInboxClient(ITEMS.map((i) => ({ ...i, read: true }))) },
};

/** A security alert to a site administrator (ADR-109): about no ticket, leading to the audit log. */
export const SecurityAlert: Story = {
  args: { client: fakeInboxClient([ALERT_ITEM, ...ITEMS]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Failed sign-ins for one account: 10 in 60 minutes'),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: /Kalo Smith/ })).toHaveAttribute(
      'href',
      expect.stringContaining('admin/audit'),
    );
  },
};

/** A track group shared with the reader (T-206): who shared it and the role, never its tracks. */
export const GroupShared: Story = {
  args: { client: fakeInboxClient([GROUP_ITEM, ...ITEMS]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Ana Ruiz shared a track group with you, with the role Members'),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Quarter plan' })).toHaveAttribute(
      'href',
      expect.stringContaining('tracks'),
    );
  },
};

/** A run of checklist changes as one item (NTF-015): who and how many, never what items say. */
export const ChecklistChanged: Story = {
  args: {
    client: fakeInboxClient([
      CHECKLIST_ITEM,
      { ...CHECKLIST_ITEM, id: '21', checklist: { changes: 3, others: 1 }, read: true },
      ...ITEMS,
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Mi Rivera made 5 changes to checklists')).toBeVisible();
    await expect(
      canvas.getByText('Mi Rivera and 1 more made 3 changes to checklists'),
    ).toBeVisible();
  },
};
