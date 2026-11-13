import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakePermissionsClient } from './fixtures';
import { PermissionsPage } from './PermissionsPage';

function renderPage(locale: Locale = 'en') {
  const client = fakePermissionsClient();
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={ADMIN}>
        <main>
          <PermissionsPage client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

describe('permission administration (M1-053)', () => {
  it('[IAM-009] adds a role, changes it, and refuses to delete one a policy uses', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    // The roles come first; "New role" opens the form, and Cancel closes it (D11, AD-18).
    const roles = await screen.findByRole('region', { name: 'Roles' });
    expect(within(roles).getByText('Members')).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Add a role' })).toBeNull();
    const opener = within(roles).getByRole('button', { name: 'New role' });
    expect(opener).toHaveClass('button-primary');
    await user.click(opener);
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    await user.click(
      within(screen.getByRole('form', { name: 'Add a role' })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(screen.queryByRole('form', { name: 'Add a role' })).toBeNull();
    // The focus goes back to the New button, not to the page.
    expect(opener).toHaveFocus();
    await user.click(opener);
    const form = screen.getByRole('form', { name: 'Add a role' });
    await user.type(within(form).getByLabelText('Role name'), 'Reviewers');
    await user.click(within(form).getByRole('button', { name: 'Add a role' }));
    expect(await screen.findByText('Role Reviewers was added.')).toBeInTheDocument();
    // Added, the form closes and the focus is back on New role.
    expect(screen.queryByRole('form', { name: 'Add a role' })).toBeNull();
    expect(opener).toHaveFocus();
    await user.click(await screen.findByRole('button', { name: 'Change role Reviewers' }));
    const edit = screen.getByRole('form', { name: 'Change role Reviewers' });
    await user.type(within(edit).getByLabelText('What the role does'), 'Read and approve');
    await user.click(within(edit).getByRole('button', { name: 'Save the role' }));
    expect(await screen.findByText('Role Reviewers was changed.')).toBeInTheDocument();
    expect(await screen.findByText('Read and approve')).toBeVisible();

    // Deleting asks first, as every destructive action does (D13): the focus on Cancel.
    const members = screen.getByRole('button', { name: 'Delete role Members' });
    expect(members).toHaveClass('button-danger-quiet');
    await user.click(members);
    const question = screen.getByRole('group', { name: /^Delete the role Members\?/ });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(question).getByRole('button', { name: 'Delete role Members' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Access policies or tracks still use this role',
    );
    // Refused: the question stays, to cancel; the focus goes back to Delete.
    await user.click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete role Members' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Delete role Reviewers' }));
    await user.click(
      within(screen.getByRole('group', { name: /^Delete the role Reviewers\?/ })).getByRole(
        'button',
        { name: 'Delete role Reviewers' },
      ),
    );
    expect(await screen.findByText('Role Reviewers was deleted.')).toBeInTheDocument();
    // Its row is gone with its button: the list's heading keeps the focus.
    expect(screen.getByRole('heading', { name: 'Roles' })).toHaveFocus();
    expect(client.calls.map((c) => c.action)).toEqual([
      'createRole',
      'updateRole',
      'deleteRole',
      'deleteRole',
    ]);
  });

  it('[IAM-010] copies a policy, gives a role and a person a permission, takes one back', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const policies = await screen.findByRole('region', { name: 'Access policies' });
    expect(screen.queryByRole('form', { name: 'Add an access policy' })).toBeNull();
    await user.click(within(policies).getByRole('button', { name: 'New access policy' }));
    const form = screen.getByRole('form', { name: 'Add an access policy' });
    await user.type(within(form).getByLabelText('Policy name'), 'Partners');
    await user.selectOptions(within(form).getByLabelText('Start from'), '1');
    await user.click(within(form).getByRole('button', { name: 'Add an access policy' }));
    expect(await screen.findByText('Partners was added.')).toBeInTheDocument();

    const give = await screen.findByRole('form', { name: 'Give a permission in Partners' });
    await user.selectOptions(within(give).getByLabelText('Permission'), 'edit_tickets');
    await user.selectOptions(within(give).getByLabelText('Role'), '9');
    await user.click(within(give).getByRole('button', { name: 'Give' }));
    expect(await screen.findByText('Edit tickets was given to Role Viewers.')).toBeInTheDocument();

    await user.selectOptions(within(give).getByLabelText('To'), 'user');
    await user.type(within(give).getByRole('searchbox', { name: 'Find a person' }), 'bo');
    await within(give).findByRole('option', { name: 'Bo Rivera' });
    await user.click(within(give).getByRole('button', { name: 'Give' }));
    expect(await screen.findByText('Edit tickets was given to Bo Rivera.')).toBeInTheDocument();

    await user.click(
      await screen.findByRole('button', { name: 'Remove Role Viewers from Edit tickets' }),
    );
    expect(await screen.findByText('Role Viewers no longer has Edit tickets.')).toBeInTheDocument();
    expect(client.calls.filter((c) => c.action === 'addGrant').map((c) => c.args[1])).toEqual([
      { permission: 'edit_tickets', grantee: 'role', roleId: 9 },
      { permission: 'edit_tickets', grantee: 'user', userId: 2 },
    ]);

    // Deleting the policy asks first (D13); once deleted, the list's heading keeps the focus.
    await user.click(screen.getByRole('button', { name: 'Delete policy Partners' }));
    const question = screen.getByRole('group', { name: /^Delete the access policy Partners\?/ });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(question).getByRole('button', { name: 'Delete policy Partners' }));
    expect(await screen.findByText('Partners was deleted.')).toBeInTheDocument();
    expect(within(policies).getByRole('heading', { name: 'Access policies' })).toHaveFocus();
    expect(client.calls.some((c) => c.action === 'deletePolicy')).toBe(true);
  });

  it('[IAM-010] refuses to delete a policy tracks use', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage Default access policy' }));
    expect(await screen.findByText('Used by SHOP, OPS.')).toBeVisible();
    // The default policy is never deleted, so it has no delete button.
    expect(screen.queryByRole('button', { name: /^Delete policy/ })).toBeNull();
  });

  it('[IAM-011] gives a global permission to a group and refuses administration to everyone', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const give = await screen.findByRole('form', { name: 'Give a global permission' });
    await user.selectOptions(within(give).getByLabelText('Permission'), 'browse_users');
    await user.selectOptions(within(give).getByLabelText('Group'), '12');
    await user.click(within(give).getByRole('button', { name: 'Give' }));
    expect(
      await screen.findByText('See people and groups was given to Group Support.'),
    ).toBeInTheDocument();
    await user.selectOptions(within(give).getByLabelText('Permission'), 'site_admin');
    await user.selectOptions(within(give).getByLabelText('To'), 'any_user');
    await user.click(within(give).getByRole('button', { name: 'Give' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Administration cannot go to everyone.',
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Remove Group Approvers from Change many tickets at once',
      }),
    );
    expect(
      await screen.findByText('Group Approvers no longer has Change many tickets at once.'),
    ).toBeInTheDocument();
    expect(client.calls.map((c) => c.action)).toEqual([
      'addGlobalGrant',
      'addGlobalGrant',
      'removeGlobalGrant',
    ]);
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await screen.findByRole('button', { name: 'Delete role Members' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage('en-XA');
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const data = new Set([
      'Administrators',
      'Members',
      'Viewers',
      'Run the track',
      'Do the work',
      'Default access policy',
      'Approvers',
      'Support',
    ]);
    const texts = visibleTexts(main).filter((t) => !data.has(t));
    expect(untranslated(texts)).toEqual([]);
  });
});
