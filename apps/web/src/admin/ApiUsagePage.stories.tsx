import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { ApiUsagePage } from './ApiUsagePage';
import { fakeApiUsageClient } from './apiUsageFixtures';
import { ADMIN, MEMBER } from './fixtures';

const meta = {
  title: 'Admin/ApiUsagePage',
  component: ApiUsagePage,
  args: { client: fakeApiUsageClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof ApiUsagePage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A sync token that ran into its limit, a person and an address that only gets errors. */
export const BusyHour: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('rowheader', { name: 'Nightly sync (token of Grace Hopper)' }),
    ).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Last hour' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  },
};

export const Quiet: Story = { args: { client: fakeApiUsageClient({ hour: [], day: [] }) } };

export const NotAnAdministrator: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
};
