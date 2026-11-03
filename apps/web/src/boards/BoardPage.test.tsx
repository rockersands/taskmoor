import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nProvider, type Translate } from '../i18n/I18nProvider';
import { boardBehind, rememberBoard } from '../routing/cameFrom';
import { setViewportWidth } from '../test/viewport';
import { BoardPage, boardFilterName } from './BoardPage';
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
      'SHOP-23 cannot go to To do: its workflow has no step there from Active.',
    );
    expect(keysIn('Doing in Everything else')).toContain('SHOP-23');
  });

  it('[AGL-013] keeps its columns in a scrolling region on a phone', async () => {
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
  it('[AGL-001] lists boards and makes one for a track, with the query out of the way', async () => {
    const user = userEvent.setup();
    const client = fakeBoardClient();
    const create = vi.spyOn(client, 'create');
    render(
      <I18nProvider locale="en">
        <BoardsPage client={client} onCreated={() => {}} />
      </I18nProvider>,
    );
    await user.type(screen.getByLabelText('Name'), 'Payments');
    expect(screen.queryByLabelText('Tickets (a query)')).toBeNull();
    const track = screen.getByRole('combobox', { name: 'Track' });
    await screen.findByRole('option', { name: 'Payments (PAY)' });
    expect(track).toBeRequired();
    await user.selectOptions(track, 'Payments (PAY)');
    await user.click(screen.getByRole('button', { name: 'Create board' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: 'Payments',
        kind: 'kanban',
        query: 'track = PAY',
      }),
    );
  });

  it('[AGL-001] carries the track into the advanced query, and asks for one if tracks fail', async () => {
    const user = userEvent.setup();
    const client = fakeBoardClient();
    const { unmount } = render(
      <I18nProvider locale="en">
        <BoardsPage client={client} onCreated={() => {}} />
      </I18nProvider>,
    );
    await screen.findByRole('option', { name: 'Web app (WEB)' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Track' }), 'Web app (WEB)');
    await user.click(
      screen.getByRole('button', { name: 'Advanced: choose the tickets with a query' }),
    );
    const query = screen.getByRole('textbox', { name: 'Tickets (a query)' });
    expect(query).toHaveValue('track = WEB');
    expect(query).toHaveFocus();
    expect(screen.getByText(/For example: track = PAY/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Choose a track instead' }));
    expect(screen.getByRole('combobox', { name: 'Track' })).toHaveFocus();
    unmount();

    client.tracks = async () => {
      throw new Error('no');
    };
    render(
      <I18nProvider locale="en">
        <BoardsPage client={client} onCreated={() => {}} />
      </I18nProvider>,
    );
    expect(await screen.findByRole('textbox', { name: 'Tickets (a query)' })).toBeRequired();
    expect(screen.getByRole('status')).toHaveTextContent('The tracks could not be loaded');
    expect(screen.queryByRole('button', { name: 'Choose a track instead' })).toBeNull();
  });

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
    await user.click(
      screen.getByRole('button', { name: 'Advanced: choose the tickets with a query' }),
    );
    await user.type(screen.getByLabelText('Tickets (a query)'), 'track = PAY');
    await user.click(screen.getByRole('button', { name: 'Create board' }));
    await waitFor(() => expect(made).toEqual([9]));
  });
});

describe('a move the workflow needs more for (ADR-049)', () => {
  it('[AGL-003] asks for the close reason the transition needs, then moves', async () => {
    const user = userEvent.setup();
    const client = fakeBoardClient({ closeReasonRequired: 'done' });
    renderBoard(client);
    const card = await screen.findByRole('link', { name: /Gift cards/ });
    card.focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Close asks for this:')).toBeVisible();
    const reason = await within(dialog).findByRole('combobox', { name: 'Close reason' });
    await within(dialog).findByRole('option', { name: 'Fixed' });
    await user.selectOptions(reason, 'Duplicate');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(client.moves.at(-1)).toMatchObject({ columnId: 'done', fields: { 'close-reason': 2 } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[AGL-003] says in plain words why a move was refused, never a code', async () => {
    const user = userEvent.setup();
    const client = fakeBoardClient();
    client.move = async () => ({
      kind: 'refused',
      code: 'transition_refused',
      refusal: {
        error: 'transition_refused',
        by: 'guard',
        name: 'only-assignee',
      },
    });
    renderBoard(client);
    const card = await screen.findByRole('link', { name: /Gift cards/ });
    card.focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/was not moved\. /);
    expect(alert).not.toHaveTextContent('transition_refused');

    client.move = async () => ({ kind: 'no_transition' });
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/its workflow has no step there from/),
    );
  });
});

describe('a card leads to its ticket and back (ADR-114)', () => {
  it('[AGL-001] remembers the board for the ticket a person opens, and only that one', () => {
    window.sessionStorage.clear();
    expect(boardBehind('PAY-1')).toBeNull();
    rememberBoard('PAY-1', { id: 7, name: 'Checkout team' });
    expect(boardBehind('PAY-1')).toEqual({ id: 7, name: 'Checkout team' });
    expect(boardBehind('PAY-2')).toBeNull();
  });
});

describe("a new board's filters in the person's language", () => {
  const t = ((id: string) => `translated ${id}`) as unknown as Translate;

  it('[AGL-001] translates the two defaults, and leaves a renamed filter alone', () => {
    expect(boardFilterName(t, { id: 'mine', name: 'Only my tickets' })).toBe(
      'translated boards.filter.mine',
    );
    expect(boardFilterName(t, { id: 'recent', name: 'Recently updated' })).toBe(
      'translated boards.filter.recent',
    );
    expect(boardFilterName(t, { id: 'mine', name: 'Mine' })).toBe('Mine');
  });
});

describe('dragging cards (M1-046)', () => {
  // jsdom has no DragEvent: a mouse event stands in, so the pointer's position reaches the page.
  beforeAll(() => {
    if (!('DragEvent' in window)) {
      Object.defineProperty(window, 'DragEvent', {
        value: class extends MouseEvent {},
        configurable: true,
      });
    }
  });
  // jsdom gives no layout: every card's box is empty, so its middle is at 0.
  const dataTransfer = () => ({
    setData: () => undefined,
    getData: () => '',
    effectAllowed: 'move',
    dropEffect: 'move',
  });
  const cardOf = (key: string) =>
    screen.getByRole('link', { name: new RegExp(`^${key} `) }).closest('li') as HTMLElement;
  const drag = (key: string, to: HTMLElement, over: HTMLElement = to, clientY = 10) => {
    const transfer = dataTransfer();
    fireEvent.dragStart(cardOf(key), { dataTransfer: transfer });
    fireEvent.dragOver(over, { dataTransfer: transfer, clientY });
    fireEvent.drop(to, { dataTransfer: transfer });
  };

  it('[AGL-002] a card dropped on another column moves there through its transition', async () => {
    const client = renderBoard();
    await page();
    drag('SHOP-19', screen.getByRole('list', { name: 'Doing in Everything else' }));
    await waitFor(() =>
      expect(keysIn('Doing in Everything else')).toEqual(['SHOP-23', 'SHOP-24', 'SHOP-19']),
    );
    // At the end of the cell: after its last card.
    expect(client.moves.at(-1)).toEqual({ ticket: 119, columnId: 'doing', after: 124 });
    expect(await screen.findByText('SHOP-19 moved to Doing.')).toBeInTheDocument();
  });

  it('[AGL-002] a drop where several transitions lead asks which one', async () => {
    renderBoard();
    await page();
    drag('SHOP-23', screen.getByRole('list', { name: 'Review and done in Everything else' }));
    expect(
      await screen.findByRole('dialog', { name: 'Move SHOP-23 to Review and done' }),
    ).toBeVisible();
  });

  it('[AGL-009] a card dropped above another in its column takes that place', async () => {
    const client = renderBoard();
    await page();
    const doing = screen.getByRole('list', { name: 'Doing in Everything else' });
    // Above the middle of SHOP-23: before it.
    drag('SHOP-24', doing, cardOf('SHOP-23'), -1);
    await waitFor(() => expect(keysIn('Doing in Everything else')).toEqual(['SHOP-24', 'SHOP-23']));
    expect(client.moves.at(-1)).toEqual({ ticket: 124, columnId: 'doing', before: 123 });
    // Dropped where it already is: nothing is asked of the server.
    const before = client.moves.length;
    drag('SHOP-24', doing, cardOf('SHOP-23'), -1);
    expect(client.moves).toHaveLength(before);
  });
});
