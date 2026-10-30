import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { setViewportWidth } from '../test/viewport';
import { fakeListClient, fakeListSearch } from './fixtures';
import { ListPage } from './ListPage';

function renderList(trackKey = 'SHOP') {
  const search = fakeListSearch();
  const client = fakeListClient(search);
  render(
    <I18nProvider locale="en">
      <SessionProvider session={MEMBER}>
        <ListPage trackKey={trackKey} client={client} search={search} />
      </SessionProvider>
    </I18nProvider>,
  );
  return { search, client };
}
const rowOf = (key: string) => screen.getByRole('link', { name: key }).closest('tr') as HTMLElement;

describe('a track’s list (M1-049)', () => {
  beforeEach(() => window.localStorage.clear());

  it('[AGL-016] lists the track’s tickets and edits a cell in place', async () => {
    const user = userEvent.setup();
    const { search } = renderList();
    expect(await screen.findByRole('heading', { name: 'List of Shop' })).toBeVisible();
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

  it('[AGL-016] colours the rows a format rule finds and names the rule beside the key', async () => {
    const user = userEvent.setup();
    renderList();
    await screen.findByRole('link', { name: 'SHOP-41' });
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

  it('[AGL-016] fits a phone: the table scrolls inside itself, never the page', async () => {
    setViewportWidth(375);
    renderList();
    await screen.findByRole('link', { name: 'SHOP-41' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});
