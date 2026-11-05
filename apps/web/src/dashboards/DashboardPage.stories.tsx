import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { DashboardPage } from './DashboardPage';
import { fakeDashboardClient, TEAM_DASHBOARD } from './fixtures';

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

/** On a wall: the title and the widgets, with no line about what the page is for. */
export const Wallboard: Story = {
  args: { wallboard: { rotation: [5], seconds: 60 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Leave the wallboard' })).toBeVisible();
    await expect(canvas.queryByText(/^The charts and lists gathered here/)).toBeNull();
  },
};

/** No widgets yet, for its owner: what a widget is and how to add the first. */
export const NoWidgets: Story = {
  args: { client: fakeDashboardClient([{ ...TEAM_DASHBOARD, widgets: [], editable: true }]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No widgets yet')).toBeVisible();
    await expect(canvas.getByText(/Edit it to add the first one/)).toBeVisible();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

/** A dashboard that cannot be found still has its page: a title and what the section is for. */
export const NotFound: Story = {
  args: {
    client: {
      ...fakeDashboardClient(),
      get: async () => {
        throw new Error('not found');
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 1, name: 'Dashboards' })).toBeVisible();
  },
};
