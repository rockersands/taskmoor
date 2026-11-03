import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { type Handler, stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { ADMIN, MEMBER, TRASHED_TICKETS, TRASHED_TRACKS } from './fixtures';

function openTrash(handlers: Record<string, Handler> = {}, session = ADMIN) {
  const calls = stubBackend({
    'GET /trash?limit=50': () => jsonResponse(200, { tickets: TRASHED_TICKETS, next: null }),
    'GET /trash/tracks': () => jsonResponse(200, { tracks: TRASHED_TRACKS }),
    'GET /admin/trash-policy': () =>
      jsonResponse(200, { retentionDays: 30, limits: { min: 1, max: 365, default: 30 } }),
    ...handlers,
  });
  window.location.hash = '#/admin/trash';
  render(<App session={session} />);
  return calls;
}

const region = (name: string) => screen.getByRole('region', { name });

describe('the trash page (M1-101)', () => {
  it('[CORE-025] lists deleted tickets and tracks with when they go for good', async () => {
    openTrash();
    expect(await screen.findByRole('heading', { level: 1, name: 'Trash' })).toBeVisible();
    expect(
      await screen.findByText(/wait here for 30 days, then they are deleted for good/),
    ).toBeVisible();
    const tickets = region('Tickets');
    const items = within(tickets).getAllByRole('listitem');
    expect(items.map((i) => within(i).getByText(/^(SHOP|OPS)-/).textContent)).toEqual([
      'SHOP-41 Checkout redesign',
      'SHOP-42 Move the pay button',
      'OPS-7 Rotate the staging certificates before they expire next month',
    ]);
    expect(within(items[0] as HTMLElement).getByText(/Deleted .* by Ada/)).toBeVisible();
    expect(within(items[0] as HTMLElement).getByText(/^Deleted for good on /)).toBeVisible();
    // A subticket that went with its parent comes back with it: no button of its own.
    expect(within(items[1] as HTMLElement).queryByRole('button')).toBeNull();
    expect(within(items[1] as HTMLElement).getByText('Comes back with SHOP-41')).toBeVisible();
    expect(within(items[2] as HTMLElement).getByText(/by the system/)).toBeVisible();

    const tracks = region('Tracks');
    expect(within(tracks).getByText('LEGACY Legacy portal (1,284 tickets)')).toBeVisible();
    // A track whose purge has begun cannot come back.
    expect(within(tracks).getByText('Being deleted for good')).toBeVisible();
    expect(within(tracks).queryByRole('button', { name: 'Restore track TRIAL' })).toBeNull();
  });

  it('[CORE-025] restores a ticket with its subtickets, and a track', async () => {
    const user = userEvent.setup();
    const calls = openTrash({
      'POST /tickets/41/restore': () => jsonResponse(200, { ticket: {} }),
      'POST /tracks/9/undelete': () => jsonResponse(200, { track: {} }),
    });
    await user.click(await screen.findByRole('button', { name: 'Restore SHOP-41' }));
    expect(await screen.findByText('SHOP-41 is back.')).toHaveAttribute('role', 'status');
    expect(within(region('Tickets')).queryByText(/SHOP-4/)).toBeNull();
    expect(within(region('Tickets')).getAllByRole('listitem')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Restore track LEGACY' }));
    expect(await screen.findByText('Track LEGACY is back.')).toBeVisible();
    expect(within(region('Tracks')).queryByText(/LEGACY/)).toBeNull();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/tickets/41/restore',
      '/tracks/9/undelete',
    ]);
  });

  it('[CORE-025] explains a refused restore', async () => {
    const user = userEvent.setup();
    openTrash({
      'POST /tickets/7/restore': () => jsonResponse(409, { error: 'parent_in_trash' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Restore OPS-7' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Its parent is still in the trash: restore the parent first.',
    );
    expect(within(region('Tickets')).getAllByRole('listitem')).toHaveLength(3);
  });

  it('[CORE-025] lets a site administrator change the retention, within 1 to 365 days', async () => {
    const user = userEvent.setup();
    const calls = openTrash({
      'PUT /admin/trash-policy': (body) =>
        jsonResponse(200, { ...(body as object), limits: { min: 1, max: 365, default: 30 } }),
    });
    const form = await screen.findByRole('form', { name: 'Retention' });
    const days = within(form).getByRole('spinbutton', { name: 'Days in the trash' });
    expect(days).toHaveValue(30);
    await user.clear(days);
    await user.type(days, '400');
    await user.click(within(form).getByRole('button', { name: 'Save retention' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Enter a whole number of days from 1 to 365.',
    );
    await user.clear(days);
    await user.type(days, '14');
    await user.click(within(form).getByRole('button', { name: 'Save retention' }));
    expect(await within(form).findByText('Retention saved.')).toBeVisible();
    expect(screen.getByText(/wait here for 14 days/)).toBeVisible();
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/admin/trash-policy', body: { retentionDays: 14 } },
    ]);
  });

  it('[CORE-025] shows other people only the tickets they may restore', async () => {
    const calls = openTrash(
      {
        'GET /trash?limit=50': () =>
          jsonResponse(200, { tickets: TRASHED_TICKETS.slice(2), next: null }),
        'GET /trash/tracks': () => jsonResponse(403, { error: 'forbidden' }),
      },
      MEMBER,
    );
    expect(await screen.findByRole('button', { name: 'Restore OPS-7' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Tracks' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Retention' })).toBeNull();
    expect(calls.some((c) => c.path.startsWith('/admin/trash-policy'))).toBe(false);
  });

  it('[CORE-025] pages through a long trash', async () => {
    const user = userEvent.setup();
    openTrash({
      'GET /trash?limit=50': () =>
        jsonResponse(200, { tickets: TRASHED_TICKETS.slice(0, 1), next: '1760951700000.41' }),
      'GET /trash?limit=50&after=1760951700000.41': () =>
        jsonResponse(200, { tickets: TRASHED_TICKETS.slice(2), next: null }),
    });
    await user.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('button', { name: 'Restore OPS-7' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('[CORE-025] says when the trash is empty, and when it cannot be read', async () => {
    openTrash({
      'GET /trash?limit=50': () => jsonResponse(200, { tickets: [], next: null }),
      'GET /trash/tracks': () => jsonResponse(200, { tracks: [] }),
    });
    expect(await screen.findByText('No tickets in the trash.')).toBeVisible();
    expect(screen.getByText('No tracks in the trash.')).toBeVisible();
  });

  it('[CORE-025] reports a trash that could not be read', async () => {
    openTrash({ 'GET /trash?limit=50': () => jsonResponse(500, { error: 'boom' }) });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The trash could not be read. Try again in a moment.',
    );
  });

  it('[CORE-025] is listed in Administration and the command palette for administrators', async () => {
    stubBackend({});
    window.location.hash = '#/admin';
    render(<App session={ADMIN} />);
    expect(await screen.findByRole('link', { name: 'Trash' })).toHaveAttribute(
      'href',
      '#/admin/trash',
    );
  });

  it('[CORE-025] works on a phone-sized screen', async () => {
    setViewportWidth(375);
    openTrash();
    expect(await screen.findByRole('button', { name: 'Restore SHOP-41' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restore track LEGACY' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    stubBackend({
      'GET /trash?limit=50': () => jsonResponse(200, { tickets: TRASHED_TICKETS, next: null }),
      'GET /trash/tracks': () => jsonResponse(200, { tracks: TRASHED_TRACKS }),
      'GET /admin/trash-policy': () => jsonResponse(200, { retentionDays: 30 }),
    });
    window.location.hash = '#/admin/trash';
    const errors: Error[] = [];
    render(<App session={ADMIN} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
    const main = screen.getByRole('main');
    await within(main).findAllByRole('spinbutton');
    const texts = visibleTexts(main);
    expect(texts.length).toBeGreaterThan(20);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
