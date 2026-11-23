import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakePermissionsClient } from './fixtures';
import { PermissionsPage } from './PermissionsPage';
import { VisibilityPage } from './VisibilityPage';
import { fakeVisibilityClient } from './visibilityFixtures';

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);

/**
 * People in field and Groups in field (IAM-010, IAM-011; T-320): a grant or a level's member
 * that names a user or group field of the ticket, chosen by the field's name.
 */
const meta = {
  title: 'Admin/Field grantees',
  component: PermissionsPage,
  // A client of its own each time: the stories change it, and each runs in both skins.
  render: () => <PermissionsPage client={fakePermissionsClient()} />,
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof PermissionsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A policy's grants, one to the people in its Reviewer field, and the form at that kind. */
export const PeopleInField: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Manage Default access policy' }),
    );
    await expect(await canvas.findByText('People in field Reviewer')).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'New permission in Default access policy' }),
    );
    const form = canvas.getByRole('form', { name: 'Give a permission in Default access policy' });
    await userEvent.selectOptions(within(form).getByLabelText('To'), 'People in a user field');
    await expect(within(form).getByRole('combobox', { name: 'User field' })).toHaveValue('cf[31]');
  },
};

/** No field of the kind yet: the choice says so. */
export const NoFieldOfTheKind: Story = {
  render: () => <PermissionsPage client={{ ...fakePermissionsClient(), fields: async () => [] }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Manage Default access policy' }),
    );
    await userEvent.click(
      await canvas.findByRole('button', { name: 'New permission in Default access policy' }),
    );
    const form = canvas.getByRole('form', { name: 'Give a permission in Default access policy' });
    await userEvent.selectOptions(within(form).getByLabelText('To'), 'Groups in a group field');
    await expect(within(form).getByRole('combobox', { name: 'Group field' })).toHaveTextContent(
      'No field of this kind yet',
    );
  },
};

/** A visibility level whose members include the people in a user field. */
export const LevelWithFieldMembers: Story = {
  render: () => <VisibilityPage client={fakeVisibilityClient()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const internal = await canvas.findByRole('list', { name: 'Members of Internal' });
    await expect(within(internal).getByText('People in field Reviewer')).toBeVisible();
    const form = canvas.getByRole('form', { name: 'Add a member to Security' });
    await userEvent.selectOptions(within(form).getByLabelText('Who'), 'Groups in a group field');
    await expect(within(form).getByRole('combobox', { name: 'Group field' })).toHaveValue('cf[32]');
  },
};

export const PeopleInFieldAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Manage Default access policy' }),
    );
    await userEvent.click(
      await canvas.findByRole('button', { name: 'New permission in Default access policy' }),
    );
    const form = canvas.getByRole('form', { name: 'Give a permission in Default access policy' });
    await userEvent.selectOptions(within(form).getByLabelText('To'), 'People in a user field');
    const box = canvas.getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  },
};
