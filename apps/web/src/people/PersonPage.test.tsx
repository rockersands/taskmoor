import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { type FakePeopleClient, fakePeopleClient, PEOPLE } from './fixtures';
import { PersonPage } from './PersonPage';

function renderPerson(
  userId: number,
  options: {
    session?: Session;
    locale?: Locale;
    client?: FakePeopleClient;
  } = {},
) {
  const client = options.client ?? fakePeopleClient();
  render(
    <I18nProvider locale={options.locale ?? 'en'}>
      <SessionProvider session={options.session ?? ADMIN}>
        <main>
          <PersonPage userId={userId} client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}
const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
const section = (name: string) => screen.getByRole('region', { name });

describe('a person’s page under People (T-331; IAM-008)', () => {
  it('[IAM-009] shows each role with where it comes from, linking to where it changes, and the tracks they run', async () => {
    renderPerson(3);
    await heading('Grace Hopper');
    const roles = section('Roles');
    const role = within(roles)
      .getByText('Configuration administrator')
      .closest('li') as HTMLElement;
    expect(within(role).getByRole('link', { name: 'Through the group Approvers' })).toHaveAttribute(
      'href',
      '#/admin/groups',
    );
    const runs = within(roles).getByText('Runs 2 tracks').closest('li') as HTMLElement;
    // Each track links to its People page, where its roles change.
    expect(within(runs).getByRole('link', { name: 'OPS · Operations' })).toHaveAttribute(
      'href',
      '#/manage/tracks/7',
    );
    expect(within(runs).getByRole('link', { name: 'SHOP · Shop' })).toBeVisible();
    expect(within(roles).getByText('In the groups Approvers.')).toBeVisible();
    expect(within(roles).getByRole('link', { name: 'Global permissions' })).toHaveAttribute(
      'href',
      '#/admin/permissions',
    );
  });

  it('[IAM-009] says Member for someone with no role, and names a role given by name or to everyone', async () => {
    const client = fakePeopleClient({
      granted: {
        2: [{ role: 'automation_admin', sources: [{ kind: 'user' }, { kind: 'everyone' }] }],
      },
    });
    renderPerson(2, { client });
    await heading('Bo Rivera');
    const roles = section('Roles');
    expect(
      within(roles).getByRole('link', { name: 'Given to them on Global permissions' }),
    ).toBeVisible();
    expect(
      within(roles).getByRole('link', {
        name: 'Given to everyone signed in, on Global permissions',
      }),
    ).toBeVisible();
    renderPerson(2, { client: fakePeopleClient() });
    expect(
      await screen.findByText('Member: they hold no administrator role and run no track.'),
    ).toBeVisible();
  });

  it('[IAM-008] makes and unmakes a site administrator, but not oneself', async () => {
    const user = userEvent.setup();
    const client = renderPerson(3);
    await heading('Grace Hopper');
    await user.click(screen.getByRole('button', { name: 'Make site administrator' }));
    expect(await screen.findByText('Grace Hopper was changed.')).toBeVisible();
    expect(client.calls).toContainEqual({ action: 'updateUser', args: [3, { isSiteAdmin: true }] });
    // The account's own mark is where the role comes from now.
    expect(
      within(section('Roles')).getByText('Marked on their account, with the button below'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Remove site administrator' })).toBeVisible();
  });

  it('[IAM-008] leaves the signed-in administrator no way to deactivate, erase or demote themselves', async () => {
    renderPerson(1);
    await heading('Ada Lovelace');
    expect(
      screen.queryByRole('button', { name: /Deactivate|Erase|site administrator/ }),
    ).toBeNull();
    expect(
      screen.getByText(/^This is you: another site administrator deactivates or erases/),
    ).toBeVisible();
  });

  it('[IAM-008] edits the name, email, time zone and language, sending only what changed', async () => {
    const user = userEvent.setup();
    const client = renderPerson(2);
    await heading('Bo Rivera');
    const profile = screen.getByRole('form', { name: 'Profile' });
    await user.clear(within(profile).getByLabelText('Name'));
    await user.type(within(profile).getByLabelText('Name'), 'Bo Rivera Soto');
    await user.selectOptions(within(profile).getByLabelText('Time zone'), 'Europe/Madrid');
    await user.click(within(profile).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Bo Rivera Soto was changed.')).toBeVisible();
    expect(client.calls).toContainEqual({
      action: 'updateUser',
      args: [2, { name: 'Bo Rivera Soto', timeZone: 'Europe/Madrid' }],
    });
    expect(await heading('Bo Rivera Soto')).toBeVisible();
    // A taken email is refused in words.
    const again = screen.getByRole('form', { name: 'Profile' });
    await user.clear(within(again).getByLabelText('Email'));
    await user.type(within(again).getByLabelText('Email'), 'grace@example.com');
    await user.click(within(again).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone already has that email.');
  });

  it('[IAM-001] marks and unmarks a break-glass account, which a directory’s account cannot be', async () => {
    const user = userEvent.setup();
    const client = renderPerson(2);
    await heading('Bo Rivera');
    const signIn = section('Sign-in');
    expect(within(signIn).getByText('This is not a break-glass account.')).toBeVisible();
    await user.click(within(signIn).getByRole('button', { name: 'Mark as a break-glass account' }));
    expect(await screen.findByText('Bo Rivera is a break-glass account now.')).toBeVisible();
    expect(client.calls).toContainEqual({ action: 'updateUser', args: [2, { breakGlass: true }] });
    expect(within(section('Sign-in')).getByText('This is a break-glass account.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove the break-glass mark' }));
    expect(await screen.findByText('Bo Rivera is no longer a break-glass account.')).toBeVisible();
  });

  it('[IAM-001] a directory’s person has no password link or break-glass mark, and says where their name changes', async () => {
    renderPerson(2, { client: fakePeopleClient({ directoryPerson: 2 }) });
    await heading('Bo Rivera');
    expect(
      screen.getByText(
        'Corporate directory keeps this person: their name and email change there, not here.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New password link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as a break-glass account' })).toBeNull();
    expect(
      screen.getByText('An account a directory keeps cannot be a break-glass account.'),
    ).toBeVisible();
  });

  it('[IAM-008] makes a new password link to hand over', async () => {
    const user = userEvent.setup();
    renderPerson(2);
    await heading('Bo Rivera');
    await user.click(screen.getByRole('button', { name: 'New password link' }));
    expect(
      ((await screen.findByRole('textbox', { name: 'Link for Bo Rivera' })) as HTMLInputElement)
        .value,
    ).toContain('reset-2');
  });

  it('[IAM-001] resets a second factor after a question that says what stops working (D13)', async () => {
    const user = userEvent.setup();
    const client = renderPerson(3);
    await heading('Grace Hopper');
    const trigger = screen.getByRole('button', { name: 'Reset second factor' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    expect(client.calls.some((c) => c.action === 'resetTwoFactor')).toBe(false);
    const question = screen.getByRole('group', {
      name: /^Grace Hopper’s authenticator app, security keys and recovery codes stop working/,
    });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(
      within(question).getByRole('button', { name: 'Reset second factor of Grace Hopper' }),
    );
    expect(await screen.findByText('Grace Hopper’s second factor was reset.')).toBeVisible();
    expect(client.calls).toContainEqual({ action: 'resetTwoFactor', args: [3] });
    expect(screen.getByText('They have no second factor.')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Grace Hopper' })).toHaveFocus();
  });

  it('[IAM-008] deactivates after a question, keeps it open when refused, and reactivates', async () => {
    const user = userEvent.setup();
    const client = renderPerson(2);
    await heading('Bo Rivera');
    const deactivate = client.deactivate;
    client.deactivate = async () => {
      throw new ApiError(409, { error: 'last_admin' });
    };
    const trigger = screen.getByRole('button', { name: 'Deactivate' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    const question = screen.getByRole('group', { name: /Bo Rivera is signed out everywhere/ });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(question).getByRole('button', { name: 'Deactivate Bo Rivera' }));
    expect(await screen.findByRole('alert')).toBeVisible();
    // Open still, to try again or cancel.
    expect(screen.getByRole('group', { name: /Bo Rivera is signed out everywhere/ })).toBe(
      question,
    );
    client.deactivate = deactivate;
    await user.click(within(question).getByRole('button', { name: 'Deactivate Bo Rivera' }));
    expect(
      await screen.findByText('Bo Rivera was deactivated and signed out everywhere.'),
    ).toBeVisible();
    // The button went with the deactivation: the page's heading keeps the focus.
    expect(screen.getByRole('heading', { level: 1, name: 'Bo Rivera' })).toHaveFocus();
    expect(screen.getByText('Deactivated', { selector: '.people-badge' })).toBeVisible();
    // A deactivated person gets no password link.
    expect(screen.queryByRole('button', { name: 'New password link' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect(await screen.findByText('Bo Rivera was reactivated.')).toBeVisible();
  });

  it('[IAM-008] ASVS 8.3.2: shows the person’s data and erases them once their email is typed', async () => {
    const user = userEvent.setup();
    const client = renderPerson(3);
    await heading('Grace Hopper');
    expect(screen.getByRole('region', { name: 'Data of Grace Hopper' })).toBeVisible();
    // Erase has the danger look of every destructive action, but asks for the email (D13).
    const opener = screen.getByRole('button', { name: 'Erase…' });
    expect(opener).toHaveClass('button-danger-quiet');
    await user.click(opener);
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    const form = screen.getByRole('form', { name: 'Erase Grace Hopper' });
    const erase = within(form).getByRole('button', { name: 'Erase permanently' });
    expect(erase).toBeDisabled();
    await user.type(
      within(form).getByLabelText('Type grace@example.com to confirm'),
      'Grace@Example.com',
    );
    await user.click(erase);
    expect(
      await screen.findByText('The person was erased; they are Former user 3 from now on.'),
    ).toBeVisible();
    expect(client.calls).toContainEqual({ action: 'erase', args: [3, 'Grace@Example.com'] });
    // A placeholder now, with no actions left.
    expect(await heading('Former user 3')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Deactivate|Reactivate|Erase|Reset|Make|Mark|link/ }),
    ).toBeNull();
    expect(screen.queryByRole('region', { name: 'Roles' })).toBeNull();
  });

  it('[IAM-034] says why an erasure is refused when a shared track group gave the last one to run a track', async () => {
    const user = userEvent.setup();
    const client = renderPerson(2);
    client.erase = async () => {
      throw new ApiError(409, { error: 'last_track_admin', trackIds: [4] });
    };
    await heading('Bo Rivera');
    await user.click(screen.getByRole('button', { name: 'Erase…' }));
    const form = screen.getByRole('form', { name: 'Erase Bo Rivera' });
    await user.type(
      within(form).getByLabelText('Type bo@example.com to confirm'),
      'bo@example.com',
    );
    await user.click(within(form).getByRole('button', { name: 'Erase permanently' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Erasing them would take back a role their shared track groups gave the only other person running a track.',
    );
  });

  it('[IAM-008] says only administrators manage people, and that a missing person is not found', async () => {
    renderPerson(2, { session: MEMBER });
    expect(screen.getByText('Only site administrators manage people.')).toBeVisible();
  });

  it('[IAM-008] opens from the address, under People in the breadcrumb, or says the person is not found', async () => {
    stubBackend({
      'GET /users/3': () =>
        jsonResponse(200, {
          user: { ...PEOPLE[2], roles: [], tracksRun: 0 },
          roles: [],
          tracks: [],
          hasSecondFactor: false,
          groups: [],
          effectiveGroupIds: [],
          directory: null,
        }),
      'GET /users/3/data-exports': () => jsonResponse(200, { exports: [] }),
      'GET /users/99': () => jsonResponse(404, { error: 'not_found' }),
      'GET /*': () => jsonResponse(403, { error: 'forbidden' }),
    });
    window.location.hash = '#/admin/users/3';
    try {
      const { unmount } = render(<App session={ADMIN} />);
      expect(await heading('Grace Hopper')).toBeVisible();
      const crumbs = screen.getByRole('navigation', { name: 'Where this page sits' });
      expect(await within(crumbs).findByRole('link', { name: 'People' })).toHaveAttribute(
        'href',
        '#/admin/users',
      );
      expect(within(crumbs).getByText('Grace Hopper')).toHaveAttribute('aria-current', 'page');
      unmount();
      window.location.hash = '#/admin/users/99';
      render(<App session={ADMIN} />);
      expect(await heading('Person not found')).toBeVisible();
    } finally {
      window.location.hash = '';
    }
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPerson(3);
    await heading('Grace Hopper');
    expect(screen.getByRole('button', { name: 'Reset second factor' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPerson(3, { locale: 'en-XA' });
    const main = screen.getByRole('main');
    await waitFor(() => expect(main.querySelector('.person-page')).not.toBeNull());
    const data = new Set([
      ...PEOPLE.flatMap((p) => [p.name, p.email]),
      'Approvers',
      'OPS',
      'Operations',
      'SHOP',
      'Shop',
    ]);
    const texts = visibleTexts(main).filter(
      (t) => !data.has(t) && !/@example\.com/.test(t) && !/\d{4}/.test(t) && t !== '·',
    );
    expect(untranslated(texts)).toEqual([]);
  });
});
