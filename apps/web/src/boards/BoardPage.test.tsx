import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider, type Translate } from '../i18n/I18nProvider';
import { boardBehind, rememberBoard } from '../routing/cameFrom';
import type { CompleteTarget, Sprint } from '../sprints/client';
import { setCoarsePointer, setViewportWidth } from '../test/viewport';
import { announceTicketChange } from '../tickets/view/ticketChanges';
import { TrackSectionsContext } from '../tracks/trackSections';
import { BoardPage, boardFilterName, offeredBoardFilters, sprintCounts } from './BoardPage';
import { peopleFromRoute, routeWithPeople } from './BoardPeopleFilter';
import { dataPath } from './client';
import { BOARD, CARDS, fakeBoardClient, manyCards, SCRUM_BOARD, VIEWER_ID } from './fixtures';

function renderBoard(client = fakeBoardClient()) {
  render(
    <I18nProvider locale="en">
      <BoardPage boardId={7} client={client} />
    </I18nProvider>,
  );
  return client;
}
const page = async () => within(await screen.findByRole('region', { name: 'Board' }));
const cell = (name: string) => within(screen.getByRole('list', { name }));
const keysIn = (name: string) =>
  cell(name)
    .queryAllByRole('link')
    .map((a) => a.textContent?.split(' ')[0]);

/**
 * A drag with pointer events, as a mouse or a finger makes it (T-162b): down on `from` (a card's
 * link, its grip or its pencil), over the page, then up there unless the test lets go itself.
 * What the page finds under the pointer is `over`. jsdom lays nothing out: every box is empty, so
 * a card's middle is at 0 and a pointer above 0 is in its lower half.
 */
function pointerDrag(
  from: Element,
  over: Element | null,
  options: { pointerType?: 'mouse' | 'touch'; y?: number; up?: boolean; button?: number } = {},
) {
  const { pointerType = 'mouse', y = 10, up = true, button = 0 } = options;
  const under = vi.spyOn(document, 'elementFromPoint').mockReturnValue(over);
  const point = { pointerId: 5, pointerType, isPrimary: true };
  fireEvent.pointerDown(from, { ...point, button, clientX: 10, clientY: 200 });
  fireEvent.pointerMove(window, { ...point, buttons: 1, clientX: 40, clientY: y });
  fireEvent.pointerMove(window, { ...point, buttons: 1, clientX: 80, clientY: y });
  const letGo = () => {
    fireEvent.pointerUp(window, { ...point, clientX: 80, clientY: y });
    under.mockRestore();
  };
  if (up) letGo();
  return letGo;
}

describe('a card’s title in place', () => {
  const cardOf = (key: string) =>
    screen.getByRole('link', { name: new RegExp(`^${key} `) }).closest('li') as HTMLElement;
  const openEditor = async (user: ReturnType<typeof userEvent.setup>, key: string) => {
    await user.click(screen.getByRole('button', { name: `Edit the title of ${key}` }));
    return screen.getByRole('textbox', { name: `Title of ${key}` });
  };

  it('[AGL-006] Enter saves through the ticket route, with the version read, and focus returns', async () => {
    const user = userEvent.setup();
    const client = renderBoard();
    await page();
    const input = await openEditor(user, 'SHOP-19');
    expect(input).toHaveFocus();
    expect(input).toHaveValue('Refunds show the wrong currency');
    await user.clear(input);
    await user.type(input, 'Refunds in the right currency{Enter}');
    expect(
      await screen.findByRole('link', { name: 'SHOP-19 Refunds in the right currency' }),
    ).toBeVisible();
    expect(client.retitles).toEqual([
      { ticket: 119, summary: 'Refunds in the right currency', version: 1 },
    ]);
    expect(screen.getByRole('button', { name: 'Edit the title of SHOP-19' })).toHaveFocus();
    expect(await screen.findByText('Title of SHOP-19 saved.')).toBeInTheDocument();
  });

  it('[AGL-006] Escape cancels, and nothing is saved', async () => {
    const user = userEvent.setup();
    const client = renderBoard();
    await page();
    const input = await openEditor(user, 'SHOP-19');
    await user.type(input, ' but not this{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Title of SHOP-19' })).toBeNull();
    expect(
      screen.getByRole('link', { name: 'SHOP-19 Refunds show the wrong currency' }),
    ).toBeVisible();
    expect(client.retitles).toEqual([]);
    expect(screen.getByRole('button', { name: 'Edit the title of SHOP-19' })).toHaveFocus();
  });

  it('[AGL-006] the same title saves nothing, and an empty one is refused in words', async () => {
    const user = userEvent.setup();
    const client = renderBoard();
    await page();
    const input = await openEditor(user, 'SHOP-19');
    await user.clear(input);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('A title cannot be empty.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await user.type(input, 'Refunds show the wrong currency{Enter}');
    expect(screen.queryByRole('textbox', { name: 'Title of SHOP-19' })).toBeNull();
    expect(client.retitles).toEqual([]);
  });

  it.each<[() => Error, string | RegExp]>([
    [() => new ApiError(403, { error: 'forbidden' }), 'You may not edit this ticket.'],
    [
      () =>
        new ApiError(403, {
          error: 'locked',
          action: 'edit',
          locks: [{ by: 'status', statusId: 1, statusName: 'Closed', allowed: [] }],
        }),
      /Closed/,
    ],
    [() => new ApiError(409, { error: 'track_archived' }), /archived track/],
    [
      () => new ApiError(400, { error: 'invalid_fields', fields: { summary: 'too_long' } }),
      /too long/,
    ],
    [() => new Error('offline'), 'The title was not saved. Try again in a moment.'],
  ])(
    '[AGL-006] shows a refusal in plain words and keeps what was written',
    async (refusal, words) => {
      const user = userEvent.setup();
      renderBoard(fakeBoardClient({ retitleRefusal: refusal }));
      await page();
      const input = await openEditor(user, 'SHOP-19');
      await user.type(input, ' now{Enter}');
      expect(await screen.findByRole('alert')).toHaveTextContent(words);
      expect(input).toHaveValue('Refunds show the wrong currency now');
      expect(input).toBeEnabled();
    },
  );

  it('[AGL-006] after a conflict says so, and the next Enter saves over the other change', async () => {
    const user = userEvent.setup();
    const client = fakeBoardClient({
      retitleRefusal: () => new ApiError(409, { error: 'version_conflict' }),
    });
    renderBoard(client);
    await page();
    const input = await openEditor(user, 'SHOP-19');
    await user.type(input, ' now{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone changed this ticket');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(client.retitles).toHaveLength(2));
    expect(client.retitles.map((r) => r.version)).toEqual([1, undefined]);
  });

  it('[AGL-006] offers the pencil only on a ticket the person may edit', async () => {
    const cards = CARDS.map((c) => (c.key === 'SHOP-19' ? { ...c, mayEdit: false } : c));
    renderBoard(fakeBoardClient({ cards }));
    await page();
    expect(screen.queryByRole('button', { name: 'Edit the title of SHOP-19' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit the title of SHOP-21' })).toBeVisible();
    // The menu to move it stays.
    expect(screen.getByRole('button', { name: 'Move SHOP-19' })).toBeVisible();
  });

  it('[AGL-006] a click right after a drag opens nothing, and a later one does', async () => {
    const client = renderBoard();
    const link = await screen.findByRole('link', { name: /^SHOP-19 / });
    const hash = window.location.hash;
    // Dragged, and let go over nothing: it stays, and the click that ends the drag is the drag's.
    pointerDrag(link, null);
    expect(screen.getByText('SHOP-19 stays where it was.')).toBeInTheDocument();
    expect(fireEvent.click(link)).toBe(false);
    expect(window.location.hash).toBe(hash);
    // A plain click later stays a real link's click, for the router to take.
    await act(() => new Promise((done) => setTimeout(done, 0)));
    const router = vi.fn((e: Event) => e.preventDefault());
    window.addEventListener('click', router, { once: true });
    fireEvent.click(link);
    expect(router).toHaveBeenCalledOnce();
    expect(link).toHaveAttribute('href', '#/tickets/SHOP-19');
    // The link itself is never the browser's own drag, which would end the pointer's.
    expect(link).toHaveAttribute('draggable', 'false');
    expect(client.moves).toEqual([]);
  });

  it('[AGL-006] the pencil neither starts a drag nor opens the ticket', async () => {
    const user = userEvent.setup();
    const client = renderBoard();
    await page();
    const hash = window.location.hash;
    const pencil = screen.getByRole('button', { name: 'Edit the title of SHOP-19' });
    expect(pencil.closest('a')).toBeNull();
    // A press on the pencil that moves does not take the card along.
    const letGo = pointerDrag(
      pencil,
      screen.getByRole('list', { name: 'Doing in Everything else' }),
      {
        up: false,
      },
    );
    expect(cardOf('SHOP-19')).not.toHaveClass('is-dragging');
    letGo();
    expect(client.moves).toEqual([]);
    await user.click(pencil);
    expect(window.location.hash).toBe(hash);
    expect(screen.getByRole('textbox', { name: 'Title of SHOP-19' })).toBeVisible();
  });

  it('[AGL-006] while editing the card cannot be dragged and its move keys do not fire', async () => {
    const user = userEvent.setup();
    const client = renderBoard();
    await page();
    const card = cardOf('SHOP-19');
    const doing = screen.getByRole('list', { name: 'Doing in Everything else' });
    const input = await openEditor(user, 'SHOP-19');
    expect(screen.queryByRole('button', { name: 'Move SHOP-19' })).toBeNull();
    pointerDrag(card, doing);
    expect(card).not.toHaveClass('is-dragging');
    await user.keyboard('{Alt>}{ArrowRight}{ArrowDown}{/Alt}');
    expect(client.moves).toEqual([]);
    expect(input).toHaveFocus();
    await user.keyboard('{Escape}');
    // Closed again, it drags as before.
    const letGo = pointerDrag(cardOf('SHOP-19'), doing, { up: false });
    expect(cardOf('SHOP-19')).toHaveClass('is-dragging');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    letGo();
    expect(client.moves).toEqual([]);
  });

  it('[AGL-006] reaches the pencil from the keyboard', async () => {
    const user = userEvent.setup();
    renderBoard();
    await page();
    screen.getByRole('link', { name: /^SHOP-19 / }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Edit the title of SHOP-19' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('textbox', { name: 'Title of SHOP-19' })).toHaveFocus();
  });
});

describe('the board page (M1-043)', () => {
  it('[CORE-032] shows how many subtickets are closed on the cards that have any', async () => {
    const asked: number[][] = [];
    renderBoard({
      ...fakeBoardClient(),
      subticketProgress: async (ids) => {
        asked.push(ids);
        return { 112: { total: 4, closed: 1 } };
      },
    });
    const board = await page();
    expect(await board.findByText('1/4')).toBeVisible();
    expect(board.getByText('1 of 4 closed (25%)')).toBeInTheDocument();
    expect(board.getAllByText(/^[0-9]+.[0-9]+$/)).toHaveLength(1);
    expect(asked[0]).toContain(112);
  });

  it('[AGL-006] keeps its first read when a ticket changes before the board has arrived', async () => {
    const client = fakeBoardClient();
    const board = await client.board(1);
    let arrive: (b: typeof board) => void = () => {};
    client.board = () =>
      new Promise((resolve) => {
        arrive = resolve;
      });
    renderBoard(client);
    act(() => announceTicketChange());
    await act(async () => arrive(board));
    expect(await screen.findByRole('region', { name: 'Board' })).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[AGL-004] shows columns per lane, the query lane before the catch-all, in rank order', async () => {
    renderBoard();
    const board = await page();
    // A track's board is titled by its section, the track named above it (D26).
    expect(board.getByRole('heading', { level: 1 })).toHaveTextContent('Board');
    expect(board.getByText('Shop')).toBeVisible();
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

  it('[AGL-006] shows a card as its title, type and priority icons, assignee and points', async () => {
    renderBoard();
    await page();
    const cardOf = (key: string) =>
      within(
        screen.getByRole('link', { name: new RegExp(`^${key} `) }).closest('li') as HTMLElement,
      );
    const urgent = cardOf('SHOP-12');
    expect(urgent.getByRole('img', { name: 'Task' })).toBeVisible();
    expect(urgent.getByRole('img', { name: 'Urgent' })).toHaveAttribute('title', 'Urgent');
    expect(urgent.getByRole('img', { name: 'Kalo Smith' })).toHaveTextContent('KS');
    // Points only where there is a value; days only once a card has waited.
    expect(urgent.queryByRole('img', { name: /point/ })).toBeNull();
    expect(urgent.getByRole('img', { name: '4 days in this column' })).toHaveTextContent('4');
    const fresh = cardOf('SHOP-19');
    expect(fresh.getByRole('img', { name: '3 points' })).toHaveTextContent('3');
    expect(fresh.getByRole('img', { name: 'Unassigned' })).toBeVisible();
    expect(fresh.queryByText(/in this column/)).toBeNull();
    expect(screen.getByText('SHOP-12')).toBeVisible();
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

  it('[AGL-002] lets only the card that moved drop into place', async () => {
    const user = userEvent.setup();
    renderBoard();
    await page();
    screen.getByRole('link', { name: /SHOP-19/ }).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await waitFor(() => expect(keysIn('Doing in Everything else')).toContain('SHOP-19'));
    const card = screen.getByRole('link', { name: /SHOP-19/ }).closest('li');
    expect(card).toHaveClass('motion-drop');
    expect(document.querySelectorAll('.motion-drop')).toHaveLength(1);
    if (card) fireEvent.animationEnd(card);
    expect(document.querySelectorAll('.motion-drop')).toHaveLength(0);
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

  it('[AGL-013] fades the edge past which more columns wait, and drops the fade at the end (D2, TR-23)', async () => {
    const at = { left: 0 };
    const restore = [
      ['scrollWidth', () => 1400],
      ['clientWidth', () => 960],
      ['scrollLeft', () => at.left],
    ].map(([name, get]) => {
      Object.defineProperty(HTMLElement.prototype, name as string, {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains('board-scroll') ? (get as () => number)() : 0;
        },
      });
      return () =>
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name as string];
    });
    try {
      renderBoard();
      await page();
      const region = screen.getByRole('region', { name: 'Columns' });
      await waitFor(() => expect(region).toHaveAttribute('data-more', 'end'));
      at.left = 440;
      fireEvent.scroll(region);
      expect(region).toHaveAttribute('data-more', 'start');
    } finally {
      for (const undo of restore) undo();
    }
  });

  it('[AGL-002] tells a finger how to move cards, and a keyboard the keys (D6, TR-7)', async () => {
    renderBoard();
    await page();
    expect(screen.getByText(/^Up and Down go from card to card/)).toBeInTheDocument();
    // A narrow window worked with a keyboard keeps the keys: touch screens only (D6).
    cleanup();
    setViewportWidth(375);
    renderBoard();
    await page();
    expect(screen.getByText(/^Up and Down go from card to card/)).toBeInTheDocument();
    cleanup();
    setCoarsePointer(true);
    renderBoard();
    await page();
    expect(
      screen.getByText(
        'Drag a card by its grip to another column, or tap the grip for a menu of every move.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Alt\+Left/)).toBeNull();
  });

  it('[AGL-005] shows its filters on a slab of their own (D28)', async () => {
    renderBoard();
    await page();
    const filters = screen.getByRole('group', { name: 'Board filters' });
    expect(filters.closest('.filter-row')).toHaveClass('board-filters');
  });

  it('[AGL-001] says a board that is not there is not found, with a way on (D4, AC-8)', async () => {
    const client = fakeBoardClient();
    client.board = async () => {
      throw new ApiError(404, { error: 'not_found' });
    };
    renderBoard(client);
    expect(await screen.findByRole('heading', { level: 1, name: 'Board not found' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to Home' })).toBeVisible();
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

describe('a link to the backlog (ADR-116)', () => {
  const openWith = (
    kind: 'scrum' | 'kanban',
    backlog: boolean | null,
    location: (typeof BOARD)['location'] = BOARD.location,
  ) =>
    render(
      <I18nProvider locale="en">
        <TrackSectionsContext.Provider
          value={backlog === null ? null : { backlog, sprints: backlog }}
        >
          <BoardPage
            boardId={7}
            client={fakeBoardClient({ board: { ...BOARD, kind, location } })}
          />
        </TrackSectionsContext.Provider>
      </I18nProvider>,
    );
  const OUTSIDE = { type: 'user', user: { id: 1, name: 'Ana' } } as (typeof BOARD)['location'];
  const outside = async () => within(await screen.findByRole('region', { name: 'Checkout team' }));

  it('[CORE-002] is not a pill on a track’s board, whose Backlog and Statistics tabs are right above (D7)', async () => {
    openWith('scrum', true);
    const board = await page();
    expect(board.queryByRole('link', { name: 'Backlog' })).toBeNull();
    expect(board.queryByRole('link', { name: 'Reports' })).toBeNull();
    expect(board.getByRole('link', { name: 'Board settings' })).toBeVisible();
  });

  it('[CORE-002] is on a Scrum board outside any track, with its reports', async () => {
    openWith('scrum', true, OUTSIDE);
    const board = await outside();
    expect(board.getByRole('link', { name: 'Backlog' })).toBeVisible();
    expect(board.getByRole('link', { name: 'Reports' })).toBeVisible();
  });

  it('[CORE-002] is not on a Kanban board', async () => {
    openWith('kanban', false, OUTSIDE);
    expect((await outside()).queryByRole('link', { name: 'Backlog' })).toBeNull();
  });

  it('[CORE-002] is not on a Scrum board whose backlog is turned off', async () => {
    openWith('scrum', false, OUTSIDE);
    expect((await outside()).queryByRole('link', { name: 'Backlog' })).toBeNull();
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

describe('dragging cards (M1-046; by pointer events since T-162b)', () => {
  const linkOf = (key: string) => screen.getByRole('link', { name: new RegExp(`^${key} `) });
  const cardOf = (key: string) => linkOf(key).closest('li') as HTMLElement;
  const doing = () => screen.getByRole('list', { name: 'Doing in Everything else' });

  it('[AGL-002] a card dropped on another column moves there through its transition', async () => {
    const client = renderBoard();
    await page();
    pointerDrag(linkOf('SHOP-19'), doing());
    await waitFor(() =>
      expect(keysIn('Doing in Everything else')).toEqual(['SHOP-23', 'SHOP-24', 'SHOP-19']),
    );
    // At the end of the cell: after its last card.
    expect(client.moves.at(-1)).toEqual({ ticket: 119, columnId: 'doing', after: 124 });
    expect(await screen.findByText('SHOP-19 moved to Doing.')).toBeInTheDocument();
    // Seamless: one way there, so nothing is asked (ADR-116).
    expect(screen.queryByRole('dialog')).toBeNull();
    // Only the card that moved drops into place, focused where it landed.
    await waitFor(() => expect(linkOf('SHOP-19')).toHaveFocus());
    expect(document.querySelectorAll('.motion-drop')).toHaveLength(1);
  });

  it('[AGL-002] a drop where several transitions lead asks which one', async () => {
    renderBoard();
    await page();
    pointerDrag(
      linkOf('SHOP-23'),
      screen.getByRole('list', { name: 'Review and done in Everything else' }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Move SHOP-23 to Review and done' }),
    ).toBeVisible();
  });

  it('[AGL-009] a card dropped above another in its column takes that place', async () => {
    const client = renderBoard();
    await page();
    // Above the middle of SHOP-23: before it.
    pointerDrag(linkOf('SHOP-24'), cardOf('SHOP-23'), { y: -1 });
    await waitFor(() => expect(keysIn('Doing in Everything else')).toEqual(['SHOP-24', 'SHOP-23']));
    expect(client.moves.at(-1)).toEqual({ ticket: 124, columnId: 'doing', before: 123 });
    // Dropped where it already is: nothing is asked of the server, and the page says so.
    const before = client.moves.length;
    pointerDrag(linkOf('SHOP-24'), cardOf('SHOP-23'), { y: -1 });
    expect(client.moves).toHaveLength(before);
    expect(screen.getByText('SHOP-24 stays where it was.')).toBeInTheDocument();
  });

  it('[AGL-002] [NFR-005] says what is in hand, marks where it would land, and Escape cancels', async () => {
    const client = renderBoard();
    await page();
    // Over the top half of SHOP-23: the line goes above it, and the cell is outlined.
    const letGo = pointerDrag(linkOf('SHOP-19'), cardOf('SHOP-23'), { y: -1, up: false });
    expect(
      screen.getByText('Moving SHOP-19: drop it on a place in a column. Escape cancels.'),
    ).toBeInTheDocument();
    expect(cardOf('SHOP-19')).toHaveClass('is-dragging');
    expect(doing()).toHaveClass('is-drop-target');
    expect(cardOf('SHOP-23')).toHaveClass('is-drop-before');
    // A label with the card's key and title follows the pointer, hidden from screen readers.
    const ghost = document.querySelector('.drag-ghost');
    expect(ghost).toHaveTextContent('SHOP-19 Refunds show the wrong currency');
    expect(ghost).toHaveAttribute('aria-hidden', 'true');
    expect(document.body).toHaveClass('is-pointer-dragging');
    // Escape goes no further than the drag: a dialog around the board would stay open.
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    document.removeEventListener('keydown', outside);
    expect(outside).not.toHaveBeenCalled();
    letGo();
    expect(screen.getByText('SHOP-19 stays where it was.')).toBeInTheDocument();
    expect(cardOf('SHOP-19')).not.toHaveClass('is-dragging');
    expect(doing()).not.toHaveClass('is-drop-target');
    expect(document.querySelector('.drag-ghost')).toBeNull();
    expect(client.moves).toEqual([]);
  });

  it('[AGL-002] a mouse let go where the page cannot hear it moves nothing, and the next press drags', async () => {
    const client = renderBoard();
    await page();
    const letGo = pointerDrag(linkOf('SHOP-19'), doing(), { up: false });
    expect(cardOf('SHOP-19')).toHaveClass('is-dragging');
    // Back on the page with no button held, then an ordinary click over another column.
    fireEvent.pointerMove(window, {
      pointerId: 5,
      pointerType: 'mouse',
      buttons: 0,
      clientX: 80,
      clientY: 10,
    });
    expect(screen.getByText('SHOP-19 stays where it was.')).toBeInTheDocument();
    expect(cardOf('SHOP-19')).not.toHaveClass('is-dragging');
    expect(doing()).not.toHaveClass('is-drop-target');
    expect(document.querySelector('.drag-ghost')).toBeNull();
    letGo();
    expect(client.moves).toEqual([]);
    pointerDrag(linkOf('SHOP-19'), doing());
    await waitFor(() => expect(client.moves).toHaveLength(1));
  });

  it('[AGL-002] a finger drags a card by its grip, not by the card; a tap opens the Move menu', async () => {
    // On a phone, where a finger is the pointer.
    setViewportWidth(375);
    const user = userEvent.setup();
    const client = renderBoard();
    await page();
    // A finger on the card scrolls the board: nothing moves.
    pointerDrag(linkOf('SHOP-19'), doing(), { pointerType: 'touch' });
    expect(client.moves).toEqual([]);
    expect(cardOf('SHOP-19')).not.toHaveClass('is-dragging');
    // On the grip, it drags: to the end of Doing.
    const grip = screen.getByRole('button', { name: 'Move SHOP-19' });
    expect(grip).toHaveAttribute('data-card-grip');
    pointerDrag(grip, doing(), { pointerType: 'touch' });
    await waitFor(() =>
      expect(keysIn('Doing in Everything else')).toEqual(['SHOP-23', 'SHOP-24', 'SHOP-19']),
    );
    expect(client.moves).toEqual([{ ticket: 119, columnId: 'doing', after: 124 }]);
    expect(screen.queryByRole('dialog')).toBeNull();
    // A press without moving is the grip's own: its Move menu opens, as before.
    await user.click(screen.getByRole('button', { name: 'Move SHOP-21' }));
    expect(
      within(cardOf('SHOP-21')).getByRole('button', { name: 'Forward to Doing' }),
    ).toBeVisible();
  });

  it('[AGL-002] a card that leaves the board under the drag asks nothing of the server', async () => {
    const client = fakeBoardClient();
    const read = client.data;
    renderBoard(client);
    await page();
    // A read is on its way when the drag begins, and it comes back without the card.
    let answer: () => void = () => {};
    const answered = new Promise<void>((done) => {
      answer = done;
    });
    client.data = async (...args) => {
      const data = await read(...args);
      await answered;
      return { ...data, cards: data.cards.filter((card) => card.id !== 119) };
    };
    act(() => announceTicketChange());
    const letGo = pointerDrag(linkOf('SHOP-19'), doing(), { up: false });
    expect(cardOf('SHOP-19')).toHaveClass('is-dragging');
    await act(async () => answer());
    await waitFor(() => expect(screen.queryByRole('link', { name: /^SHOP-19 / })).toBeNull());
    expect(document.querySelector('.drag-ghost')).toBeNull();
    letGo();
    expect(client.moves).toEqual([]);
    expect(screen.getByText('SHOP-19 stays where it was.')).toBeInTheDocument();
    expect(document.body).not.toHaveClass('is-pointer-dragging');
  });

  it('[AGL-002] a mouse drags by the grip too, but not with another button', async () => {
    const client = renderBoard();
    await page();
    pointerDrag(screen.getByRole('button', { name: 'Move SHOP-19' }), doing(), { button: 2 });
    expect(client.moves).toEqual([]);
    pointerDrag(screen.getByRole('button', { name: 'Move SHOP-19' }), doing());
    await waitFor(() => expect(client.moves).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Forward to Doing' })).toBeNull();
  });
});

describe('completing a sprint from the board (T-106)', () => {
  const sprint = (id: number, name: string, state: Sprint['state']): Sprint => ({
    id,
    boardId: 7,
    name,
    goal: '',
    state,
    sequence: id,
    startAt: null,
    endAt: null,
    startedAt: null,
    completedAt: null,
    version: 1,
  });
  /** The board's sprints as the server lists them; a completed one closes, as there. */
  function fakeSprints(
    list: Sprint[],
    options: { mayManage?: boolean; refusal?: () => Error } = {},
  ) {
    let sprints = list;
    const completions: [number, CompleteTarget][] = [];
    return {
      completions,
      boardSprints: async () => ({ sprints, mayManage: options.mayManage ?? true }),
      complete: async (id: number, to: CompleteTarget) => {
        completions.push([id, to]);
        if (options.refusal) throw options.refusal();
        sprints = sprints.map((s) => (s.id === id ? { ...s, state: 'closed' as const } : s));
      },
    };
  }
  const ACTIVE = sprint(11, 'Checkout Sprint 1', 'active');
  const PLANNED = sprint(12, 'Checkout Sprint 2', 'future');
  // Eight cards, two in each status: New and Active open, In Review and Closed in the rightmost column.
  const scrumBoard = () => fakeBoardClient({ board: SCRUM_BOARD, cards: manyCards(8) });
  function open(
    client = scrumBoard(),
    sprints = fakeSprints([sprint(10, 'Old', 'closed'), ACTIVE, PLANNED]),
  ) {
    render(
      <I18nProvider locale="en">
        <TrackSectionsContext.Provider value={{ backlog: true, sprints: true }}>
          <BoardPage boardId={7} client={client} sprints={sprints} />
        </TrackSectionsContext.Provider>
      </I18nProvider>,
    );
    return { client, sprints };
  }

  it('[AGL-010] counts the sprint’s done tickets in the rightmost column and the rest as open', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await (await page()).findByRole('button', { name: 'Complete sprint' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Complete Checkout Sprint 1?' }));
    expect(dialog.getByText('4 tickets are done and 4 are open.')).toBeVisible();
    expect(
      within(dialog.getByRole('combobox', { name: 'Open tickets go to' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Backlog', 'Checkout Sprint 2', 'A new sprint']);
  });

  it('[AGL-010] counts a status no column takes as open, as the server carries it over', () => {
    const columns = SCRUM_BOARD.columns.map((c, i) => ({
      ...c,
      count: i + 1,
      shown: i + 1,
      wip: null,
    }));
    expect(sprintCounts({ columns, unmapped: { count: 2, statuses: [] } })).toEqual({
      done: 3,
      open: 5,
    });
  });

  it('[AGL-010] Escape cancels, nothing completes, and focus returns to the button', async () => {
    const user = userEvent.setup();
    const { sprints } = open();
    const button = await (await page()).findByRole('button', { name: 'Complete sprint' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button).toHaveFocus();
    expect(sprints.completions).toEqual([]);
  });

  it('[AGL-010] completes into a planned sprint and shows the next state without a reload', async () => {
    const user = userEvent.setup();
    const { client, sprints } = open();
    const board = await page();
    await user.click(await board.findByRole('button', { name: 'Complete sprint' }));
    const reads = client.dataCalls.length;
    const dialog = within(screen.getByRole('dialog'));
    await user.selectOptions(dialog.getByRole('combobox'), 'Checkout Sprint 2');
    await user.click(dialog.getByRole('button', { name: 'Complete sprint' }));
    expect(sprints.completions).toEqual([[11, { type: 'sprint', sprintId: 12 }]]);
    await waitFor(() =>
      expect(board.queryByRole('button', { name: 'Complete sprint' })).toBeNull(),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.dataCalls.length).toBeGreaterThan(reads);
    // No Backlog pill on a track's board (D7): focus goes to the columns.
    expect(screen.getByRole('region', { name: 'Columns' })).toHaveFocus();
    expect(screen.getByText('Checkout Sprint 1 completed.')).toBeInTheDocument();
  });

  it('[AGL-010] shows a refusal in plain words and keeps the pop-up open', async () => {
    const user = userEvent.setup();
    open(
      scrumBoard(),
      fakeSprints([ACTIVE], {
        refusal: () => new ApiError(409, { error: 'sprint_not_active' }),
      }),
    );
    await user.click(await (await page()).findByRole('button', { name: 'Complete sprint' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Complete sprint' }),
    );
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
      'This sprint is no longer active: someone may have completed it already.',
    );
  });

  it('[AGL-010] is not offered to someone who may not manage the sprints', async () => {
    open(scrumBoard(), fakeSprints([ACTIVE], { mayManage: false }));
    const board = await page();
    expect(await board.findByRole('link', { name: 'Board settings' })).toBeVisible();
    expect(board.queryByRole('button', { name: /^Complete/ })).toBeNull();
  });

  it('[AGL-010] is not offered without an active sprint, nor on a Kanban board', async () => {
    open(scrumBoard(), fakeSprints([PLANNED]));
    expect((await page()).queryByRole('button', { name: /^Complete/ })).toBeNull();
    cleanup();
    const kanban = fakeSprints([ACTIVE]);
    const asked = vi.spyOn(kanban, 'boardSprints');
    open(fakeBoardClient({ cards: manyCards(8) }), kanban);
    expect((await page()).queryByRole('button', { name: /^Complete/ })).toBeNull();
    expect(asked).not.toHaveBeenCalled();
  });

  it('[AGL-011] with two active sprints, offers each and counts each one alone', async () => {
    const user = userEvent.setup();
    const client = scrumBoard();
    const data = vi.spyOn(client, 'data');
    open(client, fakeSprints([ACTIVE, sprint(13, 'Mobile Sprint 1', 'active'), PLANNED]));
    const board = await page();
    await user.click(await board.findByRole('button', { name: 'Complete Mobile Sprint 1' }));
    expect(board.getByRole('button', { name: 'Complete Checkout Sprint 1' })).toBeVisible();
    expect(data).toHaveBeenLastCalledWith(7, [], [13]);
    expect(
      await screen.findByRole('dialog', { name: 'Complete Mobile Sprint 1?' }),
    ).toHaveTextContent('4 tickets are done and 4 are open.');
  });
});
