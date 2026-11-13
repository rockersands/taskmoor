import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { setViewportWidth } from '../test/viewport';
import { fakePlanClient } from './fixtures';
import { PlanPage } from './PlanPage';

function renderPlanList() {
  window.location.hash = '#/plans/12/list';
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
});
