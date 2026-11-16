import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakePeopleClient } from './fixtures';
import { GroupsPage } from './GroupsPage';

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);

/** A group's name, its service accounts, and a directory's group (T-320). */
const meta = {
  title: 'Admin/Groups',
  component: GroupsPage,
  // A client of its own each time: the stories change it, and each runs in both skins.
  render: () => <GroupsPage client={fakePeopleClient({ directoryGroup: true })} />,
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof GroupsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A group open: its name and description first, then a service account added and marked. */
export const ServiceAccountInAGroup: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Approvers' }));
    await expect(
      await canvas.findByRole('form', { name: 'Name and description of Approvers' }),
    ).toBeVisible();
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: 'Add a service account' }),
      'Release bot',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Add the account' }));
    await expect(await canvas.findByText('Release bot is in Approvers now.')).toBeVisible();
    await expect(canvas.getByText('Service account')).toBeVisible();
  },
};

/** A directory keeps the group's name; its description still changes here. */
export const DirectoryGroup: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Engineering' }));
    const form = await canvas.findByRole('form', { name: 'Name and description of Engineering' });
    await expect(form).toHaveTextContent('The directory Corporate directory keeps');
    await expect(within(form).queryByRole('textbox', { name: 'Group name' })).toBeNull();
  },
};

/** A taken name is refused in words. */
export const NameTaken: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Support' }));
    const form = await canvas.findByRole('form', { name: 'Name and description of Support' });
    const name = within(form).getByRole('textbox', { name: 'Group name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Approvers');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'There is a group with that name already.',
    );
  },
};

export const GroupOpenAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage Engineering' }));
    await expect(await canvas.findByText('Members of Engineering')).toBeVisible();
    const box = canvas.getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  },
};
