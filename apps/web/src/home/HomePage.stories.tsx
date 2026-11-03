import type { Meta, StoryObj } from '@storybook/react-vite';
import { MEMBER } from '../admin/fixtures';
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

/** Assigned, opened lately and followed tickets. */
export const Lists: Story = {};

/** A new person: nothing yet, and one list that could not be read. */
export const EmptyAndFailed: Story = {
  args: {
    client: fakeHomeClient({ empty: ['assigned', 'recent'], failing: ['followed'] }),
    tracks: fakeHomeTracks({ empty: true }),
  },
};
