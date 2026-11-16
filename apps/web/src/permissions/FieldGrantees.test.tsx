import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { setViewportWidth } from '../test/viewport';
import type { PermissionsClient } from './client';
import { fakePermissionsClient } from './fixtures';
import { PermissionsPage } from './PermissionsPage';
import { VisibilityPage } from './VisibilityPage';
import { fakeVisibilityClient } from './visibilityFixtures';

function renderPermissions(overrides: Partial<PermissionsClient> = {}) {
  const client = fakePermissionsClient();
  render(
    <I18nProvider locale="en">
      <SessionProvider session={ADMIN}>
        <main>
          <PermissionsPage client={{ ...client, ...overrides }} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

function renderVisibility() {
  const client = fakeVisibilityClient();
  render(
    <I18nProvider locale="en">
      <SessionProvider session={ADMIN}>
        <main>
          <VisibilityPage client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

/** Opens the default policy and its form to give a permission. */
async function giveInDefault() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Manage Default access policy' }));
  await user.click(
    await screen.findByRole('button', { name: 'New permission in Default access policy' }),
  );
  const form = screen.getByRole('form', { name: 'Give a permission in Default access policy' });
  return { user, form };
}

const optionsOf = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((o) => o.textContent);

describe('people and groups in a field of the ticket (T-320)', () => {
  it('[IAM-010] names a field grant by its field, and gives one to the people in a user field', async () => {
    const client = renderPermissions();
    const { user, form } = await giveInDefault();
    // The grant the policy holds reads as its field's name, not its key.
    expect(screen.getByText('People in field Reviewer')).toBeVisible();
    expect(screen.queryByText(/cf\[31\]/)).toBeNull();
    await user.selectOptions(within(form).getByLabelText('Permission'), 'create_tickets');
    await user.selectOptions(within(form).getByLabelText('To'), 'People in a user field');
    // A shared policy names shared fields only: a local-mode track's own is not offered.
    const field = within(form).getByRole('combobox', { name: 'User field' });
    expect(optionsOf(field)).toEqual(['Reviewer']);
    await user.click(within(form).getByRole('button', { name: 'Give' }));
    expect(
      await screen.findByText('Create tickets was given to People in field Reviewer.'),
    ).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({
      action: 'addGrant',
      args: [1, { permission: 'create_tickets', grantee: 'user_field', fieldKey: 'cf[31]' }],
    });
  });

  it('[IAM-010] gives a permission to the groups in a group field, and takes a field grant back', async () => {
    const client = renderPermissions();
    const { user, form } = await giveInDefault();
    await user.selectOptions(within(form).getByLabelText('Permission'), 'edit_tickets');
    await user.selectOptions(within(form).getByLabelText('To'), 'Groups in a group field');
    expect(optionsOf(within(form).getByRole('combobox', { name: 'Group field' }))).toEqual([
      'Approving team',
    ]);
    await user.click(within(form).getByRole('button', { name: 'Give' }));
    expect(
      await screen.findByText('Edit tickets was given to Groups in field Approving team.'),
    ).toBeInTheDocument();
    await user.click(
      await screen.findByRole('button', {
        name: 'Remove People in field Reviewer from Edit tickets',
      }),
    );
    // Removing a grant asks first, naming the field grantee by its field (D13, T-267).
    const removing = screen.getByRole('group', {
      name: /^People in field Reviewer loses Edit tickets in /,
    });
    await user.click(
      within(removing).getByRole('button', {
        name: 'Remove People in field Reviewer from Edit tickets',
      }),
    );
    expect(
      await screen.findByText('People in field Reviewer no longer has Edit tickets.'),
    ).toBeInTheDocument();
    expect(client.calls.map((c) => [c.action, c.args[1]])).toEqual([
      ['addGrant', { permission: 'edit_tickets', grantee: 'group_field', fieldKey: 'cf[32]' }],
      ['removeGrant', 104],
    ]);
  });

  it('[IAM-010] says when there is no field of a kind, and gives nothing', async () => {
    const client = renderPermissions({ fields: async () => [] });
    const { user, form } = await giveInDefault();
    await user.selectOptions(within(form).getByLabelText('To'), 'Groups in a group field');
    expect(optionsOf(within(form).getByRole('combobox', { name: 'Group field' }))).toEqual([
      'No field of this kind yet',
    ]);
    await user.click(within(form).getByRole('button', { name: 'Give' }));
    expect(client.calls.some((c) => c.action === 'addGrant')).toBe(false);
    // A grant whose field is gone keeps its key, the only name left.
    expect(screen.getByText('People in field cf[31]')).toBeVisible();
  });

  it('[IAM-010] says in words when the server refuses the field', async () => {
    renderPermissions({
      addGrant: async () => {
        throw new ApiError(400, { error: 'invalid_request', detail: 'fieldKey' });
      },
    });
    const { user, form } = await giveInDefault();
    await user.selectOptions(within(form).getByLabelText('To'), 'People in a user field');
    await user.click(within(form).getByRole('button', { name: 'Give' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That field is gone, or not of this kind. Choose another.',
    );
  });

  it('[IAM-009] offers no field grantee for a global permission, which has no ticket', async () => {
    const user = userEvent.setup();
    renderPermissions();
    await user.click(await screen.findByRole('button', { name: 'New global permission' }));
    const form = screen.getByRole('form', { name: 'Give a global permission' });
    expect(optionsOf(within(form).getByLabelText('To'))).not.toContain('People in a user field');
  });

  it('[IAM-011] adds the people in a user field and the groups in a group field to a level', async () => {
    const user = userEvent.setup();
    const client = renderVisibility();
    const internal = await screen.findByRole('list', { name: 'Members of Internal' });
    expect(within(internal).getByText('People in field Reviewer')).toBeVisible();
    const form = screen.getByRole('form', { name: 'Add a member to Security' });
    await user.selectOptions(within(form).getByLabelText('Who'), 'People in a user field');
    expect(optionsOf(within(form).getByRole('combobox', { name: 'User field' }))).toEqual([
      'Reviewer',
    ]);
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(
      await screen.findByText('People in field Reviewer joined Security.'),
    ).toBeInTheDocument();
    const members = screen.getByRole('list', { name: 'Members of Security' });
    expect(within(members).getByText('People in field Reviewer')).toBeVisible();
    await user.selectOptions(
      within(screen.getByRole('form', { name: 'Add a member to Security' })).getByLabelText('Who'),
      'Groups in a group field',
    );
    await user.click(
      within(screen.getByRole('form', { name: 'Add a member to Security' })).getByRole('button', {
        name: 'Add',
      }),
    );
    expect(
      await screen.findByText('Groups in field Approving team joined Security.'),
    ).toBeInTheDocument();
    expect(client.calls.map((c) => c.args)).toEqual([
      [1, 12, { grantee: 'user_field', fieldKey: 'cf[31]' }],
      [1, 12, { grantee: 'group_field', fieldKey: 'cf[32]' }],
    ]);
  });

  it('fits a small phone with a field grantee chosen', async () => {
    setViewportWidth(375);
    renderPermissions();
    const { user, form } = await giveInDefault();
    await user.selectOptions(within(form).getByLabelText('To'), 'People in a user field');
    expect(within(form).getByRole('combobox', { name: 'User field' })).toBeVisible();
  });
});
