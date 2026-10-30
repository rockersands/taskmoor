import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { DashboardsPage } from './DashboardsPage';
import { fakeDashboardClient, TEAM_DASHBOARD } from './fixtures';

const meta = {
  title: 'Dashboards/DashboardsPage',
  component: DashboardsPage,
  args: {
    client: fakeDashboardClient([
      TEAM_DASHBOARD,
      {
        ...TEAM_DASHBOARD,
        id: 6,
        name: 'Support',
        owner: { id: 9, name: 'Grace Hopper' },
        editable: false,
        isDefault: true,
      },
    ]),
  },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof DashboardsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The person's own dashboards, those shared with them, and the wallboard choice. */
export const List: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Yours' })).toBeVisible();
  },
};

export const Empty: Story = { args: { client: fakeDashboardClient([]) } };

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
