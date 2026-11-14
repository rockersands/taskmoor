import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakePeopleClient, fakeTeamsClient, PEOPLE } from './fixtures';
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
      'Ada LovelaceSite administrator',
      'Bo Rivera',
      'Grace Hopper',
    ]);
    await user.type(screen.getByRole('searchbox', { name: 'Find by name or email' }), 'gra');
    expect(await screen.findByText('1 person')).toBeVisible();
    await user.clear(screen.getByRole('searchbox', { name: 'Find by name or email' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'deactivated');
    expect(await screen.findByText('Ken Oduya')).toBeVisible();
  });

  it('[IAM-008] adds a person and shows their one-time link', async () => {
    const user = userEvent.setup();
    const client = renderPage('users');
    await list();
    await user.click(screen.getByRole('button', { name: 'New person' }));
    const form = screen.getByRole('form', { name: 'New person' });
    await user.type(within(form).getByLabelText('Name'), 'Mo Chen');
    await user.type(within(form).getByLabelText('Email'), 'mo@example.com');
    await user.click(within(form).getByRole('checkbox', { name: 'Site administrator' }));
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Mo Chen was added.')).toBeInTheDocument();
    expect(
      (screen.getByRole('textbox', { name: 'Link for Mo Chen' }) as HTMLInputElement).value,
    ).toContain('#/password?token=');
    expect(client.calls[0]).toEqual({
      action: 'createUser',
      args: [{ name: 'Mo Chen', email: 'mo@example.com', isSiteAdmin: true }],
    });
    // The same email twice is refused in words.
    await user.click(screen.getByRole('button', { name: 'New person' }));
    const again = screen.getByRole('form', { name: 'New person' });
    await user.type(within(again).getByLabelText('Name'), 'Mo Again');
    await user.type(within(again).getByLabelText('Email'), 'mo@example.com');
    await user.click(within(again).getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone already has that email.');
  });

  it('[IAM-008] deactivates and reactivates someone, and makes a site administrator', async () => {
    const user = userEvent.setup();
    const client = renderPage('users');
    await list();
    const trigger = screen.getByRole('button', { name: 'Deactivate Bo Rivera' });
    // A destructive action looks it, and asks first, saying what will happen (D13, AD-16).
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    expect(client.calls.some((c) => c.action === 'deactivate')).toBe(false);
    const confirm = screen.getByRole('group', { name: /Bo Rivera is signed out everywhere/ });
    // The way back has the focus, and Escape takes it.
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(confirm).getByRole('button', { name: 'Deactivate Bo Rivera' })).toHaveClass(
      'button-danger',
    );
    // Escape takes the way back, and the focus goes back to the button that asked.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: /Bo Rivera is signed out everywhere/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Deactivate Bo Rivera' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Deactivate Bo Rivera' }));
    // Cancel does the same.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Deactivate Bo Rivera' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Deactivate Bo Rivera' }));
    await user.click(
      within(screen.getByRole('group', { name: /Bo Rivera is signed out everywhere/ })).getByRole(
        'button',
        { name: 'Deactivate Bo Rivera' },
      ),
    );
    expect(
      await screen.findByText('Bo Rivera was deactivated and signed out everywhere.'),
    ).toBeInTheDocument();
    // The button went with the deactivation: the page's heading keeps the focus.
    expect(screen.getByRole('heading', { level: 1, name: 'People' })).toHaveFocus();
    expect(screen.queryByText('Bo Rivera')).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'all');
    await user.click(await screen.findByRole('button', { name: 'Reactivate Bo Rivera' }));
    expect(await screen.findByText('Bo Rivera was reactivated.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Make site administrator: Grace Hopper' }));
    expect(await screen.findByText('Grace Hopper was changed.')).toBeInTheDocument();
    // Nobody acts on themselves here: no deactivate or demote for the signed-in administrator.
    const ada = PEOPLE[0]?.name as string;
    expect(screen.queryByRole('button', { name: `Deactivate ${ada}` })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'New password link for Bo Rivera' }));
    expect(
      ((await screen.findByRole('textbox', { name: 'Link for Bo Rivera' })) as HTMLInputElement)
        .value,
    ).toContain('reset-2');
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

  it('[IAM-008] ASVS 8.3.2: erases a person once their email is typed, and opens their data', async () => {
    const client = renderPage('users');
    await list();
    await userEvent.click(screen.getByRole('button', { name: 'Data of Grace Hopper' }));
    expect(await screen.findByRole('region', { name: 'Data of Grace Hopper' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Data of Grace Hopper' })).toBeNull();
    // Nobody erases themselves: Ada (signed in) has no erase button.
    expect(screen.queryByRole('button', { name: 'Erase Ada Lovelace' })).toBeNull();
    // Erase has the danger look of every destructive action, but asks for the email (D13).
    const eraseTrigger = screen.getByRole('button', { name: 'Erase Grace Hopper' });
    expect(eraseTrigger).toHaveClass('button-danger-quiet');
    expect(eraseTrigger).not.toHaveClass('button-secondary');
    await userEvent.click(eraseTrigger);
    const form = screen.getByRole('form', { name: 'Erase Grace Hopper' });
    const erase = within(form).getByRole('button', { name: 'Erase permanently' });
    expect(erase).toBeDisabled();
    await userEvent.type(
      within(form).getByLabelText('Type grace@example.com to confirm'),
      'grace@example.org',
    );
    expect(erase).toBeDisabled();
    await userEvent.clear(within(form).getByLabelText('Type grace@example.com to confirm'));
    await userEvent.type(
      within(form).getByLabelText('Type grace@example.com to confirm'),
      'Grace@Example.com',
    );
    await userEvent.click(erase);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'The person was erased; they are Former user 3 from now on.',
    );
    expect(client.calls).toContainEqual({ action: 'erase', args: [3, 'Grace@Example.com'] });
    expect(screen.queryByText('Grace Hopper')).toBeNull();
    // Shown among everyone as erased, with no actions left.
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'all');
    const erased = (await screen.findByText('Former user 3')).closest('li') as HTMLElement;
    expect(within(erased).getByText('Erased')).toBeVisible();
    expect(within(erased).queryByRole('button')).toBeNull();
  });

  it('[IAM-034] says why an erasure is refused when a shared track group gave the last one to run a track', async () => {
    const client = renderPage('users');
    client.erase = async () => {
      throw new ApiError(409, { error: 'last_track_admin', trackIds: [4] });
    };
    await list();
    await userEvent.click(screen.getByRole('button', { name: 'Erase Bo Rivera' }));
    const form = screen.getByRole('form', { name: 'Erase Bo Rivera' });
    await userEvent.type(
      within(form).getByLabelText('Type bo@example.com to confirm'),
      'bo@example.com',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Erase permanently' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Erasing them would take back a role their shared track groups gave the only other person running a track.',
    );
    expect(screen.getByText('Bo Rivera')).toBeVisible();
  });

  it('[IAM-008] keeps the deactivation question open when it is refused, saying why', async () => {
    const user = userEvent.setup();
    const client = renderPage('users');
    client.deactivate = async () => {
      throw new ApiError(409, { error: 'last_admin' });
    };
    await list();
    await user.click(screen.getByRole('button', { name: 'Deactivate Bo Rivera' }));
    const question = screen.getByRole('group', { name: /Bo Rivera is signed out everywhere/ });
    await user.click(within(question).getByRole('button', { name: 'Deactivate Bo Rivera' }));
    expect(await screen.findByRole('alert')).toBeVisible();
    // Open still, to try again or cancel.
    expect(screen.getByRole('group', { name: /Bo Rivera is signed out everywhere/ })).toBe(
      question,
    );
    await user.click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Deactivate Bo Rivera' })).toHaveFocus();
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage('users');
    await list();
    expect(screen.getByRole('button', { name: 'Deactivate Bo Rivera' })).toBeVisible();
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
