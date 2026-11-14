import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { textLines } from '../admin/textLines';
import { SessionProvider } from '../session/SessionProvider';
import { fakePeopleClient, fakeTeamsClient, manyPeople } from './fixtures';
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

/** The page's width beside Administration's list on a 1280 px screen. */
const atDesktopPageWidth = (Story: () => ReactElement) => (
  <div style={{ width: 638 }}>
    <Story />
  </div>
);

/**
 * At a desktop's page width each person's five actions stay on one line, 'Erase…' included; it
 * once wrapped onto a line of its own in every row.
 */
export const ActionsOnOneLine: Story = {
  decorators: [atDesktopPageWidth],
  // Bo is a site administrator too, so his row offers the longest wording, 'Remove site
  // administrator'.
  args: {
    client: (() => {
      const base = fakePeopleClient();
      return {
        ...base,
        users: async (...query: Parameters<typeof base.users>) => {
          const found = await base.users(...query);
          return {
            ...found,
            users: found.users.map((u) => (u.id === 2 ? { ...u, isSiteAdmin: true } : u)),
          };
        },
      };
    })(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Grace Hopper');
    const rows = canvasElement.querySelectorAll('.people-list-users .people-actions');
    const lines = [...rows].map(
      (row) =>
        new Set([...row.children].map((b) => Math.round(b.getBoundingClientRect().top))).size,
    );
    await expect([...rows].some((row) => row.querySelectorAll('button').length === 5)).toBe(true);
    await expect(lines.filter((n) => n !== 1)).toEqual([]);
  },
};

/**
 * The "New …" button has one place on every administration page (D11): under the title and its
 * purpose line, at the start, whether the purpose line is short (Groups) or long (Teams).
 */
export const NewButtonUnderThePurposeLine: Story = {
  decorators: [atDesktopPageWidth],
  render: () => (
    <>
      <GroupsPage client={fakePeopleClient()} />
      <TeamsPage client={fakeTeamsClient()} />
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of ['New group', 'New team']) {
      const button = await canvas.findByRole('button', { name });
      const header = button.closest('header') as HTMLElement;
      const title = within(header).getByRole('heading', { level: 1 });
      const purpose = header.querySelector('.page-purpose') as HTMLElement;
      await expect(Math.round(button.getBoundingClientRect().left)).toBe(
        Math.round(title.getBoundingClientRect().left),
      );
      await expect(button.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        purpose.getBoundingClientRect().bottom,
      );
    }
  },
};

/** Adding someone: the form, then the one-time link to send them. */
export const AddingSomeone: Story = {
  args: { client: fakePeopleClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'New person' }));
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
    await userEvent.click(await canvas.findByRole('button', { name: 'New person' }));
    await expect(await canvas.findByText('Grace Hopper')).toBeVisible();
    await expect(canvas.getByText(/^Add people, make site/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/**
 * On a phone each person's last sign-in stays on one line, whatever the length of the address
 * before it: it broke inside the date, 'Nov / 14, 2026', at a place that depended on the address
 * (S3-AC-10). The row is tried at every phone width, so some width puts a break in each phrase.
 */
export const LastSignInWholeAtPhoneWidth: Story = {
  decorators: [
    (Story) => (
      <div data-testid="phone-width" style={{ width: 360 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Grace Hopper');
    const box = canvas.getByTestId('phone-width');
    const metas = [...canvasElement.querySelectorAll<HTMLElement>('.people-meta')];
    await expect(metas.length).toBeGreaterThan(1);
    const broken: string[] = [];
    for (let width = 300; width <= 420; width += 4) {
      box.style.width = `${width}px`;
      for (const meta of metas) {
        const signIn = ((meta.textContent ?? '').split(' · ')[1] ?? '').replace(/\s+/g, ' ');
        // The phrase, spaces as the layout leaves them, is whole on one of the lines.
        const lines = textLines(meta).map((line) => line.replace(/\s+/g, ' ').trim());
        if (!lines.some((line) => line.endsWith(signIn))) {
          broken.push(`${width}: ${lines.join(' / ')}`);
        }
      }
    }
    await expect(broken).toEqual([]);
    box.style.width = '360px';
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

/** More people than a page holds (T-307): the count says how many, Show more lists the rest. */
const showsMore = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByText('5 people')).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
  await expect(await canvas.findByText('Person 004')).toBeVisible();
  return canvas;
};

export const ShowMorePeople: Story = {
  decorators: [atDesktopPageWidth],
  args: { client: fakePeopleClient({ pageSize: 3, people: manyPeople(5) }) },
  play: async ({ canvasElement }) => {
    await showsMore(canvasElement);
  },
};

export const ShowMorePeopleAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  args: { client: fakePeopleClient({ pageSize: 3, people: manyPeople(5) }) },
  play: async ({ canvasElement }) => {
    await fitsPhoneWidth(await showsMore(canvasElement));
  },
};
