import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakePeopleClient, PEOPLE } from './fixtures';
import { GroupsPage } from './GroupsPage';
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
    await user.click(screen.getByRole('button', { name: 'Add a person' }));
    const form = screen.getByRole('form', { name: 'Add a person' });
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
    await user.click(screen.getByRole('button', { name: 'Add a person' }));
    const again = screen.getByRole('form', { name: 'Add a person' });
    await user.type(within(again).getByLabelText('Name'), 'Mo Again');
    await user.type(within(again).getByLabelText('Email'), 'mo@example.com');
    await user.click(within(again).getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone already has that email.');
  });

  it('[IAM-008] deactivates and reactivates someone, and makes a site administrator', async () => {
    const user = userEvent.setup();
    renderPage('users');
    await list();
    await user.click(screen.getByRole('button', { name: 'Deactivate Bo Rivera' }));
    expect(
      await screen.findByText('Bo Rivera was deactivated and signed out everywhere.'),
    ).toBeInTheDocument();
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

  it('[IAM-008] makes a group, adds a person, nests a group and refuses a loop', async () => {
    const user = userEvent.setup();
    const client = renderPage('groups');
    await list();
    const form = screen.getByRole('form', { name: 'Add a group' });
    await user.type(within(form).getByLabelText('Group name'), 'Payments');
    await user.click(within(form).getByRole('button', { name: 'Add a group' }));
    expect(await screen.findByText('Payments was added.')).toBeInTheDocument();
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

  it('[IAM-008] deletes a group after a confirmation', async () => {
    const user = userEvent.setup();
    renderPage('groups');
    await list();
    await user.click(screen.getByRole('button', { name: 'Manage Support' }));
    await user.click(await screen.findByRole('button', { name: 'Delete group Support' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByText('Support was deleted.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage Support' })).toBeNull();
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
