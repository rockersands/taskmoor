import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { asOnATouchScreen, tooSmallForAFinger } from '../test/touch';
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
    await expect(await canvas.findByRole('heading', { name: 'Checkout 2.0' })).toBeVisible();
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
    await expect(await canvas.findByRole('heading', { name: 'Checkout 2.0' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** A release that is not there, or not for this person: the page still says what it is. */
export const NotFound: Story = {
  args: {
    client: {
      ...fakeReleaseClient(),
      get: async () => {
        throw new Error('not found');
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Releases', level: 1 })).toBeVisible();
  },
};

/** A finger reaches each ticket of the release (ADR-033). */
export const OnATouchScreen: Story = {
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('table');
    await expect(
      tooSmallForAFinger(canvasElement, ['.release-table a', '.release-legend a']),
    ).toEqual([]);
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
