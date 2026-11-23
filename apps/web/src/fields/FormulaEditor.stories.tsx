import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { FieldConfig } from './client';
import { FormulaEditor } from './FormulaEditor';
import { fakeFieldsClient, sampleFields } from './fixtures';

/** The editor as a form keeps it: the settings as typed. */
function Live({ start }: { start: FieldConfig }) {
  const [config, setConfig] = useState(start);
  return (
    <FormulaEditor
      config={config}
      onChange={setConfig}
      fields={sampleFields()}
      check={fakeFieldsClient().checkFormula}
      trackId={null}
    />
  );
}

const meta = {
  title: 'Admin/Fields/FormulaEditor',
  component: Live,
  args: { start: { expression: '{Cost} * 2', output: 'currency', currency: 'EUR', decimals: 2 } },
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

/** A formula that holds: what it gives and the fields it reads. */
export const Checked: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('It gives a number. It reads {Cost}.')).toBeVisible();
  },
};

/** A mistake, said by line and column in the reader’s language. */
export const Mistake: Story = {
  args: { start: { expression: 'round({Pionts}, 1)', output: 'number' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        'Line 1, column 7: No field is called {Pionts}, or a formula here cannot see it.',
      ),
    ).toBeVisible();
  },
};

/** The help: the fields it can read, in braces, and the functions. */
export const Help: Story = {
  args: { start: { expression: '', output: 'date' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'What a formula can use' }));
    await expect(canvas.getByRole('list', { name: 'Fields it can read' })).toBeVisible();
  },
};
