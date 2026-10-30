import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakeSavedSearchClient, fakeSearchClient } from './fixtures';
import { queryFromHash, SearchPage } from './SearchPage';

function renderPage(initialQuery?: string, locale: Locale = 'en') {
  const client = fakeSearchClient();
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={MEMBER}>
        <main>
          <SearchPage
            client={client}
            savedClient={fakeSavedSearchClient()}
            {...(initialQuery ? { initialQuery } : {})}
          />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

describe('the search page (M1-041)', () => {
  it('[QRY-001] searches by basic choices and shows them as a query in the advanced mode', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const basic = screen.getByRole('form', { name: 'Basic' });
    await user.click(await within(basic).findByLabelText('SHOP Shop'));
    await user.click(within(basic).getByLabelText('Active'));
    await user.selectOptions(within(basic).getByLabelText('Assigned to'), 'me');
    await user.type(within(basic).getByLabelText('Words'), 'refund');
    await user.click(within(basic).getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('3 tickets')).toBeVisible();
    expect(client.queries).toEqual([
      'track = SHOP AND stage = active AND assignee = currentUser() AND text ~ "refund" ORDER BY updated DESC',
    ]);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByRole('combobox', { name: 'Query' })).toHaveValue(client.queries[0]);
  });

  it('[QRY-001] reads a query back into the basic mode, or says it goes beyond it', async () => {
    const user = userEvent.setup();
    renderPage('priority = High');
    const query = await screen.findByRole('combobox', { name: 'Query' });
    await user.click(screen.getByRole('button', { name: 'Basic' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This query says more than the basic mode can show.',
    );
    await user.clear(query);
    await user.type(query, 'track in (OPS, SHOP) and stage = closed');
    await user.click(screen.getByRole('button', { name: 'Basic' }));
    const basic = screen.getByRole('form', { name: 'Basic' });
    expect(within(basic).getByLabelText('OPS Operations')).toBeChecked();
    expect(within(basic).getByLabelText('SHOP Shop')).toBeChecked();
    expect(within(basic).getByLabelText('Closed')).toBeChecked();
  });

  it('[QRY-001] suggests at the caret and takes a suggestion with the keyboard', async () => {
    const user = userEvent.setup();
    renderPage('priority = High');
    const query = await screen.findByRole('combobox', { name: 'Query' });
    await user.clear(query);
    await user.type(query, 'tra');
    const listbox = screen.getByRole('listbox', { name: 'Suggestions' });
    // The common field first, then the others that start the same way.
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['track', 'trackCategory', 'trackType']);
    await user.keyboard('{Tab}');
    expect(query).toHaveValue('track ');
    await user.type(query, '= ');
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['SHOP', 'OPS']);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(query).toHaveValue('track = OPS ');
  });

  it('[QRY-001] shows where a query is wrong, as the backend says', async () => {
    const user = userEvent.setup();
    renderPage('priority = High');
    const query = await screen.findByRole('combobox', { name: 'Query' });
    await user.clear(query);
    await user.type(query, 'nope = 1');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'There is no field "nope" (at column 1, near "nope")',
    );
    expect(query).toHaveAttribute('aria-invalid', 'true');
  });

  it('[QRY-001] runs the query in the address and loads more results', async () => {
    const user = userEvent.setup();
    renderPage('track = SHOP');
    const results = await screen.findByRole('region', { name: 'Results' });
    const table = await within(results).findByRole('table');
    // A heading row and a row per ticket.
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    await user.click(within(results).getByRole('button', { name: 'More results' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    expect(within(table).getByRole('link', { name: 'OPS-12' })).toBeVisible();
    expect(queryFromHash('#/search?q=track%20%3D%20SHOP')).toBe('track = SHOP');
  });

  it('[QRY-009] says when a count is an estimate or a lower bound (M1-040)', async () => {
    renderPage('text ~ many');
    expect(await screen.findByText('About 123,456 tickets')).toBeVisible();
  });

  it('[QRY-009] says when there are more results than were counted', async () => {
    renderPage('text ~ lots');
    expect(await screen.findByText('More than 10,000 tickets')).toBeVisible();
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await screen.findByRole('button', { name: 'Advanced' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage('track = SHOP', 'en-XA');
    const main = screen.getByRole('main');
    await within(main).findByRole('table');
    // Cell values are tickets' data, not the page's words.
    for (const cell of main.querySelectorAll('.search-cell-value')) cell.textContent = '';
    // So are saved searches' names (M1-063).
    const data = new Set([
      'SHOP-41',
      'SHOP-44',
      'track = SHOP',
      'Customer',
      'Points',
      'Team',
      'My open work',
    ]);
    const texts = visibleTexts(main).filter((t) => !data.has(t));
    expect(untranslated(texts)).toEqual([]);
  });
});
