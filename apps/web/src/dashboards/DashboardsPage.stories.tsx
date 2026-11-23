import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
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

/**
 * The person's own dashboards, those shared with them, and the wallboard choice; every card's
 * title in one style.
 */
export const List: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Yours' })).toBeVisible();
    const size = (name: string) =>
      getComputedStyle(canvas.getByRole('heading', { level: 2, name })).fontSize;
    await expect(size('Wallboard')).toBe(size('Yours'));
    await expect(size('Shared with you')).toBe(size('Yours'));
  },
};

/** A box ticked: the wallboard card offers to start it with the dashboards chosen (PL-14). */
export const WallboardChosen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wallboard = await canvas.findByRole('region', { name: 'Wallboard' });
    await expect(within(wallboard).queryByRole('link')).toBeNull();
    await userEvent.click(
      canvas.getByRole('checkbox', { name: 'Show Checkout team on the wallboard' }),
    );
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Show Support on the wallboard' }));
    const start = within(wallboard).getByRole('link', {
      name: 'Start the wallboard with 2 dashboards',
    });
    await expect(start).toBeVisible();
    await expect(start).toHaveAttribute('href', '#/dashboards/5/wallboard?rotate=5,6&seconds=60');
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

/** A finger reaches each dashboard's name and the box that puts it on the wallboard (ADR-033). */
export const OnATouchScreen: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findAllByRole('checkbox');
    await expect(
      tooSmallForAFinger(canvasElement, ['.dashboard-row > a', '.dashboard-row .reports-check']),
    ).toEqual([]);
  },
};
