import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { ADMIN, MEMBER } from './fixtures';
import { NetworkAccessPage } from './NetworkAccessPage';
import { fakeNetworkClient, OFFICE_LIST } from './networkFixtures';

const meta = {
  title: 'Admin/NetworkAccessPage',
  component: NetworkAccessPage,
  args: { client: fakeNetworkClient(OFFICE_LIST) },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof NetworkAccessPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The office network, with travelling staff allowed from anywhere. */
export const OfficeOnly: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('checkbox', { name: 'Only allow these addresses' }),
    ).toBeChecked();
  },
};

export const Off: Story = { args: { client: fakeNetworkClient() } };

export const NotAnAdministrator: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
};
