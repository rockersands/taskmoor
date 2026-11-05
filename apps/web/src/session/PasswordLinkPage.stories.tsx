import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { KALO } from '../account/fixtures';
import { ApiError } from '../api/client';
import { type PasswordLinkClient, PasswordLinkPage } from './PasswordLinkPage';
import { SessionProvider } from './SessionProvider';

const link = (purpose: 'activate' | 'reset'): PasswordLinkClient => ({
  inspect: async () => ({ purpose, name: 'Nia Okafor', email: 'nia@example.com' }),
  redeem: async () => ({ ...KALO, name: 'Nia Okafor', email: 'nia@example.com' }),
});

/** Stories pass the link endpoints in; nothing calls a backend. */
const meta = {
  title: 'Session/PasswordLinkPage',
  component: PasswordLinkPage,
  args: { onDone: () => {}, client: link('activate') },
  beforeEach: () => {
    window.location.hash = '#/password?token=story-token';
  },
  decorators: [
    (Story) => (
      <SessionProvider session={{ status: 'anonymous' }}>
        <Story />
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof PasswordLinkPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Activation: Story = {};

export const Reset: Story = { args: { client: link('reset') } };

export const Checking: Story = {
  args: { client: { ...link('activate'), inspect: () => new Promise(() => {}) } },
};

export const InvalidLink: Story = {
  args: {
    client: {
      ...link('activate'),
      inspect: async () => {
        throw new ApiError(404, { error: 'invalid_link' });
      },
    },
  },
};

export const WithoutToken: Story = {
  beforeEach: () => {
    window.location.hash = '#/password';
  },
};

export const WeakPassword: Story = {
  args: {
    client: {
      ...link('activate'),
      redeem: async () => {
        throw new ApiError(400, {
          error: 'weak_password',
          codes: ['common', 'contains_identity'],
          problems: ['password: is too common', 'password: contains your name'],
        });
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('New password'), 'niaokafor2024!');
    await userEvent.type(canvas.getByLabelText('Confirm new password'), 'niaokafor2024!');
    await userEvent.click(canvas.getByRole('button', { name: 'Save password and sign in' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'Choose a different password:',
    );
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
};

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('form')).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
