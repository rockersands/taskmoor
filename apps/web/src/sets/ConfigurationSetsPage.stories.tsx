import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, TRACK_ADMIN } from '../admin/fixtures';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { ConfigurationSetsPage } from './ConfigurationSetsPage';
import { fakeSetsClient } from './fixtures';

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

/** A type set open: its types, their order, the preselected one and its default kinds (T-320). */
export const TypeSetOpen: Story = {
  args: { client: fakeSetsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Software types' }));
    await expect(canvas.getByRole('list', { name: 'Order in the set' })).toBeVisible();
    await expect(canvas.getByLabelText('Software tracks')).toBeDisabled();
  },
};

/** A type dropped that tickets still have: the set asks which kept type they take (CORE-005). */
export const DroppedTypeInUse: Story = {
  args: { client: fakeSetsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Software types' }));
    const panel = canvas.getByRole('form', { name: 'Settings of Software types' });
    await userEvent.click(within(panel).getByLabelText('Bug'));
    await userEvent.click(within(panel).getByRole('button', { name: 'Save the set' }));
    await expect(await canvas.findByLabelText('Tickets of Bug become')).toHaveFocus();
  },
};

/** The same question at a phone's width: nothing sticks out sideways. */
export const DroppedTypeAtPhoneWidth: Story = {
  ...DroppedTypeInUse,
  decorators: [atPhoneWidth],
  play: async (context) => {
    await DroppedTypeInUse.play?.(context);
    await fitsPhoneWidth(within(context.canvasElement));
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
    // Its own ticket types come first (T-322).
    await expect(canvas.getByRole('region', { name: 'Its own ticket types' })).toBeVisible();
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

/** The shared sets on a phone, each kind on its card, with what the page is for at the top. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Type sets' })).toBeVisible();
    await expect(canvas.getByText(/^Type sets and field rule sets/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
