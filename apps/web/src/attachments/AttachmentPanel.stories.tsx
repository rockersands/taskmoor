import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { AttachmentPanel } from './AttachmentPanel';
import { ATTACHMENTS, fakeAttachmentClient } from './fixtures';

const meta = {
  title: 'Tickets/AttachmentPanel',
  component: AttachmentPanel,
  args: { ticket: 'SHOP-41', client: fakeAttachmentClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 960 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof AttachmentPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A member's view: pictures, documents, a ZIP, one file being scanned and one blocked. */
export const WithFiles: Story = {};

export const ReadOnly: Story = {
  args: {
    client: fakeAttachmentClient({
      canCreate: false,
      attachments: ATTACHMENTS.map((a) => ({ ...a, canDelete: false })),
    }),
  },
};

export const Empty: Story = {
  args: { client: fakeAttachmentClient({ attachments: [] }) },
};

export const StorageNotConfigured: Story = {
  args: {
    client: fakeAttachmentClient({ attachments: [], canCreate: false, available: false }),
  },
};

export const Uploaded: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const file = new File(['release notes'], 'release-notes.txt', { type: 'text/plain' });
    await userEvent.upload(await canvas.findByLabelText('Attach files'), file);
    await expect(await canvas.findByText('release-notes.txt attached.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Download release-notes.txt' })).toBeVisible();
  },
};

export const TooLarge: Story = {
  args: { client: fakeAttachmentClient({ maxFileSize: 8 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const file = new File(['more than eight bytes'], 'big.iso', { type: 'application/x-iso' });
    await userEvent.upload(await canvas.findByLabelText('Attach files'), file);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'big.iso is larger than the 8 B limit for one file.',
    );
  },
};

export const UploadRefused: Story = {
  args: {
    client: fakeAttachmentClient(
      {},
      {
        upload: async () => {
          throw new ApiError(500, { error: 'storage_failed' });
        },
      },
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    await userEvent.upload(await canvas.findByLabelText('Attach files'), file);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'notes.txt could not be attached.',
    );
  },
};

export const ConfirmDelete: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete server.log' }));
    await expect(canvas.getByText('Delete server.log for good?')).toBeVisible();
  },
};

export const PhoneWidth: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 360 }}>
        <Story />
      </div>
    ),
  ],
};
