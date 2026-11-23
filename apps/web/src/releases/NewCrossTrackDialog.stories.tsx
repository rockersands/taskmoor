import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakeCrossTrackClient } from './crossTrackFixtures';
import { NewCrossTrackDialog } from './NewCrossTrackDialog';

const meta = {
  title: 'Releases/NewCrossTrackDialog',
  component: NewCrossTrackDialog,
  args: { client: fakeCrossTrackClient(), onMade: () => {}, onClose: () => {} },
} satisfies Meta<typeof NewCrossTrackDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A name, an end, and the upcoming releases of tracks the person administers. */
export const WithCandidates: Story = {
  play: async () => {
    const dialog = await within(document.body).findByRole('dialog');
    await expect(await within(dialog).findByRole('checkbox', { name: /Shop 2\.1/ })).toBeVisible();
  },
};

/** A list that stops at its limit: a word goes to the server for the rest. */
export const StopsShort: Story = {
  args: { client: fakeCrossTrackClient({ stopsShort: true }) },
  play: async () => {
    const dialog = await within(document.body).findByRole('dialog');
    await expect(await within(dialog).findByText(/The list stops at 500/)).toBeVisible();
  },
};

/** A finger reaches each way to end it and each release to tick (ADR-033). */
export const OnATouchScreen: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
  play: async () => {
    const dialog = await within(document.body).findByRole('dialog');
    await within(dialog).findByRole('checkbox', { name: /Shop 2\.1/ });
    await expect(
      tooSmallForAFinger(dialog, ['label.form-field-inline', '.cross-track-candidates label']),
    ).toEqual([]);
  },
};

/** Someone who administers no track has nothing to link, and is told why. */
export const NothingToLink: Story = {
  args: {
    client: {
      ...fakeCrossTrackClient(),
      candidates: async () => ({ releases: [], truncated: false }),
    },
  },
  play: async () => {
    const dialog = await within(document.body).findByRole('dialog');
    await expect(await within(dialog).findByText('No release to link')).toBeVisible();
  },
};
