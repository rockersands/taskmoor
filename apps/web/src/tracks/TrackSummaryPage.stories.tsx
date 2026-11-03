import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CUSTOM_WIDGETS, fakeTrackClient, SHOP_SUMMARY } from './fixtures';
import { TrackSummaryPage } from './TrackSummaryPage';

const CUSTOM = { layout: 'two' as const, version: 1, widgets: CUSTOM_WIDGETS };

const meta = {
  title: 'Tracks/TrackSummaryPage',
  component: TrackSummaryPage,
  args: { trackKey: 'SHOP', client: fakeTrackClient(), checkQuery: async () => true },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof TrackSummaryPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Open, new, closed and due tickets, and the open ones by stage, priority, type and person. */
export const Summary: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Open by assignee' })).toBeVisible();
  },
};

export const NotFound: Story = { args: { client: fakeTrackClient(null) } };

/** The widgets chosen for the track, as anyone who may only read it sees them. */
export const CustomizedForAViewer: Story = {
  args: { client: fakeTrackClient(SHOP_SUMMARY, { custom: CUSTOM }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('article', { name: 'Open bugs' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Customize' })).toBeNull();
  },
};

/** What the track's owner and administrators can change, while they change it. */
export const Customizing: Story = {
  args: { client: fakeTrackClient(SHOP_SUMMARY, { custom: CUSTOM, mayCustomize: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Customize' }));
    await expect(await canvas.findByRole('button', { name: 'Save the summary' })).toBeVisible();
  },
};

/** Before anyone customized it, for someone who may. */
export const DefaultForAnAdministrator: Story = {
  args: { client: fakeTrackClient(SHOP_SUMMARY, { mayCustomize: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Customize' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Back to the default' })).toBeNull();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const PhoneCustomizing: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  args: { client: fakeTrackClient(SHOP_SUMMARY, { custom: CUSTOM, mayCustomize: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Customize' }));
    await expect(await canvas.findByRole('button', { name: 'Save the summary' })).toBeVisible();
  },
};
