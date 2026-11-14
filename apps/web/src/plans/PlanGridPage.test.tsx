import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import type { PlanView } from './address';
import { fakePlanClient } from './fixtures';
import { BY_STATUS, ESTIMATES, type FakeGridOptions, fakeGridClient } from './grid/clientFixtures';
import { PlanGridPage } from './PlanGridPage';
import { PlanPage } from './PlanPage';
import { fakeScenarioClient } from './scenarioFixtures';

/**
 * A plan's Grid (T-089a; PLN-010; ADR-122 stage 10): plan 12, "Spring launch", whose sample tree
 * has two Outcomes and a ticket of its own; OPS-12 is outside the plan, DATA-7 was placed by a
 * link, SHOP-44 hides a child from the viewer and SHOP-70 is reached twice.
 */
function renderGrid(
  options: FakeGridOptions = {},
  view: PlanView = { filters: {}, group: null },
  scenario: { id: number; name: string } | null = null,
) {
  const grid = fakeGridClient(options);
  const result = render(
    <I18nProvider locale="en">
      <PlanGridPage
        planId={12}
        view={view}
        scenario={scenario}
        client={grid}
        search={grid.search}
      />
    </I18nProvider>,
  );
  return { grid, ...result };
}

const saved = { structures: [{ id: 3, name: 'Estimates', spec: ESTIMATES }] };
const rowOf = (key: string) =>
  screen.getByRole('rowheader', { name: new RegExp(`^${key}(?!\\d)`) })
    .parentElement as HTMLElement;
/** A row's cells besides its tree cell (a `td` of a treegrid is a gridcell in browsers). */
const cellsOf = (row: HTMLElement) => Array.from(row.querySelectorAll('td'));

afterEach(() => {
  window.location.hash = '';
  window.localStorage.clear();
  act(() => setViewportWidth(1440));
});

describe('a plan’s Grid (PLN-010)', () => {
  it('[PLN-010] shows the unsaved default to a plan with no structure, and says so', async () => {
    const { grid } = renderGrid();
    const tree = await screen.findByRole('treegrid', { name: 'Default structure' });
    expect(screen.getByText(/^This is the default structure, not saved/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save as a structure…' })).toBeVisible();
    expect(grid.calls.rows[0]?.sid).toBe('default');
    // Key, summary, status and assignee, a count and a progress total.
    const headers = within(tree)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual([
      'Ticket',
      'Summary',
      'Status',
      'Assignee',
      'Rows belowTotal of rows below',
      'ProgressTotal of rows below',
    ]);
  });

  it('[PLN-010] draws a treegrid whose rows say their level, place and whether they are open', async () => {
    renderGrid(saved);
    const tree = await screen.findByRole('treegrid', { name: 'Estimates' });
    // Nine rows, a header row and the last row.
    expect(tree).toHaveAttribute('aria-rowcount', '11');
    const outcome = rowOf('SHOP-1');
    expect(outcome).toHaveAttribute('aria-level', '1');
    expect(outcome).toHaveAttribute('aria-expanded', 'true');
    expect(outcome).toHaveAttribute('aria-posinset', '1');
    expect(outcome).toHaveAttribute('aria-setsize', '3');
    const sub = rowOf('SHOP-60');
    expect(sub).toHaveAttribute('aria-level', '3');
    expect(sub).not.toHaveAttribute('aria-expanded');
    expect(rowOf('SHOP-70')).toHaveAttribute('aria-rowindex', '10');
  });

  it('[PLN-010] totals the rows below each row, the last row the top rows, never a hidden ticket', async () => {
    renderGrid(saved);
    await screen.findByRole('treegrid');
    // Estimates: SHOP-41's own 5 h is not added; its subticket's 2 h is its total.
    const cells = (key: string) => cellsOf(rowOf(key)).map((c) => c.textContent);
    expect(cells('SHOP-41')).toContain('2 h');
    expect(cells('SHOP-1')).toContain('6 h');
    expect(cells('SHOP-1')).toContain('2 of 4 closed');
    // Points: SHOP-60 1, SHOP-44 5, OPS-12 2.
    expect(cells('SHOP-1')).toContain('8');
    const last = screen.getByRole('rowheader', { name: 'All rows' }).parentElement as HTMLElement;
    expect(within(last).getByText('2 of 9 closed')).toBeVisible();
    // Hidden, outside the plan, placed by a link, and reached twice: counted and said, not named.
    expect(within(rowOf('SHOP-44')).getByText('+1 not shown')).toBeVisible();
    expect(within(rowOf('SHOP-1')).getByText('+1 not shown')).toBeVisible();
    expect(within(rowOf('OPS-12')).getByText('Not in this plan')).toBeVisible();
    expect(within(rowOf('DATA-7')).getByText('Placed by a link')).toBeVisible();
    expect(
      within(rowOf('SHOP-70')).getByText('Also reached once more, shown elsewhere'),
    ).toBeVisible();
  });

  it('[PLN-010] collapses and expands rows, and keeps what is collapsed in this browser', async () => {
    const user = userEvent.setup();
    const { unmount } = renderGrid(saved);
    await screen.findByRole('treegrid');
    await user.click(screen.getByRole('button', { name: 'Collapse SHOP-1' }));
    expect(screen.queryByRole('rowheader', { name: /SHOP-41/ })).toBeNull();
    expect(rowOf('SHOP-1')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('treegrid')).toHaveAttribute('aria-rowcount', '7');
    expect(window.localStorage.getItem('taskmoor.grid.12.3')).toBe('["t1"]');
    unmount();
    renderGrid(saved);
    await screen.findByRole('treegrid');
    expect(screen.getByRole('button', { name: 'Expand SHOP-1' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.getAllByRole('row')).toHaveLength(2 + 3);
    await user.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getAllByRole('row')).toHaveLength(2 + 9);
  });

  it('[PLN-010] moves with the keyboard: arrows, Right and Left to open and close, Home and End', async () => {
    const user = userEvent.setup();
    renderGrid(saved);
    await screen.findByRole('treegrid');
    const first = rowOf('SHOP-1');
    act(() => first.focus());
    await user.keyboard('{ArrowLeft}');
    expect(rowOf('SHOP-1')).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{ArrowRight}');
    expect(rowOf('SHOP-1')).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{ArrowDown}');
    expect(rowOf('SHOP-41')).toHaveFocus();
    // Left on a child row goes to its parent's row.
    await user.keyboard('{ArrowDown}{ArrowLeft}');
    expect(rowOf('SHOP-41')).toHaveFocus();
    // Into its cells, and to a row's ends.
    await user.keyboard('{ArrowRight}');
    expect(within(rowOf('SHOP-41')).getByRole('rowheader')).toHaveFocus();
    await user.keyboard('{End}');
    expect(cellsOf(rowOf('SHOP-41')).at(-1)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(within(rowOf('SHOP-41')).getByRole('rowheader')).toHaveFocus();
    await user.keyboard('{Control>}{End}{/Control}');
    expect(within(rowOf('SHOP-70')).getByRole('rowheader')).toHaveFocus();
  });

  it('[PLN-010] edits a cell in place; the totals above change and their cells are read again', async () => {
    const user = userEvent.setup();
    const { grid } = renderGrid(saved);
    await screen.findByRole('treegrid');
    await screen.findByRole('button', { name: 'Edit Points of SHOP-44' });
    expect(cellsOf(rowOf('SHOP-1')).map((c) => c.textContent)).toContain('8');
    const before = grid.calls.tickets.length;
    await user.click(screen.getByRole('button', { name: 'Edit Points of SHOP-44' }));
    const field = screen.getByRole('spinbutton', { name: 'Edit Points of SHOP-44' });
    await user.clear(field);
    await user.type(field, '8{Enter}');
    await waitFor(() => expect(cellsOf(rowOf('SHOP-1')).map((c) => c.textContent)).toContain('11'));
    // SHOP-1's cells are read again, since the server recomputed its stored formula fields.
    await waitFor(() =>
      expect(grid.calls.tickets.slice(before).some((ids) => ids.includes(1))).toBe(true),
    );
    expect(grid.store.get(44)?.fields).toEqual({ '41': 8 });
  });

  it('[PLN-010] scrolls 100,000 rows to the last and saves an edit there, drawing only a window', async () => {
    const errors = vi.spyOn(console, 'error');
    const user = userEvent.setup();
    renderGrid({ skeleton: 100_000 });
    const tree = await screen.findByRole('treegrid', { name: 'Default structure' });
    expect(tree).toHaveAttribute('aria-rowcount', String(100_000 + 2));
    expect(within(tree).getAllByRole('row').length).toBeLessThan(80);
    act(() => (within(tree).getAllByRole('row')[1] as HTMLElement).focus());
    await user.keyboard('{Control>}{End}{/Control}');
    const last = await screen.findByRole('rowheader', { name: /BIG-100000/ });
    expect(last.parentElement).toHaveAttribute('aria-rowindex', String(100_000 + 1));
    // Drawn: the window around the last row and the focused row, never every row.
    expect(within(tree).getAllByRole('row').length).toBeLessThan(80);
    const edit = await screen.findByRole('button', { name: 'Edit Summary of BIG-100000' });
    await user.click(edit);
    const field = screen.getByRole('textbox', { name: 'Edit Summary of BIG-100000' });
    await user.clear(field);
    await user.type(field, 'The last one{Enter}');
    expect(await screen.findByText('The last one')).toBeVisible();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  }, 60_000);

  it('[PLN-010] inside a scenario shows live values, read-only', async () => {
    const { grid } = renderGrid(
      saved,
      { filters: {}, group: null, scenario: 4 },
      {
        id: 4,
        name: 'Faster',
      },
    );
    await screen.findByRole('treegrid');
    expect(screen.getByText(/^The Grid shows tickets as they are, not drafts/)).toBeVisible();
    await waitFor(() => expect(grid.calls.tickets.length).toBeGreaterThan(0));
    await within(rowOf('SHOP-41')).findByText('Refunds fail for expired cards');
    expect(screen.queryByRole('button', { name: /^Edit Summary of/ })).toBeNull();
    expect(grid.calls.rows[0]?.at.scenario).toBe(4);
  });

  it('[PLN-010] refuses a read that runs too long, showing nothing of it, and tries again', async () => {
    const user = userEvent.setup();
    const { grid } = renderGrid({ timeout: true });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Reading this structure took too long, so nothing is shown/,
    );
    expect(screen.queryByRole('treegrid')).toBeNull();
    grid.fixed();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('treegrid')).toBeVisible();
  });

  it('[PLN-010] says when a structure adds no rows, and when it stops at 100,000', async () => {
    renderGrid({ skeleton: 'empty' });
    expect(await screen.findByText('No rows in this structure')).toBeVisible();
  });

  it('[PLN-010] says the rows are cut at the limit', async () => {
    renderGrid({ more: true });
    expect(await screen.findByText('Shows the first 9 rows.')).toBeVisible();
  });

  it('[PLN-010] names groups by field and value, "No value" for none', async () => {
    renderGrid({
      skeleton: 'grouped',
      structures: [{ id: 5, name: 'By status', spec: BY_STATUS }],
    });
    await screen.findByRole('treegrid');
    expect(screen.getByRole('rowheader', { name: /Status: Active/ })).toBeVisible();
    expect(screen.getByRole('rowheader', { name: /Status: No value/ })).toBeVisible();
  });

  it('[PLN-010] marks a column that no longer works, while the rest still does', async () => {
    renderGrid({
      ...saved,
      problems: [
        {
          path: 'columns.8',
          reason: 'formula',
          error: { code: 'unknown_field', message: 'No field is called Points' },
        },
      ],
    });
    const tree = await screen.findByRole('treegrid');
    expect(
      within(tree).getByRole('columnheader', { name: /Does not work: No field is called Points/ }),
    ).toBeVisible();
    expect(cellsOf(rowOf('SHOP-1')).map((c) => c.textContent)).toContain('6 h');
  });

  it('[PLN-010] on a phone shows cards that open a sheet of every column', async () => {
    act(() => setViewportWidth(360));
    const user = userEvent.setup();
    renderGrid(saved);
    const cards = await screen.findByRole('list', { name: '9 rows' });
    expect(screen.queryByRole('treegrid')).toBeNull();
    await user.click(within(cards).getByRole('button', { name: 'Collapse SHOP-1' }));
    expect(within(cards).queryByRole('button', { name: 'Open SHOP-41' })).toBeNull();
    await user.click(within(cards).getByRole('button', { name: 'Open SHOP-70' }));
    const sheet = await screen.findByRole('dialog', { name: /^SHOP-70/ });
    expect(
      within(sheet).getByRole('rowheader', { name: 'Sum of Original estimate' }),
    ).toBeVisible();
    expect(
      await within(sheet).findByRole('button', { name: 'Edit Summary of SHOP-70' }),
    ).toBeVisible();
  });

  it('[NFR-006] passes every string through the pseudo-locale', async () => {
    const errors: Error[] = [];
    const grid = fakeGridClient(saved);
    const view = render(
      <I18nProvider locale="en-XA" onError={(e) => errors.push(e)}>
        <PlanGridPage
          planId={12}
          view={{ filters: {}, group: null }}
          scenario={null}
          client={grid}
          search={grid.search}
        />
      </I18nProvider>,
    );
    await screen.findByRole('treegrid');
    await waitFor(() =>
      expect(view.container.querySelectorAll('.plan-grid-quiet')).toHaveLength(0),
    );
    // Keys, summaries, names, statuses and numbers are data, as typed.
    const data = new Set([
      'Estimates',
      'Points below',
      'Points',
      'Checkout that never loses a cart',
      'Refunds fail for expired cards',
      'Retry the refund job',
      'Receipts show the wrong currency',
      'Rotate the payment keys',
      'Faster search',
      'Index product names',
      'Rebuild the search index',
      'Dark mode for receipts',
      'Ana Ruiz',
      'Kalo Moana',
      'Rin Okafor',
      'New',
      'Active',
      'Closed',
    ]);
    const typed = (x: string) => data.has(x) || /^([A-Z]+-\d+|[\d.,]+)$/.test(x);
    expect(untranslated(visibleTexts(view.container).filter((x) => !typed(x)))).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('the Grid on the plan’s page (ADR-122 stage 10)', () => {
  it('[PLN-010] has a Grid tab after List, keeping the view', async () => {
    window.location.hash = '#/plans/12/grid?track=SHOP';
    const plans = fakePlanClient();
    const search = fakeListSearch();
    const grid = fakeGridClient(saved);
    render(
      <I18nProvider locale="en">
        <PlanPage
          id={12}
          section="grid"
          client={plans}
          scenarios={fakeScenarioClient(plans, { scenarios: [{ name: 'Faster' }] })}
          grid={grid}
          search={grid.search}
          list={fakeListClient(search)}
          now={() => new Date('2026-11-14T09:00:00Z')}
        />
      </I18nProvider>,
    );
    expect(await screen.findByRole('treegrid', { name: 'Estimates' })).toBeVisible();
    const tabs = screen.getByRole('navigation', { name: /^Sections of / });
    const names = within(tabs)
      .getAllByRole('link')
      .map((l) => l.textContent);
    expect(names.indexOf('Grid')).toBe(names.indexOf('List') + 1);
    expect(within(tabs).getByRole('link', { name: 'Grid' })).toHaveAttribute(
      'href',
      '#/plans/12/grid?track=SHOP',
    );
    expect(grid.calls.rows[0]?.at.filters).toEqual({ track: 'SHOP' });
  });
});
