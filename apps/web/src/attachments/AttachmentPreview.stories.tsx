import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AttachmentPreview } from './AttachmentPreview';
import { ATTACHMENTS, fakeAttachmentClient } from './fixtures';

const pick = (id: number) => ATTACHMENTS.find((a) => a.id === id) as (typeof ATTACHMENTS)[number];

const meta = {
  title: 'Tickets/AttachmentPreview',
  component: AttachmentPreview,
  args: { attachment: pick(11), client: fakeAttachmentClient(), onClose: () => {} },
} satisfies Meta<typeof AttachmentPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Image: Story = {};

export const Text: Story = {
  args: { attachment: pick(13) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(await canvas.findByText(/payment declined: card expired/)).toBeVisible();
  },
};

export const ZipContents: Story = {
  args: { attachment: pick(14) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(
      await canvas.findByRole('link', { name: 'Download dumps/README.txt' }),
    ).toBeVisible();
    await expect(canvas.getByText(/Unusual path/)).toBeVisible();
  },
};

export const PreviewFailed: Story = {
  args: {
    attachment: pick(13),
    client: fakeAttachmentClient(
      {},
      {
        text: async () => {
          throw new Error('offline');
        },
      },
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'The preview could not be loaded.',
    );
  },
};
