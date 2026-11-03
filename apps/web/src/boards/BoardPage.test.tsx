import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nProvider, type Translate } from '../i18n/I18nProvider';
import { boardBehind, rememberBoard } from '../routing/cameFrom';
import { setViewportWidth } from '../test/viewport';
import { BoardPage, boardFilterName, offeredBoardFilters } from './BoardPage';
import { peopleFromRoute, routeWithPeople } from './BoardPeopleFilter';
import { dataPath } from './client';
import { BOARD, CARDS, fakeBoardClient, manyCards, VIEWER_ID } from './fixtures';

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
    await user.click(board.getByRole('button', { name: 'My work', pressed: false }));
    await waitFor(() => expect(client.dataCalls.at(-1)).toEqual(['mine']));
    expect(await board.findByText('2 hidden by board filters')).toBeVisible();
    expect(board.getByRole('button', { name: 'My work' })).toHaveAttribute('aria-pressed', 'true');
    expect(dataPath(7, ['mine', 'recent'])).toBe('/boards/7/data?filters=mine%2Crecent');
  });

  describe('the person filter', () => {
    afterEach(() => {
      window.history.replaceState(null, '', window.location.pathname);
    });
    const shownKeys = () =>
      screen
        .getAllByRole('link', { name: /^SHOP-/ })
        .map((a) => a.textContent?.split(' ')[0])
        .sort();

    it('[AGL-005] lets a plain member pick Me, Unassigned and people; several show any of them', async () => {
      const user = userEvent.setup();
      const client = renderBoard(fakeBoardClient({ board: { mayConfigure: false } }));
      const board = await page();
      expect(board.queryByRole('link', { name: 'Board settings' })).toBeNull();
      const group = within(board.getByRole('group', { name: 'Filter by person' }));
      await user.click(group.getByRole('button', { name: 'Me', pressed: false }));
      await waitFor(() => expect(shownKeys()).toEqual(['SHOP-12', 'SHOP-21']));
      expect(client.peopleCalls.at(-1)).toEqual(['me']);
      // Counts stay whole, as for any board filter.
      expect(board.getByText('Over the maximum')).toBeVisible();
      await user.click(group.getByRole('button', { name: 'Unassigned', pressed: false }));
      await waitFor(() =>
        expect(shownKeys()).toEqual(['SHOP-12', 'SHOP-19', 'SHOP-21', 'SHOP-24']),
      );
      // The person is in the menu, and once chosen shows beside it; the viewer is "Me", not a name.
      await user.click(group.getByText('People'));
      expect(group.queryByRole('checkbox', { name: 'Kalo Smith' })).toBeNull();
      await user.click(group.getByRole('checkbox', { name: 'Rin Okafor' }));
      await waitFor(() => expect(shownKeys()).toContain('SHOP-23'));
      expect(client.peopleCalls.at(-1)).toEqual(['me', 'none', '6']);
      expect(group.getByRole('button', { name: 'Rin Okafor', pressed: true })).toBeVisible();
      await user.click(group.getByRole('button', { name: 'Clear people' }));
      await waitFor(() => expect(client.peopleCalls.at(-1)).toEqual([]));
      expect(shownKeys()).toHaveLength(5);
    });

    it('[AGL-005] stays in the address, reads a shared link, and follows a change of address', async () => {
      const user = userEvent.setup();
      window.history.replaceState(null, '', '#/boards/7?people=6,bad%20one,none');
      const client = renderBoard();
      const board = await page();
      expect(client.peopleCalls.at(-1)).toEqual(['6', 'none']);
      expect(board.getByRole('button', { name: 'Rin Okafor', pressed: true })).toBeVisible();
      expect(board.getByRole('button', { name: 'Unassigned', pressed: true })).toBeVisible();
      await user.click(board.getByRole('button', { name: 'Unassigned' }));
      await waitFor(() => expect(client.peopleCalls.at(-1)).toEqual(['6']));
      expect(window.location.hash).toBe('#/boards/7?people=6');
      await user.click(board.getByRole('button', { name: 'Clear people' }));
      await waitFor(() => expect(window.location.hash).toBe('#/boards/7'));
      // Someone choosing a link to the same board: the page stays and the filter follows.
      window.location.hash = '#/boards/7?people=me';
      await waitFor(() => expect(client.peopleCalls.at(-1)).toEqual(['me']));
      expect(board.getByRole('button', { name: 'Me', pressed: true })).toBeVisible();
      expect(routeWithPeople('#/boards/7?x=1&people=2', ['me', '3'])).toBe(
        '#/boards/7?x=1&people=me,3',
      );
      expect(peopleFromRoute('#/boards/7')).toEqual([]);
      expect(dataPath(7, [], undefined, ['me', '6'])).toBe('/boards/7/data?people=me%2C6');
    });

    it('[AGL-005] shows the viewer as Me and someone with no tickets here without a name', async () => {
      const user = userEvent.setup();
      window.history.replaceState(null, '', `#/boards/7?people=${VIEWER_ID},999`);
      const client = renderBoard();
      const board = await page();
      expect(board.getByRole('button', { name: 'Me', pressed: true })).toBeVisible();
      await user.click(
        board.getByRole('button', { name: 'Someone with no tickets here', pressed: true }),
      );
      await waitFor(() => expect(client.peopleCalls.at(-1)).toEqual([String(VIEWER_ID)]));
      await user.click(board.getByRole('button', { name: 'Me', pressed: true }));
      await waitFor(() => expect(client.peopleCalls.at(-1)).toEqual([]));
    });

    it('[AGL-005] asks one read per change, however many cards there are', async () => {
      const user = userEvent.setup();
      const client = fakeBoardClient({ cards: manyCards(300) });
      const data = vi.spyOn(client, 'data');
      renderBoard(client);
      const board = await page();
      expect(data).toHaveBeenCalledTimes(1);
      await user.click(board.getByRole('button', { name: 'Unassigned' }));
      await waitFor(() => expect(data).toHaveBeenCalledTimes(2));
    });

    it('[AGL-005] works from the keyboard, and says what it found', async () => {
      const user = userEvent.setup();
      const client = renderBoard();
      const board = await page();
      board.getByRole('button', { name: 'Me' }).focus();
      await user.keyboard(' ');
      await waitFor(() => expect(client.peopleCalls.at(-1)).toEqual(['me']));
      expect(await screen.findByText('2 cards shown')).toBeInTheDocument();
      const opener = board.getByRole('button', { name: 'People', expanded: false });
      opener.focus();
      await user.keyboard('{Enter}');
      expect(opener).toHaveAttribute('aria-expanded', 'true');
      const person = await board.findByRole('checkbox', { name: 'Rin Okafor' });
      person.focus();
      await user.keyboard(' ');
      await waitFor(() => expect(client.peopleCalls.at(-1)).toEqual(['me', '6']));
      await user.keyboard('{Escape}');
      const closed = board.getByRole('button', { name: 'People (1 chosen)', expanded: false });
      expect(closed).toHaveFocus();
      expect(board.queryByRole('checkbox', { name: 'Rin Okafor' })).toBeNull();
    });

    it('[AGL-005] says so when the people chosen have no cards, with a way out', async () => {
      const user = userEvent.setup();
      renderBoard(fakeBoardClient({ cards: CARDS.filter((c) => !c.mine) }));
      const board = await page();
      await user.click(board.getByRole('button', { name: 'Me' }));
      expect(await board.findByText('No cards for these people')).toBeVisible();
      await user.click(board.getAllByRole('button', { name: 'Clear people' })[0] as HTMLElement);
      await waitFor(() => expect(shownKeys()).toHaveLength(3));
    });

    it('[AGL-005] finds a name in a long list', async () => {
      const user = userEvent.setup();
      const crowd = Array.from({ length: 12 }, (_, i) => ({
        ...(CARDS[1] as (typeof CARDS)[number]),
        id: 500 + i,
        key: `SHOP-${500 + i}`,
        fields: { assignee: { id: 20 + i, name: `Person ${i}` } },
      }));
      renderBoard(fakeBoardClient({ cards: crowd }));
      const board = await page();
      await user.click(board.getByRole('button', { name: 'People' }));
      expect(board.getAllByRole('checkbox')).toHaveLength(12);
      await user.type(board.getByRole('searchbox', { name: 'Find a person' }), 'person 11');
      expect(board.getAllByRole('checkbox').map((b) => b.closest('label')?.textContent)).toEqual([
        'Person 11',
      ]);
      await user.type(board.getByRole('searchbox', { name: 'Find a person' }), 'zzz');
      expect(board.getByText('Nobody by that name is assigned here.')).toBeVisible();
    });

    it('[AGL-005] speaks Spanish and fits a small phone', async () => {
      setViewportWidth(375);
      render(
        <I18nProvider locale="es">
          <BoardPage boardId={7} client={fakeBoardClient()} />
        </I18nProvider>,
      );
      const group = await screen.findByRole('group', { name: 'Filtrar por persona' });
      expect(within(group).getByRole('button', { name: 'Yo' })).toBeVisible();
      expect(within(group).getByText('Personas')).toBeVisible();
      setViewportWidth(1440);
    });
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

  it('[AGL-005] carries the person filter along, so the way back shows the same cards', async () => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '#/boards/7?people=me');
    const user = userEvent.setup();
    renderBoard();
    await page();
    await user.click(screen.getByRole('link', { name: /SHOP-21/ }));
    expect(boardBehind('SHOP-21')).toEqual({ id: 7, name: 'Checkout team', people: 'me' });
    window.history.replaceState(null, '', window.location.pathname);
  });
});

describe('the old "Only my tickets" filter', () => {
  const mine = { id: 'mine', name: 'Only my tickets', query: 'assignee = currentUser()' };

  it('[AGL-005] is not offered, as "Me" finds the same cards and combines with other people', async () => {
    const client = fakeBoardClient({
      board: { ...BOARD, boardFilters: [{ ...mine, description: '' }] },
    });
    renderBoard(client);
    const board = await page();
    expect(board.queryByRole('button', { name: 'Only my tickets' })).toBeNull();
    expect(board.queryByRole('group', { name: 'Board filters' })).toBeNull();
    expect(board.getByRole('button', { name: 'Me' })).toBeVisible();
  });

  it('[AGL-005] stays when someone renamed it or wrote their own', () => {
    const renamed = { ...mine, name: 'Mine' };
    const written = { ...mine, id: 'f3', name: 'Assigned to me' };
    const wider = { ...mine, query: 'assignee = currentUser() OR assignee IS EMPTY' };
    expect(offeredBoardFilters([mine, renamed, written, wider])).toEqual([renamed, written, wider]);
  });
});

describe("a new board's filter in the person's language", () => {
  const t = ((id: string) => `translated ${id}`) as unknown as Translate;

  it('[AGL-001] translates the default, and leaves a renamed filter alone', () => {
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
