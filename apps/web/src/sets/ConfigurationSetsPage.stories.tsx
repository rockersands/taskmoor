import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, TRACK_ADMIN } from '../admin/fixtures';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { ConfigurationSetsPage } from './ConfigurationSetsPage';
import { fakeSetsClient } from './fixtures';

const meta = {
  title: 'Admin/Configuration sets',
  component: ConfigurationSetsPage,
  args: { client: fakeSetsClient() },
  decorators: [
    (Story, context) => (
      <SessionProvider session={(context.parameters.session as Session) ?? ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof ConfigurationSetsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Type sets and field rule sets. */
export const Sets: Story = {};

/** The default rule set open: every field with its rule. */
export const RuleSetOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Manage Default field rules' }),
    );
    await expect(await canvas.findByRole('group', { name: 'Customer' })).toBeVisible();
  },
};

/**
 * Someone who runs OPS, a track with its own configuration, on its own page (T-163a): its type
 * set, whose types they choose, and the rule set it owns, open, with the offer to use it.
 */
export const TrackAdministrator: Story = {
  args: { client: fakeSetsClient(), trackId: 4 },
  parameters: { session: TRACK_ADMIN },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Ops rules' }));
    await expect(await canvas.findByRole('group', { name: 'Ops notes' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Use this set for OPS' })).toBeVisible();
    await expect(canvas.queryByText('Default field rules')).toBeNull();
  },
};

/** The same on a phone. */
export const TrackAdministratorOnAPhone: Story = {
  ...TrackAdministrator,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

/** On the shared page, someone who runs tracks chooses one with its own configuration. */
export const TracksToChoose: Story = {
  parameters: { session: TRACK_ADMIN },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'Configuration sets of OPS · Operations' }),
    ).toBeVisible();
  },
};
