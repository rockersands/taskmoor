import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { Field } from './client';
import { fakeFieldsClient, sampleFields } from './fixtures';
import { OptionList } from './OptionList';

const fieldOf = (id: number) => sampleFields().find((f) => f.id === id) as Field;

/** The list as a page keeps it: the field as the server last answered. */
function Live({ start }: { start: Field }) {
  const [field, setField] = useState(start);
  const context = field.contexts[0];
  if (!context) return null;
  return (
    <OptionList
      field={field}
      context={context}
      client={fakeFieldsClient()}
      onField={setField}
      onChanged={() => {}}
      onProblem={() => {}}
      defaultIds={[201]}
    />
  );
}

const meta = {
  title: 'Admin/Fields/OptionList',
  component: Live,
  args: { start: fieldOf(2) },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Live>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A choice list: the default marked, one option no longer offered, Up and Down on each. */
export const Options: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Move Low up' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Move Medium up' }));
    await expect(canvas.getByRole('button', { name: 'Move Medium down' })).toHaveFocus();
  },
};

/** A two-level list: each option's child options under it, with their own New child option. */
export const TwoLevels: Story = {
  args: { start: fieldOf(5) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('list', { name: 'Child options of Europe' })).toBeVisible();
    await expect(canvas.getByText('Americas has no child options yet.')).toBeVisible();
  },
};

/**
 * An option with child options asks before Delete and says what goes (D13, T-267); a plain one
 * goes at once.
 */
export const DeleteAsksFirst: Story = {
  args: { start: fieldOf(5) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Delete Europe' }));
    const question = canvas.getByRole('group', { name: /^Delete Europe and its 2 child options/ });
    await expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  },
};

/** A context with no option yet. */
export const NoOptions: Story = {
  args: { start: fieldOf(3) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No options yet.')).toBeVisible();
  },
};
