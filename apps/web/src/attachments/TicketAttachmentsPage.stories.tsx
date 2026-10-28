import type { Meta, StoryObj } from '@storybook/react-vite';
import { fromMarkdown, writeDocToYDoc } from '@taskmoor/richtext';
import { expect, within } from 'storybook/test';
import * as Y from 'yjs';
import type { Connect } from '../richtext/CollaborativeEditor';
import { fakeAttachmentClient } from './fixtures';
import { TicketAttachmentsPage } from './TicketAttachmentsPage';

const DESCRIPTION = fromMarkdown('Paying with an **expired card** shows no message.\n');

/** The description's shared document, kept in the page. */
const inPage: Connect = (_name, onStatus) => {
  const document = new Y.Doc();
  writeDocToYDoc(document, DESCRIPTION);
  queueMicrotask(() => onStatus('live'));
  return { document, provider: null, destroy: () => document.destroy() };
};

const meta = {
  title: 'Tickets/TicketAttachmentsPage',
  component: TicketAttachmentsPage,
  args: {
    ticket: 'SHOP-41',
    load: async () => ({
      id: 41,
      key: 'SHOP-41',
      summary: 'Checkout fails for expired cards',
      description: DESCRIPTION,
    }),
    client: fakeAttachmentClient(),
    connect: inPage,
    mentions: () => async () => [],
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof TicketAttachmentsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', {
        level: 1,
        name: 'SHOP-41 Checkout fails for expired cards',
      }),
    ).toBeVisible();
  },
};

export const NotFound: Story = {
  args: {
    load: async () => {
      throw new Error('not found');
    },
  },
};
