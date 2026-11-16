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
  it('[CORE-001] [CORE-025] adds a track, renames it, archives it after asking and restores it at once', async () => {
    const user = userEvent.setup();
    const client = renderPage('tracks');
    await screen.findByText('SHOP · Shop');
    await user.click(screen.getByRole('button', { name: 'New track' }));
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
    // Archiving locks everyone out of changing it: asked first, focus on Cancel (D13, T-267).
    const archive = screen.getByRole('button', { name: 'Archive track PAY' });
    expect(archive).toHaveClass('button-danger-quiet');
    await user.click(archive);
    const question = screen.getByRole('group', {
      name: 'Nobody can change the tickets of PAY until it is restored, and search leaves them out. They stay readable.',
    });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(client.calls.map((c) => c.action)).toEqual(['createTrack', 'updateTrack']);
    await user.click(within(question).getByRole('button', { name: 'Archive track PAY' }));
    expect(await screen.findByText('Track PAY was archived.')).toBeInTheDocument();
    // Restoring loses nothing: a plain button, with the focus, that acts at once.
    const restore = await screen.findByRole('button', { name: 'Restore track PAY' });
    expect(restore).toHaveClass('button-secondary');
    expect(restore).toHaveFocus();
    await user.click(restore);
    expect(await screen.findByText('Track PAY was restored.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Archive track PAY' })).toHaveFocus();
    expect(client.calls.map((c) => c.action)).toEqual([
      'createTrack',
      'updateTrack',
      'archiveTrack',
      'archiveTrack',
    ]);
    expect(client.calls.at(-1)?.args).toEqual([expect.any(Number), false]);
  });

  it('[CORE-002] adds a track from the Scrum template and opens the board it made', async () => {
    const user = userEvent.setup();
    const client = renderPage('tracks');
    await screen.findByText('SHOP · Shop');
    await user.click(screen.getByRole('button', { name: 'New track' }));
    const form = within(screen.getByRole('form', { name: 'Add a track' }));
    await user.type(form.getByLabelText('Key'), 'pay');
    await user.type(form.getByLabelText('Track name'), 'Payments');
    await user.selectOptions(
      form.getByRole('combobox', { name: 'Start from' }),
      'Scrum: a board with a backlog and sprints',
    );
    await user.click(form.getByRole('button', { name: 'Add a track' }));
    expect(await screen.findByText('Track PAY was added, with its board.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the board of PAY' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^#\/boards\/\d+$/),
    );
    expect(client.calls.at(-1)?.args[0]).toEqual({
      key: 'PAY',
      name: 'Payments',
      mode: 'shared',
      template: 'scrum',
    });
  });

  it('[CORE-002] adds a track with the configuration of another shared track', async () => {
    const user = userEvent.setup();
    const client = renderPage('tracks');
    await screen.findByText('SHOP · Shop');
    await user.click(screen.getByRole('button', { name: 'New track' }));
    const form = within(screen.getByRole('form', { name: 'Add a track' }));
    await user.type(form.getByLabelText('Key'), 'web');
    await user.type(form.getByLabelText('Track name'), 'Web shop');
    await user.selectOptions(form.getByRole('combobox', { name: 'Start from' }), 'Shop (SHOP)');
    await user.click(form.getByRole('button', { name: 'Add a track' }));
    expect(await screen.findByText('Track WEB was added.')).toBeInTheDocument();
    expect(client.calls.at(-1)?.args[0]).toMatchObject({ key: 'WEB', copyFrom: 3 });
    // The form closes once the track is added, the focus back on New track, which opens it
    // again (D11).
    expect(screen.queryByRole('form', { name: 'Add a track' })).toBeNull();
    const opener = screen.getByRole('button', { name: 'New track' });
    expect(opener).toHaveFocus();
    await user.click(opener);
    const again = within(screen.getByRole('form', { name: 'Add a track' }));
    // A local-mode track cannot copy: only templates are offered.
    await user.selectOptions(again.getByRole('combobox', { name: 'Configuration' }), 'local');
    expect(again.queryByRole('option', { name: 'Shop (SHOP)' })).toBeNull();
    // Cancel closes it and the focus goes back to New track.
    await user.click(again.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Add a track' })).toBeNull();
    expect(opener).toHaveFocus();
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

  it('[WF-001] switches a track to a map at once when no ticket needs a new status', async () => {
    const user = userEvent.setup();
    const client = renderPage('tracks');
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Workflow map' }), '22');
    expect(await screen.findByText('Track SHOP uses Bugs apart now.')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Switch SHOP to Bugs apart' })).toBeNull();
    expect(client.calls.map((c) => [c.action, ...c.args])).toEqual([
      ['trackMapImpact', 3, 22],
      ['switchWorkflowMap', 3, 22, undefined],
    ]);
  });

  it('[WF-001] [WF-002] asks where tickets go before switching a track’s map, then moves them (T-320)', async () => {
    const user = userEvent.setup();
    const client = renderPage('tracks', { refuseMapping: true });
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Workflow map' }), '22');
    const step = await screen.findByRole('form', { name: 'Switch SHOP to Bugs apart' });
    expect(within(step).getByRole('heading', { name: 'Switch SHOP to Bugs apart' })).toHaveFocus();
    expect(step).toHaveTextContent(
      '15 tickets are in statuses the new workflows lack. Choose where they go',
    );
    // Nothing is chosen for the person: the switch waits for every choice.
    await user.click(within(step).getByRole('button', { name: 'Switch and move the tickets' }));
    expect(within(step).getByRole('alert')).toHaveTextContent(
      'Choose a status for each, then confirm.',
    );
    const review = within(step).getByRole('combobox', {
      name: 'Move the 12 Bug tickets in In review to',
    });
    expect(review).toHaveAttribute('aria-invalid', 'true');
    expect(review).toHaveAccessibleDescription(
      'A status of Bug workflow, the new workflow of Bug.',
    );
    expect(
      within(review)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a status', 'Open', 'Fixing', 'Closed']);
    await user.selectOptions(review, 'Fixing');
    await user.selectOptions(
      within(step).getByRole('combobox', { name: 'Move the 3 Bug tickets in Waiting to' }),
      'Open',
    );
    await user.click(within(step).getByRole('button', { name: 'Switch and move the tickets' }));
    expect(
      await screen.findByText(
        'Track SHOP uses Bugs apart now. 15 tickets moved to their new statuses.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Switch SHOP to Bugs apart' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Workflow map' })).toHaveFocus();
    expect(client.calls.at(-1)).toEqual({
      action: 'switchWorkflowMap',
      args: [3, 22, { '5': { '3': 11, '4': 10 } }],
    });
  });

  it('[WF-001] cancels the mapping step and keeps the track’s map (T-320)', async () => {
    const user = userEvent.setup();
    const client = renderPage('tracks', { refuseMapping: true });
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    const select = await screen.findByRole('combobox', { name: 'Workflow map' });
    await user.selectOptions(select, '22');
    const step = await screen.findByRole('form', { name: 'Switch SHOP to Bugs apart' });
    await user.click(within(step).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Switch SHOP to Bugs apart' })).toBeNull();
    expect(select).toHaveValue('20');
    expect(select).toHaveFocus();
    expect(client.calls.map((c) => c.action)).toEqual(['trackMapImpact']);
  });

  it('[WF-001] shows the progress of tickets that move in the background (T-320)', async () => {
    const user = userEvent.setup();
    renderPage('tracks', { refuseMapping: true, moving: true });
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Workflow map' }), '22');
    const step = await screen.findByRole('form', { name: 'Switch SHOP to Bugs apart' });
    for (const box of within(step).getAllByRole('combobox')) await user.selectOptions(box, 'Open');
    await user.click(within(step).getByRole('button', { name: 'Switch and move the tickets' }));
    expect(
      await screen.findByText(
        'Track SHOP uses Bugs apart now. 15 tickets are moving to their new statuses.',
      ),
    ).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Tickets moved: 0 of 15' });
    expect(bar).toHaveAttribute('value', '0');
    expect(
      await screen.findByText('All 15 tickets have moved.', {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Tickets moved: 15 of 15' })).toBeVisible();
  });

  it('[WF-001] asks again when tickets changed after the preview (T-320)', async () => {
    const user = userEvent.setup();
    const client = renderPage('tracks', { refuseMapping: true, changedAfterPreview: true });
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Workflow map' }), '22');
    const step = await screen.findByRole('form', { name: 'Switch SHOP to Bugs apart' });
    for (const box of within(step).getAllByRole('combobox'))
      await user.selectOptions(box, 'Closed');
    await user.click(within(step).getByRole('button', { name: 'Switch and move the tickets' }));
    expect(await within(step).findByRole('alert')).toHaveTextContent(
      'Tickets changed since this was read. Check where each goes, then confirm again.',
    );
    // The choices stay; confirming again goes through.
    await user.click(within(step).getByRole('button', { name: 'Switch and move the tickets' }));
    expect(
      await screen.findByText(
        'Track SHOP uses Bugs apart now. 15 tickets moved to their new statuses.',
      ),
    ).toBeInTheDocument();
    expect(client.calls.filter((c) => c.action === 'trackMapImpact')).toHaveLength(2);
  });

  it('[WF-001] asks where tickets go before saving a map a track uses (T-320)', async () => {
    const user = userEvent.setup();
    const client = renderPage('maps', { refuseMapping: true });
    await user.click(await screen.findByRole('button', { name: 'Manage Default workflow map' }));
    const map = await screen.findByRole('form', { name: 'Workflows in Default workflow map' });
    await user.selectOptions(
      within(map).getByRole('combobox', { name: 'Workflow for every other type' }),
      '2',
    );
    await user.click(within(map).getByRole('button', { name: 'Save the map' }));
    const step = await screen.findByRole('form', { name: 'Save Default workflow map' });
    for (const box of within(step).getAllByRole('combobox'))
      await user.selectOptions(box, 'Fixing');
    await user.click(within(step).getByRole('button', { name: 'Save and move the tickets' }));
    expect(
      await screen.findByText(
        'Default workflow map was saved. 15 tickets moved to their new statuses.',
      ),
    ).toBeInTheDocument();
    expect(within(map).getByRole('button', { name: 'Save the map' })).toHaveFocus();
    expect(client.calls.at(-1)).toEqual({
      action: 'updateWorkflowMap',
      args: [
        20,
        { defaultWorkflowId: 2, entries: [], typeStatusMapping: { '5': { '3': 11, '4': 11 } } },
      ],
    });
  });

  it('[WF-001] a change to the map while its mapping step is open closes the step, and Save previews it anew (T-320)', async () => {
    const user = userEvent.setup();
    const client = renderPage('maps', { refuseMapping: true });
    await user.click(await screen.findByRole('button', { name: 'Manage Default workflow map' }));
    const map = await screen.findByRole('form', { name: 'Workflows in Default workflow map' });
    await user.selectOptions(
      within(map).getByRole('combobox', { name: 'Workflow for every other type' }),
      '2',
    );
    await user.click(within(map).getByRole('button', { name: 'Save the map' }));
    await screen.findByRole('form', { name: 'Save Default workflow map' });
    // Task gets its own line: the step was for the map without it.
    await user.selectOptions(
      within(map).getByRole('combobox', { name: 'Give a type its own workflow' }),
      'Task',
    );
    await user.click(within(map).getByRole('button', { name: 'Add' }));
    expect(screen.queryByRole('form', { name: 'Save Default workflow map' })).toBeNull();
    await user.click(within(map).getByRole('button', { name: 'Save the map' }));
    const step = await screen.findByRole('form', { name: 'Save Default workflow map' });
    for (const box of within(step).getAllByRole('combobox'))
      await user.selectOptions(box, 'Fixing');
    await user.click(within(step).getByRole('button', { name: 'Save and move the tickets' }));
    await screen.findByText(/^Default workflow map was saved\./);
    const change = { defaultWorkflowId: 2, entries: [{ ticketTypeId: 6, workflowId: 2 }] };
    expect(client.calls).toEqual([
      { action: 'workflowMapImpact', args: [20, { defaultWorkflowId: 2, entries: [] }] },
      { action: 'workflowMapImpact', args: [20, change] },
      {
        action: 'updateWorkflowMap',
        args: [20, { ...change, typeStatusMapping: { '5': { '3': 11, '4': 11 } } }],
      },
    ]);
  });

  it('[WF-001] saves a map no track uses without a preview (T-320)', async () => {
    const user = userEvent.setup();
    const client = renderPage('maps', { refuseMapping: true });
    await user.click(await screen.findByRole('button', { name: 'Manage Bugs apart' }));
    const map = await screen.findByRole('form', { name: 'Workflows in Bugs apart' });
    await user.click(within(map).getByRole('button', { name: 'Save the map' }));
    expect(await screen.findByText('Bugs apart was saved.')).toBeInTheDocument();
    expect(client.calls.map((c) => c.action)).toEqual(['updateWorkflowMap']);
  });

  it("[CORE-002] turns a track's sprints off and on again", async () => {
    const user = userEvent.setup();
    const client = renderPage('tracks');
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    const sprints = await screen.findByRole('checkbox', { name: 'Sprints in SHOP' });
    expect(sprints).toBeChecked();
    expect(sprints).toHaveAccessibleDescription(
      expect.stringContaining('Turning them off deletes no sprint'),
    );
    await user.click(sprints);
    expect(await screen.findByText('Track SHOP has its sprints turned off now.')).toBeVisible();
    expect(sprints).not.toBeChecked();
    await user.click(sprints);
    expect(await screen.findByText('Track SHOP has sprints now.')).toBeVisible();
    expect(sprints).toBeChecked();
    expect(client.calls.map((c) => c.args)).toEqual([
      [3, { features: { sprints: false } }],
      [3, { features: { sprints: true } }],
    ]);
  });

  it('[AGL-010] names the running sprint that keeps sprints on, with a way to the board', async () => {
    const user = userEvent.setup();
    const client = renderPage('tracks', { runningSprint: 'Shop Sprint 4' });
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    const sprints = await screen.findByRole('checkbox', { name: 'Sprints in SHOP' });
    await user.click(sprints);
    const said =
      'The sprint “Shop Sprint 4” is still running in SHOP. Complete it first, then turn sprints off.';
    expect(await screen.findByRole('alert')).toHaveTextContent(said);
    // Nothing changed: the box stays ticked and points at the reason.
    expect(sprints).toBeChecked();
    expect(sprints).toHaveAttribute('aria-invalid', 'true');
    expect(sprints).toHaveAccessibleDescription(expect.stringContaining(said));
    expect(screen.getByRole('link', { name: 'Complete it on the board of SHOP' })).toHaveAttribute(
      'href',
      '#/tracks/SHOP/board',
    );
    expect(screen.queryByText('Track SHOP has its sprints turned off now.')).toBeNull();
    expect(client.calls.at(-1)).toEqual({
      action: 'updateTrack',
      args: [3, { features: { sprints: false } }],
    });
  });

  it("[CORE-002] offers no sprints on a track whose board is Kanban, and says why with a way to the board's kind", async () => {
    const user = userEvent.setup();
    const client = renderPage('tracks');
    await user.click(await screen.findByRole('button', { name: 'Manage track OPS' }));
    expect(
      await screen.findByText(
        'No sprints in OPS: its board is Kanban, and only a Scrum board has sprints. To have them, change the board to Scrum in its settings.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Settings of the board of OPS' })).toHaveAttribute(
      'href',
      '#/boards/40/settings',
    );
    expect(screen.queryByRole('checkbox', { name: 'Sprints in OPS' })).toBeNull();
    expect(client.calls.filter((c) => c.action === 'updateTrack')).toEqual([]);
  });

  it('[CORE-002] offers no sprints on a track with no board yet, and says why', async () => {
    const user = userEvent.setup();
    const client = renderPage('tracks');
    client.trackBoard = async () => null;
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    expect(await screen.findByText(/^No sprints in SHOP: it has no board yet/)).toHaveTextContent(
      'Its board is made as Kanban the first time someone opens it',
    );
    expect(screen.getByRole('link', { name: 'Go to the board of SHOP' })).toHaveAttribute(
      'href',
      '#/tracks/SHOP/board',
    );
    expect(screen.queryByRole('checkbox', { name: 'Sprints in SHOP' })).toBeNull();
  });

  it('[CORE-002] says why when the board turned Kanban after the page read it', async () => {
    const user = userEvent.setup();
    const client = renderPage('tracks');
    // Read as Scrum; the server answers that it is Kanban now.
    client.trackBoard = async () => ({ id: 40, kind: 'scrum' });
    await user.click(await screen.findByRole('button', { name: 'Manage track OPS' }));
    const sprints = await screen.findByRole('checkbox', { name: 'Sprints in OPS' });
    expect(sprints).not.toBeChecked();
    await user.click(sprints);
    expect(await screen.findByText(/^No sprints in OPS: its board is Kanban/)).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: 'Sprints in OPS' })).toBeNull();
    expect(screen.queryByText('Track OPS has sprints now.')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[CORE-002] says why a Kanban track has no sprints on a small phone', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderPage('tracks');
    await user.click(await screen.findByRole('button', { name: 'Manage track OPS' }));
    expect(await screen.findByText(/^No sprints in OPS/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Settings of the board of OPS' })).toBeVisible();
  });

  it('[AGL-010] shows the refusal and its way to the board on a small phone', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderPage('tracks', { runningSprint: 'Shop Sprint 4' });
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Sprints in SHOP' }));
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Complete it on the board of SHOP' })).toBeVisible();
  });

  it('[WF-001] makes a workflow map and gives a ticket type its own workflow', async () => {
    const user = userEvent.setup();
    const client = renderPage('maps');
    await screen.findByText('Default workflow map');
    // The map's workflow is labelled, so its name never reads as a doubled word (AD-26).
    expect(screen.getAllByText(/^Workflow for every other type: /).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'New workflow map' }));
    const form = screen.getByRole('form', { name: 'Add a workflow map' });
    await user.type(within(form).getByLabelText('Map name'), 'Tasks apart');
    await user.click(within(form).getByRole('button', { name: 'Add a workflow map' }));
    expect(await screen.findByText('Tasks apart was added.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New workflow map' })).toHaveFocus();
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
    const trigger = within(map).getByRole('button', { name: 'Delete map Tasks apart' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    // Asks first, saying what will happen (D13).
    const question = within(map).getByRole('group', {
      name: 'Delete Tasks apart? No track can use it afterwards, and this cannot be undone.',
    });
    await user.click(within(question).getByRole('button', { name: 'Delete map Tasks apart' }));
    expect(await screen.findByText('Tasks apart was deleted.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Workflow maps' })).toHaveFocus();
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
