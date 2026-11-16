import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { FieldConfig, FieldType } from './client';
import { FieldSettings } from './FieldSettings';

/** The settings as a form keeps them. */
function Live({ type, start }: { type: FieldType; start: FieldConfig }) {
  const [config, setConfig] = useState(start);
  return <FieldSettings type={type} config={config} onChange={setConfig} />;
}

const meta = {
  title: 'Admin/Fields/FieldSettings',
  component: Live,
  args: { type: 'number', start: { format: 'currency', currency: 'EUR', decimals: 2 } },
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

/** A number shown as euros, with a sample of how values read. */
export const Currency: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/shows as €1,234\.50/)).toBeVisible();
  },
};

/** A percentage: the currency code goes. */
export const Percentage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByLabelText('Shows as'), 'percentage');
    await expect(canvas.queryByLabelText('Currency code')).toBeNull();
  },
};

/** A paragraph's most characters. */
export const Paragraph: Story = {
  args: { type: 'paragraph', start: { maxChars: 500 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText('Most characters')).toHaveValue(500);
  },
};
