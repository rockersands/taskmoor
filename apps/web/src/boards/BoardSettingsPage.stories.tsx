import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { BoardSettingsPage } from './BoardSettingsPage';
import { BOARD, fakeBoardClient } from './fixtures';

const meta = {
  title: 'Boards/BoardSettingsPage',
  component: BoardSettingsPage,
  args: { boardId: 7, client: fakeBoardClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof BoardSettingsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Columns with their limits, the status mapping, an Expedite lane and two board filters. */
export const Settings: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('combobox', { name: 'Column for In Review' }),
    ).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Query of Expedite' })).toBeVisible();
  },
};

/** Colours by query, with a rule. */
export const ColourRules: Story = {
  args: {
    client: fakeBoardClient({
      board: {
        ...BOARD,
        cardRules: {
          colourBy: 'queries',
          colours: [{ id: 'r1', query: 'priority = Urgent', colour: '#c4314b' }],
          fields: ['assignee'],
          daysInColumn: true,
        },
      },
    }),
  },
};

/** Someone who may only look. */
export const ReadOnly: Story = {
  args: { client: fakeBoardClient({ board: { ...BOARD, mayConfigure: false } }) },
};
