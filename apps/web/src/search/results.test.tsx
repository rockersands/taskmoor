import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { useTimeZone } from '../test/timeZone';
import { setViewportWidth } from '../test/viewport';
import { exportUrl, type SearchTicket } from './client';
import { cellChange, DEFAULT_COLUMNS, loadColumns, valueText } from './columns';
import { fakeSavedSearchClient, fakeSearchClient, TICKETS } from './fixtures';
import { ResultGrid } from './ResultTable';
import { SearchPage } from './SearchPage';

/** The stylesheets, read from disk: the web project turns CSS imports off. */
const STYLES = ['apps/web/src/styles', 'src/styles'].find((d) => existsSync(d)) ?? 'src/styles';

function renderPage(
  initialQuery = 'track = SHOP',
  session: Session = MEMBER,
  locale: Locale = 'en',
) {
  const client = fakeSearchClient();
  const view = render(
    <I18nProvider locale={locale}>
      <SessionProvider session={session}>
        <main>
          <SearchPage
            client={client}
            savedClient={fakeSavedSearchClient()}
            initialQuery={initialQuery}
          />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return { client, ...view };
}

const headings = () =>
  within(screen.getByRole('table'))
    .getAllByRole('columnheader')
    .map((h) => h.textContent);

/** The row of a ticket, by its key. */
const row = (key: string) =>
  screen.getByRole('link', { name: key }).closest('tr') as HTMLTableRowElement;

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('search results (M1-042)', () => {
  it('[QRY-014] adds, moves and removes columns from the keyboard and keeps them per person', async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await screen.findByRole('table');
    expect(headings()).toEqual([
      'Key',
      'Summary',
      'Type',
      'Status',
      'Assignee',
      'Priority',
      'Updated',
    ]);
    const toggle = screen.getByRole('button', { name: 'Columns' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    await user.keyboard('{Enter}');
    const panel = screen.getByRole('group', { name: 'Columns' });
    await user.selectOptions(within(panel).getByLabelText('Add a column'), 'Points');
    await user.click(within(panel).getByRole('button', { name: 'Add' }));
    expect(headings().at(-1)).toBe('Points');
    // Moved up with the keyboard; the focus stays on the moved column's button.
    within(panel).getByRole('button', { name: 'Move Points up' }).focus();
    await user.keyboard('{Enter}');
    expect(within(panel).getByRole('button', { name: 'Move Points up' })).toHaveFocus();
    expect(headings().slice(-2)).toEqual(['Points', 'Updated']);
    expect(within(panel).getByRole('status')).toHaveTextContent('Points is now column 7.');
    await user.click(within(panel).getByRole('button', { name: 'Remove Type' }));
    expect(headings()).not.toContain('Type');
    first.unmount();

    // Kept for this person: a new page shows the same columns.
    renderPage();
    await screen.findByRole('table');
    expect(headings()).toEqual([
      'Key',
      'Summary',
      'Status',
      'Assignee',
      'Priority',
      'Points',
      'Updated',
    ]);
    expect(loadColumns(MEMBER.status === 'signed-in' ? MEMBER.user.id : 0)).toContain('cf[41]');
    expect(loadColumns(99)).toEqual(DEFAULT_COLUMNS);
  });

  it('[QRY-014] works when the browser keeps nothing', async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage off');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage off');
    });
    renderPage();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    await user.click(screen.getByRole('button', { name: 'Remove Updated' }));
    expect(headings()).not.toContain('Updated');
  });

  it('[QRY-014] edits a summary in place through the ticket route and updates the row', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Edit Summary of SHOP-41' }));
    const input = screen.getByRole('textbox', { name: 'Edit Summary of SHOP-41' });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, 'Refunds fail for every card{Enter}');
    expect(await within(row('SHOP-41')).findByText('Refunds fail for every card')).toBeVisible();
    expect(client.edits).toEqual([
      { id: 41, change: { summary: 'Refunds fail for every card', version: 1 } },
    ]);
    // Back on the edit button, and the next edit sends the new version.
    expect(screen.getByRole('button', { name: 'Edit Summary of SHOP-41' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Edit Priority of SHOP-41' }));
    await user.click(screen.getByRole('combobox', { name: 'Edit Priority of SHOP-41' }));
    await user.click(screen.getByRole('option', { name: 'High' }));
    await user.click(within(row('SHOP-41')).getByRole('button', { name: 'Save' }));
    expect(await within(row('SHOP-41')).findByRole('img', { name: 'High' })).toBeVisible();
    expect(client.edits[1]).toEqual({ id: 41, change: { priorityId: 1, version: 2 } });
  });

  it('[CORE-005] [CORE-014] shows type and priority as icons, named for assistive technology', async () => {
    renderPage();
    await screen.findByRole('table');
    const cells = within(row('SHOP-41'));
    expect(cells.getByRole('img', { name: 'Bug' })).toHaveAttribute('title', 'Bug');
    expect(cells.getByRole('img', { name: 'Medium' })).toHaveAttribute('title', 'Medium');
  });

  it('[QRY-014] assigns to me, edits labels and a custom number in place', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Edit Assignee of SHOP-44' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Edit Assignee of SHOP-44' }),
      'Me (Bo)',
    );
    await user.click(within(row('SHOP-44')).getByRole('button', { name: 'Save' }));
    expect(await within(row('SHOP-44')).findByText('Bo')).toBeVisible();
    expect(client.edits[0]).toEqual({ id: 44, change: { assigneeId: 2, version: 1 } });

    await user.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = screen.getByRole('group', { name: 'Columns' });
    for (const name of ['Labels', 'Points']) {
      await user.selectOptions(within(panel).getByLabelText('Add a column'), name);
      await user.click(within(panel).getByRole('button', { name: 'Add' }));
    }
    await user.click(screen.getByRole('button', { name: 'Edit Labels of SHOP-41' }));
    const labels = screen.getByRole('textbox', { name: 'Edit Labels of SHOP-41' });
    expect(labels).toHaveValue('payments');
    await user.type(labels, ', refunds{Enter}');
    expect(await within(row('SHOP-41')).findByText('payments, refunds')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Edit Points of SHOP-41' }));
    const points = screen.getByRole('spinbutton', { name: 'Edit Points of SHOP-41' });
    await user.clear(points);
    await user.type(points, '5{Enter}');
    expect(await within(row('SHOP-41')).findByText('5')).toBeVisible();
    expect(client.edits.slice(1)).toEqual([
      { id: 41, change: { labels: ['payments', 'refunds'], version: 1 } },
      { id: 41, change: { fields: { 41: 5 }, version: 2 } },
    ]);
    // A select field is not edited in place. (The edits outside closed the pop-over.)
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    const again = screen.getByRole('group', { name: 'Columns' });
    await user.selectOptions(within(again).getByLabelText('Add a column'), 'Team');
    await user.click(within(again).getByRole('button', { name: 'Add' }));
    expect(screen.queryByRole('button', { name: 'Edit Team of SHOP-41' })).toBeNull();
  });

  it('[QRY-014] shows a refused edit on its cell: a lock, a bad value; Escape leaves', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await screen.findByRole('link', { name: 'OPS-12' });
    await user.click(screen.getByRole('button', { name: 'Edit Summary of OPS-12' }));
    await user.type(screen.getByRole('textbox', { name: 'Edit Summary of OPS-12' }), '!{Enter}');
    const alert = await within(row('OPS-12')).findByRole('alert');
    expect(alert).toHaveTextContent(
      'In status Closed, only the Administrators role can edit this ticket.',
    );
    expect(screen.getByRole('textbox', { name: 'Edit Summary of OPS-12' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await user.keyboard('{Escape}');
    expect(within(row('OPS-12')).getByText('Rotate the payment keys')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit Summary of OPS-12' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Edit Summary of SHOP-44' }));
    await user.clear(screen.getByRole('textbox', { name: 'Edit Summary of SHOP-44' }));
    await user.keyboard('{Enter}');
    expect(await within(row('SHOP-44')).findByRole('alert')).toHaveTextContent(
      'This value is not accepted here.',
    );
  });

  it('[QRY-015] offers CSV and JSON downloads of the query in the shown columns', async () => {
    renderPage('track = SHOP ORDER BY key');
    await screen.findByRole('table');
    const nav = screen.getByRole('navigation', { name: 'Export' });
    const csv = within(nav).getByRole('link', { name: 'Export CSV' });
    expect(csv).toHaveAttribute('download');
    const url = new URL(csv.getAttribute('href') as string, 'http://x.test');
    expect(url.pathname).toBe('/api/v1/search/export');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'track = SHOP ORDER BY key',
      format: 'csv',
      columns: ['key', ...DEFAULT_COLUMNS].join(','),
    });
    expect(within(nav).getByRole('link', { name: 'Export JSON' })).toHaveAttribute(
      'href',
      exportUrl('track = SHOP ORDER BY key', 'json', DEFAULT_COLUMNS),
    );
  });

  it('[QRY-015] [NFR-006] gives a person whose region writes 1,5 the semicolon CSV file (T-263)', async () => {
    const spain: Session =
      MEMBER.status === 'signed-in'
        ? { ...MEMBER, user: { ...MEMBER.user, locale: 'es-ES' } }
        : MEMBER;
    renderPage('track = SHOP ORDER BY key', spain);
    await screen.findByRole('table');
    const nav = screen.getByRole('navigation', { name: 'Export' });
    const csv = new URL(
      within(nav).getByRole('link', { name: 'Export CSV' }).getAttribute('href') as string,
      'http://x.test',
    );
    expect(csv.searchParams.get('separator')).toBe('semicolon');
    expect(csv.searchParams.get('format')).toBe('csv');
    // JSON has no separator.
    const json = new URL(
      within(nav).getByRole('link', { name: 'Export JSON' }).getAttribute('href') as string,
      'http://x.test',
    );
    expect(json.searchParams.has('separator')).toBe(false);
  });

  it('[QRY-014] [NFR-005] fits a small phone: stacked rows of key, summary, then status, assignee and priority (TR-1, PL-1)', async () => {
    setViewportWidth(375);
    renderPage();
    const rows = await screen.findByRole('list', { name: 'Tickets' });
    expect(screen.queryByRole('table')).toBeNull();
    const first = within(rows).getAllByRole('listitem')[0] as HTMLElement;
    const words = [...first.querySelectorAll('p, dd')].map((e) => e.textContent?.trim());
    const ticket = TICKETS[0] as (typeof TICKETS)[number];
    expect(words.slice(0, 2)).toEqual([ticket.key, ticket.summary]);
    expect(words).toContain(ticket.status.name);
    expect(words).toContain(ticket.assignee?.name ?? 'Unassigned');
    expect(within(first).getByRole('link', { name: ticket.key })).toHaveAttribute(
      'href',
      `#/tickets/${ticket.key}`,
    );
    // Labelled for a screen reader, though the labels are not shown.
    expect(within(first).getByText('Status')).toHaveClass('visually-hidden');
  });

  it('[QRY-014] gives the summary the width and keeps short values and dates on one line (TR-8, PL-10)', async () => {
    renderPage();
    const table = await screen.findByRole('table');
    const header = (name: string) =>
      within(table).getByRole('columnheader', { name: new RegExp(`^${name}`) });
    expect(header('Summary')).toHaveAttribute('data-column', 'summary');
    expect(header('Summary')).not.toHaveAttribute('data-one-line');
    for (const name of ['Type', 'Status', 'Priority', 'Updated']) {
      expect(header(name)).toHaveAttribute('data-one-line');
    }
    const updated = within(row('SHOP-41')).getAllByRole('cell').at(-1) as HTMLElement;
    expect(updated).toHaveAttribute('data-one-line');
    // The rules themselves: the summary takes the free width; one-line cells never wrap.
    const css = readFileSync(join(STYLES, 'search.css'), 'utf8');
    expect(css).toMatch(/\.search-table \[data-column\] \{\s*width: 1%;/);
    expect(css).toMatch(/\.search-table \[data-one-line\] \{\s*white-space: nowrap;/);
    expect(css).not.toMatch(/\.search-cell-value \{[^}]*overflow-wrap: anywhere/);
  });

  it('[QRY-014] writes Unassigned in the Assignee cell of a ticket no one is assigned, as the phone rows do', async () => {
    renderPage();
    await screen.findByRole('table');
    const cell = within(row('SHOP-44'))
      .getAllByRole('cell')
      .find((c) => c.getAttribute('data-column') === 'assignee');
    expect(cell).toHaveTextContent(/^Unassigned$/);
    // A name still shows as itself.
    const named = within(row('SHOP-41'))
      .getAllByRole('cell')
      .find((c) => c.getAttribute('data-column') === 'assignee');
    expect(named).toHaveTextContent(/^Kalo Moana$/);
  });

  it('[QRY-014] says the order the results are in and marks that column (PL-11)', async () => {
    renderPage();
    const table = await screen.findByRole('table');
    // No ORDER BY: latest created first, as the server sorts them.
    expect(screen.getByText('Sorted by Created, latest first')).toBeVisible();
    for (const header of within(table).getAllByRole('columnheader')) {
      expect(header).not.toHaveAttribute('aria-sort');
    }
  });

  it('[QRY-014] marks the sorted column of an ordered query with aria-sort (PL-11)', async () => {
    renderPage('track = SHOP ORDER BY updated ASC');
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: /^Updated/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    expect(screen.getByText('Sorted by Updated, earliest first')).toBeVisible();
  });

  it('[QRY-014] reads a date order as earliest or latest first, a due date too (PL-11)', async () => {
    renderPage('track = SHOP ORDER BY due ASC');
    await screen.findByRole('table');
    // A due date lies ahead as often as behind: "oldest" would not fit it.
    expect(screen.getByText('Sorted by Due date, earliest first')).toBeVisible();
  });

  it('[QRY-014] reads a date order in Spanish as earliest or latest first too, never oldest or most recent (PL-11, S3-WK-8)', async () => {
    const due = renderPage('track = SHOP ORDER BY due DESC', MEMBER, 'es');
    await screen.findByRole('table');
    // 'Más reciente' and 'más antiguo' speak of the past; a due date may be next month. The
    // neuter 'lo' fits a feminine column (Fecha límite) and a masculine one (Creado) alike.
    expect(screen.getByText('Ordenado por Fecha límite, lo más tardío primero')).toBeVisible();
    due.unmount();
    renderPage('track = SHOP ORDER BY created ASC', MEMBER, 'es');
    await screen.findByRole('table');
    expect(screen.getByText('Ordenado por Creado, lo más temprano primero')).toBeVisible();
  });
});

// A start, due or custom date cell reads in the person's locale and on its calendar day, as the
// ticket's own fields do, never '2026-10-13'; a custom datetime cell reads as Created and Updated
// do, never '2026-10-13T09:00:00Z' (T-240).
describe('date cells in the person’s locale (T-240)', () => {
  useTimeZone('America/Los_Angeles');

  const dated = (): SearchTicket[] => [
    {
      ...(TICKETS[0] as SearchTicket),
      startDate: '2026-10-01',
      dueDate: '2026-10-13',
      fields: { '50': '2026-11-02', '51': '2026-10-13T09:00:00Z' },
    },
  ];
  const renderGrid = (locale: 'en' | 'es') =>
    render(
      <I18nProvider locale={locale}>
        <SessionProvider session={MEMBER}>
          <ResultGrid
            tickets={dated()}
            columns={['summary', 'startDate', 'dueDate', 'cf[50]', 'cf[51]']}
            fields={[
              { id: 50, name: 'Go-live', type: 'date' },
              { id: 51, name: 'Cut-over', type: 'datetime' },
            ]}
            client={fakeSearchClient()}
            onSaved={() => {}}
          />
        </SessionProvider>
      </I18nProvider>,
    );
  const cells = () =>
    within(row('SHOP-41'))
      .getAllByRole('cell')
      .slice(1)
      .map((c) => c.querySelector('.search-cell-value')?.textContent);

  it('[QRY-014] [NFR-006] in English', () => {
    renderGrid('en');
    expect(cells()).toEqual([
      'Oct 1, 2026',
      'Oct 13, 2026',
      'Nov 2, 2026',
      'Oct 13, 2026, 2:00 AM',
    ]);
  });

  it('[QRY-014] [NFR-006] in Spanish', () => {
    renderGrid('es');
    expect(cells()).toEqual(['1 oct 2026', '13 oct 2026', '2 nov 2026', '13 oct 2026, 2:00']);
  });

  // Created and Updated give the summary the room their time took (TR-8, PL-10); a custom
  // date-and-time field keeps its time in view, since someone chose it.
  it('[QRY-014] [NFR-006] shows a ticket’s Created and Updated as a day, the time in its words and tooltip (TR-8, PL-10)', () => {
    render(
      <I18nProvider locale="en">
        <SessionProvider session={MEMBER}>
          <ResultGrid
            tickets={[
              {
                ...(TICKETS[0] as SearchTicket),
                createdAt: '2026-10-13T09:00:00Z',
                // 05:30 on the 14th by UTC's clock is still the 13th in Los Angeles.
                updatedAt: '2026-10-14T05:30:00Z',
                fields: { '51': '2026-10-13T09:00:00Z' },
              },
            ]}
            columns={['summary', 'createdAt', 'updatedAt', 'cf[51]']}
            fields={[{ id: 51, name: 'Cut-over', type: 'datetime' }]}
            client={fakeSearchClient()}
            onSaved={() => {}}
          />
        </SessionProvider>
      </I18nProvider>,
    );
    const [created, updated, cutOver] = within(row('SHOP-41')).getAllByRole('cell').slice(1);
    if (!created || !updated || !cutOver) throw new Error('Missing cells');
    const shown = (cell: HTMLElement) =>
      Array.from(cell.querySelectorAll('[aria-hidden="true"]'), (part) => part.textContent);
    expect(shown(created)).toEqual(['Oct 13, 2026']);
    expect(shown(updated)).toEqual(['Oct 13, 2026']);
    // A screen reader hears the whole moment, and a pointer resting on the day shows it.
    expect(within(updated).getByText('Oct 13, 2026, 10:30 PM')).toHaveClass('visually-hidden');
    const moment = updated.querySelector('time');
    expect(moment).toHaveAttribute('datetime', '2026-10-14T05:30:00Z');
    expect(moment).toHaveAttribute('title', 'Oct 13, 2026, 10:30 PM');
    expect(created.querySelector('time')).toHaveAttribute('title', 'Oct 13, 2026, 2:00 AM');
    expect(cutOver.querySelector('.search-cell-value')).toHaveTextContent('Oct 13, 2026, 2:00 AM');
    expect(cutOver.querySelector('time')).toBeNull();
  });
});

describe('result columns (M1-042)', () => {
  it('[QRY-014] turns a cell input into the ticket route body', () => {
    expect(cellChange('summary', { kind: 'text' }, 'New words')).toEqual({ summary: 'New words' });
    expect(cellChange('priority', { kind: 'priority' }, '')).toEqual({ priorityId: null });
    expect(cellChange('labels', { kind: 'labels' }, 'a, b  c')).toEqual({
      labels: ['a', 'b', 'c'],
    });
    expect(cellChange('dueDate', { kind: 'date' }, '')).toEqual({ dueDate: null });
    expect(cellChange('cf[9]', { kind: 'number' }, '2.5')).toEqual({ fields: { 9: 2.5 } });
    expect(cellChange('cf[9]', { kind: 'text' }, ' ')).toEqual({ fields: { 9: null } });
  });

  it('[CORE-010] shows a number column by its field’s format, a formula’s by its output (T-320)', () => {
    render(
      <I18nProvider locale="en">
        <SessionProvider session={MEMBER}>
          <ResultGrid
            tickets={[
              { ...(TICKETS[0] as SearchTicket), fields: { '60': 1234.5, '61': 40, '62': 3 } },
            ]}
            columns={['cf[60]', 'cf[61]', 'cf[62]']}
            fields={[
              {
                id: 60,
                name: 'Cost',
                type: 'number',
                config: { format: 'currency', currency: 'EUR', decimals: 2 },
              },
              { id: 61, name: 'Done', type: 'formula', config: { output: 'percentage' } },
              { id: 62, name: 'Plain', type: 'number', config: {} },
            ]}
            client={fakeSearchClient()}
            onSaved={() => {}}
          />
        </SessionProvider>
      </I18nProvider>,
    );
    expect(
      within(row('SHOP-41'))
        .getAllByRole('cell')
        .map((c) => c.querySelector('.search-cell-value')?.textContent),
    ).toEqual(['€1,234.50', '40%', '3']);
  });

  it('[QRY-014] shows values as text', () => {
    expect(valueText({ id: 1, name: 'High' })).toBe('High');
    expect(
      valueText([
        { id: 1, value: 'Red' },
        { id: 2, value: 'Blue' },
      ]),
    ).toBe('Red, Blue');
    expect(valueText({ id: 1, value: 'Europe', child: { id: 2, value: 'Lisbon' } })).toBe(
      'Europe / Lisbon',
    );
    expect(valueText({ id: 3, key: 'SHOP-1', summary: 'Parent' })).toBe('SHOP-1');
    expect(
      valueText({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
      }),
    ).toBe('Hello');
    expect(valueText(null)).toBe('');
  });
});
