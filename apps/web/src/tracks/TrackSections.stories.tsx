import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { BOARD } from '../boards/fixtures';
import type { ConfigurationClient } from '../configuration/client';
import { SessionProvider } from '../session/SessionProvider';
import { NoBacklog } from './BoardInTrack';
import { fakeTrackClient } from './fixtures';
import { TrackFilesPage } from './TrackFilesPage';
import { TrackLayout } from './TrackLayout';
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

const mayMakeTracks = {
  status: 'signed-in',
  user: {
    id: 1,
    name: 'Kalo',
    email: 'kalo@example.com',
    isSiteAdmin: true,
    mayCreateLocalTracks: true,
    timeZone: null,
    locale: null,
  },
} as const;
const creator = {
  tracks: async () => [],
  createTrack: async () => ({ track: { key: 'PAY' } }),
} as unknown as ConfigurationClient;

/** The directory of tracks. */
export const Directory: Story = {
  render: () => (
    <main>
      <TracksPage client={fakeTrackClient()} />
    </main>
  ),
};

/** A search of the directory that matches no track says so as an empty state (T-289). */
export const DirectoryFindsNothing: Story = {
  render: () => (
    <main>
      <TracksPage client={fakeTrackClient()} />
    </main>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Find a track'), 'zzz');
    await expect(await canvas.findByText('No track has that name or key.')).toHaveClass(
      'empty-state-title',
    );
  },
};

/** The directory for someone who may make a track. */
export const DirectoryWithNewTrack: Story = {
  render: () => (
    <SessionProvider session={mayMakeTracks}>
      <main>
        <TracksPage client={fakeTrackClient()} creator={creator} />
      </main>
    </SessionProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'New track' })).toBeVisible();
  },
};

/** The form that makes a track, in its dialog. */
export const NewTrackOpen: Story = {
  render: () => (
    <SessionProvider session={mayMakeTracks}>
      <main>
        <TracksPage client={fakeTrackClient()} creator={creator} />
      </main>
    </SessionProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'New track' }));
    // The dialog is drawn at the end of the page's body (shell/OverlayLayer.tsx).
    const dialog = within(within(document.body).getByRole('dialog', { name: 'New track' }));
    await expect(dialog.getByLabelText('Key')).toHaveFocus();
    await expect(dialog.getByRole('button', { name: 'Create track' })).toBeVisible();
  },
};

/** No tracks yet, for someone who may make the first. */
export const EmptyDirectoryOffersIt: Story = {
  render: () => {
    const client = fakeTrackClient();
    client.list = async () => [];
    return (
      <SessionProvider session={mayMakeTracks}>
        <main>
          <TracksPage client={client} creator={creator} />
        </main>
      </SessionProvider>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No tracks yet')).toBeVisible();
    await expect(canvas.getAllByRole('button', { name: 'New track' })).toHaveLength(2);
  },
};

/** A track's files and web links. */
export const FilesAndLinks: Story = {
  render: () => (
    <main>
      <TrackFilesPage trackKey="SHOP" client={fakeTrackClient()} />
    </main>
  ),
};
