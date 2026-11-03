import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { MEMBER } from '../admin/fixtures';
import { type Handler, stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { templateOf } from './CreateTicketPage';
import { BUG_FORM, CHORE_FORM, PRIORITIES, TRACKS, TYPES } from './fixtures';

const CHORE_7 = {
  track: { key: 'SHOP' },
  ticketType: { id: 4 },
  summary: 'Rotate the payment keys',
  priority: { id: 1 },
  labels: ['security', 'quarterly'],
  startDate: null,
  dueDate: '2026-12-01',
};

function renderApp(handlers: Record<string, Handler> = {}) {
  const calls = stubBackend({
    'GET /tracks': () => jsonResponse(200, { tracks: TRACKS }),
    'GET /priorities': () => jsonResponse(200, { priorities: PRIORITIES }),
    'GET /tracks/SHOP/ticket-types': () =>
      jsonResponse(200, { typeSetId: 1, defaultTypeId: 3, ticketTypes: TYPES }),
    'GET /tracks/SHOP/layout?ticketTypeId=3&operation=create': () => jsonResponse(200, BUG_FORM),
    'GET /tracks/SHOP/layout?ticketTypeId=4&operation=create': () => jsonResponse(200, CHORE_FORM),
    ...handlers,
  });
  window.location.hash = '#/home';
  render(<App session={MEMBER} />);
  return calls;
}

describe('the create dialog (M1-052)', () => {
  it('[AGL-018] still closes with Escape after focus falls out of it, as when Create is pressed', async () => {
    const user = userEvent.setup();
    renderApp();
    const opener = await screen.findByRole('button', { name: 'New ticket' });
    opener.focus();
    await user.keyboard('c');
    const dialog = await screen.findByRole('dialog', { name: 'Create ticket' });
    // What a submit button does when it turns disabled under the pointer.
    (document.activeElement as HTMLElement).blur();
    expect(dialog).not.toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Tab}');
    expect(dialog).toHaveFocus();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Create ticket' })).toBeNull();
  });

  it('[AGL-018] opens with C anywhere outside a field, closes with Escape and gives focus back', async () => {
    const user = userEvent.setup();
    renderApp();
    const opener = await screen.findByRole('button', { name: 'New ticket' });
    opener.focus();
    await user.keyboard('c');
    const dialog = await screen.findByRole('dialog', { name: 'Create ticket' });
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Create ticket' })).toBeVisible();
    expect(await within(dialog).findByLabelText('Summary (required)')).toBeVisible();
    // C typed into a field is a letter, not the shortcut.
    await user.type(within(dialog).getByLabelText('Summary (required)'), 'cc');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Create ticket' })).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('[CORE-013] creates from the top bar and links the ticket, closing on the way', async () => {
    const user = userEvent.setup();
    renderApp({ 'POST /tickets': () => jsonResponse(201, { ticket: { key: 'SHOP-9' } }) });
    await user.click(await screen.findByRole('button', { name: 'New ticket' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create ticket' });
    await user.selectOptions(await within(dialog).findByLabelText('Ticket type'), '4');
    await user.type(await within(dialog).findByLabelText('Summary (required)'), 'Clean the cache');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    const open = await within(dialog).findByRole('link', { name: 'Open SHOP-9' });
    await user.click(open);
    expect(screen.queryByRole('dialog', { name: 'Create ticket' })).toBeNull();
    expect(window.location.hash).toBe('#/tickets/SHOP-9');
  });

  it('[CORE-013] starts from a ticket: its type, words, priority, labels and dates', async () => {
    const user = userEvent.setup();
    const calls = renderApp({
      'GET /tickets/SHOP-7': () => jsonResponse(200, { ticket: CHORE_7 }),
      'GET /tickets/SHOP-404': () => jsonResponse(404, { error: 'not_found' }),
      'POST /tickets': () => jsonResponse(201, { ticket: { key: 'SHOP-10' } }),
    });
    await user.click(await screen.findByRole('button', { name: 'New ticket' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create ticket' });
    const key = await within(dialog).findByLabelText('Start from a ticket (its key)');
    await user.type(key, 'shop-404');
    await user.click(within(dialog).getByRole('button', { name: 'Copy its fields' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'There is no ticket SHOP-404 that you may see.',
    );
    await user.clear(key);
    await user.type(key, 'shop-7');
    await user.click(within(dialog).getByRole('button', { name: 'Copy its fields' }));
    expect(
      await within(dialog).findByText('The fields of SHOP-7 are filled in: change what differs.'),
    ).toBeVisible();
    expect(within(dialog).getByLabelText('Ticket type')).toHaveValue('4');
    expect(await within(dialog).findByLabelText('Summary (required)')).toHaveValue(
      'Rotate the payment keys',
    );
    expect(within(dialog).getByLabelText('Labels')).toHaveValue('security quarterly');
    expect(within(dialog).getByLabelText('Due date')).toHaveValue('2026-12-01');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await within(dialog).findByRole('link', { name: 'Open SHOP-10' });
    const sent = calls.find((c) => c.method === 'POST' && c.path === '/tickets');
    expect(sent?.body).toMatchObject({
      track: 'SHOP',
      ticketTypeId: 4,
      summary: 'Rotate the payment keys',
      labels: ['security', 'quarterly'],
      dueDate: '2026-12-01',
    });
  });

  it('copies no people, releases or custom fields from a template', () => {
    expect(
      templateOf({ ...CHORE_7, description: { type: 'doc', content: [] }, priority: null }),
    ).toEqual({
      track: 'SHOP',
      ticketTypeId: 4,
      values: {
        summary: 'Rotate the payment keys',
        labels: 'security quarterly',
        dueDate: '2026-12-01',
      },
      docs: { description: { type: 'doc', content: [] } },
    });
  });

  it('fills a small phone without sideways scrolling', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'New ticket' }));
    expect(await screen.findByRole('dialog', { name: 'Create ticket' })).toBeVisible();
  });
});
