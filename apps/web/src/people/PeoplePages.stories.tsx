import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { textLines } from '../admin/textLines';
import { SessionProvider } from '../session/SessionProvider';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
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

/** People: each with their roles, the tracks they run or Member, and one Edit link (T-331). */
export const People: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Grace Hopper')).toBeVisible();
    await expect(canvas.getByText('Runs 2 tracks')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Edit Grace Hopper' })).toBeVisible();
  },
};

/** The page's width beside Administration's list on a 1280 px screen. */
const atDesktopPageWidth = (Story: () => ReactElement) => (
  <div style={{ width: 638 }}>
    <Story />
  </div>
);

/**
 * At a desktop's page width a row is its name, address and roles at the start and Edit at the
 * end, level with the name; the longest roles, Configuration administrator and Runs 2 tracks,
 * stay on one line (T-331).
 */
export const RolesAndEditOnEachRow: Story = {
  decorators: [atDesktopPageWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Grace Hopper');
    const rows = [
      ...canvasElement.querySelectorAll<HTMLElement>('.people-list-users .people-item'),
    ];
    for (const row of rows) {
      const name = row.querySelector('.people-name') as HTMLElement;
      const edit = within(row).getByRole('link', { name: /^Edit / });
      // At the row's end, level with the name.
      const box = row.getBoundingClientRect();
      await expect(edit.getBoundingClientRect().left).toBeGreaterThan(box.left + box.width / 2);
      await expect(edit.getBoundingClientRect().top).toBeLessThan(
        name.getBoundingClientRect().bottom,
      );
      const badges = [...row.querySelectorAll('.people-role')];
      await expect(new Set(badges.map((b) => Math.round(b.getBoundingClientRect().top))).size).toBe(
        1,
      );
    }
  },
};

/** The role filter: the people who run tracks (T-331). */
export const FilteredByRole: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Grace Hopper');
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: 'Role' }),
      'People who run tracks',
    );
    await expect(await canvas.findByText('1 person')).toBeVisible();
    await expect(canvas.getByText('Grace Hopper')).toBeVisible();
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

/** A finger reaches each Edit link and the filters (ADR-033, T-331). */
export const PeopleOnATouchScreen: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Grace Hopper');
    await expect(
      tooSmallForAFinger(canvasElement, ['.people-edit', '.people-filters select']),
    ).toEqual([]);
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
