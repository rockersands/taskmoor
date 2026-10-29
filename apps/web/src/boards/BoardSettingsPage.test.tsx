import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { BoardSettingsPage } from './BoardSettingsPage';
import { BOARD, fakeBoardClient } from './fixtures';

function renderSettings(client = fakeBoardClient()) {
  render(
    <I18nProvider locale="en">
      <BoardSettingsPage boardId={7} client={client} />
    </I18nProvider>,
  );
  return client;
}
const ready = () => screen.findByRole('heading', { level: 1, name: 'Settings of Checkout team' });

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
    expect(patch?.boardFilters?.map((f) => f.name)).toEqual(['Only my tickets', 'Bugs']);
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
    renderSettings(fakeBoardClient({ board: { ...BOARD, mayConfigure: false } }));
    expect(
      await screen.findByText(
        'Only board admins and the administrators of its track change this board.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  });
});
