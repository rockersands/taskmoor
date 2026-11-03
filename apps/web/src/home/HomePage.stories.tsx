import type { Meta, StoryObj } from '@storybook/react-vite';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
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
