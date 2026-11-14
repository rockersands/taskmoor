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

/**
 * Each window is a narrow number with a unit picker, like the session lengths on the same page,
 * and the count beside it is as narrow (S3-AC-6): both were plain fields across the whole panel.
 */
export const WindowsWithAUnit: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 900 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rule = await canvas.findByRole('group', { name: 'Failed sign-ins for one account' });
    const window = within(rule).getByLabelText('Within this time');
    const unit = within(rule).getByRole('combobox', { name: 'Unit of “Within this time”' });
    await expect(window).toHaveValue(1);
    await expect(unit).toHaveValue('hours');
    const count = within(rule).getByLabelText('Alert after this many');
    const panel = rule.getBoundingClientRect().width;
    for (const field of [window, count]) {
      await expect(field.getBoundingClientRect().width).toBeLessThan(panel / 3);
    }
    await expect(Math.round(count.getBoundingClientRect().width)).toBe(
      Math.round(window.getBoundingClientRect().width),
    );
  },
};

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
