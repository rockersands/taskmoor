import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { ESTIMATES, type FakeGridOptions, fakeGridClient } from './grid/clientFixtures';
import { DEFAULT_STRUCTURE } from './grid/types';
import { PlanGridPage } from './PlanGridPage';

/** Making and changing a structure of a plan's Grid (T-089a; PLN-010; ADR-122 stage 10). */
function renderGrid(options: FakeGridOptions = {}) {
  const grid = fakeGridClient(options);
  render(
    <I18nProvider locale="en">
      <PlanGridPage
        planId={12}
        view={{ filters: {}, group: null }}
        scenario={null}
        client={grid}
        search={grid.search}
      />
    </I18nProvider>,
  );
  return { grid };
}

afterEach(() => {
  window.location.hash = '';
  window.localStorage.clear();
});

describe('the structure dialog (PLN-010)', () => {
  it('[PLN-010] saves the steps in the order they apply, with totals and a checked formula', async () => {
    const user = userEvent.setup();
    const { grid } = renderGrid();
    await screen.findByRole('treegrid');
    await user.click(screen.getByRole('button', { name: 'New structure…' }));
    const dialog = screen.getByRole('dialog', { name: 'New structure' });
    const inside = within(dialog);
    await user.type(inside.getByLabelText('Name'), 'Work by status');
    await user.type(inside.getByLabelText(/^Add tickets: a query/), 'status != Closed');
    await user.click(inside.getByRole('button', { name: 'Add linked tickets' }));
    await user.selectOptions(
      inside.getByLabelText('Add linked tickets 1: tickets this one'),
      'is blocked by',
    );
    await user.selectOptions(inside.getByLabelText('How far'), 'up to 2 links away');
    await user.selectOptions(inside.getByLabelText('Group by'), 'Status');
    await user.selectOptions(inside.getByLabelText('Then group by'), 'Team');
    await user.click(inside.getByLabelText('Add children, down every level'));
    // A total of Points over the rows below, and a formula.
    await user.selectOptions(inside.getByLabelText('Kind'), 'Total of rows below');
    await user.selectOptions(inside.getByLabelText('Total'), 'Sum');
    await user.selectOptions(inside.getByLabelText('Of'), 'Points');
    await user.click(inside.getByRole('button', { name: 'Add column' }));
    expect(inside.getByText('Adds up Points of the rows below each row.')).toBeVisible();
    await user.selectOptions(inside.getByLabelText('Kind'), 'Formula');
    await user.click(inside.getByRole('button', { name: 'Add column' }));
    expect(await inside.findByText('The formula checks.')).toBeVisible();
    expect(inside.getByText('4 of 30 columns; 1 of 10 totals; 1 of 5 formulas')).toBeVisible();
    await user.click(inside.getByRole('button', { name: 'Create structure' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(grid.calls.created[0]?.spec).toEqual({
      steps: [
        { kind: 'insert', query: 'status != Closed' },
        { kind: 'group', field: 'status' },
        { kind: 'group', field: 'cf[42]' },
        { kind: 'children' },
        { kind: 'links', linkTypeId: 1, direction: 'inward', depth: 2 },
      ],
      columns: [
        { kind: 'ticket', field: 'key' },
        { kind: 'ticket', field: 'summary' },
        { kind: 'total', fn: 'sum', of: 'cf[41]' },
        {
          kind: 'formula',
          name: 'Child rows',
          expression: 'count(children)',
          output: 'number',
          decimals: 0,
        },
      ],
    });
    expect(screen.getByRole('status')).toHaveTextContent('Saved Work by status.');
    expect(window.location.hash).toBe('#/plans/12/grid?structure=1');
  });

  it('[PLN-010] says where a formula does not check, as the server words it, and refuses to save', async () => {
    const user = userEvent.setup();
    const { grid } = renderGrid();
    await screen.findByRole('treegrid');
    await user.click(screen.getByRole('button', { name: 'New structure…' }));
    const inside = within(screen.getByRole('dialog', { name: 'New structure' }));
    await user.type(inside.getByLabelText('Name'), 'Broken');
    await user.selectOptions(inside.getByLabelText('Kind'), 'Formula');
    await user.click(inside.getByRole('button', { name: 'Add column' }));
    const expression = inside.getByLabelText('Formula of column 3');
    await user.clear(expression);
    await user.type(expression, 'sum(children.{{nope})');
    await user.tab();
    expect(
      await inside.findByText('The formula does not check: No field is called nope'),
    ).toBeVisible();
    await user.click(inside.getByRole('button', { name: 'Create structure' }));
    expect(await inside.findByRole('alert')).toHaveTextContent(
      'Something in the structure does not work; it is marked below.',
    );
    expect(grid.calls.created).toHaveLength(1);
  });

  it('[PLN-010] asks for a name, and refuses one the plan already has', async () => {
    const user = userEvent.setup();
    renderGrid({ structures: [{ id: 3, name: 'Estimates', spec: ESTIMATES }] });
    await screen.findByRole('treegrid');
    await user.click(screen.getByRole('button', { name: 'New structure…' }));
    const inside = within(screen.getByRole('dialog', { name: 'New structure' }));
    await user.click(inside.getByRole('button', { name: 'Create structure' }));
    expect(inside.getByRole('alert')).toHaveTextContent('A structure needs a name.');
    await user.type(inside.getByLabelText('Name'), 'estimates');
    await user.click(inside.getByRole('button', { name: 'Create structure' }));
    expect(await inside.findByRole('alert')).toHaveTextContent(
      'This plan already has a structure of that name.',
    );
  });

  it('[PLN-010] saves the unsaved default as a structure, starting from its columns', async () => {
    const user = userEvent.setup();
    const { grid } = renderGrid();
    await screen.findByRole('treegrid');
    await user.click(screen.getByRole('button', { name: 'Save as a structure…' }));
    const inside = within(screen.getByRole('dialog', { name: 'New structure' }));
    expect(inside.getByLabelText('Add children, down every level')).toBeChecked();
    await user.type(inside.getByLabelText('Name'), 'Our tree');
    await user.click(inside.getByRole('button', { name: 'Create structure' }));
    await waitFor(() => expect(grid.calls.created).toHaveLength(1));
    expect(grid.calls.created[0]?.spec).toEqual(DEFAULT_STRUCTURE);
  });

  it('[PLN-010] changes a structure with its version, and says when someone changed it meanwhile', async () => {
    const user = userEvent.setup();
    const { grid } = renderGrid({ structures: [{ id: 3, name: 'Estimates', spec: ESTIMATES }] });
    await screen.findByRole('treegrid', { name: 'Estimates' });
    await user.click(screen.getByRole('button', { name: 'Edit structure…' }));
    const inside = within(screen.getByRole('dialog', { name: 'Edit Estimates' }));
    await user.click(inside.getByRole('button', { name: 'Remove Points below' }));
    await user.click(inside.getByRole('button', { name: 'Move Progress by closed tickets up' }));
    await user.click(inside.getByRole('button', { name: 'Save structure' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(grid.calls.changed[0]).toMatchObject({
      sid: 3,
      change: { version: 1, name: 'Estimates' },
    });
    const sent = grid.calls.changed[0] as { change: { spec: typeof ESTIMATES } };
    const columns = sent.change.spec.columns;
    expect(columns).toHaveLength(ESTIMATES.columns.length - 1);
    expect(columns.at(-2)).toEqual({ kind: 'total', fn: 'progress' });
    // Someone else's change meanwhile: the next try from an old copy is refused.
    await grid.change(12, 3, { name: 'Elsewhere', version: 2 });
    await user.click(screen.getByRole('button', { name: 'Edit structure…' }));
    const again = within(screen.getByRole('dialog'));
    await user.click(again.getByRole('button', { name: 'Save structure' }));
    expect(await again.findByRole('alert')).toHaveTextContent(
      'Someone changed this structure meanwhile.',
    );
  });

  it('[PLN-010] offers readers no way to change structures', async () => {
    renderGrid({ editable: false, structures: [{ id: 3, name: 'Estimates', spec: ESTIMATES }] });
    await screen.findByRole('treegrid');
    expect(screen.queryByRole('button', { name: 'New structure…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit structure…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete structure' })).toBeNull();
  });
});
