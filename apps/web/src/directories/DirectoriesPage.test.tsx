import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { type Handler, noContent, stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import type { Directory, DirectoryRun } from './client';
import { DirectoriesPage } from './DirectoriesPage';
import { FAILED, fakeDirectoriesClient, HEAD_OFFICE, LAB, PRESETS, SUCCEEDED } from './fixtures';

function openPage(handlers: Record<string, Handler> = {}, session = ADMIN) {
  const calls = stubBackend({
    'GET /directories': () =>
      jsonResponse(200, { directories: [HEAD_OFFICE, LAB], presets: PRESETS }),
    ...handlers,
  });
  window.location.hash = '#/admin/directories';
  render(<App session={session} />);
  return calls;
}

const directoryItem = async (name: string) => {
  const list = await screen.findByRole('list', { name: 'Directories' });
  const item = within(list)
    .getAllByRole('listitem')
    .find((li) => within(li).queryByText(name, { exact: true }));
  if (!item) throw new Error(`no directory named ${name}`);
  return item;
};

describe('directory administration (M1-082)', () => {
  it('[IAM-005] lists the directories in precedence order, with what they manage and their last sync', async () => {
    openPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'LDAP and Active Directory' }),
    ).toBeVisible();
    const list = await screen.findByRole('list', { name: 'Directories' });
    expect(list.tagName).toBe('OL');
    const office = await directoryItem('Head office');
    for (const text of [
      'Active Directory',
      'ldaps://dc1.corp.example:636',
      '1,180 accounts, 214 groups',
      'Syncs every 60 minutes, in full every 24 hours',
    ]) {
      expect(within(office).getByText(text)).toBeVisible();
    }
    expect(
      within(office).getByText(
        /^Sync .*: 2 accounts created, 1 account deactivated, 3 groups updated, 1 warning$/,
      ),
    ).toBeVisible();
    const lab = await directoryItem('Research lab');
    for (const text of [
      'OpenLDAP',
      'Read and write',
      'Disabled',
      'ldap://ldap.lab.example:389 with StartTLS',
    ]) {
      expect(within(lab).getByText(text)).toBeVisible();
    }
    expect(
      within(lab).getByText(/^Full sync failed .*it would have removed more than half/),
    ).toBeVisible();
    // The first can only go down, the last only up.
    expect(within(office).queryByRole('button', { name: 'Move Head office up' })).toBeNull();
    expect(within(lab).queryByRole('button', { name: 'Move Research lab down' })).toBeNull();
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: 'Administration',
      }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('[IAM-005] adds a directory after testing the connection', async () => {
    const user = userEvent.setup();
    let directories: Directory[] = [];
    const calls = openPage({
      'GET /directories': () => jsonResponse(200, { directories, presets: PRESETS }),
      'POST /directories/test': () =>
        jsonResponse(200, {
          ok: true,
          users: { count: 842, more: false, sample: [] },
          groups: { count: 1, more: false, sample: [] },
        }),
      'POST /directories': (body) => {
        const created = { ...HEAD_OFFICE, ...(body as object), id: 7, lastRun: null } as Directory;
        directories = [created];
        return jsonResponse(201, { directory: created });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Add a directory' }));
    const form = screen.getByRole('form', { name: 'New directory' });
    expect(within(form).getByLabelText('Name')).toHaveFocus();
    await user.keyboard('Lab');
    await user.click(within(form).getByRole('radio', { name: 'OpenLDAP' }));
    expect(within(form).getByLabelText('People filter')).toHaveValue(PRESETS.openldap.userFilter);
    await user.type(within(form).getByLabelText('URL'), 'ldap://ldap.lab.example');
    await user.click(within(form).getByRole('checkbox', { name: 'Upgrade to TLS with StartTLS' }));
    await user.type(within(form).getByLabelText('Bind DN'), 'cn=taskmoor,dc=lab,dc=example');
    await user.type(within(form).getByLabelText('Password'), 'typed in the form');
    await user.type(within(form).getByLabelText('Base DN'), 'dc=lab,dc=example');
    await user.click(within(form).getByRole('radio', { name: 'Read and write' }));
    await user.click(within(form).getByRole('button', { name: 'Test connection' }));
    expect(
      await within(form).findByText('Connected. 842 people and 1 group match the filters.'),
    ).toHaveAttribute('role', 'status');
    await user.click(within(form).getByRole('button', { name: 'Add directory' }));

    expect(await screen.findByText('Added Lab. Its first sync starts shortly.')).toBeVisible();
    const created = calls.find((c) => c.method === 'POST' && c.path === '/directories');
    expect(created?.body).toEqual({
      name: 'Lab',
      kind: 'openldap',
      url: 'ldap://ldap.lab.example',
      startTls: true,
      bindDn: 'cn=taskmoor,dc=lab,dc=example',
      bindPassword: 'typed in the form',
      baseDn: 'dc=lab,dc=example',
      userBaseDn: null,
      userFilter: PRESETS.openldap.userFilter,
      groupBaseDn: null,
      groupFilter: PRESETS.openldap.groupFilter,
      attributes: {},
      mode: 'read_write',
      enabled: true,
      syncIntervalMinutes: 60,
      fullSyncHours: 24,
    });
    expect(calls.find((c) => c.path === '/directories/test')?.body).toMatchObject({
      url: 'ldap://ldap.lab.example',
      bindPassword: 'typed in the form',
    });
    expect(screen.getByRole('heading', { level: 2, name: 'Directories' })).toHaveFocus();
  });

  it('[IAM-005] an edit sends what changed and keeps the saved password when left blank', async () => {
    const user = userEvent.setup();
    const calls = openPage({
      'PATCH /directories/1': (body) =>
        jsonResponse(200, { directory: { ...HEAD_OFFICE, ...(body as object) } }),
      'POST /directories/test': () =>
        jsonResponse(200, { ok: false, error: 'tls_failed', detail: 'self-signed certificate' }),
    });
    const office = await directoryItem('Head office');
    await user.click(within(office).getByRole('button', { name: 'Edit Head office' }));
    const form = within(office).getByRole('form', { name: 'Edit Head office' });
    expect(within(form).getByLabelText('Password')).toHaveValue('');
    expect(
      within(form).getByText(
        'A password is saved and is never shown again. Leave blank to keep it.',
      ),
    ).toBeVisible();
    expect(within(form).getByText(/Saved: CN=Corp Root CA, valid until/)).toBeVisible();
    // A test of the saved directory sends its id, so the backend uses its own password.
    await user.click(within(form).getByRole('button', { name: 'Test connection' }));
    expect(await within(form).findByText(/The secure connection failed/)).toBeVisible();
    expect(calls.find((c) => c.path === '/directories/test')?.body).toMatchObject({ id: 1 });
    expect(calls.find((c) => c.path === '/directories/test')?.body).not.toHaveProperty(
      'bindPassword',
    );

    await user.clear(within(form).getByLabelText('Minutes between syncs'));
    await user.type(within(form).getByLabelText('Minutes between syncs'), '4');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'Enter whole minutes from 5 to 1,440.',
    );
    expect(within(form).getByLabelText('Minutes between syncs')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await user.type(within(form).getByLabelText('Minutes between syncs'), '5');
    await user.click(within(form).getByText('Attribute names'));
    await user.type(within(form).getByLabelText('Email'), 'proxyAddresses');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved Head office.')).toBeVisible();
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: '/directories/1',
      body: { attributes: { email: 'proxyAddresses' }, syncIntervalMinutes: 45 },
    });
  });

  it('[IAM-005] explains a refusal next to the field it is about', async () => {
    const user = userEvent.setup();
    openPage({
      'PATCH /directories/2': () => jsonResponse(400, { error: 'insecure_transport' }),
    });
    const lab = await directoryItem('Research lab');
    await user.click(within(lab).getByRole('button', { name: 'Edit Research lab' }));
    const form = within(lab).getByRole('form', { name: 'Edit Research lab' });
    await user.click(within(form).getByRole('checkbox', { name: 'Upgrade to TLS with StartTLS' }));
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Use an ldaps:// URL, or turn on StartTLS',
    );
    expect(within(form).getByLabelText('URL')).toHaveAttribute('aria-invalid', 'true');
  });

  it('[IAM-005] asks for a sync and shows how it went; a safety stop is confirmed with Sync and remove', async () => {
    const user = userEvent.setup();
    let office = HEAD_OFFICE;
    let lab: Directory = { ...LAB, enabled: true };
    const calls = openPage({
      'GET /directories': () => jsonResponse(200, { directories: [office, lab], presets: PRESETS }),
      'POST /directories/1/sync': () => {
        const run: DirectoryRun = {
          ...SUCCEEDED,
          id: 60,
          trigger: 'manual',
          stats: { usersUpdated: 4 },
        };
        office = { ...office, lastRun: run };
        return jsonResponse(202, { run });
      },
      'POST /directories/2/sync': (body) => {
        const run: DirectoryRun = { ...FAILED, id: 61, status: 'queued', error: null };
        lab = { ...lab, lastRun: run };
        return jsonResponse(202, { run, body });
      },
    });
    const item = await directoryItem('Head office');
    await user.click(within(item).getByRole('button', { name: 'Sync Head office now' }));
    expect(await screen.findByText('A sync of Head office is on its way.')).toBeVisible();
    expect(await within(item).findByText(/: 4 accounts updated$/)).toBeVisible();
    expect(calls.find((c) => c.path === '/directories/1/sync')?.body).toEqual({
      mode: 'incremental',
    });

    const failing = await directoryItem('Research lab');
    await user.click(
      within(failing).getByRole('button', { name: 'Sync Research lab and remove what left it' }),
    );
    expect(calls.find((c) => c.path === '/directories/2/sync')?.body).toEqual({
      mode: 'full',
      confirmRemovals: true,
    });
    expect(await within(failing).findByText('Full sync waiting to start…')).toBeVisible();
  });

  it('[IAM-005] says when a disabled directory cannot sync', async () => {
    openPage();
    const lab = await directoryItem('Research lab');
    expect(within(lab).getByRole('button', { name: 'Sync Research lab now' })).toBeDisabled();
  });

  it('[IAM-005] looks again while a sync waits or runs', async () => {
    let calls = 0;
    const running = { ...HEAD_OFFICE, lastRun: { ...SUCCEEDED, status: 'running' as const } };
    const client = {
      ...fakeDirectoriesClient(),
      list: async () => {
        calls += 1;
        return { directories: [calls < 3 ? running : HEAD_OFFICE], presets: PRESETS };
      },
    };
    render(
      <I18nProvider locale="en">
        <SessionProvider session={ADMIN}>
          <DirectoriesPage client={client} pollMs={10} />
        </SessionProvider>
      </I18nProvider>,
    );
    expect(await screen.findByText('Sync running…')).toBeVisible();
    expect(await screen.findByText(/: 2 accounts created/)).toBeVisible();
    const settled = calls;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(calls).toBe(settled);
  });

  it('[IAM-005] moves a directory in the precedence order', async () => {
    const user = userEvent.setup();
    const calls = openPage({ 'PUT /directories/order': () => noContent() });
    const office = await directoryItem('Head office');
    await user.click(within(office).getByRole('button', { name: 'Move Head office down' }));
    expect(await screen.findByText('Moved Head office.')).toBeVisible();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ ids: [2, 1] });
  });

  it('[IAM-005] shows the history of syncs with warnings in words', async () => {
    const user = userEvent.setup();
    openPage({ 'GET /directories/1/runs': () => jsonResponse(200, { runs: [SUCCEEDED] }) });
    const office = await directoryItem('Head office');
    await user.click(within(office).getByRole('button', { name: 'History of Head office' }));
    expect(
      await within(office).findByRole('heading', { level: 3, name: 'Recent syncs of Head office' }),
    ).toBeVisible();
    expect(
      within(office).getByText(
        'Skipped, it has no email address: CN=Scanner,OU=Devices,DC=corp,DC=example',
      ),
    ).toBeVisible();
  });

  it('[IAM-005] deletes a directory only after confirmation, and explains the last administrator', async () => {
    const user = userEvent.setup();
    let refuse = true;
    const calls = openPage({
      'DELETE /directories/1': () =>
        refuse ? jsonResponse(409, { error: 'last_admin' }) : noContent(),
    });
    const office = await directoryItem('Head office');
    await user.click(within(office).getByRole('button', { name: 'Delete Head office' }));
    expect(
      within(office).getByText(
        'Delete Head office? The 1,180 accounts it manages are deactivated and keep their work. Its groups stay as Taskmoor groups.',
      ),
    ).toBeVisible();
    expect(within(office).getByRole('button', { name: 'Delete directory' })).toHaveFocus();
    await user.click(within(office).getByRole('button', { name: 'Delete directory' }));
    expect(await within(office).findByRole('alert')).toHaveTextContent(
      'manages the last active site administrator',
    );
    refuse = false;
    await user.click(within(office).getByRole('button', { name: 'Delete directory' }));
    expect(await screen.findByText('Deleted Head office.')).toBeVisible();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
  });

  it('[IAM-005] is listed in Administration for site administrators only', async () => {
    stubBackend({});
    window.location.hash = '#/admin';
    const { unmount } = render(<App session={ADMIN} />);
    expect(screen.getByRole('link', { name: 'LDAP and Active Directory' })).toHaveAttribute(
      'href',
      '#/admin/directories',
    );
    unmount();
    render(<App session={MEMBER} />);
    expect(screen.queryByRole('link', { name: 'LDAP and Active Directory' })).toBeNull();
  });

  it('[IAM-005] tells other people the page is for administrators, without asking the backend', async () => {
    const calls = openPage({}, MEMBER);
    expect(
      await screen.findByText('Only site administrators can manage directories.'),
    ).toBeVisible();
    expect(calls).toEqual([]);
  });

  it('[IAM-005] reports directories that could not be read', async () => {
    openPage({ 'GET /directories': () => jsonResponse(500, { error: 'boom' }) });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The directories could not be read. Try again in a moment.',
    );
  });

  it('[IAM-005] works on a phone-sized screen', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    openPage();
    const office = await directoryItem('Head office');
    await user.click(within(office).getByRole('button', { name: 'Edit Head office' }));
    const form = within(office).getByRole('form', { name: 'Edit Head office' });
    expect(within(form).getByRole('button', { name: 'Save changes' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    const user = userEvent.setup();
    stubBackend({
      'GET /directories': () =>
        jsonResponse(200, { directories: [HEAD_OFFICE, LAB], presets: PRESETS }),
      'GET /directories/1/runs': () => jsonResponse(200, { runs: [SUCCEEDED, FAILED] }),
    });
    window.location.hash = '#/admin/directories';
    const errors: Error[] = [];
    render(<App session={ADMIN} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
    const main = screen.getByRole('main');
    await within(main).findAllByText(/Head office/);
    const buttons = within(main).getAllByRole('button');
    // The new-directory form, an editor and a history, so every string is on screen.
    await user.click(
      buttons.find((b) => b.getAttribute('aria-expanded') === 'false') as HTMLElement,
    );
    const editors = within(main)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-controls'));
    for (const button of editors.slice(0, 2)) await user.click(button);
    await waitFor(() => expect(within(main).getAllByRole('form').length).toBeGreaterThan(0));
    const data = [
      HEAD_OFFICE.url,
      LAB.url,
      ...Object.values(PRESETS.active_directory),
      PRESETS.openldap.userFilter,
      PRESETS.openldap.groupFilter,
      HEAD_OFFICE.bindDn,
      HEAD_OFFICE.baseDn,
      HEAD_OFFICE.userBaseDn,
      HEAD_OFFICE.name,
      LAB.name,
      LAB.bindDn,
      LAB.baseDn,
    ];
    const texts = visibleTexts(main).filter((text) => !data.includes(text));
    expect(texts.length).toBeGreaterThan(40);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
