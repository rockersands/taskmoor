import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakeGuardrailsClient, fakeStorageClient } from './fixtures';
import { GuardrailsPage } from './GuardrailsPage';

const meta = {
  title: 'Admin/Guardrails',
  component: GuardrailsPage,
  args: { client: fakeGuardrailsClient(), storage: fakeStorageClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof GuardrailsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every limit with its usage; one is above a lowered limit. */
export const Guardrails: Story = {};

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
    await canvas.findAllByRole('meter');
    await fitsPhoneWidth(canvas);
  },
};

export const NotAnAdministrator: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
};
