import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { BOARD } from '../boards/fixtures';
import { NoBacklog } from './BoardInTrack';
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

/** One tab bar shared by every page of a track. A Scrum track has a Backlog. */
export const Tabs: Story = {
  args: { client: fakeTrackClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Board' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(await canvas.findByRole('link', { name: 'Backlog' })).toBeVisible();
  },
};

/** A Kanban track has no Backlog tab at all. */
export const KanbanTabs: Story = {
  args: {
    trackKey: 'KAN',
    client: fakeTrackClient(undefined, { sections: { backlog: false, sprints: false } }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Statistics' })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'Backlog' })).toBeNull();
  },
};

/** The address of a backlog on a track that has none. */
export const NoBacklogHere: Story = {
  render: () => (
    <main>
      <NoBacklog board={{ ...BOARD, mayConfigure: true }} />
    </main>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Open the board' })).toBeVisible();
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
