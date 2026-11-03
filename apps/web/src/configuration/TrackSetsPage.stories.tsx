import type { Meta, StoryObj } from '@storybook/react-vite';
import { CONFIG_ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { TrackSetsPage } from './TrackSetsPage';
import { fakeTrackSetsClient } from './trackSetsFixtures';

const meta = {
  title: 'Admin/TrackSets',
  component: TrackSetsPage,
  args: { client: fakeTrackSetsClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={CONFIG_ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof TrackSetsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A shared-mode track, as a configuration administrator sees it. */
export const SharedTrack: Story = {};

/** A local-mode track, with sets of its own among the choices. */
export const LocalTrack: Story = { args: { initialTrackId: 4 } };

/** No tracks yet. */
export const Empty: Story = { args: { client: fakeTrackSetsClient([]) } };
