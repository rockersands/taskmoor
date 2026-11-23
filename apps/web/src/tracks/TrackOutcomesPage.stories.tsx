import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import type { TrackOutcome } from './client';
import { fakeTrackClient, managedOutcomes, outcomePages, SHOP_OUTCOMES } from './fixtures';
import { TrackLayout } from './TrackLayout';
import { TrackOutcomesPage } from './TrackOutcomesPage';

/** The page over outcomes its manage panel changes, fresh each time it is drawn (T-082). */
function Managed({ outcomes = SHOP_OUTCOMES }: { outcomes?: TrackOutcome[] }) {
  const [state] = useState(() => {
    const made = managedOutcomes(outcomes);
    const client = fakeTrackClient();
    client.outcomes = made.outcomes;
    return { client, manager: made.manager };
  });
  return <TrackOutcomesPage trackKey="SHOP" client={state.client} manager={state.manager} />;
}

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
      await within(canvasElement).findByText(/None of this track’s ticket types/),
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

/**
 * The manage panel, on any track type (T-082): a new outcome, then one moved up, edited and
 * closed, each through the ticket routes.
 */
export const Managing: Story = {
  render: () => <Managed />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage outcomes' }));
    const panel = canvas.getByRole('region', { name: 'Manage outcomes' });
    await userEvent.type(within(panel).getByLabelText('Summary'), 'Loyalty points{Enter}');
    await expect(await canvas.findByText('Created SHOP-60.')).toBeVisible();
    const row = () => canvas.getByRole('group', { name: 'Manage SHOP-60' });
    await userEvent.click(within(row()).getByRole('button', { name: 'Move up' }));
    await expect(await canvas.findByText('Moved SHOP-60 up.')).toBeVisible();
    await userEvent.click(within(row()).getByRole('button', { name: 'Edit' }));
    await expect(canvas.getByRole('form', { name: 'Edit SHOP-60' })).toBeVisible();
  },
};

/** Closing asks how when the workflow offers more than one way. */
export const ManagingAClose: Story = {
  render: () => <Managed />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage outcomes' }));
    await userEvent.click(
      within(canvas.getByRole('group', { name: 'Manage SHOP-51' })).getByRole('button', {
        name: 'Close',
      }),
    );
    await expect(await canvas.findByText('Closed SHOP-51.')).toBeVisible();
  },
};

/** No outcomes yet, for someone who may create one: the panel is a press away. */
export const EmptyForAManager: Story = {
  render: () => <Managed outcomes={[]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'New outcome' }));
    await expect(canvas.getByRole('textbox', { name: 'Summary' })).toHaveFocus();
  },
};

/** The panel on a phone: the tools wrap under each outcome, nothing scrolls sideways. */
export const ManagingOnAPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  render: () => <Managed />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage outcomes' }));
    await userEvent.click(
      within(canvas.getByRole('group', { name: 'Manage SHOP-50' })).getByRole('button', {
        name: 'Edit',
      }),
    );
    const page = canvasElement.ownerDocument.documentElement;
    await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
  },
};

/** A finger reaches every tool of the panel (ADR-033). */
export const ManagingOnATouchScreen: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
  render: () => <Managed />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage outcomes' }));
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.track-outcomes-new input',
        '.track-outcomes-new button',
        '.track-outcome-tools button',
      ]),
    ).toEqual([]);
  },
};
