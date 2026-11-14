import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakeReleaseClient } from './fixtures';
import { ReleasesPage } from './ReleasesPage';

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
  title: 'Releases/ReleasesPage',
  component: ReleasesPage,
  args: { trackKey: 'CHK', client: fakeReleaseClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof ReleasesPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Upcoming, shipped and archived releases, with the form to add one. */
export const Hub: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Releases' })).toBeVisible();
    await expect(canvas.getByText('Overdue')).toBeVisible();
    await expect(canvas.getByRole('form', { name: 'New release' })).toBeVisible();
  },
};

/** Someone who may only read the track's releases. */
export const ReadOnly: Story = {
  args: { client: fakeReleaseClient({ mayManage: false }) },
};

/** At a phone's width, with the form and the rows one under another. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('form', { name: 'New release' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** A track with no release yet: what a release is, and where the first one comes from. */
export const NoneYet: Story = {
  args: {
    client: {
      ...fakeReleaseClient(),
      list: async () => ({ mayManage: true, releases: [] }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No upcoming releases.')).toBeVisible();
    await expect(canvas.getByText(/^A release gathers the tickets/)).toBeVisible();
    await expect(canvas.getByText('Nothing shipped yet.')).toBeVisible();
  },
};

/** A track that is not there, or not for this person: the page still says what it is. */
export const NotFound: Story = {
  args: {
    client: {
      ...fakeReleaseClient(),
      track: async () => {
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

/** A finger reaches the release across tracks a release is in (ADR-033). */
export const LinkedOnATouchScreen: Story = {
  args: { client: fakeReleaseClient({ linked: true }) },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('link', { name: /Spring launch/ });
    await expect(tooSmallForAFinger(canvasElement, ['.release-cross-track'])).toEqual([]);
  },
};

/** A finger reaches each release and the fold-out of the archived ones (ADR-033). */
export const OnATouchScreen: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(/archived release/);
    await expect(
      tooSmallForAFinger(canvasElement, ['.release-name', '.release-group summary']),
    ).toEqual([]);
  },
};
