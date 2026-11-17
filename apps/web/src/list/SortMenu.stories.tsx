import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { DEFAULT_SORT } from './order';
import { SortMenu } from './SortMenu';

const NAMES: Record<string, string> = { summary: 'Summary', key: 'Key', updatedAt: 'Updated' };

const meta = {
  title: 'Views/SortMenu',
  component: SortMenu,
  args: { sort: DEFAULT_SORT, nameOf: (column: string) => NAMES[column] ?? column, onChange: fn() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof SortMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The list's orders, newest created first; choosing Key orders by ticket number (T-330). */
export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const menu = within(canvasElement).getByRole('combobox', { name: 'Sort by' });
    await expect(menu).toHaveDisplayValue('Newest created first');
    await userEvent.selectOptions(menu, 'Key');
    await expect(args.onChange).toHaveBeenLastCalledWith({ column: 'key', direction: 'ascending' });
  },
};

/** A heading chose an order the menu has no entry for: an extra entry first names it. */
export const NamesAHeadingsOrder: Story = {
  args: { sort: { column: 'summary', direction: 'ascending' } },
  play: async ({ canvasElement }) => {
    const menu = within(canvasElement).getByRole('combobox', { name: 'Sort by' });
    await expect(menu).toHaveDisplayValue('Summary, ascending');
  },
};

/** A date column reversed reads as earliest first. */
export const NamesADateReversed: Story = {
  args: { sort: { column: 'updatedAt', direction: 'ascending' } },
  play: async ({ canvasElement }) => {
    const menu = within(canvasElement).getByRole('combobox', { name: 'Sort by' });
    await expect(menu).toHaveDisplayValue('Updated, earliest first');
  },
};
