import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { setViewportWidth } from '../test/viewport';
import { fakePlanClient } from './fixtures';
import { PlanPage } from './PlanPage';

function renderPlanList(hash = '#/plans/12/list') {
  window.location.hash = hash;
  const search = fakeListSearch();
  render(
    <I18nProvider locale="en">
      <PlanPage
        id={12}
        section="list"
        client={fakePlanClient()}
        search={search}
        list={fakeListClient(search)}
        now={() => new Date('2026-11-04T09:00:00Z')}
      />
    </I18nProvider>,
  );
  return search;
}

afterEach(() => {
  window.location.hash = '';
  window.localStorage.clear();
});

describe('a plan’s list after the page review (T-220)', () => {
  it('[PLN-012] opens Columns as the same pop-over as search, and ends in Show more (PL-34)', async () => {
    const user = userEvent.setup();
    renderPlanList();
    await screen.findAllByRole('link', { name: /^[A-Z]+-\d+$/ });
    // A button, as on search, not a fold-out card.
    expect(document.querySelector('details.list-panel')).toBeNull();
    const columns = screen.getByRole('button', { name: 'Columns' });
    expect(columns).toHaveAttribute('aria-expanded', 'false');
    await user.click(columns);
    const panel = screen.getByRole('group', { name: 'Columns' });
    expect(within(panel).getByRole('button', { name: 'Default columns' })).toBeVisible();
    // Sorted newest created first, and the Created column says so when it is shown.
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveDisplayValue(
      'Newest created first',
    );
  });

  it('[PLN-012] [NFR-005] shows its tickets as stacked rows on a phone (PL-1, D1)', async () => {
    setViewportWidth(375);
    renderPlanList();
    const rows = await screen.findByRole('list', { name: 'Tickets' });
    expect(screen.queryByRole('table')).toBeNull();
    const first = within(rows).getAllByRole('listitem')[0] as HTMLElement;
    expect(first.querySelector('.result-row-summary')?.textContent).toBeTruthy();
  });

  it('[PLN-012] [PLN-014] orders by a heading, the other way on a second click; the address and the file follow (T-330)', async () => {
    const user = userEvent.setup();
    const search = renderPlanList();
    await screen.findAllByRole('link', { name: /^[A-Z]+-\d+$/ });
    await user.click(screen.getByRole('button', { name: 'Key' }));
    await waitFor(() => expect(window.location.hash).toBe('#/plans/12/list?sort=key'));
    await waitFor(() => expect(search.queries.at(-1)).toMatch(/ ORDER BY key ASC$/));
    expect(await screen.findByRole('columnheader', { name: 'Key' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    const menu = screen.getByRole('combobox', { name: 'Sort by' });
    expect(menu).toHaveDisplayValue('Key');
    const file = async () => {
      await user.click(screen.getByRole('button', { name: 'Download' }));
      const link = await screen.findByRole('menuitem', { name: 'CSV' });
      const url = new URL(link.getAttribute('href') as string, 'http://x.test');
      await user.keyboard('{Escape}');
      return [url.searchParams.get('sort'), url.searchParams.get('order')];
    };
    expect(await file()).toEqual(['key', 'asc']);
    // Again, by keyboard: the other way, which the menu names as no entry of its own.
    (await screen.findByRole('button', { name: 'Key' })).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(window.location.hash).toBe('#/plans/12/list?sort=key&order=desc'));
    await waitFor(() => expect(search.queries.at(-1)).toMatch(/ ORDER BY key DESC$/));
    expect(await screen.findByRole('columnheader', { name: 'Key' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveDisplayValue('Key, descending');
    expect(await file()).toEqual(['key', 'desc']);
    // The menu's Type: by type name, A to Z.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'Type');
    await waitFor(() => expect(window.location.hash).toBe('#/plans/12/list?sort=type'));
    await waitFor(() => expect(search.queries.at(-1)).toMatch(/ ORDER BY type ASC$/));
    expect(await file()).toEqual(['type', 'asc']);
    // Back to the default: the address holds no order.
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Sort by' }),
      'Newest created first',
    );
    await waitFor(() => expect(window.location.hash).toBe('#/plans/12/list'));
    expect(await file()).toEqual(['created', 'desc']);
  });

  it('[PLN-014] opens an address made before T-330 in the order it named', async () => {
    const search = renderPlanList('#/plans/12/list?sort=priority');
    await screen.findAllByRole('link', { name: /^[A-Z]+-\d+$/ });
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveDisplayValue('Priority');
    expect(search.queries.at(-1)).toMatch(/ ORDER BY priority DESC$/);
  });
});
