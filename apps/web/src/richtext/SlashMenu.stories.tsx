import type { Meta, StoryObj } from '@storybook/react-vite';
import type { PmJson } from '@taskmoor/richtext';
import { expect, userEvent, within } from 'storybook/test';
import { type EditorTools, EditorToolsProvider } from './EditorTools';
import { RichTextEditor } from './RichTextEditor';
import { RichTextView } from './RichTextView';

const TOOLS: EditorTools = {
  attachments: async () => [
    { name: 'notes.pdf', image: false, href: 'https://files.example.test/2', thumbnail: null },
    // Two files of one name (TT-4): the picker tells them apart.
    {
      name: 'screen.png',
      image: true,
      href: 'https://files.example.test/3',
      thumbnail: null,
      sha256: 'a'.repeat(64),
      size: 48_000,
      createdAt: '2026-11-01T10:00:00Z',
      author: 'Ana Ruiz',
    },
    {
      name: 'screen.png',
      image: true,
      href: 'https://files.example.test/4',
      thumbnail: null,
      sha256: 'b'.repeat(64),
      size: 52_000,
      createdAt: '2026-11-02T16:30:00Z',
      author: 'Ben Ode',
    },
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
    // Columns with widths (TT-2): a third and two thirds.
    {
      type: 'columnLayout',
      content: [
        { type: 'column', attrs: { width: 33.33 }, content: para('Narrow.') },
        { type: 'column', attrs: { width: 66.67 }, content: para('Wide.') },
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

/** A section whose text this person hid while editing (TT-1); the title stays a field. */
export const HiddenSectionInTheEditor: Story = {
  args: { initial: BLOCKS },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole('button', { name: 'Text of the section “Steps”' });
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.getByText('Inside.')).not.toBeVisible();
  },
};

/** The code block's prompt with its list of common languages (TT-8), narrowed. */
export const LanguageList: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('textbox', { name: 'Description' }));
    await userEvent.keyboard('/code');
    await canvas.findByRole('listbox', { name: 'Blocks to add' });
    await userEvent.keyboard('{Enter}');
    await canvas.findByRole('combobox', { name: 'Code language (optional)' });
    await userEvent.keyboard('ja{ArrowDown}');
    const list = canvas.getByRole('listbox', { name: 'Common languages' });
    await expect(within(list).getByRole('option', { name: 'Java' })).toBeVisible();
  },
};

/** Two files of one name, each with its size, date and who added it (TT-4). */
export const SameNamedFiles: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('textbox', { name: 'Description' }));
    await userEvent.keyboard('/image');
    await canvas.findByRole('listbox', { name: 'Blocks to add' });
    await userEvent.keyboard('{Enter}');
    const list = await canvas.findByRole('listbox', { name: 'Image or file from this ticket' });
    await expect(within(list).getAllByRole('option', { name: /^screen\.png \(/ })).toHaveLength(2);
  },
};

/** The widths of the columns the caret is in (TT-2). */
export const ColumnWidths: Story = {
  args: { initial: BLOCKS },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText('Wide.'));
    await userEvent.keyboard(' /width');
    await canvas.findByRole('listbox', { name: 'Blocks to add' });
    await userEvent.keyboard('{Enter}');
    await expect(
      await canvas.findByRole('combobox', { name: 'Widths of the 2 columns' }),
    ).toHaveDisplayValue('33.3%, 66.7%');
  },
};
