import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { DashboardsPage } from './DashboardsPage';
import { fakeDashboardClient, TEAM_DASHBOARD } from './fixtures';

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
};

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

/** None yet: what a dashboard is, and the form above makes the first. */
export const Empty: Story = {
  args: { client: fakeDashboardClient([]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No dashboards yet')).toBeVisible();
    await expect(canvas.getByText(/^A dashboard gathers charts/)).toBeVisible();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Yours' })).toBeVisible();
    await expect(canvas.getByText(/^Charts and lists that sum up/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
