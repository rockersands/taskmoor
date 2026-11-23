import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, CONFIG_ADMIN, TRACK_ADMIN } from '../admin/fixtures';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { PermissionExplainerPage } from './PermissionExplainerPage';
import { VisibilityPage } from './VisibilityPage';
import { fakeExplainClient, fakeVisibilityClient } from './visibilityFixtures';

const meta = {
  title: 'Admin/VisibilityPolicies',
  component: VisibilityPage,
  args: { client: fakeVisibilityClient() },
  decorators: [
    (Story, context) => (
      <SessionProvider session={(context.parameters.session as Session) ?? ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof VisibilityPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A policy in use with two levels, and one no track uses. */
export const Policies: Story = {};

/** A level just added has no members yet, and says so as an empty state (T-289). */
export const LevelWithNoMembers: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const spare = await page.findByRole('region', { name: 'Spare' });
    const add = within(spare).getByRole('form', { name: 'Add a level to Spare' });
    await userEvent.type(within(add).getByLabelText('Level name'), 'Counsel');
    await userEvent.click(within(add).getByRole('button', { name: 'Add a level' }));
    await expect(await within(spare).findByText(/^No members yet/)).toHaveClass(
      'empty-state-title',
    );
  },
};

/** No policy yet: what one is for. */
export const Empty: Story = { args: { client: fakeVisibilityClient([]) } };

/**
 * The explainer's Explain button is as wide as its words, like every other form's submit, not the
 * width of the form (S3-AC-3).
 */
export const ExplainButtonContentWidth: Story = {
  render: () => (
    <div style={{ width: 760 }}>
      <PermissionExplainerPage client={fakeExplainClient()} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const form = await page.findByRole('form', { name: 'Ask why' });
    const button = within(form).getByRole('button', { name: 'Explain' });
    const field = within(form).getByLabelText('Ticket key (optional)');
    await expect(button.getBoundingClientRect().width).toBeLessThan(
      field.getBoundingClientRect().width / 2,
    );
  },
};

/** A configuration administrator manages the shared policies too (T-322). */
export const ForAConfigurationAdministrator: Story = {
  parameters: { session: CONFIG_ADMIN },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole('region', { name: 'Spare' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New visibility policy' })).toBeVisible();
  },
};

/** A local-mode track's own policies, for someone who runs it, with the one to use (T-322). */
export const TrackOwnPolicies: Story = {
  args: { client: fakeVisibilityClient(), trackId: 4 },
  parameters: { session: TRACK_ADMIN },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const own = await page.findByRole('region', { name: 'Night desk' });
    await expect(
      within(own).getByRole('button', { name: 'Use this policy for OPS' }),
    ).toBeVisible();
    await expect(page.queryByRole('region', { name: 'Company levels' })).toBeNull();
  },
};

/** Someone who runs tracks, on the shared page: the tracks of their own to choose from. */
export const ChooseATrack: Story = {
  parameters: { session: TRACK_ADMIN },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(
      await page.findByRole('link', { name: 'Visibility policies of OPS · Operations' }),
    ).toBeVisible();
  },
};

/** The explainer, asked about a ticket a level hides. */
export const Explainer: Story = {
  render: () => <PermissionExplainerPage client={fakeExplainClient()} />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const form = await page.findByRole('form', { name: 'Ask why' });
    await userEvent.type(within(form).getByLabelText('Ticket key (optional)'), 'SHOP-9');
    await userEvent.click(within(form).getByRole('button', { name: 'Explain' }));
    await expect(await page.findByText(/SHOP-9 is at the level Security/)).toBeVisible();
  },
};
