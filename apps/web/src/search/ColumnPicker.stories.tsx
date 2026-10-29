import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ColumnPicker } from './ColumnPicker';
import { DEFAULT_COLUMNS } from './columns';

const FIELDS = [
  { id: 40, name: 'Customer', type: 'text' },
  { id: 41, name: 'Points', type: 'number' },
];

function Picker() {
  const [columns, setColumns] = useState<string[]>([...DEFAULT_COLUMNS]);
  return (
    <main style={{ padding: 24 }}>
      <ColumnPicker columns={columns} fields={FIELDS} onChange={setColumns} />
    </main>
  );
}

const meta = {
  title: 'Search/ColumnPicker',
  component: Picker,
} satisfies Meta<typeof Picker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Closed, as the results bar shows it. */
export const Closed: Story = {};

/** Open: the shown columns with their buttons, and a custom field added and moved up. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Columns' }));
    const panel = canvas.getByRole('group', { name: 'Columns' });
    await userEvent.selectOptions(within(panel).getByLabelText('Add a column'), 'Points');
    await userEvent.click(within(panel).getByRole('button', { name: 'Add' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Move Points up' }));
    await expect(within(panel).getByRole('button', { name: 'Move Points up' })).toHaveFocus();
  },
};
