import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { AiLimitsPage } from './AiLimitsPage';
import { fakeAiLimitsClient } from './aiLimitsFixtures';
import { ADMIN } from './fixtures';

const meta = {
  title: 'Admin/AiLimits',
  component: AiLimitsPage,
  args: { client: fakeAiLimitsClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof AiLimitsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two limits, a list price and an administrator's rate. */
export const LimitsAndPrices: Story = {};

/** No limit yet, and no price known. */
export const Empty: Story = { args: { client: fakeAiLimitsClient([], []) } };

/** The form for a limit. */
export const AddingALimit: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await userEvent.click(await page.findByRole('button', { name: 'New limit' }));
    await expect(page.getByRole('form', { name: 'New limit' })).toBeVisible();
  },
};

/** The form for a rate. */
export const AddingARate: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await userEvent.click(await page.findByRole('button', { name: 'New rate' }));
    await expect(page.getByRole('form', { name: 'New rate' })).toBeVisible();
  },
};
