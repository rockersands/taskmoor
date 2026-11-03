import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { BUG_FORM } from '../fixtures';
import { fakePickerClient } from './fixtures';
import { type PickedTemplate, TemplateOutcome, TemplatePicker } from './TemplatePicker';

function Picker() {
  const [picked, setPicked] = useState<PickedTemplate | null>(null);
  return (
    <TemplatePicker
      client={fakePickerClient()}
      track="SHOP"
      typeId={3}
      form={BUG_FORM}
      picked={picked}
      onPick={setPicked}
      onChange={setPicked}
    />
  );
}

const meta = {
  title: 'Tickets/TemplatePicker',
  component: Picker,
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Picker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Choosing: Story = {};

/** Chosen: the values the form cannot edit and the subticket count, each with a checkbox. */
export const Chosen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(
      await canvas.findByRole('combobox', { name: 'Start from a template' }),
      'Release checklist',
    );
    await expect(await canvas.findByRole('checkbox', { name: 'Assignee' })).toBeChecked();
  },
};

/** What the create form says after making a ticket from a template. */
export const Outcome: Story = {
  render: () => (
    <TemplateOutcome
      form={BUG_FORM}
      outcome={{
        key: 'SHOP-9',
        left: ['assigneeId', 'fields.7'],
        subtickets: [
          { summary: 'Write the notes', key: 'SHOP-10', error: null },
          { summary: 'Announce it', key: null, error: 'refused' },
        ],
      }}
    />
  ),
};
