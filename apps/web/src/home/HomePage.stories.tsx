import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import type { HomeTicket } from './client';
import { fakeHomeClient, fakeHomeTracks } from './fixtures';
import { HomePage } from './HomePage';

const meta = {
  title: 'Home/HomePage',
  component: HomePage,
  args: { client: fakeHomeClient(), tracks: fakeHomeTracks() },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof HomePage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The tracks the person belongs to, then assigned, opened lately and followed tickets. */
export const Lists: Story = {};

/**
 * A new person: in no track yet, so Your tracks says so and leads to the Tracks page; nothing
 * else yet, and one list that could not be read.
 */
export const EmptyAndFailed: Story = {
  args: {
    client: fakeHomeClient({ empty: ['assigned', 'recent'], failing: ['followed'] }),
    tracks: fakeHomeTracks({ empty: true }),
  },
};

/** In no track, and allowed to make one: New track beside the way to the Tracks page. */
export const NoTrackMayCreate: Story = {
  args: { tracks: fakeHomeTracks({ empty: true }) },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <Story />
      </SessionProvider>
    ),
  ],
};

/** In more tracks than Home shows: six, and a link to all of them on the Tracks page. */
export const ManyTracks: Story = {
  args: {
    tracks: async () =>
      Array.from({ length: 8 }, (_, i) => ({
        id: i + 1,
        key: `TR${i + 1}`,
        name: `Track ${i + 1}`,
        type: 'software',
      })),
  },
};

const followed = (
  id: number,
  summary: string,
  type: string,
  priority: [string, number],
  status: HomeTicket['status'],
): HomeTicket => ({
  id,
  key: `MOB-${id}`,
  summary,
  ticketType: { name: type },
  priority: { name: priority[0], level: priority[1] },
  status,
  track: { key: 'MOB', name: 'Mobile apps' },
  updatedAt: '2026-10-29T08:00:00Z',
});

/**
 * 'You follow' at a desktop width (CORE-019): whatever the summary's length or the status's name,
 * each row's type and priority icons stand in one column, and the statuses in the next.
 */
export const IconsInOneColumn: Story = {
  args: {
    client: {
      ...fakeHomeClient(),
      followed: async () => [
        followed(50, 'Offline mode', 'Feature', ['High', 3], { name: 'New', stage: 'new' }),
        followed(
          53,
          'Push notifications arrive twice after the app is updated',
          'Bug',
          ['Low', 1],
          {
            name: 'In Review',
            stage: 'active',
          },
        ),
        followed(52, 'Dark icons', 'Chore', ['Medium', 2], { name: 'Done', stage: 'closed' }),
      ],
    },
  },
  render: (args) => (
    <div style={{ width: 640 }}>
      <HomePage {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole('region', { name: /You follow/ });
    await within(list).findByText('Offline mode');
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.home-ticket'));
    await expect(rows).toHaveLength(3);
    const lefts = (selector: string) =>
      rows.map((row) => Math.round(row.querySelector(selector)?.getBoundingClientRect().left ?? 0));
    const icons = lefts('.ticket-icons');
    await expect(new Set(icons).size, icons.join()).toBe(1);
    const statuses = lefts('.home-ticket-status');
    await expect(new Set(statuses).size, statuses.join()).toBe(1);
  },
};
