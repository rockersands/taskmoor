import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CodeField, type CodeFieldProps } from './CodeField';

function Controlled(props: Omit<CodeFieldProps, 'value' | 'onChange'>) {
  const [value, setValue] = useState('');
  return (
    <form className="form" aria-label="Code">
      <CodeField {...props} value={value} onChange={setValue} />
    </form>
  );
}

const meta = {
  title: 'TwoFactor/CodeField',
  component: Controlled,
  args: { kind: 'one-time', label: 'Authentication code' },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Controlled>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OneTimeCode: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByLabelText('Authentication code');
    await expect(field).toHaveAttribute('inputmode', 'numeric');
    await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    await userEvent.type(field, '492039');
    await expect(field).toHaveValue('492039');
  },
};

export const WithHint: Story = {
  args: {
    label: 'Code from the app',
    hint: '6 digits. The app shows a new code every 30 seconds.',
  },
};

export const RecoveryCode: Story = {
  args: {
    kind: 'recovery',
    label: 'Recovery code',
    hint: 'Ten letters and digits, such as ABCDE-23456.',
  },
};

export const Invalid: Story = { args: { invalid: true } };
