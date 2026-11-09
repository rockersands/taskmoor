import type { Meta, StoryObj } from '@storybook/react-vite';
import { CrossTrackState } from './CrossTrackState';
import { StageProgress } from './StageProgress';

const meta = {
  title: 'Releases/CrossTrackState',
  component: CrossTrackState,
  args: { state: 'upcoming' },
} satisfies Meta<typeof CrossTrackState>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each state, in words. */
export const AllStates: Story = {
  render: () => (
    <p style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <CrossTrackState state="empty" />
      <CrossTrackState state="upcoming" />
      <CrossTrackState state="ready" />
      <CrossTrackState state="overdue" />
      <CrossTrackState state="shipped" />
    </p>
  ),
};

const counted = (query: string, count: number) => ({ query, count, exact: true });

/** The bar and legend a release's page and a release across tracks' page share. */
export const Progress: Story = {
  render: () => (
    <StageProgress
      stages={{
        new: counted('crossTrackRelease = 5 AND stage = new', 3),
        active: counted('crossTrackRelease = 5 AND stage = active', 2),
        closed: counted('crossTrackRelease = 5 AND stage = closed', 7),
      }}
    />
  ),
};
