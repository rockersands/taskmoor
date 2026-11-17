import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import type { PeopleClient } from './client';
import { fakePeopleClient, fakeTeamsClient, manyPeople, PEOPLE } from './fixtures';
import { GroupsPage } from './GroupsPage';
import { TeamsPage } from './TeamsPage';
import { UsersPage } from './UsersPage';

function renderPage(page: 'users' | 'groups', session: Session = ADMIN, locale: Locale = 'en') {
  const client = fakePeopleClient();
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={session}>
        <main>
          {page === 'users' ? <UsersPage client={client} /> : <GroupsPage client={client} />}
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}
const list = () => screen.findAllByRole('listitem');

describe('people (M1-053, IAM-008)', () => {
  it('[IAM-008] lists active people, finds them and shows the deactivated on request', async () => {
    const user = userEvent.setup();
    renderPage('users');
    expect((await list()).map((li) => li.querySelector('.people-name')?.textContent)).toEqual([
      'Ada Lovelace',
      'Bo Rivera',
      'Grace Hopper',
    ]);
    await user.type(screen.getByRole('searchbox', { name: 'Find by name or email' }), 'gra');
    expect(await screen.findByText('1 person')).toBeVisible();
    await user.clear(screen.getByRole('searchbox', { name: 'Find by name or email' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'deactivated');
    expect(await screen.findByText('Ken Oduya')).toBeVisible();
  });

  it('[IAM-009] shows every administrator role each person holds, the tracks they run, or Member (T-331)', async () => {
    renderPage('users');
    const roles = (await list()).map((li) => li.querySelector('.people-roles')?.textContent);
    expect(roles).toEqual([
      'Site administrator',
      'Member',
      'Configuration administrator, Runs 2 tracks',
    ]);
    // Each role is a badge of its own.
    const grace = screen.getByText('Grace Hopper').closest('li') as HTMLElement;
    expect(
      [...grace.querySelectorAll('.people-role')].map((b) => b.lastChild?.textContent),
    ).toEqual(['Configuration administrator', 'Runs 2 tracks']);
  });

  it('[IAM-008] gives each row one Edit link to the person’s page, and no other action (T-331)', async () => {
    renderPage('users');
    const rows = await list();
    for (const row of rows) {
      const name = row.querySelector('.people-name')?.textContent as string;
      // The visible word starts the name, which says whom it edits (WCAG 2.5.3).
      const edit = within(row).getByRole('link', { name: `Edit ${name}` });
      expect(edit).toHaveTextContent(/^Edit$/);
      expect(within(row).getAllByRole('link')).toHaveLength(1);
      expect(within(row).queryByRole('button')).toBeNull();
    }
    expect(screen.getByRole('link', { name: 'Edit Bo Rivera' })).toHaveAttribute(
      'href',
      '#/admin/users/2',
    );
    expect(
      screen.queryByRole('button', { name: /Deactivate|Erase|Data of|password link/ }),
    ).toBeNull();
  });

  it('[IAM-009] filters by role on the server, and keeps the filters in the address (T-331)', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/admin/users?show=all';
    try {
      const client = renderPage('users');
      const asked: unknown[][] = [];
      const users = client.users;
      client.users = (...args) => {
        asked.push(args);
        return users(...args);
      };
      // The address's status is the list's.
      expect(screen.getByRole('combobox', { name: 'Show' })).toHaveValue('all');
      await list();
      const role = screen.getByRole('combobox', { name: 'Role' });
      expect(role).toHaveValue('any');
      await user.selectOptions(role, 'People who run tracks');
      await waitFor(() =>
        expect(
          screen
            .getAllByRole('listitem')
            .map((li) => li.querySelector('.people-name')?.textContent),
        ).toEqual(['Grace Hopper']),
      );
      expect(asked.at(-1)).toEqual(['', 'all', 0, 'runs_tracks']);
      expect(window.location.hash).toBe('#/admin/users?show=all&role=runs_tracks');
      await user.selectOptions(role, 'AI administrators');
      // Ken, deactivated, keeps his role.
      expect(await screen.findByText('Ken Oduya')).toBeVisible();
      await user.selectOptions(role, 'Members, with no role');
      await waitFor(() => expect(screen.queryByText('Ken Oduya')).toBeNull());
      expect(screen.getByText('Bo Rivera')).toBeVisible();
      await user.selectOptions(role, 'Any role');
      expect(window.location.hash).toBe('#/admin/users?show=all');
    } finally {
      window.location.hash = '';
    }
  });

  it('[IAM-009] starts from the role the address names', async () => {
    window.location.hash = '#/admin/users?role=site_admin';
    try {
      renderPage('users');
      expect(screen.getByRole('combobox', { name: 'Role' })).toHaveValue('site_admin');
      expect((await list()).map((li) => li.querySelector('.people-name')?.textContent)).toEqual([
        'Ada Lovelace',
      ]);
    } finally {
      window.location.hash = '';
    }
  });

  it('[IAM-008] says only administrators manage people', () => {
    renderPage('users', MEMBER);
    expect(screen.getByText('Only site administrators manage people.')).toBeVisible();
  });

  it('[IAM-008] counts a group’s members and groups with the separator Teams uses (AD-18)', async () => {
    renderPage('groups');
    await list();
    expect(screen.getByText('2 members · 0 groups inside · Sign off releases')).toBeVisible();
    expect(screen.getByText('1 member · 0 groups inside')).toBeVisible();
  });

  it('[IAM-008] makes a group, adds a person, nests a group and refuses a loop', async () => {
    const user = userEvent.setup();
    const client = renderPage('groups');
    await list();
    // The list comes first; "New group" opens the form (D11, AD-18).
    expect(screen.queryByRole('form', { name: 'Add a group' })).toBeNull();
    const opener = screen.getByRole('button', { name: 'New group' });
    expect(opener).toHaveClass('button-primary');
    await user.click(opener);
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    const form = screen.getByRole('form', { name: 'Add a group' });
    await user.type(within(form).getByLabelText('Group name'), 'Payments');
    await user.click(within(form).getByRole('button', { name: 'Add a group' }));
    expect(await screen.findByText('Payments was added.')).toBeInTheDocument();
    // The form closes and the focus goes back to New group, not to the page.
    expect(opener).toHaveFocus();
    // The new group opens: add Grace, put Support inside.
    expect(await screen.findByText('Members of Payments')).toBeVisible();
    await user.type(screen.getByRole('searchbox', { name: 'Add a person' }), 'gra');
    await user.click(await screen.findByRole('button', { name: 'Add Grace Hopper to Payments' }));
    expect(await screen.findByText('Grace Hopper is in Payments now.')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Put a group inside' }), '12');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Support is inside Payments now.')).toBeInTheDocument();
    // Payments inside Support would close a loop.
    await user.click(screen.getByRole('button', { name: 'Manage Payments' }));
    await user.click(screen.getByRole('button', { name: 'Manage Support' }));
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Put a group inside' }),
      String(client.calls.find((c) => c.action === 'addChild')?.args[0]),
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That would put a group inside itself.',
    );
  });

  it('[IAM-008] deletes a group after a confirmation that says what goes (D13)', async () => {
    const user = userEvent.setup();
    renderPage('groups');
    await list();
    await user.click(screen.getByRole('button', { name: 'Manage Support' }));
    const trigger = await screen.findByRole('button', { name: 'Delete group Support' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    const question = screen.getByRole('group', {
      name: 'Delete Support? Its members stay; permissions given to it go.',
    });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Delete group Support' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Delete group Support' }));
    await user.click(
      within(screen.getByRole('group')).getByRole('button', { name: 'Delete group Support' }),
    );
    expect(await screen.findByText('Support was deleted.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage Support' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Groups' })).toHaveFocus();
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage('users');
    await list();
    expect(screen.getByRole('link', { name: 'Edit Bo Rivera' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage('users', ADMIN, 'en-XA');
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const data = new Set(PEOPLE.flatMap((p) => [p.name, p.email]));
    const texts = visibleTexts(main).filter(
      (t) => !data.has(t) && !/@example\.com/.test(t) && !/\d{4}/.test(t) && t !== '·',
    );
    expect(untranslated(texts)).toEqual([]);
  });
});

function renderTeams(session: Session = ADMIN, locale: Locale = 'en') {
  const client = fakeTeamsClient();
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={session}>
        <main>
          <TeamsPage client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

describe('teams (M1-123, CORE-027)', () => {
  it('[CORE-027] lists teams with their members and lead', async () => {
    renderTeams();
    const items = await list();
    expect(items.map((li) => li.querySelector('.people-name')?.textContent)).toEqual([
      'Mobile',
      'Platform',
    ]);
    expect(screen.getByText('2 members · led by Grace Hopper · Runs the servers')).toBeVisible();
    expect(screen.getByText('0 members · No lead')).toBeVisible();
  });

  it('[CORE-027] makes a team, adds members, names a lead and renames it', async () => {
    const user = userEvent.setup();
    const client = renderTeams();
    await list();
    const opener = screen.getByRole('button', { name: 'New team' });
    await user.click(opener);
    // Cancel closes the form and gives the focus back to New team.
    await user.click(
      within(screen.getByRole('form', { name: 'Add a team' })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(screen.queryByRole('form', { name: 'Add a team' })).toBeNull();
    expect(opener).toHaveFocus();
    await user.click(opener);
    const form = screen.getByRole('form', { name: 'Add a team' });
    await user.type(within(form).getByLabelText('Team name'), 'Payments');
    await user.type(within(form).getByLabelText('Description (optional)'), 'Money in and out');
    await user.click(within(form).getByRole('button', { name: 'Add a team' }));
    expect(await screen.findByText('Payments was added.')).toBeInTheDocument();
    // The new team opens: add Bo, make Bo the lead, then rename the team.
    expect(await screen.findByText('Members of Payments')).toBeVisible();
    await user.type(screen.getByRole('searchbox', { name: 'Add a person' }), 'bo');
    await user.click(await screen.findByRole('button', { name: 'Add Bo Rivera to Payments' }));
    expect(await screen.findByText('Bo Rivera is in Payments now.')).toBeInTheDocument();
    const edit = screen.getByRole('form', { name: 'Change Payments' });
    await user.selectOptions(within(edit).getByRole('combobox', { name: 'Lead' }), '2');
    const name = within(edit).getByLabelText('Team name');
    await user.clear(name);
    await user.type(name, 'Billing');
    await user.click(within(edit).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Billing was saved.')).toBeInTheDocument();
    expect(await screen.findByText('1 member · led by Bo Rivera · Money in and out')).toBeVisible();
    expect(client.calls.at(-1)).toEqual({
      action: 'updateTeam',
      args: [expect.any(Number), { name: 'Billing', description: 'Money in and out', leadId: 2 }],
    });
  });

  it('[CORE-027] refuses a name that is taken, removes a member and deletes a team', async () => {
    const user = userEvent.setup();
    renderTeams();
    await list();
    await user.click(screen.getByRole('button', { name: 'New team' }));
    const form = screen.getByRole('form', { name: 'Add a team' });
    await user.type(within(form).getByLabelText('Team name'), 'platform');
    await user.click(within(form).getByRole('button', { name: 'Add a team' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'There is a team with that name already.',
    );
    await user.click(screen.getByRole('button', { name: 'Manage Platform' }));
    await user.click(await screen.findByRole('button', { name: 'Remove Bo Rivera from Platform' }));
    expect(await screen.findByText('Bo Rivera is no longer in Platform.')).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'Delete team Platform' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    // Asks first, saying what will happen (D13).
    const question = screen.getByRole('group', {
      name: 'Delete Platform? Boards and areas let go of it, and Team fields that name it become empty.',
    });
    await user.click(within(question).getByRole('button', { name: 'Delete team Platform' }));
    expect(await screen.findByText('Platform was deleted.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage Platform' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Teams' })).toHaveFocus();
  });

  it('[CORE-027] says only administrators manage teams', () => {
    renderTeams(MEMBER);
    expect(screen.getByText('Only site administrators manage teams.')).toBeVisible();
  });

  it('fits a small phone', async () => {
    const user = userEvent.setup();
    setViewportWidth(360);
    renderTeams();
    await list();
    await user.click(screen.getByRole('button', { name: 'Manage Platform' }));
    expect(await screen.findByRole('button', { name: 'Delete team Platform' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    const user = userEvent.setup();
    renderTeams(ADMIN, 'en-XA');
    const main = screen.getByRole('main');
    const items = await within(main).findAllByRole('listitem');
    await user.click(within(items[1] as HTMLElement).getByRole('button'));
    await within(main).findByRole('combobox');
    const data = new Set([...PEOPLE.map((p) => p.name), 'Platform', 'Mobile', 'Runs the servers']);
    const texts = visibleTexts(main).filter(
      (t) => !data.has(t) && t !== '·' && t !== '· Runs the servers',
    );
    expect(untranslated(texts)).toEqual([]);
  });
});

describe('people past the first page (T-307)', () => {
  const names = () =>
    screen.getAllByRole('listitem').map((li) => li.querySelector('.people-name')?.textContent);
  const showMore = () => screen.getByRole('button', { name: 'Show more' });
  const renderUsers = (client: PeopleClient) =>
    render(
      <I18nProvider locale="en">
        <SessionProvider session={ADMIN}>
          <main>
            <UsersPage client={client} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );

  it('[IAM-008] counts everyone and shows the rest a page at a time', async () => {
    const user = userEvent.setup();
    renderUsers(fakePeopleClient({ pageSize: 3, people: manyPeople(7) }));
    expect(await screen.findByText('7 people')).toBeVisible();
    expect(names()).toEqual(['Person 001', 'Person 002', 'Person 003']);
    // Each page starts at the last person shown, to see that the list did not move.
    await user.click(showMore());
    await waitFor(() => expect(names()).toHaveLength(5));
    await user.click(showMore());
    await waitFor(() => expect(names()).toHaveLength(7));
    expect(names().at(-1)).toBe('Person 007');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(screen.getByText('7 people')).toBeVisible();
  });

  it('[IAM-008] a search after Show more starts afresh, and the late page is dropped', async () => {
    const user = userEvent.setup();
    const base = fakePeopleClient({ pageSize: 2, people: manyPeople(5) });
    let release = () => {};
    const client: PeopleClient = {
      ...base,
      users: async (query, status, offset = 0) => {
        const answer = await base.users(query, status, offset);
        // The second page of everyone arrives only after the search below has been answered.
        if (query === '' && offset > 0) await new Promise<void>((done) => (release = done));
        return answer;
      },
    };
    renderUsers(client);
    await screen.findByText('5 people');
    await user.click(showMore());
    // Not disabled, so the focus stays on it.
    expect(showMore()).toHaveAttribute('aria-disabled', 'true');
    await user.type(screen.getByRole('searchbox', { name: 'Find by name or email' }), 'person 005');
    expect(await screen.findByText('1 person')).toBeVisible();
    expect(names()).toEqual(['Person 005']);
    release();
    await new Promise((settle) => setTimeout(settle, 20));
    expect(names()).toEqual(['Person 005']);
    expect(screen.getByText('1 person')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('[IAM-008] a change keeps the pages Show more opened', async () => {
    const user = userEvent.setup();
    renderUsers(fakePeopleClient({ pageSize: 3, people: manyPeople(7) }));
    await screen.findByText('7 people');
    await user.click(showMore());
    await waitFor(() => expect(names()).toHaveLength(5));
    // Adding someone reads the list again, as many people as were shown.
    await user.click(screen.getByRole('button', { name: 'New person' }));
    const form = screen.getByRole('form', { name: 'New person' });
    await user.type(within(form).getByLabelText('Name'), 'Person 0045');
    await user.type(within(form).getByLabelText('Email'), 'person-0045@example.com');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Person 0045 was added.')).toBeInTheDocument();
    await waitFor(() =>
      expect(names()).toEqual([
        'Person 001',
        'Person 002',
        'Person 003',
        'Person 004',
        'Person 0045',
      ]),
    );
    expect(showMore()).toBeVisible();
  });

  it('[IAM-008] skips nobody when someone ahead leaves the list, and the focus goes to the last page', async () => {
    const user = userEvent.setup();
    const base = fakePeopleClient({ pageSize: 3 });
    let people = manyPeople(7);
    const client: PeopleClient = {
      ...base,
      users: async (_query, _status, offset = 0) => ({
        users: structuredClone(people.slice(offset, offset + 3)),
        total: people.length,
      }),
    };
    renderUsers(client);
    await screen.findByText('7 people');
    // Another administrator (or the directory) deactivates Person 002 meanwhile.
    people = people.filter((p) => p.name !== 'Person 002');
    showMore().focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('6 people')).toBeVisible();
    expect(names()).toEqual(['Person 001', 'Person 003', 'Person 004', 'Person 005', 'Person 006']);
    expect(showMore()).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(names()).toHaveLength(6));
    expect(names().at(-1)).toBe('Person 007');
    // The last page: the button goes, and the focus is on the person it brought.
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    await waitFor(() => expect(screen.getByText('Person 007').closest('li')).toHaveFocus());
  });
});
