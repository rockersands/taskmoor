import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { GroupSummary } from '../admin/SecurityPage';
import { type MappingRow, mappingRow } from './draft';
import { GROUPS } from './fixtures';
import { GroupMapField } from './GroupMapField';

/** The field keeps no rows of its own; the story holds them like the provider form does. */
function Field({
  initial = [],
  groups = GROUPS,
}: {
  initial?: MappingRow[];
  groups?: GroupSummary[] | null;
}) {
  const [rows, setRows] = useState(initial);
  return (
    <form className="form" aria-label="Group mapping">
      <GroupMapField rows={rows} groups={groups} onChange={setRows} />
    </form>
  );
}

const meta = {
  title: 'Admin/GroupMapField',
  component: Field,
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoMappings: Story = {};

export const WithMappings: Story = {
  args: { initial: [mappingRow('finance', 3), mappingRow('platform-engineering', 7)] },
};

export const AddingAMapping: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Add mapping' }));
    await expect(canvas.getByLabelText('Claim value')).toHaveFocus();
  },
};

export const NoGroups: Story = { args: { groups: [] } };

export const GroupsUnavailable: Story = { args: { groups: null } };

export const Phone: Story = {
  args: { initial: [mappingRow('finance', 3), mappingRow('platform-engineering', 7)] },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
