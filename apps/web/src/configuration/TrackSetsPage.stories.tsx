import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, CONFIG_ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { TrackSetsPage } from './TrackSetsPage';
import { fakeTrackSetsClient } from './trackSetsFixtures';

const meta = {
  title: 'Admin/TrackSets',
  component: TrackSetsPage,
  args: { client: fakeTrackSetsClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={CONFIG_ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof TrackSetsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A shared-mode track, as a configuration administrator sees it. */
export const SharedTrack: Story = {};

/** A local-mode track, with sets of its own among the choices. */
export const LocalTrack: Story = { args: { initialTrackId: 4 } };

/** No tracks yet. */
export const Empty: Story = { args: { client: fakeTrackSetsClient([]) } };

/**
 * A shared-mode track switching to a type set that lacks types its tickets have: the page asks
 * which type each one's tickets take, at its level (CORE-005 (2); T-322).
 */
export const TypeSetMapping: Story = {
  // A client of its own each time: a save changes it, and the story runs in both skins.
  render: () => <TrackSetsPage client={fakeTrackSetsClient()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const form = await canvas.findByRole('form', { name: 'Sets of SHOP' });
    await userEvent.selectOptions(within(form).getByLabelText('Type set'), 'Support types');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    const question = await within(form).findByRole('group', {
      name: 'Tickets of the types Support types lacks',
    });
    await expect(
      within(question).getByRole('combobox', { name: 'Tickets of Bug become' }),
    ).toHaveFocus();
    await expect(
      within(question).getByText(/^Support types has no type at the Outcome level/),
    ).toBeVisible();
  },
};

/** A site administrator also has the way to the page that makes access policies. */
export const SiteAdministrator: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <Story />
      </SessionProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'Make and change access policies on Permissions.' }),
    ).toBeVisible();
  },
};

/** A finger reaches the links to the pages that make priority sets and policies (ADR-033). */
export const OnATouchScreen: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('link', { name: 'Make and change priority sets on Priorities.' });
    await expect(tooSmallForAFinger(canvasElement, ['.form-hint-link a'])).toEqual([]);
  },
};
