import type { Meta, StoryObj } from '@storybook/react-vite';
import { fromMarkdown, writeDocToYDoc } from '@taskmoor/richtext';
import { expect, within } from 'storybook/test';
import * as Y from 'yjs';
import { CollaborativeEditor, type CollabStatus, type Connect } from './CollaborativeEditor';

const TEXT = fromMarkdown(
  '## Steps\n\n1. Open the cart\n2. Pay with an expired card\n\nThe page says **nothing**.\n',
);

/** A shared document kept in the page, answering as the server would. */
function inPage(status: CollabStatus): Connect {
  return (_name, onStatus) => {
    const document = new Y.Doc();
    writeDocToYDoc(document, TEXT);
    queueMicrotask(() => onStatus(status));
    return { document, provider: null, destroy: () => document.destroy() };
  };
}

const live = inPage('live');
const refused = inPage('refused');
const offline = inPage('offline');
const connecting: Connect = () => ({ document: new Y.Doc(), provider: null, destroy: () => {} });

const meta = {
  title: 'Rich text/CollaborativeEditor',
  component: CollaborativeEditor,
  args: {
    ticketId: 41,
    field: 'description',
    labelledBy: 'story-label',
    fallback: TEXT,
    user: { id: 3, name: 'Kalo Smith' },
    connect: live,
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <h2 id="story-label" className="facts-title">
          Description
        </h2>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof CollaborativeEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Live: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Changes are saved as you type.')).toBeVisible();
    await expect(canvas.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
  },
};

export const Connecting: Story = { args: { connect: connecting } };

export const Offline: Story = { args: { connect: offline } };

/** Someone who may read but not edit the text (the server refused them). */
export const ReadOnly: Story = {
  args: { connect: refused },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('You can read this text but not edit it.')).toBeVisible();
  },
};

export const Empty: Story = { args: { connect: refused, fallback: null } };
