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
    const form = await screen.findByRole('form', { name: 'Add a role' });
    await user.type(within(form).getByLabelText('Role name'), 'Reviewers');
    // Every add action has the one filled style (D11, AD-19).
    expect(within(form).getByRole('button', { name: 'Add a role' })).toHaveClass('button-primary');
    await user.click(within(form).getByRole('button', { name: 'Add a role' }));
    expect(await screen.findByText('Role Reviewers was added.')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Change role Reviewers' }));
    const edit = screen.getByRole('form', { name: 'Change role Reviewers' });
    await user.type(within(edit).getByLabelText('What the role does'), 'Read and approve');
    await user.click(within(edit).getByRole('button', { name: 'Save the role' }));
    expect(await screen.findByText('Role Reviewers was changed.')).toBeInTheDocument();
    expect(await screen.findByText('Read and approve')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Delete role Members' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Access policies or tracks still use this role',
    );
    await user.click(screen.getByRole('button', { name: 'Delete role Reviewers' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByText('Role Reviewers was deleted.')).toBeInTheDocument();
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
    const form = await screen.findByRole('form', { name: 'Add an access policy' });
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
