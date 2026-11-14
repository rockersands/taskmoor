import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakeTrackClient } from '../tracks/fixtures';
import { fakeCrossTrackClient } from './crossTrackFixtures';
import { fakeReleaseClient } from './fixtures';
import { ReleasePage } from './ReleasePage';

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
};

const meta = {
  title: 'Releases/ReleasePage',
  component: ReleasePage,
  args: {
    releaseId: 2,
    client: fakeReleaseClient({ approver: true }),
    crossTrack: fakeCrossTrackClient(),
    now: () => new Date('2026-10-30T09:00:00Z'),
    tracks: fakeTrackClient(),
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof ReleasePage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An overdue release: progress by stage, warnings, an approver's choice and shipping. */
export const Upcoming: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '2.0' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Warnings' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Ship this release…' })).toBeVisible();
  },
};

/** A shipped release with its generated notes. */
export const Shipped: Story = {
  args: { releaseId: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Feature', level: 3 })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Copy as Markdown' })).toBeVisible();
  },
};

/** Someone who may read the release but neither ship nor approve it. */
export const ReadOnly: Story = {
  args: { client: fakeReleaseClient({ mayManage: false }) },
};

/** At a phone's width: the state above the title, the sections one under another. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '2.0' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** A release that is not there, or not for this person: a not-found page with a way on (D4). */
export const NotFound: Story = {
  args: {
    client: {
      ...fakeReleaseClient(),
      get: async () => {
        throw new ApiError(404, { error: 'not_found' });
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Release not found', level: 1 }),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Go to Home' })).toBeVisible();
  },
};

/** A finger reaches each ticket of the release (ADR-033). */
export const OnATouchScreen: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('table');
    await expect(
      tooSmallForAFinger(canvasElement, ['.release-table a', '.release-legend a']),
    ).toEqual([]);
  },
};

/** A finger reaches the release across tracks in its facts (ADR-033). */
export const LinkedOnATouchScreen: Story = {
  args: { releaseId: 3, client: fakeReleaseClient({ linked: true }) },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('link', { name: 'Spring launch' });
    await expect(tooSmallForAFinger(canvasElement, ['.release-facts a'])).toEqual([]);
  },
};

/**
 * A release with no closed tickets yet (D27; PLN-007): "Add to a release across tracks…" is a
 * normal button, not a bar across the card, and empty notes offer no Markdown.
 */
export const NothingClosedYet: Story = {
  args: { releaseId: 3 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const add = await canvas.findByRole('button', { name: 'Add to a release across tracks…' });
    const card = add.closest('section')?.getBoundingClientRect();
    if (!card) throw new Error('the button is in its section');
    await expect(add.getBoundingClientRect().width).toBeLessThan(card.width / 2);
    const notes = within(canvas.getByRole('region', { name: 'Release notes' }));
    await expect(notes.queryByRole('button', { name: 'Copy as Markdown' })).toBeNull();
  },
};

/** In a release across tracks on another day: said in words, with Align for its administrators. */
export const OutOfStep: Story = {
  args: { releaseId: 3, client: fakeReleaseClient({ linked: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Spring launch' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: /Align to/ })).toBeVisible();
  },
};
