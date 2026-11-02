import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { fakeAlertsClient } from './alertsFixtures';
import { SecurityAlertsForm } from './SecurityAlertsForm';

const meta = {
  title: 'Admin/SecurityAlertsForm',
  component: SecurityAlertsForm,
  args: { client: fakeAlertsClient(), locale: 'en-GB' },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof SecurityAlertsForm>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The defaults and the two latest alerts. */
export const Defaults: Story = {};

/** No alert raised yet. */
export const NoAlerts: Story = {
  args: { client: fakeAlertsClient([]) },
};

/** A stricter account rule, saved. */
export const Stricter: Story = {
  args: { client: fakeAlertsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rule = await canvas.findByRole('group', { name: 'Failed sign-ins for one account' });
    const threshold = within(rule).getByLabelText('Alert after this many');
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '5');
    await userEvent.click(canvas.getByRole('button', { name: 'Save alert rules' }));
    await expect(await canvas.findByText('Alert rules saved.')).toBeVisible();
  },
};

export const Failed: Story = {
  args: {
    client: fakeAlertsClient(undefined, {
      load: async () => {
        throw new Error('network');
      },
    }),
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
