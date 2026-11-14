import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { setViewportWidth } from '../test/viewport';
import { exportUrl } from './client';
import { cellChange, DEFAULT_COLUMNS, loadColumns, valueText } from './columns';
import { fakeSavedSearchClient, fakeSearchClient, TICKETS } from './fixtures';
import { SearchPage } from './SearchPage';

/** The stylesheets, read from disk: the web project turns CSS imports off. */
const STYLES = ['apps/web/src/styles', 'src/styles'].find((d) => existsSync(d)) ?? 'src/styles';

function renderPage(initialQuery = 'track = SHOP') {
  const client = fakeSearchClient();
  const view = render(
    <I18nProvider locale="en">
      <SessionProvider session={MEMBER}>
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
