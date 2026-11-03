import type { Meta, StoryObj } from '@storybook/react-vite';
import { writeDocToYDoc } from '@taskmoor/richtext';
import { expect, userEvent, within } from 'storybook/test';
import * as Y from 'yjs';
import { MEMBER } from '../../admin/fixtures';
import { fakeAttachmentClient } from '../../attachments/fixtures';
import { fakeCommentClient } from '../../comments/fixtures';
import type { Connect } from '../../richtext/CollaborativeEditor';
import { SessionProvider } from '../../session/SessionProvider';
import { fakeCloneClient } from '../clone/fixtures';
import { fakeToolsClient } from '../tools/fixtures';
import { fakeTicketClient, SHOP_41 } from './fixtures';
import { TicketPage } from './TicketPage';

/** The description's shared document, kept in the page. */
const inPage: Connect = (_name, onStatus) => {
  const document = new Y.Doc();
  if (SHOP_41.description) writeDocToYDoc(document, SHOP_41.description);
  queueMicrotask(() => onStatus('live'));
  return { document, provider: null, destroy: () => document.destroy() };
};

const meta = {
  title: 'Tickets/TicketPage',
  component: TicketPage,
  args: {
    ticket: 'SHOP-41',
    client: fakeTicketClient(),
    tools: fakeToolsClient(),
    comments: fakeCommentClient(),
    attachments: fakeAttachmentClient(),
    clone: fakeCloneClient().client,
    connect: inPage,
    mentions: () => async () => [],
  },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof TicketPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A ticket in progress: details, transitions, links, files, the comments. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', {
        level: 1,
        name: 'SHOP-41 Checkout fails for expired cards',
      }),
    ).toBeVisible();
    await expect(await canvas.findByRole('button', { name: 'Follow (2)' })).toBeVisible();
  },
};

/** The History tab of the activity. */
export const History: Story = {
  args: { client: fakeTicketClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('tab', { name: 'History' }));
    await expect(await canvas.findByText('Changed Status from New to Active')).toBeVisible();
  },
};

/** Closing asks for a close reason. */
export const Closing: Story = {
  args: { client: fakeTicketClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Close, to Closed' }));
    await expect(canvas.getByRole('combobox', { name: 'Close reason' })).toBeVisible();
  },
};

/** The keyboard shortcuts, open. */
export const Shortcuts: Story = {
  args: { client: fakeTicketClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Keyboard shortcuts' }));
    await expect(canvas.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  },
};

export const NotFound: Story = {
  args: { client: fakeTicketClient({ missing: true }) },
};
