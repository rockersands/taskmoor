import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakeWebhooksClient } from './fixtures';
import { WebhooksPage } from './WebhooksPage';

const meta = {
  title: 'Admin/Webhooks',
  component: WebhooksPage,
  args: { client: fakeWebhooksClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof WebhooksPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One sending and one turned off. */
export const Webhooks: Story = {};

/** No webhook yet: what one is for. */
export const Empty: Story = { args: { client: fakeWebhooksClient([]) } };

/** The form for a new webhook. */
export const NewWebhook: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await userEvent.click(await page.findByRole('button', { name: 'New webhook' }));
    await expect(page.getByRole('form', { name: 'New webhook' })).toBeVisible();
  },
};

/** Deliveries of a webhook, one of them failed. */
export const WithDeliveries: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await userEvent.click(
      await page.findByRole('button', { name: 'Deliveries of Payments channel' }),
    );
    await expect(await page.findByText('Service Unavailable')).toBeVisible();
  },
};
