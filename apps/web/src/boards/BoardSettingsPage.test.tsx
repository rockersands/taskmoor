import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { fakeTrackClient } from '../tracks/fixtures';
import { TrackLayout } from '../tracks/TrackLayout';
import { BoardSettingsPage } from './BoardSettingsPage';
import { BOARD, fakeBoardClient, SCRUM_BOARD } from './fixtures';

function renderSettings(client = fakeBoardClient()) {
  render(
    <I18nProvider locale="en">
      <BoardSettingsPage boardId={7} client={client} />
    </I18nProvider>,
  );
  return client;
}
const ready = () => screen.findByRole('heading', { level: 1, name: 'Settings of Checkout team' });

describe("changing the board's kind (ADR-116)", () => {
  it("[CORE-002] tells the track's tab bar at once, so Backlog comes or goes without a reload", async () => {
    const user = userEvent.setup();
    const tracks = fakeTrackClient();
    const sections = vi.fn(async () => ({ backlog: false, sprints: false }));
    tracks.sections = sections;
    render(
      <I18nProvider locale="en">
        <TrackLayout trackKey="SHOP" section="board" client={tracks}>
          <BoardSettingsPage boardId={7} client={fakeBoardClient()} />
        </TrackLayout>
      </I18nProvider>,
    );
    await ready();
    const bar = screen.getByRole('navigation', { name: 'Sections of SHOP' });
    await waitFor(() => expect(sections).toHaveBeenCalledTimes(1));
    expect(within(bar).queryByRole('link', { name: 'Backlog' })).toBeNull();

    sections.mockResolvedValue({ backlog: true, sprints: true });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'scrum');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await within(bar).findByRole('link', { name: 'Backlog' })).toBeVisible();

    // Saving something else does not ask again.
    const asked = sections.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByRole('status');
    expect(sections).toHaveBeenCalledTimes(asked);
  });
});

describe('columns no card can reach (ADR-116)', () => {
  const reach = {
    workflow: { id: 1, name: 'Default workflow' },
    singleWorkflow: true,
    otherTracks: ['Web app'],
    columns: { todo: 'no_status' as const },
    mayFix: true,
  };

  it('[AGL-002] says so at once, names who else is affected and offers the fix', async () => {
    const user = userEvent.setup();
    const client = fakeBoardClient();
    const read = client.settings;
    client.settings = async (id) => ({ ...(await read(id)), reach });
    const fix = vi.spyOn(client, 'addColumnPath');
    render(
      <I18nProvider locale="en">
        <BoardSettingsPage boardId={7} client={client} />
      </I18nProvider>,
    );
    expect(await screen.findByText(/No card can go to To do yet/)).toBeVisible();
    expect(screen.getByText(/which Web app also use/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Let cards reach To do' }));
    expect(fix).toHaveBeenCalledWith(7, 'todo');
  });

  it('[AGL-002] tells others who can fix it instead of offering it', async () => {
    const client = fakeBoardClient();
    const read = client.settings;
    client.settings = async (id) => ({ ...(await read(id)), reach: { ...reach, mayFix: false } });
    render(
      <I18nProvider locale="en">
        <BoardSettingsPage boardId={7} client={client} />
      </I18nProvider>,
    );
    expect(await screen.findByText(/A site or configuration administrator can fix/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Let cards reach/ })).toBeNull();
  });
});

describe('board settings (M1-043)', () => {
  it('[AGL-002] [AGL-003] maps statuses to columns and sets WIP limits', async () => {
    const user = userEvent.setup();
    const client = renderSettings();
    await ready();
    expect(screen.getByRole('combobox', { name: 'Column for In Review' })).toHaveDisplayValue(
      'Review and done',
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Column for In Review' }),
      'Doing',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Column for New' }), '');
    await user.clear(screen.getByRole('spinbutton', { name: 'Maximum in Doing' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Maximum in Doing' }), '4');
    await user.type(screen.getByRole('spinbutton', { name: 'Minimum in To do' }), '1');
    await user.click(screen.getByRole('button', { name: 'Add a column' }));
    await user.type(screen.getByRole('textbox', { name: 'Name of column 4' }), 'Shipped');
    await user.click(screen.getByRole('button', { name: 'Move Shipped up' }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(client.patches[0]?.version).toBe(3);
    expect(client.patches[0]?.columns).toEqual([
      { id: 'todo', name: 'To do', statusIds: [], min: 1, max: null },
      { id: 'doing', name: 'Doing', statusIds: [2, 3], min: null, max: 4 },
      { name: 'Shipped', statusIds: [], min: null, max: null },
      { id: 'done', name: 'Review and done', statusIds: [4], min: 1, max: null },
    ]);
  });

  it('[CORE-027] gives the board a team, and takes it away', async () => {
    const user = userEvent.setup();
    const client = renderSettings(fakeBoardClient({ board: { team: { id: 22, name: 'Mobile' } } }));
    await ready();
    const team = screen.getByRole('combobox', { name: 'Team' });
    expect(team).toHaveDisplayValue('Mobile');
    await user.selectOptions(team, 'Platform');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(client.patches[0]?.teamId).toBe(21);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Team' }), 'No team');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(client.patches[1]?.teamId).toBeNull());
  });

  it('[WF-010] lets the columns become the track’s statuses, and hides the status mapping', async () => {
    const user = userEvent.setup();
    renderSettings();
    await ready();
    const managed = screen.getByRole('checkbox', {
      name: 'This board’s columns are its track’s statuses',
    });
    expect(managed).not.toBeChecked();
    expect(screen.getByRole('table', { name: 'Which column shows each status' })).toBeVisible();
    await user.click(managed);
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(managed).toBeChecked();
    expect(managed).toHaveAccessibleDescription(/A new column gets a status of its own/);
    expect(screen.queryByRole('table', { name: 'Which column shows each status' })).toBeNull();
  });

  it('[WF-010] explains why a board cannot manage its workflow', async () => {
    const user = userEvent.setup();
    const client = fakeBoardClient();
    client.manageWorkflow = async () => ({ ok: false, problem: 'shared_mode_track' });
    renderSettings(client);
    await ready();
    await user.click(
      screen.getByRole('checkbox', { name: 'This board’s columns are its track’s statuses' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only a board of a local-mode track can manage its workflow.',
    );
  });

  it('[AGL-004] [AGL-005] sets the lanes and orders the board filters', async () => {
    const user = userEvent.setup();
    const client = renderSettings();
    await ready();
    expect(screen.getByRole('textbox', { name: 'Query of Expedite' })).toHaveValue(
      'priority = Urgent',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Group cards' }), 'assignees');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Unassigned tickets' }), 'first');
    await user.click(screen.getByRole('button', { name: 'Add a board filter' }));
    await user.type(screen.getByRole('textbox', { name: 'Name of board filter 3' }), 'Bugs');
    await user.type(screen.getByRole('textbox', { name: 'Query of Bugs' }), 'type = Bug');
    await user.click(screen.getByRole('button', { name: 'Move Bugs up' }));
    await user.click(screen.getByRole('button', { name: 'Remove Recently updated' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Show board filters as' }),
      'dropdown',
    );
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByRole('status');
    const patch = client.patches[0];
    expect(patch?.swimlanes).toMatchObject({ mode: 'assignees', unassigned: 'first' });
    expect(patch?.boardFilters?.map((f) => f.name)).toEqual(['My work', 'Bugs']);
    expect(patch?.boardFilterDisplay).toBe('dropdown');
  });

  it('[AGL-006] colours by query and allows ten card fields at most', async () => {
    const user = userEvent.setup();
    const client = renderSettings();
    await ready();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Colour cards by' }), 'queries');
    await user.click(screen.getByRole('button', { name: 'Add a colour rule' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Query of Colour rule 1' }),
      'priority = High',
    );
    const fields = within(screen.getByRole('group', { name: 'Fields on cards (up to 10)' }));
    for (const name of [
      'Due date',
      'Start date',
      'Labels',
      'Target releases',
      'Areas',
      'Requester',
      'Parent',
      'Track',
    ]) {
      await user.click(fields.getByRole('checkbox', { name }));
    }
    expect(fields.getByRole('checkbox', { name: 'Votes' })).toBeDisabled();
    expect(fields.getByRole('checkbox', { name: 'Assignee' })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Show days in column' }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByRole('status');
    expect(client.patches[0]?.cardRules).toMatchObject({
      colourBy: 'queries',
      colours: [{ query: 'priority = High', colour: '#2f6fdb' }],
      daysInColumn: false,
    });
    expect(client.patches[0]?.cardRules?.fields).toHaveLength(10);
  });

  it('[AGL-001] marks a query the server cannot read, and says when someone saved first', async () => {
    const user = userEvent.setup();
    const client = renderSettings();
    await ready();
    const query = screen.getByRole('textbox', { name: 'Tickets (a query)' });
    await user.clear(query);
    await user.type(query, 'status =');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved.');
    expect(query).toHaveAttribute('aria-invalid', 'true');
    expect(query).toHaveAccessibleDescription('This query cannot be read.');
    // Saved by someone else meanwhile: the version moved on.
    await client.update(7, { version: 3, name: 'Elsewhere' });
    await user.clear(query);
    await user.type(query, 'track = SHOP');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Someone changed this board meanwhile.'),
    );
  });

  it('[AGL-001] is read-only for people who may not configure the board', async () => {
    renderSettings(fakeBoardClient({ board: { ...SCRUM_BOARD, mayConfigure: false } }));
    expect(
      await screen.findByText(
        'Only board admins and the administrators of its track change this board.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Sprints' })).toBeNull();
  });
});

describe('sprint settings of a Scrum board (M1-044, M1-045)', () => {
  const scrum = (options: Parameters<typeof fakeBoardClient>[0] = {}) =>
    fakeBoardClient({ board: SCRUM_BOARD, ...options });
  const sprints = () => within(screen.getByRole('group', { name: 'Sprints' }));
  const save = () => userEvent.click(screen.getByRole('button', { name: 'Save settings' }));

  it('[AGL-007] [AGL-012] shows the saved settings and saves a changed cycle with the rest', async () => {
    const user = userEvent.setup();
    const client = renderSettings(scrum());
    await ready();
    expect(sprints().getByRole('combobox', { name: 'Estimate with' })).toHaveDisplayValue(
      'A number field, such as story points',
    );
    await waitFor(() =>
      expect(sprints().getByRole('combobox', { name: 'Number field' })).toHaveDisplayValue(
        'Story points',
      ),
    );
    expect(
      sprints().getByRole('checkbox', { name: 'Roll sprints over automatically' }),
    ).toBeChecked();
    const length = sprints().getByRole('spinbutton', { name: 'Days in each sprint' });
    expect(length).toHaveValue(14);
    expect(sprints().getByRole('combobox', { name: 'Time zone of the cycle' })).toHaveDisplayValue(
      'Europe/Madrid',
    );
    await user.clear(length);
    await user.type(length, '21');
    await user.selectOptions(
      sprints().getByRole('combobox', { name: 'Time zone of the cycle' }),
      'America/Mexico_City',
    );
    await user.selectOptions(
      sprints().getByRole('combobox', { name: 'Time tracking' }),
      'remainingEstimate',
    );
    await save();
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(client.patches[0]?.sprintSettings).toEqual({
      estimation: { statistic: 'field', fieldId: 31 },
      timeTracking: 'remainingEstimate',
      parallelSprints: false,
      cycle: { lengthDays: 21, timeZone: 'America/Mexico_City' },
    });
    // The saved board reads back into the form.
    expect(sprints().getByRole('spinbutton', { name: 'Days in each sprint' })).toHaveValue(21);
    expect(sprints().getByRole('combobox', { name: 'Time zone of the cycle' })).toHaveDisplayValue(
      'America/Mexico City',
    );
  });

  it('[AGL-011] [AGL-012] explains a cycle refused beside parallel sprints, then saves it off', async () => {
    const user = userEvent.setup();
    const client = renderSettings(scrum());
    await ready();
    await user.click(
      sprints().getByRole('checkbox', { name: 'Allow several active sprints at once' }),
    );
    await save();
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved.');
    const cycle = sprints().getByRole('checkbox', { name: 'Roll sprints over automatically' });
    expect(cycle).toBeInvalid();
    expect(cycle).toHaveAccessibleDescription(/Turn off several active sprints to use it\.$/);
    await user.click(cycle);
    await save();
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(client.patches[1]?.sprintSettings).toMatchObject({ parallelSprints: true, cycle: null });
  });

  it('[AGL-007] [AGL-012] explains a field that is not a number field and a time zone the server does not know', async () => {
    const user = userEvent.setup();
    renderSettings(
      scrum({
        board: {
          ...SCRUM_BOARD,
          sprintSettings: {
            ...SCRUM_BOARD.sprintSettings,
            estimation: { statistic: 'field', fieldId: 99 },
          },
        },
        unknownTimeZones: ['Pacific/Chatham'],
      }),
    );
    await ready();
    await user.selectOptions(
      sprints().getByRole('combobox', { name: 'Time zone of the cycle' }),
      'Pacific/Chatham',
    );
    await save();
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved.');
    const picker = sprints().getByRole('combobox', { name: 'Number field' });
    expect(picker).toHaveDisplayValue('Field 99');
    expect(picker).toHaveAccessibleDescription(
      'This field is not a number field, or it no longer exists. Pick another.',
    );
    expect(
      sprints().getByRole('combobox', { name: 'Time zone of the cycle' }),
    ).toHaveAccessibleDescription(/The server does not know this time zone\. Pick another\.$/);
  });

  it('[AGL-007] belongs to Scrum boards only', async () => {
    const user = userEvent.setup();
    const client = renderSettings();
    await ready();
    expect(screen.queryByRole('group', { name: 'Sprints' })).toBeNull();
    await save();
    await screen.findByRole('status');
    expect(client.patches[0]).not.toHaveProperty('sprintSettings');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'scrum');
    expect(sprints().getByRole('combobox', { name: 'Estimate with' })).toHaveDisplayValue(
      'Original time estimate',
    );
    expect(
      sprints().getByRole('checkbox', { name: 'Roll sprints over automatically' }),
    ).not.toBeChecked();
  });

  it('[AGL-012] turns a cycle on on a phone', async () => {
    act(() => setViewportWidth(375));
    const user = userEvent.setup();
    const client = renderSettings(fakeBoardClient({ board: { ...BOARD, kind: 'scrum' } }));
    await ready();
    await user.click(sprints().getByRole('checkbox', { name: 'Roll sprints over automatically' }));
    await user.selectOptions(
      sprints().getByRole('combobox', { name: 'Time zone of the cycle' }),
      'Pacific/Auckland',
    );
    await save();
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(client.patches[0]?.sprintSettings?.cycle).toEqual({
      lengthDays: 14,
      timeZone: 'Pacific/Auckland',
    });
  });
});
