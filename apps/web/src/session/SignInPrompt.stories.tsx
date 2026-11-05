import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { RequireSession } from './RequireSession';
import { SessionProvider } from './SessionProvider';

function Guarded() {
  return (
    <RequireSession>
      <h1 className="page-title">Settings</h1>
    </RequireSession>
  );
}

const meta = {
  title: 'Session/RequireSession',
  component: Guarded,
  decorators: [
    (Story) => (
      <main style={{ padding: 32 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Guarded>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Anonymous: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={{ status: 'anonymous' }}>
        <Story />
      </SessionProvider>
    ),
  ],
};

export const SignedIn: Story = {
  decorators: [
    (Story) => (
      <SessionProvider
        session={{
          status: 'signed-in',
          user: {
            id: 1,
            name: 'Kalo',
            email: 'kalo@example.com',
            isSiteAdmin: true,
            timeZone: null,
            locale: null,
          },
        }}
      >
        <Story />
      </SessionProvider>
    ),
  ],
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

/** The prompt of a guarded page on a phone. */
export const AtPhoneWidth: Story = {
  decorators: [
    atPhoneWidth,
    (Story) => (
      <SessionProvider session={{ status: 'anonymous' }}>
        <Story />
      </SessionProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1 })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
