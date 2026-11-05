import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CrossTrackReleasesPage } from './CrossTrackReleasesPage';
import { fakeCrossTrackClient } from './crossTrackFixtures';

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
  title: 'Releases/CrossTrackReleasesPage',
  component: CrossTrackReleasesPage,
  args: { client: fakeCrossTrackClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof CrossTrackReleasesPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One upcoming: its end, its state in words, the tracks seen and what is hidden. */
export const Upcoming: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Spring launch' })).toBeVisible();
    await expect(canvas.getByText(/1 release hidden from you/)).toBeVisible();
  },
};

/** Nothing yet: the page says what one is for. */
export const Empty: Story = {
  args: { client: fakeCrossTrackClient({ empty: true }) },
};

/** One whose releases have all shipped. */
export const Shipped: Story = {
  args: { client: fakeCrossTrackClient({ shipped: true }) },
};

/** The new dialog: a name, an end, and releases to tick. */
export const Making: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'New release across tracks' }));
    const dialog = await within(document.body).findByRole('dialog');
    await expect(
      await within(dialog).findByRole('checkbox', { name: /Website 3\.0/ }),
    ).toBeVisible();
  },
};

/** The server refused: the page says so in words. */
export const Failed: Story = {
  args: {
    client: {
      ...fakeCrossTrackClient(),
      list: async () => {
        throw new Error('down');
      },
    },
  },
};

/** At a phone's width each row is a card. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Spring launch' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
