import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { PasswordField, type PasswordFieldProps } from './PasswordField';

/** A controlled field needs state; the story keeps it. */
function Field(props: Omit<PasswordFieldProps, 'value' | 'onChange'> & { initial?: string }) {
  const { initial = '', ...rest } = props;
  const [value, setValue] = useState(initial);
  return (
    <div className="form" style={{ padding: 24 }}>
      <PasswordField {...rest} value={value} onChange={setValue} />
      {rest.invalid && (
        <p id="story-error" className="form-error" role="alert">
          The current password is not correct.
        </p>
      )}
    </div>
  );
}

const meta = {
  title: 'Session/PasswordField',
  component: Field,
  args: { label: 'Password', autoComplete: 'current-password', initial: 'correct horse battery' },
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Hidden: Story = {};

export const Shown: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole('button', { name: 'Show password' });
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByLabelText('Password')).toHaveAttribute('type', 'text');
  },
};

export const NewPasswordWithHint: Story = {
  args: {
    label: 'New password',
    toggleLabel: 'Show new password',
    autoComplete: 'new-password',
    hint: 'At least 12 characters. A passphrase of several words works well.',
    initial: '',
  },
};

/**
 * A field marked wrong is marked whole: the show-password end takes the field's red edge rather
 * than keeping its grey one (the sign-in page after a miss).
 */
export const Invalid: Story = {
  args: { invalid: true, describedBy: 'story-error' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText('Password');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    const red = getComputedStyle(input).borderTopColor;
    const toggle = getComputedStyle(canvas.getByRole('button', { name: 'Show password' }));
    await expect([
      toggle.borderTopColor,
      toggle.borderRightColor,
      toggle.borderBottomColor,
    ]).toEqual([red, red, red]);
  },
};

/** Phones get 44px targets for the toggle. */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
