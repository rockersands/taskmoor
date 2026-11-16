import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakePeopleClient, PEOPLE, SERVICE_ACCOUNTS } from './fixtures';
import { GroupsPage } from './GroupsPage';

function renderGroups(options: Parameters<typeof fakePeopleClient>[0] = {}, locale: Locale = 'en') {
  const client = fakePeopleClient(options);
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={ADMIN}>
        <main>
          <GroupsPage client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

async function manage(name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: `Manage ${name}` }));
  await screen.findByText(`Members of ${name}`);
  return user;
}

describe('groups: renaming and service accounts (T-320)', () => {
  it('[IAM-008] renames a group and changes its description', async () => {
    const client = renderGroups();
    const user = await manage('Support');
    const form = screen.getByRole('form', { name: 'Name and description of Support' });
    const name = within(form).getByRole('textbox', { name: 'Group name' });
    await user.clear(name);
    await user.type(name, 'Help desk');
    await user.type(
      within(form).getByRole('textbox', { name: 'Description (optional)' }),
      'First line',
    );
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Help desk was saved.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Manage Help desk' })).toBeVisible();
    expect(screen.getByText('Members of Help desk')).toBeVisible();
    expect(client.calls.at(-1)).toEqual({
      action: 'renameGroup',
      args: [12, { name: 'Help desk', description: 'First line' }],
    });
  });

  it('[IAM-008] says in words that a group name is taken', async () => {
    renderGroups();
    const user = await manage('Support');
    const form = screen.getByRole('form', { name: 'Name and description of Support' });
    const name = within(form).getByRole('textbox', { name: 'Group name' });
    await user.clear(name);
    await user.type(name, 'approvers');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'There is a group with that name already.',
    );
    expect(name).toHaveValue('approvers');
  });

  it("[IAM-008] leaves a directory's group name to the directory, and changes its description", async () => {
    const client = renderGroups({ directoryGroup: true });
    const user = await manage('Engineering');
    const form = screen.getByRole('form', { name: 'Name and description of Engineering' });
    expect(within(form).queryByRole('textbox', { name: 'Group name' })).toBeNull();
    expect(form).toHaveTextContent(
      'The directory Corporate directory keeps this group’s name: rename it there.',
    );
    const about = within(form).getByRole('textbox', { name: 'Description (optional)' });
    await user.clear(about);
    await user.type(about, 'Synced nightly');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Engineering was saved.')).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({
      action: 'renameGroup',
      args: [13, { description: 'Synced nightly' }],
    });
    // Its members come from the directory, where no service account is.
    expect(screen.queryByRole('combobox', { name: 'Add a service account' })).toBeNull();
    // A service account the directory's group holds is still marked as one.
    const bot = screen.getByText(/^Release bot · /);
    expect(bot).toHaveTextContent('Service account');
  });

  it('[IAM-007] adds a service account to a group, marked as one, and removes it', async () => {
    const client = renderGroups();
    const user = await manage('Approvers');
    const pick = screen.getByRole('combobox', { name: 'Add a service account' });
    expect(pick).toHaveAccessibleDescription(
      'A service account in a group gets the group’s permissions, as a person does.',
    );
    expect(
      within(pick)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a service account', ...SERVICE_ACCOUNTS.map((a) => a.name)]);
    const add = screen.getByRole('button', { name: 'Add the account' });
    expect(add).toBeDisabled();
    await user.selectOptions(pick, 'Release bot');
    await user.click(add);
    expect(await screen.findByText('Release bot is in Approvers now.')).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({ action: 'addMember', args: [11, 50] });
    const row = (await screen.findByText(/^Release bot · /)).closest('li') as HTMLElement;
    expect(within(row).getByText('Service account')).toBeVisible();
    // Only the accounts not in the group are offered.
    expect(
      within(screen.getByRole('combobox', { name: 'Add a service account' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a service account', 'Nightly export']);
    // People are not marked.
    const grace = (await screen.findByText(/^Grace Hopper · /)).closest('li') as HTMLElement;
    expect(within(grace).queryByText('Service account')).toBeNull();
    await user.click(
      within(row).getByRole('button', { name: 'Remove Release bot from Approvers' }),
    );
    expect(await screen.findByText('Release bot is no longer in Approvers.')).toBeInTheDocument();
  });

  it('fits a small phone with a group open', async () => {
    setViewportWidth(375);
    renderGroups();
    await manage('Approvers');
    expect(screen.getByRole('combobox', { name: 'Add a service account' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderGroups({ directoryGroup: true }, 'en-XA');
    const user = userEvent.setup();
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const manageButtons = within(main).getAllByRole('button', { expanded: false });
    // The last group, Engineering, kept by a directory, with a service account in it.
    await user.click(manageButtons.at(-1) as HTMLElement);
    await within(main).findAllByRole('form');
    const data = new Set([
      ...PEOPLE.flatMap((p) => [p.name, p.email]),
      ...SERVICE_ACCOUNTS.flatMap((a) => [a.name, a.email]),
      'Approvers',
      'Support',
      'Engineering',
      'Sign off releases',
      'From the company directory',
      'Corporate directory',
    ]);
    // The list's counts end with the group's own description, after a separator.
    const texts = visibleTexts(main).filter(
      (t) =>
        !data.has(t) &&
        !data.has(t.replace(/^· /, '')) &&
        !/@(example\.com|service\.invalid)/.test(t) &&
        t !== '·',
    );
    expect(untranslated(texts)).toEqual([]);
  });
});
