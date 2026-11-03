import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { fakeTrackClient } from './fixtures';
import { TrackFilesPage } from './TrackFilesPage';
import { TrackLayout } from './TrackLayout';
import { TrackNavList } from './TrackNavList';
import { TracksPage } from './TracksPage';

const meta = {
  title: 'Tracks/Sections',
  component: TrackLayout,
  args: { trackKey: 'SHOP', section: 'board', children: <p>The section's page.</p> },
} satisfies Meta<typeof TrackLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One tab bar shared by every page of a track. */
export const Tabs: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Board' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};

/** The directory of tracks. */
export const Directory: Story = {
  render: () => (
    <main>
      <TracksPage client={fakeTrackClient()} />
    </main>
  ),
};

/** The tracks under "Tracks" in the sidebar, the current one marked. */
export const InTheSidebar: Story = {
  render: () => (
    <nav aria-label="Main">
      <TrackNavList hash="#/tracks/SHOP/board" client={fakeTrackClient()} />
    </nav>
  ),
};

/** A track's files and web links. */
export const FilesAndLinks: Story = {
  render: () => (
    <main>
      <TrackFilesPage trackKey="SHOP" client={fakeTrackClient()} />
    </main>
  ),
};
