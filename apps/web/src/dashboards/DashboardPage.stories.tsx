import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { ApiError } from '../api/client';
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
    await expect(await canvas.findByRole('figure', { name: 'Tickets by Priority' })).toBeVisible();
    await expect(await canvas.findByRole('figure', { name: 'Created vs closed' })).toBeVisible();
    // Each Share bar's length follows its share, not a tick of the same few pixels.
    const stats = within(await canvas.findByRole('article', { name: 'Ticket statistics' }));
    await stats.findByRole('table');
    const bars = [
      ...canvasElement.querySelectorAll<HTMLElement>(
        '[aria-label="Ticket statistics"] .widget-share-bar',
      ),
    ].map((bar) => bar.getBoundingClientRect().width);
    // checkout 22 and ux 6 of 51.
    await expect(bars[0]).toBeGreaterThan(10);
    await expect((bars[2] ?? 0) / (bars[0] ?? 1)).toBeCloseTo(6 / 22, 1);
    // Every number column aligns at its end, the first one included.
    const grid = within(canvas.getByRole('article', { name: 'Two-dimensional statistics' }));
    const first = grid.getAllByRole('row')[1]?.querySelectorAll('td')[0] as HTMLElement;
    await expect(['end', 'right']).toContain(getComputedStyle(first).textAlign);
    // A widget table's head is the quiet head of every data table (T-222): sunken, muted, small.
    const head = stats.getAllByRole('columnheader')[0] as HTMLElement;
    const probe = document.createElement('table');
    probe.className = 'data-table';
    probe.innerHTML = '<thead><tr><th scope="col">x</th></tr></thead>';
    // Beside the widget's table, so both read the same tokens.
    (head.closest('article') ?? canvasElement).append(probe);
    const quiet = getComputedStyle(probe.querySelector('th') as HTMLElement);
    const look = (style: CSSStyleDeclaration) => [
      style.backgroundColor,
      style.color,
      style.fontSize,
      style.fontWeight,
    ];
    await expect(look(getComputedStyle(head))).toEqual(look(quiet));
    await expect(getComputedStyle(head).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    probe.remove();
    // A group's progress stays on one line ('1 of 3 done').
    const done = canvas.getByText('1 of 3 done');
    await expect(done.getBoundingClientRect().height).toBeLessThan(
      1.8 * Number.parseFloat(getComputedStyle(done).fontSize),
    );
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

/**
 * On a wall (D31): its own layout in large type, the title and the widgets alone. No line about
 * the page, no "Show the numbers", and the way out shows only once the keyboard or a pointer
 * reaches it.
 */
export const Wallboard: Story = {
  args: { wallboard: { rotation: [5], seconds: 60 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const leave = await canvas.findByRole('link', { name: 'Leave the wallboard' });
    const exits = leave.closest('.wallboard-exits') as HTMLElement;
    await expect(getComputedStyle(exits).opacity).toBe('0');
    await expect(canvas.queryByText(/^The charts and lists gathered here/)).toBeNull();
    await canvas.findAllByRole('figure');
    for (const numbers of canvasElement.querySelectorAll('.chart-table')) {
      await expect(getComputedStyle(numbers).display).toBe('none');
    }
    const page = canvasElement.querySelector('.is-wallboard') as HTMLElement;
    await expect(Number.parseFloat(getComputedStyle(page).fontSize)).toBeGreaterThanOrEqual(20);
    leave.focus();
    await waitFor(() => expect(getComputedStyle(exits).opacity).toBe('1'));
  },
};

/**
 * Two widgets on a wall, each card the screen's height (PL-15): its title at its top, its content
 * right under it rather than spread over the card, and the ring grown to fill it.
 */
export const WallboardFewWidgets: Story = {
  args: {
    wallboard: { rotation: [5], seconds: 60 },
    client: fakeDashboardClient([
      {
        ...TEAM_DASHBOARD,
        layout: 'two',
        widgets: TEAM_DASHBOARD.widgets
          .filter((w) => w.id === 'intro' || w.id === 'pie')
          .map((w) => ({ ...w, column: w.id === 'pie' ? 1 : 0 })),
      },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pie = await canvas.findByRole('figure', { name: 'Tickets by Priority' });
    await canvas.findByText('Ask in #checkout.');
    for (const card of canvasElement.querySelectorAll<HTMLElement>('.dashboard-widget')) {
      const title = card.querySelector('.dashboard-widget-title') as HTMLElement;
      const body = card.querySelector('.dashboard-widget-head + *') as HTMLElement;
      const top = card.getBoundingClientRect().top;
      await expect(title.getBoundingClientRect().top - top).toBeLessThanOrEqual(40);
      const gap = body.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
      await expect(gap).toBeLessThanOrEqual(24);
    }
    // The ring grows with the screen rather than staying the size of a card on a desk.
    await expect(within(pie).getByRole('img').getBoundingClientRect().width).toBeGreaterThan(168);
  },
};

/** On a phone the hidden way out takes no room: the first card sits under the title. */
export const WallboardPhone: Story = {
  args: { wallboard: { rotation: [5], seconds: 60 } },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByRole('heading', { level: 1, name: 'Checkout team' });
    const first = (await canvas.findAllByRole('article'))[0] as HTMLElement;
    const gap = first.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
    await expect(gap).toBeLessThanOrEqual(48);
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

/** On a phone the ring stands in the middle of its card, the legend under it. */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pie = await canvas.findByRole('figure', { name: 'Tickets by Priority' });
    const ring = within(pie).getByRole('img').getBoundingClientRect();
    const box = (pie.querySelector('.chart-donut') as HTMLElement).getBoundingClientRect();
    await expect(
      Math.abs(ring.left + ring.width / 2 - (box.left + box.width / 2)),
    ).toBeLessThanOrEqual(4);
  },
};

/** A dashboard that cannot be found: the shared not-found page, with a way on (D4). */
export const NotFound: Story = {
  args: {
    client: {
      ...fakeDashboardClient(),
      get: async () => {
        throw new ApiError(404, { error: 'not_found' });
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { level: 1, name: 'Dashboard not found' }),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Go to Home' })).toBeVisible();
  },
};

/** A dashboard that could not be read for another reason: its header stays, the alert under it. */
export const Failed: Story = {
  args: {
    client: {
      ...fakeDashboardClient(),
      get: async () => {
        throw new ApiError(500, { error: 'internal' });
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(canvas.getByRole('alert')).toHaveTextContent('could not be loaded');
  },
};
