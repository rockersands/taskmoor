import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, CONFIG_ADMIN, MEMBER, TRACK_ADMIN } from '../admin/fixtures';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { NotificationPoliciesPage } from './NotificationPoliciesPage';
import { fakePoliciesClient } from './policiesFixtures';

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
  title: 'Admin/Notification policies',
  component: NotificationPoliciesPage,
  args: { client: fakePoliciesClient() },
  decorators: [
    (Story, context) => (
      <SessionProvider session={(context.parameters.session as Session) ?? ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof NotificationPoliciesPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The shared policies, the default first, with the tracks that use each. */
export const Policies: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Manage Payments' })).toBeVisible();
    await expect(canvas.getByText('Default')).toBeVisible();
  },
};

/** One policy open: its rules by event, a rule to add, its name, and Delete. */
export const PolicyOpen: Story = {
  args: { client: fakePoliciesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Payments' }));
    await expect(canvas.getByRole('list', { name: 'Ticket closed' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Delete Payments' })).toBeVisible();
  },
};

/** A rule naming a transition's own event, typed, about to be added. */
export const TypedTransitionEvent: Story = {
  args: { client: fakePoliciesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Payments' }));
    const form = canvas.getByRole('form', { name: 'Add a rule to Payments' });
    await userEvent.selectOptions(
      within(form).getByLabelText('Event'),
      'Another transition event…',
    );
    await userEvent.selectOptions(within(form).getByLabelText('Who hears of it'), 'A person');
    await expect(within(form).getByLabelText('Transition event name')).toBeVisible();
    await expect(within(form).getByRole('searchbox', { name: 'Find a person' })).toBeVisible();
  },
};

/** New policy: the form above the list, starting from the default's rules. */
export const NewPolicy: Story = {
  args: { client: fakePoliciesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'New policy' }));
    await expect(canvas.getByRole('form', { name: 'Add policy' })).toBeVisible();
  },
};

/** The default policy open: it says why it has no Delete. */
export const DefaultOpen: Story = {
  args: { client: fakePoliciesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Manage Default notifications' }),
    );
    await expect(canvas.getByText(/^The default policy cannot be deleted/)).toBeVisible();
  },
};

/** A configuration administrator manages the shared policies too (IAM-009). */
export const ConfigurationAdministrator: Story = {
  args: { client: fakePoliciesClient() },
  parameters: { session: CONFIG_ADMIN },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'New policy' })).toBeVisible();
  },
};

/** Someone who runs OPS, a track with its own configuration, on its own page. */
export const TrackAdministrator: Story = {
  args: { client: fakePoliciesClient(), trackId: 4 },
  parameters: { session: TRACK_ADMIN },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('OPS uses On-call alerts.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Manage On-call alerts' }));
    await expect(canvas.getByRole('list', { name: 'Ticket created' })).toBeVisible();
  },
};

/** The same on a phone. */
export const TrackAdministratorOnAPhone: Story = {
  ...TrackAdministrator,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

/** On the shared page, someone who runs tracks chooses one with its own configuration. */
export const TracksToChoose: Story = {
  args: { client: fakePoliciesClient() },
  parameters: { session: TRACK_ADMIN },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'Notification policies of OPS · Operations' }),
    ).toBeVisible();
  },
};

/** Someone who may not use the page is told only so. */
export const Refused: Story = {
  args: { client: fakePoliciesClient() },
  parameters: { session: MEMBER },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/^Only site and configuration/)).toBeVisible();
  },
};

/** The policies could not be read: the header stays, with the failure under it. */
export const LoadFailed: Story = {
  args: { client: fakePoliciesClient({ fail: 'load' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 1 })).toBeVisible();
  },
};

/** A policy open on a phone, with its rule form: nothing sticks out sideways. */
export const AtPhoneWidth: Story = {
  args: { client: fakePoliciesClient() },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Payments' }));
    await expect(canvas.getByRole('form', { name: 'Add a rule to Payments' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
