import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakeConfigurationClient } from './fixtures';
import { TracksAdminPage } from './TracksAdminPage';
import { WorkflowMapsPage } from './WorkflowMapsPage';

function renderPage(
  page: 'tracks' | 'maps',
  start: Parameters<typeof fakeConfigurationClient>[0] = {},
  locale: Locale = 'en',
) {
  const client = fakeConfigurationClient(start);
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={ADMIN}>
        <main>
          {page === 'tracks' ? (
            <TracksAdminPage client={client} />
          ) : (
            <WorkflowMapsPage client={client} />
          )}
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

describe('track and workflow map administration (M1-053)', () => {
  it('[CORE-001] adds a track, renames it and archives it', async () => {
    const user = userEvent.setup();
    const client = renderPage('tracks');
    await screen.findByText('SHOP · Shop');
    const form = screen.getByRole('form', { name: 'Add a track' });
    await user.type(within(form).getByLabelText('Key'), 'pay');
    await user.type(within(form).getByLabelText('Track name'), 'Payments');
    await user.click(within(form).getByRole('button', { name: 'Add a track' }));
    expect(await screen.findByText('Track PAY was added.')).toBeInTheDocument();
    const name = await screen.findByLabelText('Track name', { selector: '.people-panel input' });
    await user.clear(name);
    await user.type(name, 'Payments team');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByText('Track PAY was changed.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Archive track PAY' }));
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    expect(await screen.findByText('Track PAY was archived.')).toBeInTheDocument();
    expect(client.calls.map((c) => c.action)).toEqual([
      'createTrack',
      'updateTrack',
      'archiveTrack',
    ]);
  });

  it('[IAM-002] gives a role to a person and a group, and takes it back', async () => {
    const user = userEvent.setup();
    const client = renderPage('tracks');
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    expect(await screen.findByText('Grace Hopper: Members')).toBeVisible();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Role' }), '9');
    await user.type(screen.getByRole('searchbox', { name: 'Give the role to a person' }), 'bo');
    await user.click(await screen.findByRole('button', { name: 'Add Bo Rivera as Viewers' }));
    expect(await screen.findByText('Bo Rivera is Viewers now.')).toBeInTheDocument();
    expect(await screen.findByText('Bo Rivera: Viewers')).toBeVisible();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Give the role to a group' }),
      '12',
    );
    await user.click(screen.getAllByRole('button', { name: 'Add' }).at(-1) as HTMLElement);
    expect(await screen.findByText('Group Support: Viewers')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove Grace Hopper as Members' }));
    expect(await screen.findByText('Grace Hopper is no longer Members.')).toBeInTheDocument();
    expect(client.calls.filter((c) => c.action === 'setRoleActor').map((c) => c.args)).toEqual([
      [3, 9, 'users', 2, true],
      [3, 9, 'groups', 12, true],
      [3, 8, 'users', 3, false],
    ]);
  });

  it('[WF-001] switches a track to another workflow map, and says when tickets need a mapping', async () => {
    const user = userEvent.setup();
    renderPage('tracks', { refuseMapping: true });
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Workflow map' }), '22');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '12 tickets are in statuses the new workflows lack.',
    );
  });

  it('[WF-001] makes a workflow map and gives a ticket type its own workflow', async () => {
    const user = userEvent.setup();
    const client = renderPage('maps');
    await screen.findByText('Default workflow map');
    const form = screen.getByRole('form', { name: 'Add a workflow map' });
    await user.type(within(form).getByLabelText('Map name'), 'Tasks apart');
    await user.click(within(form).getByRole('button', { name: 'Add a workflow map' }));
    expect(await screen.findByText('Tasks apart was added.')).toBeInTheDocument();
    const map = await screen.findByRole('form', { name: 'Workflows in Tasks apart' });
    await user.selectOptions(
      within(map).getByRole('combobox', { name: 'Give a type its own workflow' }),
      '6',
    );
    await user.click(within(map).getByRole('button', { name: 'Add' }));
    await user.selectOptions(within(map).getByRole('combobox', { name: 'Task follows' }), '2');
    await user.click(within(map).getByRole('button', { name: 'Save the map' }));
    expect(await screen.findByText('Tasks apart was saved.')).toBeInTheDocument();
    expect(client.calls.at(-1)?.args[1]).toEqual({
      defaultWorkflowId: 1,
      entries: [{ ticketTypeId: 6, workflowId: 2 }],
    });
    // And deletes it.
    await user.click(within(map).getByRole('button', { name: 'Delete map Tasks apart' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByText('Tasks apart was deleted.')).toBeInTheDocument();
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage('tracks');
    expect(await screen.findByRole('button', { name: 'Manage track SHOP' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage('maps', {}, 'en-XA');
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const data = new Set([
      'Default workflow map',
      'Bugs apart',
      'Default workflow',
      'Bug workflow',
    ]);
    const texts = visibleTexts(main).filter((t) => !data.has(t));
    expect(untranslated(texts)).toEqual([]);
  });
});
