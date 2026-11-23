import type { Meta, StoryObj } from '@storybook/react-vite';
import { fromAdfJson, fromMarkdown } from '@taskmoor/richtext';
import { expect, userEvent, within } from 'storybook/test';
import { onARealTouchScreen } from '../test/touch';
import type { MentionPerson } from './mentions';
import { RichTextEditor } from './RichTextEditor';

const PEOPLE: MentionPerson[] = [
  { id: 7, name: 'Kalo Smith', canView: true },
  { id: 8, name: 'Ana Ruiz', canView: true },
  { id: 9, name: 'Mi Rivera', canView: false },
];
const findPeople = async (query: string) =>
  PEOPLE.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));

/** Everything the schema holds, as an imported document would bring it. */
const EVERYTHING = fromAdfJson({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Checkout fails' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Since ' },
        { type: 'date', attrs: { timestamp: '1772582400000' } },
        { type: 'text', text: ', ' },
        { type: 'text', text: 'expired cards', marks: [{ type: 'strong' }] },
        { type: 'text', text: ' are refused; ' },
        { type: 'mention', attrs: { id: '7', text: '@Kalo Smith' } },
        { type: 'text', text: ' knows the ' },
        {
          type: 'text',
          text: 'payment flow',
          marks: [{ type: 'link', attrs: { href: 'https://example.test/flow' } }],
        },
        { type: 'text', text: '. Status: ' },
        { type: 'status', attrs: { text: 'IN REVIEW', color: 'blue' } },
        { type: 'text', text: ' ' },
        { type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } },
      ],
    },
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { state: 'DONE' },
          content: [{ type: 'text', text: 'Reproduce' }],
        },
        { type: 'taskItem', attrs: { state: 'TODO' }, content: [{ type: 'text', text: 'Fix' }] },
      ],
    },
    {
      type: 'panel',
      attrs: { panelType: 'warning' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Affects production.' }] }],
    },
    {
      type: 'codeBlock',
      attrs: { language: 'sql' },
      content: [{ type: 'text', text: 'SELECT * FROM card WHERE expires < now();' }],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Card' }] }],
            },
            {
              type: 'tableHeader',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Result' }] }],
            },
          ],
        },
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Expired' }] }],
            },
            {
              type: 'tableCell',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Refused' }] }],
            },
          ],
        },
      ],
    },
    {
      type: 'blockquote',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Seen on every browser.' }] }],
    },
    { type: 'extension', attrs: { extensionKey: 'chart', parameters: { series: [1, 2] } } },
  ],
});

const meta = {
  title: 'Rich text/RichTextEditor',
  component: RichTextEditor,
  args: { labelledBy: 'story-label', mentions: findPeople },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <p id="story-label" className="rt-label">
          Description
        </p>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof RichTextEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Everything: Story = { args: { initial: EVERYTHING } };

export const ReadOnly: Story = { args: { initial: EVERYTHING, editable: false } };

export const Invalid: Story = {
  args: { initial: fromMarkdown('Too short.'), required: true, invalid: true },
};

/** Markdown shortcuts as you type (NTF-006 (1)). */
export const MarkdownShortcuts: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Description' });
    await userEvent.click(textbox);
    await userEvent.keyboard('## Plan{Enter}[[] write it{Enter}');
    await expect(canvas.getByRole('heading', { level: 2, name: 'Plan' })).toBeVisible();
    await expect(canvas.getByRole('checkbox', { name: 'Checklist item: write it' })).toBeVisible();
  },
};

/** "@" offers people; one who cannot see the ticket is marked, and picking them warns. */
export const Mentions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Description' });
    await userEvent.click(textbox);
    await userEvent.keyboard('Ask @riv');
    const list = await canvas.findByRole('listbox', { name: 'People to mention' });
    await expect(within(list).getByRole('option', { name: /Mi Rivera/ })).toBeVisible();
    await userEvent.keyboard('{Enter}');
    await expect(
      await canvas.findByText('Mi Rivera cannot see this ticket and will not be notified.'),
    ).toBeVisible();
  },
};

/** The toolbar is one tab stop; the arrow keys walk it (NTF-006 (3)). */
export const KeyboardOnly: Story = {
  args: { initial: fromMarkdown('Some text') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Bold' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    await expect(canvas.getByRole('button', { name: 'Strikethrough' })).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('textbox', { name: 'Description' })).toHaveFocus();
  },
};

/**
 * On a touch phone, in a card's width (about 290 px at 375; NTF-006, PL-42), the toolbar keeps
 * one row: More is counted when the tools are fitted, so it never wraps alone onto a second row.
 */
export const OneRowOnAPhone: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
  render: (args) => (
    <div style={{ width: 290 }}>
      <RichTextEditor {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toolbar = canvas.getByRole('toolbar', { name: 'Formatting' });
    const buttons = within(toolbar).getAllByRole('button');
    await expect(buttons.at(-1)).toHaveAccessibleName('More tools');
    const top = buttons[0]?.getBoundingClientRect().top ?? 0;
    for (const button of buttons) {
      await expect(
        button.getBoundingClientRect().top,
        button.getAttribute('aria-label') ?? '',
      ).toBe(top);
    }
    await expect(buttons.length).toBeGreaterThan(2);
  },
};
