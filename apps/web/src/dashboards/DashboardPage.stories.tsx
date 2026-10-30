import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { DashboardPage } from './DashboardPage';
import { fakeDashboardClient } from './fixtures';

const meta = {
  title: 'Dashboards/DashboardPage',
  component: DashboardPage,
  args: { id: 5, client: fakeDashboardClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof DashboardPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A widget of every kind in three columns. */
export const Widgets: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('figure', { name: 'Pie chart' })).toBeVisible();
    await expect(await canvas.findByRole('figure', { name: 'Created vs closed' })).toBeVisible();
  },
};

/** Its owner editing: layout, a widget to add, and each widget's tools. */
export const Editing: Story = {
  args: { client: fakeDashboardClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit dashboard' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Settings of Newest in SHOP' }));
    await expect(canvas.getByRole('form', { name: 'Settings of Search results' })).toBeVisible();
  },
};

export const Wallboard: Story = {
  args: { wallboard: { rotation: [5], seconds: 60 } },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
