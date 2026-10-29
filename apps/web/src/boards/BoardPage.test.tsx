import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { BoardPage } from './BoardPage';
import { BoardsPage } from './BoardsPage';
import { dataPath } from './client';
import { CARDS, fakeBoardClient } from './fixtures';

function renderBoard(client = fakeBoardClient()) {
  render(
    <I18nProvider locale="en">
      <BoardPage boardId={7} client={client} />
    </I18nProvider>,
  );
  return client;
}
const page = async () => within(await screen.findByRole('region', { name: 'Checkout team' }));
const cell = (name: string) => within(screen.getByRole('list', { name }));
const keysIn = (name: string) =>
  cell(name)
    .queryAllByRole('link')
    .map((a) => a.textContent?.split(' ')[0]);

describe('the board page (M1-043)', () => {
  it('[AGL-004] shows columns per lane, the query lane before the catch-all, in rank order', async () => {
    renderBoard();
    const board = await page();
    expect(board.getByRole('heading', { level: 1 })).toHaveTextContent('Checkout team');
    expect(board.getByText('Kanban board · in Shop')).toBeVisible();
    expect(board.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Expedite 1 ticket',
      'Everything else 4 tickets',
    ]);
    expect(keysIn('Doing in Expedite')).toEqual(['SHOP-12']);
    expect(keysIn('To do in Everything else')).toEqual(['SHOP-19', 'SHOP-21']);
    expect(keysIn('Doing in Everything else')).toEqual(['SHOP-23', 'SHOP-24']);
    expect(board.getByRole('link', { name: /SHOP-12/ })).toHaveAttribute(
      'href',
      '#/tickets/SHOP-12',
    );
  });

  it('[AGL-003] marks a column over its maximum and one under its minimum', async () => {
    renderBoard();
    const board = await page();
    const heads = board.getAllByRole('heading', { level: 2 }).map((h) => h.parentElement);
    const doing = heads.find((h) => h?.textContent?.startsWith('Doing')) as HTMLElement;
    const done = heads.find((h) => h?.textContent?.startsWith('Review and done')) as HTMLElement;
    expect(doing).toHaveAttribute('data-wip', 'over');
    expect(doing).toHaveTextContent('3 ticketsmax 2Over the maximum');
    expect(done).toHaveAttribute('data-wip', 'under');
    expect(done).toHaveTextContent('Under the minimum');
  });

  it('[AGL-005] asks for the active board filters and keeps counts whole', async () => {
    const user = userEvent.setup();
    const client = renderBoard();
    const board = await page();
    await user.click(board.getByRole('button', { name: 'Only my tickets', pressed: false }));
    await waitFor(() => expect(client.dataCalls.at(-1)).toEqual(['mine']));
    expect(await board.findByText('2 hidden by board filters')).toBeVisible();
    expect(board.getByRole('button', { name: 'Only my tickets' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(dataPath(7, ['mine', 'recent'])).toBe('/boards/7/data?filters=mine%2Crecent');
  });

  it('[AGL-002] moves a card to the next column with Alt+Right, keeping focus on it', async () => {
    const user = userEvent.setup();
    const client = renderBoard();
    await page();
    screen.getByRole('link', { name: /SHOP-19/ }).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await waitFor(() => expect(keysIn('Doing in Everything else')).toContain('SHOP-19'));
    expect(client.moves).toEqual([{ ticket: 119, columnId: 'doing' }]);
    expect(screen.getByRole('link', { name: /SHOP-19/ })).toHaveFocus();
    expect(screen.getByText('SHOP-19 moved to Doing.')).toBeInTheDocument();
  });

  it('[AGL-009] moves a card up and down within its column with Alt+Up and Alt+Down', async () => {
    const user = userEvent.setup();
    const client = renderBoard();
    await page();
    screen.getByRole('link', { name: /SHOP-24/ }).focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(keysIn('Doing in Everything else')).toEqual(['SHOP-24', 'SHOP-23']));
    expect(client.moves.at(-1)).toEqual({ ticket: 124, columnId: 'doing', before: 123 });
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(keysIn('Doing in Everything else')).toEqual(['SHOP-23', 'SHOP-24']));
    expect(client.moves.at(-1)).toEqual({ ticket: 124, columnId: 'doing', after: 123 });
  });

  it('[AGL-002] asks which transition when several lead into the column', async () => {
    const user = userEvent.setup();
    const client = renderBoard();
    await page();
    await user.click(screen.getByRole('button', { name: 'Move SHOP-23' }));
    await user.click(screen.getByRole('button', { name: 'Forward to Review and done' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move SHOP-23 to Review and done' });
    const options = within(dialog)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(options).toEqual(['Send to review (to In Review)', 'Close (to Closed)', 'Cancel']);
    expect(within(dialog).getByRole('button', { name: /Send to review/ })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: /Send to review/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(client.moves.at(-1)).toEqual({ ticket: 123, columnId: 'done', transitionId: 2 });
    expect(keysIn('Review and done in Everything else')).toEqual(['SHOP-23']);
  });

  it('[AGL-002] says so when no transition leads into the column', async () => {
    const user = userEvent.setup();
    renderBoard();
    await page();
    screen.getByRole('link', { name: /SHOP-23/ }).focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No transition leads SHOP-23 into To do.',
    );
    expect(keysIn('Doing in Everything else')).toContain('SHOP-23');
  });

  it('[ADR-033] keeps its columns in a scrolling region on a phone', async () => {
    setViewportWidth(375);
    renderBoard(fakeBoardClient({ cards: CARDS.slice(0, 2) }));
    await page();
    const region = screen.getByRole('region', { name: 'Columns' });
    expect(region).toHaveClass('board-scroll');
    expect(region).toHaveAttribute('tabindex', '0');
    setViewportWidth(1440);
  });
});

describe('the boards list (M1-043)', () => {
  it('[AGL-001] lists boards and makes one from a query', async () => {
    const user = userEvent.setup();
    const client = fakeBoardClient();
    const made: number[] = [];
    render(
      <I18nProvider locale="en">
        <BoardsPage client={client} onCreated={(b) => made.push(b.id)} />
      </I18nProvider>,
    );
    expect(await screen.findByRole('link', { name: 'Checkout team' })).toHaveAttribute(
      'href',
      '#/boards/7',
    );
    expect(screen.getByText('Scrum board · kept by Kalo Smith')).toBeVisible();
    await user.type(screen.getByLabelText('Name'), 'Payments');
    await user.selectOptions(screen.getByLabelText('Kind'), 'scrum');
    await user.type(screen.getByLabelText('Tickets (a query)'), 'track = PAY');
    await user.click(screen.getByRole('button', { name: 'Create board' }));
    await waitFor(() => expect(made).toEqual([9]));
  });
});
