import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { applyStylesheet } from '../test/stylesheets';
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
    expect(screen.getByRole('textbox', { name: 'Query' })).toHaveValue(client.queries[0]);
  });

  it('[QRY-001] reads a query back into the basic mode, or says it goes beyond it', async () => {
    const user = userEvent.setup();
    renderPage('status = Active');
    const query = await screen.findByRole('textbox', { name: 'Query' });
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

  it('[QRY-014] [QRY-006] adds a date filter, makes it a query and reads it back with its days', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const basic = screen.getByRole('form', { name: 'Basic' });
    const add = within(basic).getByRole('combobox', { name: 'Add a filter' });
    await user.selectOptions(add, 'created');
    await user.click(within(basic).getByRole('button', { name: 'Add filter' }));
    const group = within(within(basic).getByRole('group', { name: 'Date created' }));
    // The keyboard carries straight on into the new filter.
    expect(group.getByRole('combobox', { name: 'When' })).toHaveFocus();
    await user.selectOptions(group.getByRole('combobox', { name: 'When' }), 'between');
    expect(group.getByText(/left out of the search/)).toBeVisible();
    await user.type(group.getByLabelText('From'), '2026-10-01');
    await user.type(group.getByLabelText('To'), '2026-10-31');
    expect(group.queryByText(/left out of the search/)).toBeNull();
    await user.click(within(basic).getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('3 tickets')).toBeVisible();
    expect(client.queries).toEqual([
      'created >= 2026-10-01 AND created < 2026-11-01 ORDER BY updated DESC',
    ]);
    // The same query in the advanced mode, and back with the same days.
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByRole('textbox', { name: 'Query' })).toHaveValue(client.queries[0]);
    await user.click(screen.getByRole('button', { name: 'Basic' }));
    const again = within(screen.getByRole('group', { name: 'Date created' }));
    expect(again.getByRole('combobox', { name: 'When' })).toHaveValue('between');
    expect(again.getByLabelText('From')).toHaveValue('2026-10-01');
    expect(again.getByLabelText('To')).toHaveValue('2026-10-31');
  });

  it('[QRY-014] says when the second day comes before the first', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Add a filter' }), 'due');
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    const group = within(screen.getByRole('group', { name: 'Due date' }));
    await user.selectOptions(group.getByRole('combobox', { name: 'When' }), 'between');
    await user.type(group.getByLabelText('From'), '2026-10-31');
    await user.type(group.getByLabelText('To'), '2026-10-01');
    expect(group.getByText(/nothing will match/)).toBeVisible();
    expect(group.getByLabelText('To')).toHaveAttribute('aria-invalid', 'true');
  });

  it('[QRY-014] offers the values a person may see, as check boxes or suggestions, and Me', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const basic = screen.getByRole('form', { name: 'Basic' });
    const addFilter = async (field: string) => {
      await user.selectOptions(screen.getByRole('combobox', { name: 'Add a filter' }), field);
      await user.click(within(basic).getByRole('button', { name: 'Add filter' }));
    };
    await addFilter('type');
    const types = within(within(basic).getByRole('group', { name: 'Type' }));
    await user.click(await types.findByRole('checkbox', { name: 'Bug' }));
    await user.click(types.getByRole('checkbox', { name: 'Story' }));
    await addFilter('labels');
    const labels = within(within(basic).getByRole('group', { name: 'Labels' }));
    const box = labels.getByRole('combobox', { name: 'Value for Labels' });
    expect(box).toHaveFocus();
    await waitFor(() =>
      expect(
        [...(box.closest('fieldset')?.querySelectorAll('datalist option') ?? [])].map((o) =>
          o.getAttribute('value'),
        ),
      ).toEqual(['payments', 'refunds', 'urgent']),
    );
    // Enter takes a typed value and does not search yet.
    await user.type(box, 'refunds{Enter}');
    expect(client.queries).toEqual([]);
    expect(labels.getByRole('button', { name: 'Remove refunds from Labels' })).toBeVisible();
    expect(box).toHaveValue('');
    await addFilter('creator');
    const creator = within(within(basic).getByRole('group', { name: 'Creator' }));
    await user.click(creator.getByRole('button', { name: 'Me' }));
    expect(creator.getByRole('button', { name: 'Remove Me from Creator' })).toBeVisible();
    await user.click(within(basic).getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(client.queries).toEqual([
        'type IN (Bug, Story) AND labels = refunds AND creator = currentUser() ORDER BY updated DESC',
      ]),
    );
  });

  it('[QRY-014] asks for a track before listing releases when there are too many to ask', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Add a filter' }), 'area');
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    const group = within(screen.getByRole('group', { name: 'Area' }));
    expect(await group.findByText(/Pick a track above/)).toBeVisible();
    await user.click(screen.getByLabelText('SHOP Shop'));
    await waitFor(() => expect(group.queryByText(/Pick a track above/)).toBeNull());
  });

  it('[QRY-014] removes one filter, or clears them all, and moves focus sensibly', async () => {
    const user = userEvent.setup();
    const client = renderPage(
      'priority = High AND due < 2026-12-01 AND text ~ refund ORDER BY updated DESC',
    );
    const basic = await screen.findByRole('form', { name: 'Basic' });
    expect(await within(basic).findByRole('checkbox', { name: 'High' })).toBeChecked();
    const add = within(basic).getByRole('combobox', { name: 'Add a filter' });
    await user.click(within(basic).getByRole('button', { name: 'Remove filter: Due date' }));
    expect(within(basic).queryByRole('group', { name: 'Due date' })).toBeNull();
    expect(add).toHaveFocus();
    await user.click(within(basic).getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(client.queries.at(-1)).toBe(
        'priority = High AND text ~ "refund" ORDER BY updated DESC',
      ),
    );
    await user.click(within(basic).getByRole('button', { name: 'Clear all' }));
    expect(within(basic).queryByRole('group', { name: 'Priority' })).toBeNull();
    expect(within(basic).getByLabelText('Words')).toHaveValue('');
    expect(within(basic).queryByRole('button', { name: 'Clear all' })).toBeNull();
  });

  it('[QRY-014] keeps the filters in the address, and a link opens them in the basic mode', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '#/search');
    renderPage();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Add a filter' }), 'due');
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    const group = within(screen.getByRole('group', { name: 'Due date' }));
    await user.type(group.getByLabelText('Day'), '2026-10-31');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(window.location.hash).toContain('due%20%3D%202026-10-31'));
    expect(queryFromHash(window.location.hash)).toBe('due = 2026-10-31 ORDER BY updated DESC');
    window.history.replaceState(null, '', window.location.pathname);
  });

  it('[QRY-014] works in Spanish, on a phone', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderPage(undefined, 'es');
    const add = await screen.findByRole('combobox', { name: 'Añadir un filtro' });
    await user.selectOptions(add, 'closed');
    await user.click(screen.getByRole('button', { name: 'Añadir filtro' }));
    const group = within(screen.getByRole('group', { name: 'Fecha de cierre' }));
    expect(group.getByRole('combobox', { name: 'Cuándo' })).toHaveValue('on');
    expect(group.getByLabelText('Día')).toHaveAttribute('type', 'date');
    expect(group.getByRole('button', { name: 'Quitar filtro: Fecha de cierre' })).toBeVisible();
    setViewportWidth(1440);
  });

  it('[NFR-006] [QRY-014] words every filter from the catalogue, and seeded values in Spanish', async () => {
    const user = userEvent.setup();
    renderPage(undefined, 'en-XA');
    const basic = (await screen.findByRole('main')).querySelector('form') as HTMLFormElement;
    await within(basic).findAllByRole('checkbox');
    // Every filter "Add a filter" offers, one after another, until it offers none.
    for (let add = basic.querySelector('.search-filter-add select'); add !== null; ) {
      const field = (add as HTMLSelectElement).options[1]?.value as string;
      await user.selectOptions(add, field);
      await user.click(within(add.parentElement as HTMLElement).getByRole('button'));
      add = basic.querySelector('.search-filter-add select');
    }
    expect(basic.querySelectorAll('.search-filter')).toHaveLength(13);
    for (const when of basic.querySelectorAll('.search-filter select')) {
      await user.selectOptions(when, 'between');
    }
    await within(basic).findByRole('checkbox', { name: '[Ĥíğĥ~~]' });
    // Types and priorities the workspace did not start with are its data, as written.
    expect(untranslated(visibleTexts(basic))).toEqual(['Story', 'Task', 'Medium']);
    cleanup();

    renderPage(undefined, 'es');
    const add = await screen.findByRole('combobox', { name: 'Añadir un filtro' });
    for (const field of ['type', 'priority']) {
      await user.selectOptions(add, field);
      await user.click(screen.getByRole('button', { name: 'Añadir filtro' }));
    }
    const type = within(screen.getByRole('group', { name: 'Tipo' }));
    expect(await type.findByRole('checkbox', { name: 'Error' })).toBeVisible();
    const priority = within(screen.getByRole('group', { name: 'Prioridad' }));
    expect(await priority.findByRole('checkbox', { name: 'Alta' })).toBeVisible();
  });

  it('[QRY-001] suggests at the caret and takes a suggestion with the keyboard', async () => {
    const user = userEvent.setup();
    renderPage('status = Active');
    const query = await screen.findByRole('textbox', { name: 'Query' });
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
    renderPage('status = Active');
    const query = await screen.findByRole('textbox', { name: 'Query' });
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
    await user.click(within(results).getByRole('button', { name: 'Show more' }));
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

describe('the search form after the page review (T-220)', () => {
  it('[QRY-014] labels its groups as it labels its fields (PL-33)', async () => {
    const gone = applyStylesheet('search.css');
    try {
      renderPage();
      const tracks = await screen.findByRole('group', { name: 'Tracks' });
      const legend = tracks.querySelector('legend') as HTMLElement;
      expect(getComputedStyle(legend).fontSize).toBe('var(--font-size-200)');
    } finally {
      gone();
    }
  });

  it('[QRY-014] [NFR-005] makes a short stage label a finger wide on touch (PL-13)', async () => {
    const gone = applyStylesheet('search.css', 'pointer: coarse');
    try {
      renderPage();
      const stage = await screen.findByRole('group', { name: 'Stage' });
      for (const label of stage.querySelectorAll('label')) {
        expect(getComputedStyle(label).minWidth).toBe('var(--hit-target-touch)');
      }
    } finally {
      gone();
    }
  });
});
