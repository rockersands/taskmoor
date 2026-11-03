import type { Meta, StoryObj } from '@storybook/react-vite';
import type { PmJson } from '@taskmoor/richtext';
import { expect, userEvent, within } from 'storybook/test';
import { type EditorTools, EditorToolsProvider } from './EditorTools';
import { RichTextEditor } from './RichTextEditor';
import { RichTextView } from './RichTextView';

const TOOLS: EditorTools = {
  attachments: async () => [
    { name: 'notes.pdf', image: false, href: 'https://files.example.test/2', thumbnail: null },
  ],
  tickets: async () => [
    { id: 40, key: 'SHOP-40', summary: 'Retry a failed payment', status: { name: 'New' } },
  ],
};

const para = (text: string): PmJson[] => [{ type: 'paragraph', content: [{ type: 'text', text }] }];

/** Every block the menu adds that a document shows by itself. */
const BLOCKS: PmJson = {
  type: 'doc',
  content: [
    { type: 'panel', attrs: { panelType: 'warning' }, content: para('Careful.') },
    { type: 'expand', attrs: { title: 'Steps' }, content: para('Inside.') },
    {
      type: 'columnLayout',
      content: [
        { type: 'column', content: para('Left.') },
        { type: 'column', content: para('Right.') },
      ],
    },
    { type: 'attachmentRef', attrs: { name: 'notes.pdf', image: false } },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Blocked by ' },
        { type: 'ticketRef', attrs: { key: 'SHOP-40' } },
        { type: 'text', text: ' since ' },
        { type: 'date', attrs: { timestamp: String(Date.UTC(2026, 10, 3)) } },
        { type: 'text', text: ' ' },
        { type: 'status', attrs: { text: 'In review', color: 'blue' } },
        { type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } },
      ],
    },
  ],
};

const meta = {
  title: 'Rich text/Slash menu',
  component: RichTextEditor,
  args: { labelledBy: 'story-label', mentions: async () => [] },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720, minHeight: 420 }}>
        <p id="story-label" className="rt-label">
          Description
        </p>
        <EditorToolsProvider value={TOOLS}>
          <Story />
        </EditorToolsProvider>
      </main>
    ),
  ],
} satisfies Meta<typeof RichTextEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

/** "/" opens the whole list. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('textbox', { name: 'Description' }));
    await userEvent.keyboard('/');
    const list = await canvas.findByRole('listbox', { name: 'Blocks to add' });
    await expect(within(list).getByRole('option', { name: 'Heading 1' })).toBeVisible();
  },
};

/** Typing narrows it. */
export const Narrowed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('textbox', { name: 'Description' }));
    await userEvent.keyboard('/panel');
    const list = await canvas.findByRole('listbox', { name: 'Blocks to add' });
    await expect(within(list).getByRole('option', { name: 'Warning panel' })).toBeVisible();
  },
};

/** A block that asks for something first: a status label's words and colour. */
export const AskingForAStatus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('textbox', { name: 'Description' }));
    await userEvent.keyboard('/status');
    await canvas.findByRole('listbox', { name: 'Blocks to add' });
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByRole('combobox', { name: 'Colour' })).toBeVisible();
  },
};

/** The new blocks in the editor. */
export const BlocksInTheEditor: Story = {
  args: { initial: BLOCKS },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole('textbox', { name: 'Section title' }),
    ).toHaveValue('Steps');
  },
};

/** The new blocks where a document is only read. */
export const BlocksInReadMode: Story = {
  render: () => <RichTextView doc={BLOCKS} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'SHOP-40' })).toBeVisible();
    await expect(canvas.getByText('Steps')).toBeVisible();
    await expect(await canvas.findByRole('link', { name: 'notes.pdf' })).toBeVisible();
  },
};
