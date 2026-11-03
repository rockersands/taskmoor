import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { TrackOutcome } from './client';
import { fakeTrackClient, outcomePages, SHOP_OUTCOMES } from './fixtures';
import { TrackLayout } from './TrackLayout';
import { TrackOutcomesPage } from './TrackOutcomesPage';

const withOutcomes = (outcomes: TrackOutcome[], size = 100, types = ['Outcome']) => {
  const client = fakeTrackClient();
  client.outcomes = outcomePages(outcomes, size, types);
  return client;
};

const meta = {
  title: 'Tracks/TrackOutcomesPage',
  component: TrackOutcomesPage,
  args: { trackKey: 'SHOP', client: fakeTrackClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof TrackOutcomesPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each outcome with its status, progress and dates: open ones first, the closed one last. */
export const Outcomes: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'SHOP-50 Card payments in every market' }),
    ).toHaveAttribute('href', '#/tickets/SHOP-50');
    await expect(canvas.getByRole('progressbar', { name: '5 of 8 closed (63%)' })).toBeVisible();
    await expect(canvas.getByText('No tickets under it yet')).toBeVisible();
  },
};

/** In its track, under the Outcomes tab. */
export const InTheTrack: Story = {
  render: (args) => (
    <TrackLayout trackKey="SHOP" section="outcomes" client={fakeTrackClient()}>
      <TrackOutcomesPage {...args} />
    </TrackLayout>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Outcomes' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};

/** More than a page: the next comes on asking. */
export const MorePages: Story = {
  args: {
    client: withOutcomes(
      [...SHOP_OUTCOMES.slice(0, 3), ...SHOP_OUTCOMES.slice(0, 3)].map((o, i) => ({
        ...o,
        id: o.id + i * 10,
        key: `SHOP-${60 + i}`,
      })),
      3,
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Show more outcomes' }));
    await expect(await canvas.findByRole('link', { name: /^SHOP-65 / })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Show more outcomes' })).toBeNull();
  },
};

/** No outcomes yet: what one is, and which type makes one. */
export const Empty: Story = {
  args: { client: withOutcomes([]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No outcomes yet')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Create a ticket' })).toBeVisible();
  },
};

/** A track whose types have none at the outcome level. */
export const NoOutcomeType: Story = {
  args: { client: withOutcomes([], 100, []) },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText(/None of this track's ticket types/),
    ).toBeVisible();
  },
};

/** A phone: the progress goes under the name, and nothing scrolls sideways. */
export const OnAPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'SHOP-50 Card payments in every market' }),
    ).toBeVisible();
    const page = canvasElement.ownerDocument.documentElement;
    await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
  },
};
