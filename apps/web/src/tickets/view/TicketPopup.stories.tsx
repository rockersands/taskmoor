import type { Meta, StoryObj } from '@storybook/react-vite';
import { writeDocToYDoc } from '@taskmoor/richtext';
import { expect, userEvent, within } from 'storybook/test';
import * as Y from 'yjs';
import { MEMBER } from '../../admin/fixtures';
import { fakeAttachmentClient } from '../../attachments/fixtures';
import { fakeCommentClient } from '../../comments/fixtures';
import type { Connect } from '../../richtext/CollaborativeEditor';
import { openOverlay } from '../../routing/router';
import { SessionProvider } from '../../session/SessionProvider';
import { fakeCloneClient } from '../clone/fixtures';
import type { TicketDetails } from './client';
import { fakeTicketClient, SHOP_41 } from './fixtures';
import { TicketPopup } from './TicketPopup';

const inPage: Connect = (_name, onStatus) => {
  const document = new Y.Doc();
  if (SHOP_41.description) writeDocToYDoc(document, SHOP_41.description);
  queueMicrotask(() => onStatus('live'));
  return { document, provider: null, destroy: () => document.destroy() };
};

const NAME = 'SHOP-41 Checkout fails for expired cards';

const meta = {
  title: 'Tickets/TicketPopup',
  component: TicketPopup,
  args: {
    client: fakeTicketClient(),
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
          <h1 className="page-title">The page beneath</h1>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
  // The pop-up reads its ticket from the address, and goes when the entry does.
  beforeEach: () => {
    const before = window.location.href;
    window.history.replaceState(null, '', before);
    openOverlay('#/tickets/SHOP-41');
    return () => window.history.replaceState(null, '', before);
  },
} satisfies Meta<typeof TicketPopup>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Over the page: the same view as the ticket page, with a bar to leave by. */
export const OverThePage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole('dialog', { name: NAME });
    await expect(dialog).toBeVisible();
    await expect(await within(dialog).findByRole('button', { name: 'Follow (2)' })).toBeVisible();
    await expect(within(dialog).getByRole('link', { name: 'Open full page' })).toBeVisible();
  },
};

/** The frame at once, while the ticket is on its way. */
export const Loading: Story = {
  args: {
    client: { ...fakeTicketClient(), get: () => new Promise<TicketDetails>(() => {}) },
  },
  play: async ({ canvasElement }) => {
    const dialog = await within(canvasElement).findByRole('dialog', { name: 'SHOP-41' });
    await expect(within(dialog).getByRole('status')).toBeVisible();
  },
};

/** Unsaved text stops a click outside and asks first. */
export const AskingAboutADraft: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole('dialog', { name: NAME });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Edit labels' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Labels' }), ' typed');
    await userEvent.click(canvas.getByRole('button', { name: 'Close this ticket' }));
    await expect(
      await canvas.findByRole('alertdialog', { name: 'Discard what you have not saved?' }),
    ).toBeVisible();
  },
};

/** A phone: a full-screen sheet. */
export const OnAPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('dialog', { name: NAME })).toBeVisible();
  },
};
