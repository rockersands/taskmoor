import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakePeopleClient, fakeTeamsClient } from './fixtures';
import { GroupsPage } from './GroupsPage';
import { TeamsPage } from './TeamsPage';
import { UsersPage } from './UsersPage';

const meta = {
  title: 'Admin/People',
  component: UsersPage,
  args: { client: fakePeopleClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof UsersPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** People: site administrators, deactivated people, and the actions on each. */
export const People: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Grace Hopper')).toBeVisible();
  },
};

/** Adding someone: the form, then the one-time link to send them. */
export const AddingSomeone: Story = {
  args: { client: fakePeopleClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Add a person' }));
    await userEvent.type(canvas.getByLabelText('Name'), 'Mo Chen');
    await userEvent.type(canvas.getByLabelText('Email'), 'mo@example.com');
    await userEvent.click(canvas.getByRole('button', { name: 'Add' }));
    await expect(await canvas.findByRole('textbox', { name: 'Link for Mo Chen' })).toBeVisible();
  },
};

/** A person's data (ASVS 8.3.2): the Data panel, and erasing confirmed by their email. */
export const ErasingSomeone: Story = {
  args: { client: fakePeopleClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Data of Bo Rivera' }));
    await expect(await canvas.findByText('Data of Bo Rivera')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Erase Bo Rivera' }));
    await userEvent.type(canvas.getByLabelText('Type bo@example.com to confirm'), 'bo@example.com');
    await userEvent.click(canvas.getByRole('button', { name: 'Erase permanently' }));
    await expect(await canvas.findByText(/they are Former user 2 from now on/)).toBeVisible();
  },
};

export const NotAnAdministrator: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
};

/** Groups, one open with its members and the groups it could hold. */
export const Groups: Story = {
  render: () => <GroupsPage client={fakePeopleClient()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Approvers' }));
    await expect(await canvas.findByText('Members of Approvers')).toBeVisible();
  },
};

/** Teams (M1-123), one open: its name, description and lead, its members, and delete. */
export const Teams: Story = {
  render: () => <TeamsPage client={fakeTeamsClient()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Platform' }));
    await expect(await canvas.findByText('Members of Platform')).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: 'Lead' })).toHaveValue('3');
  },
};
