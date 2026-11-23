import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakeListClient, fakeListSearch } from './fixtures';
import { ListPage } from './ListPage';

function renderList(trackKey = 'SHOP', locale: Locale = 'en') {
  const search = fakeListSearch();
  const client = fakeListClient(search);
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={MEMBER}>
        <ListPage trackKey={trackKey} client={client} search={search} />
      </SessionProvider>
    </I18nProvider>,
  );
  return { search, client };
}
const rowOf = (key: string) => screen.getByRole('link', { name: key }).closest('tr') as HTMLElement;

describe('a track’s list (M1-049)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '#/');
  });

  it('[AGL-016] orders by a heading, the other way on a second click, and the address keeps it (T-330)', async () => {
    window.history.replaceState(null, '', '#/tracks/SHOP/list');
    const user = userEvent.setup();
    const { search } = renderList();
    await screen.findByRole('link', { name: 'SHOP-41' });
    const menu = () => screen.getByRole('combobox', { name: 'Sort by' });
    expect(await screen.findByRole('columnheader', { name: 'Key' })).not.toHaveAttribute(
      'aria-sort',
    );
    // The button sits inside the heading and is named by its words.
    const heading = screen.getByRole('columnheader', { name: 'Key' });
    await user.click(within(heading).getByRole('button', { name: 'Key' }));
    await waitFor(() => expect(search.queries.at(-1)).toBe('track = SHOP ORDER BY key ASC'));
    expect(await screen.findByRole('columnheader', { name: 'Key' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    expect(window.location.hash).toBe('#/tracks/SHOP/list?sort=key');
    expect(menu()).toHaveDisplayValue('Key');
    // The table stays while its rows are read again: the heading keeps the focus, and the new
    // order is said.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sorted by Key'));
    expect(screen.getByRole('button', { name: 'Key' })).toHaveFocus();
    // Again, by keyboard where the focus is: the other way, which the menu names as no entry.
    await user.keyboard('{Enter}');
    await waitFor(() => expect(search.queries.at(-1)).toBe('track = SHOP ORDER BY key DESC'));
    expect(await screen.findByRole('columnheader', { name: 'Key' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(window.location.hash).toBe('#/tracks/SHOP/list?sort=key&order=desc');
    expect(menu()).toHaveDisplayValue('Key, descending');
    expect(screen.getByRole('button', { name: 'Key' })).toHaveFocus();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Sorted by Key, descending'),
    );
    // A column the menu has no entry for: the menu still says the order.
    await user.click(await screen.findByRole('button', { name: 'Updated' }));
    await waitFor(() => expect(search.queries.at(-1)).toBe('track = SHOP ORDER BY updated DESC'));
    expect(menu()).toHaveDisplayValue('Recently updated');
    await user.click(await screen.findByRole('button', { name: 'Updated' }));
    await waitFor(() => expect(search.queries.at(-1)).toBe('track = SHOP ORDER BY updated ASC'));
    expect(menu()).toHaveDisplayValue('Updated, earliest first');
    await user.click(await screen.findByRole('button', { name: 'Summary' }));
    await waitFor(() => expect(search.queries.at(-1)).toBe('track = SHOP ORDER BY summary ASC'));
    expect(menu()).toHaveDisplayValue('Summary, ascending');
    // The menu's Type and Key: by type name A to Z, and by ticket number.
    await user.selectOptions(menu(), 'Type');
    await waitFor(() => expect(search.queries.at(-1)).toBe('track = SHOP ORDER BY type ASC'));
    expect(window.location.hash).toBe('#/tracks/SHOP/list?sort=type');
    expect(await screen.findByRole('columnheader', { name: 'Type' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    // The extra entry is gone once the menu names the order.
    expect(within(menu()).queryByRole('option', { name: 'Summary, ascending' })).toBeNull();
    await user.selectOptions(menu(), 'Newest created first');
    await waitFor(() => expect(search.queries.at(-1)).toBe('track = SHOP ORDER BY created DESC'));
    expect(window.location.hash).toBe('#/tracks/SHOP/list');
  });

  it('[AGL-016] opens an address ordered by a field the person cannot see in the default order (T-330)', async () => {
    window.history.replaceState(null, '', '#/tracks/SHOP/list?sort=cf[99]');
    const { search } = renderList();
    await screen.findByRole('link', { name: 'SHOP-41' });
    // Not a refused query that every group would show as a bad filter: newest created first.
    expect(search.queries).toEqual(['track = SHOP ORDER BY created DESC']);
    expect(screen.queryByText('The filter is not a query this list can run.')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveDisplayValue(
      'Newest created first',
    );
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('[AGL-016] opens an address ordered by a field the person sees in that order (T-330)', async () => {
    window.history.replaceState(null, '', '#/tracks/SHOP/list?sort=cf[40]');
    const { search } = renderList();
    await screen.findByRole('link', { name: 'SHOP-41' });
    expect(search.queries).toEqual(['track = SHOP ORDER BY cf[40] ASC']);
  });

  it('[AGL-016] opens in the order its address holds (T-330)', async () => {
    window.history.replaceState(null, '', '#/tracks/SHOP/list?sort=type&order=desc');
    const { search } = renderList();
    await screen.findByRole('link', { name: 'SHOP-41' });
    expect(search.queries[0]).toBe('track = SHOP ORDER BY type DESC');
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveDisplayValue(
      'Type, descending',
    );
    expect(await screen.findByRole('columnheader', { name: 'Type' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('[AGL-016] lists the track’s tickets and edits a cell in place', async () => {
    const user = userEvent.setup();
    const { search } = renderList();
    // Titled by its section, under the track's name (D26).
    expect(await screen.findByRole('heading', { name: 'List', level: 1 })).toBeVisible();
    expect(screen.getByText('Shop', { selector: '.page-eyebrow' })).toBeVisible();
    expect(await screen.findByRole('link', { name: 'SHOP-41' })).toBeVisible();
    expect(search.queries[0]).toBe('track = SHOP ORDER BY created DESC');
    await user.click(screen.getByRole('button', { name: 'Edit Summary of SHOP-41' }));
    const input = screen.getByRole('textbox', { name: 'Edit Summary of SHOP-41' });
    await user.clear(input);
    await user.type(input, 'Refunds work again{Enter}');
    await waitFor(() =>
      expect(within(rowOf('SHOP-41')).getByText('Refunds work again')).toBeVisible(),
    );
    expect(search.edits.at(-1)).toMatchObject({
      id: 41,
      change: { summary: 'Refunds work again' },
    });
  });

  it('[AGL-016] groups by priority and shows each group’s count', async () => {
    const user = userEvent.setup();
    const { search } = renderList();
    await screen.findByRole('link', { name: 'SHOP-41' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Group by' }), 'Priority');
    expect(await screen.findByRole('heading', { name: 'High (1 ticket)' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Medium (2 tickets)' })).toBeVisible();
    const high = within(screen.getByRole('region', { name: 'High (1 ticket)' }));
    expect(await high.findByRole('link', { name: 'SHOP-44' })).toBeVisible();
    expect(search.queries).toContain('track = SHOP AND priority = 1 ORDER BY created DESC');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'Due date');
    await waitFor(() =>
      expect(search.queries).toContain('track = SHOP AND priority = 1 ORDER BY due ASC'),
    );
  });

  it('[AGL-016] [NFR-006] names a seeded type’s or priority’s group in Spanish, and keeps its query', async () => {
    const user = userEvent.setup();
    const { search } = renderList('SHOP', 'es');
    await screen.findByRole('link', { name: 'SHOP-41' });
    const groupBy = screen.getByRole('combobox', { name: 'Agrupar por' });
    await user.selectOptions(groupBy, 'Prioridad');
    const high = await screen.findByRole('region', { name: 'Alta (1 ticket)' });
    expect(await within(high).findByRole('link', { name: 'SHOP-44' })).toBeVisible();
    expect(search.queries).toContain('track = SHOP AND priority = 1 ORDER BY created DESC');
    // A priority someone added shows as they wrote it.
    expect(screen.getByRole('heading', { name: 'Medium (2 tickets)' })).toBeVisible();
    await user.selectOptions(groupBy, 'Tipo');
    expect(await screen.findByRole('heading', { name: 'Error (3 tickets)' })).toBeVisible();
    await waitFor(() =>
      expect(search.queries).toContain('track = SHOP AND type = Bug ORDER BY created DESC'),
    );
  });

  it('[AGL-016] colours the rows a format rule finds and names the rule beside the key', async () => {
    const user = userEvent.setup();
    renderList();
    await screen.findByRole('link', { name: 'SHOP-41' });
    // Format rules open as the shared pop-over (T-216).
    await user.click(screen.getByRole('button', { name: 'Format rules' }));
    const form = within(screen.getByRole('form', { name: 'Add rule' }));
    await user.type(form.getByRole('textbox', { name: 'Name' }), 'Untouched');
    await user.type(form.getByRole('textbox', { name: 'Condition' }), 'stage = new');
    await user.click(form.getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(rowOf('SHOP-44')).toHaveAttribute('data-tone', 'red'));
    expect(within(rowOf('SHOP-44')).getByText('Untouched')).toBeVisible();
    expect(rowOf('SHOP-41')).not.toHaveAttribute('data-tone');
    // A rule on one column tints that cell only.
    await user.type(form.getByRole('textbox', { name: 'Name' }), 'Urgent');
    await user.type(form.getByRole('textbox', { name: 'Condition' }), 'priority = High');
    await user.selectOptions(form.getByRole('combobox', { name: 'Colour' }), 'Priority');
    await user.selectOptions(form.getByRole('combobox', { name: 'Tone' }), 'Amber');
    await user.click(form.getByRole('button', { name: 'Add rule' }));
    await waitFor(() =>
      expect(within(rowOf('SHOP-44')).getByText('High').closest('td')).toHaveAttribute(
        'data-tone',
        'amber',
      ),
    );
    // Kept for the next visit, in this browser.
    expect(
      JSON.parse(window.localStorage.getItem('taskmoor.list.rules.SHOP') ?? '[]'),
    ).toHaveLength(2);
    // A bad condition says so; the others still apply.
    await user.type(form.getByRole('textbox', { name: 'Name' }), 'Broken');
    await user.type(form.getByRole('textbox', { name: 'Condition' }), 'nope = 1');
    await user.click(form.getByRole('button', { name: 'Add rule' }));
    expect(await screen.findByText(/This condition is not valid/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove the rule Broken' }));
    expect(screen.queryByText(/This condition is not valid/)).toBeNull();
  });

  it('[AGL-016] says when the filter is not a query, and makes a ticket at the end', async () => {
    const user = userEvent.setup();
    const { client } = renderList();
    await screen.findByRole('link', { name: 'SHOP-41' });
    await user.type(screen.getByRole('textbox', { name: 'Filter' }), 'nope = 1');
    await user.click(screen.getByRole('button', { name: 'Apply filter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not a query');
    await user.type(
      screen.getByRole('textbox', { name: 'Summary of a new ticket in Shop' }),
      'Gift wrapping{Enter}',
    );
    await waitFor(() => expect(client.created).toEqual(['Gift wrapping']));
  });

  it('[AGL-016] fits a phone: stacked rows, never a squeezed table (TR-1, D1)', async () => {
    setViewportWidth(375);
    renderList();
    await screen.findByRole('link', { name: 'SHOP-41' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
    const rows = screen.getByRole('list', { name: 'Tickets' });
    expect(screen.queryByRole('table')).toBeNull();
    const row = screen.getByRole('link', { name: 'SHOP-41' }).closest('li') as HTMLElement;
    expect(rows.contains(row)).toBe(true);
    expect(row.querySelector('.result-row-summary')?.textContent).toBeTruthy();
    expect(row.querySelector('.result-row-facts')).not.toBeNull();
  });

  it('[AGL-016] has no link that repeats a tab, and explains itself behind its help mark (D7, TR-28)', async () => {
    const user = userEvent.setup();
    renderList();
    await screen.findByRole('link', { name: 'SHOP-41' });
    expect(screen.queryByRole('link', { name: 'Track summary' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'What is List for?' }));
    expect(screen.getByText(/^Each row is a ticket of this track/)).toBeVisible();
  });

  it('[AGL-016] marks the column its order follows (PL-11)', async () => {
    const user = userEvent.setup();
    renderList();
    await screen.findByRole('link', { name: 'SHOP-41' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'updated');
    const updated = await screen.findByRole('columnheader', { name: /^Updated/ });
    expect(updated).toHaveAttribute('aria-sort', 'descending');
    expect(await screen.findByRole('columnheader', { name: 'Summary' })).not.toHaveAttribute(
      'aria-sort',
    );
  });

  it('[AGL-016] [NFR-006] shows when a ticket was updated as its day on the person’s clock, the time in its name and tooltip (TR-8)', async () => {
    const search = fakeListSearch();
    render(
      <I18nProvider locale="en" timeZone="Asia/Kolkata">
        <SessionProvider session={MEMBER}>
          <ListPage trackKey="SHOP" client={fakeListClient(search)} search={search} />
        </SessionProvider>
      </I18nProvider>,
    );
    await screen.findByRole('link', { name: 'SHOP-41' });
    const cell = rowOf('SHOP-41').querySelector<HTMLElement>('td[data-column="updatedAt"]');
    if (!cell) throw new Error('No Updated cell');
    // 08:00 UTC is 1:30 PM in Kolkata, half an hour off the hour: the person's own clock.
    expect(within(cell).getByText('Oct 29, 2026')).toHaveAttribute('aria-hidden', 'true');
    const whole = /^Oct 29, 2026, 1:30\sPM$/;
    expect(cell.querySelector('.search-cell-value time')?.getAttribute('title')).toMatch(whole);
    expect(within(rowOf('SHOP-41')).getByRole('cell', { name: whole })).toBe(cell);
  });

  it('[NFR-006] words its filter and groups from the catalogue, in the pseudo-locale too', async () => {
    const user = userEvent.setup();
    renderList('SHOP', 'en-XA');
    const page = (await screen.findByRole('link', { name: 'SHOP-41' })).closest(
      'section.list-page',
    ) as HTMLElement;
    const groupBy = page.querySelector('.list-tools select') as HTMLSelectElement;
    await user.selectOptions(groupBy, 'priority');
    // The seeded priority's name goes through the catalogue inside the heading's own words.
    expect(await screen.findByRole('heading', { name: /^\[\[Ĥíğĥ~~\] / })).toBeVisible();
    // Cell values are tickets' data (a moment's tooltip too), and so are the names of fields and
    // values someone added.
    for (const cell of page.querySelectorAll('.search-cell-value')) {
      cell.textContent = '';
      cell.removeAttribute('title');
    }
    const data = new Set(['SHOP-41', 'SHOP-44', 'OPS-12', 'Customer', 'Team', 'Shop']);
    expect(untranslated(visibleTexts(page).filter((text) => !data.has(text)))).toEqual([]);
    expect(within(page).getByRole('heading', { name: /^\[Medium / })).toBeVisible();
  });
});
