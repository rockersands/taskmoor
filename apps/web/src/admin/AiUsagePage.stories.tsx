import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { AiUsagePage } from './AiUsagePage';
import { fakeAiUsageClient, QUIET_MONTH } from './aiUsageFixtures';
import { ADMIN, MEMBER } from './fixtures';

const meta = {
  title: 'Admin/AiUsagePage',
  component: AiUsagePage,
  args: { client: fakeAiUsageClient(), now: () => new Date('2026-10-31T15:00:00Z') },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof AiUsagePage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A month of summaries and duplicate checks on Bedrock, with three spend limits. */
export const BusyMonth: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('table', { name: 'By person' })).toBeVisible();
    await expect(canvas.getByText(/Amazon Bedrock, region eu-central-1/)).toBeVisible();
  },
};

export const Quiet: Story = { args: { client: fakeAiUsageClient(QUIET_MONTH, { limits: [] }) } };

export const NotSetUp: Story = {
  args: {
    client: fakeAiUsageClient(QUIET_MONTH, {
      limits: [],
      statement: {
        configured: false,
        provider: null,
        region: null,
        features: [],
        contentDays: 0,
        neverSent: ['hidden-tickets', 'credentials'],
      },
    }),
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
