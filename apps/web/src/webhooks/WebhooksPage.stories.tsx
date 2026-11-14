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

/**
 * The "New …" button in the place every administration page has it (D11, AD-18): under the title
 * and its purpose line, at the start. Wide enough for the purpose line to fit beside it, which
 * once put the button at the right end of the title's row.
 */
export const NewButtonUnderThePurposeLine: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 1200 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const button = await page.findByRole('button', { name: 'New webhook' });
    const header = button.closest('header') as HTMLElement;
    const title = within(header).getByRole('heading', { level: 1 });
    const purpose = header.querySelector('.page-purpose') as HTMLElement;
    await expect(Math.round(button.getBoundingClientRect().left)).toBe(
      Math.round(title.getBoundingClientRect().left),
    );
    await expect(button.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      purpose.getBoundingClientRect().bottom,
    );
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
