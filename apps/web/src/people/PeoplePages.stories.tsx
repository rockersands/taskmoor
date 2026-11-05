import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakePeopleClient, fakeTeamsClient } from './fixtures';
import { GroupsPage } from './GroupsPage';
import { TeamsPage } from './TeamsPage';
import { UsersPage } from './UsersPage';

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

/** A search that finds nobody says what to try. */
export const NobodyMatches: Story = {
  args: { client: { ...fakePeopleClient(), users: async () => ({ users: [], total: 0 }) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Nobody matches.')).toBeVisible();
    await expect(canvas.getByText(/^Try another name/)).toBeVisible();
  },
};

/** Someone who may not be here is not told what the page is for. */
export const NotAnAdministratorHasNoPurposeLine: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText(/^Add people, make site/)).toBeNull();
  },
};

/** People on a phone, with the form to add someone open. */
export const PeopleAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Add a person' }));
    await expect(await canvas.findByText('Grace Hopper')).toBeVisible();
    await expect(canvas.getByText(/^Add people, make site/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

export const NoGroupsYet: Story = {
  render: () => <GroupsPage client={{ ...fakePeopleClient(), groups: async () => [] }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No groups yet.')).toBeVisible();
    await expect(canvas.getByText(/^A group gathers people/)).toBeVisible();
  },
};

export const GroupsAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  render: () => <GroupsPage client={fakePeopleClient()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Approvers' }));
    await expect(await canvas.findByText('Members of Approvers')).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

export const NoTeamsYet: Story = {
  render: () => <TeamsPage client={{ ...fakeTeamsClient(), teams: async () => [] }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No teams yet.')).toBeVisible();
    await expect(canvas.getByText(/^A team says who works together/)).toBeVisible();
  },
};

export const TeamsAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  render: () => <TeamsPage client={fakeTeamsClient()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Platform' }));
    await expect(await canvas.findByText('Members of Platform')).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
