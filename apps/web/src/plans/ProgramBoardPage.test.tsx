import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { SIGNED_IN } from '../account/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { SyncEngine } from '../sync/engine';
import { SyncProvider } from '../sync/SyncProvider';
import { memoryStore } from '../sync/store';
import { setViewportWidth } from '../test/viewport';
import { announceTicketChange } from '../tickets/view/ticketChanges';
import { ProgramBoardPage } from './ProgramBoardPage';
import { ProgramBoardsPage } from './ProgramBoardsPage';
import { type CardMoved, cardChange, type ProgramBoard } from './programBoardClient';
import { boardFixture, type FakeBoardOptions, fakeBoardClient } from './programBoardFixtures';

/**
 * A plan's program board (T-089d; PLN-008; ADR-122 stage 5), with the fixture board "Spring PI":
 * weekly periods from Monday 2 November 2026, Web and Ops, and today Wednesday 4 November.
 */
function renderBoard(
  options: FakeBoardOptions = {},
  wrap = (node: React.ReactNode) => node,
  view?: React.ComponentProps<typeof ProgramBoardPage>['view'],
) {
  const client = fakeBoardClient(options);
  render(
    wrap(
      <I18nProvider locale="en">
        <ProgramBoardPage
          planId={12}
          boardId={5}
          filters={{}}
          client={client}
          now={() => new Date('2026-11-04T09:00:00Z')}
          {...(view ? { view } : {})}
        />
      </I18nProvider>,
    ),
  );
  return client;
}

/** A local copy whose first pull brings one change made by someone else. */
function engineWithOneChange() {
  let served = false;
  return new SyncEngine({
    store: memoryStore(),
    api: {
      groups: async () => ({ position: '1', tracks: [] }),
      bootstrap: async () => ({ position: '1', tickets: [], next: null }),
      changes: async (after) => {
        if (served) return { changes: [], position: after, resync: false };
        served = true;
        return {
          changes: [{ seq: '2', entity: 'ticket', id: 102, trackId: 1, op: 'delete' }],
          position: '2',
          resync: false,
        };
      },
      send: async () => ({ status: 200, body: {} }),
    },
  });
}
const withEngine = (engine: SyncEngine) => (node: React.ReactNode) => (
  <SessionProvider session={SIGNED_IN}>
    <SyncProvider create={async () => engine}>{node}</SyncProvider>
  </SessionProvider>
);

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The fixture board without SHOP-2: moved by someone else out of this board. */
function withoutShop2(): ProgramBoard {
  const board = boardFixture();
  const take = (cell: { count: number; cards: number[] }) =>
    cell.cards.includes(102)
      ? { count: cell.count - 1, cards: cell.cards.filter((id) => id !== 102) }
      : cell;
  return {
    ...board,
    rows: board.rows.map((r) => ({
      ...r,
      unscheduled: take(r.unscheduled),
      cells: r.cells.map(take),
    })),
    cards: board.cards.filter((c) => c.id !== 102),
  };
}

const cardIn = (cell: HTMLElement, key: string) =>
  within(cell)
    .queryAllByRole('listitem')
    .find((li) => li.getAttribute('data-card') === key);

const searched = (link: HTMLElement) =>
  new URLSearchParams((link.getAttribute('href') ?? '').split('?')[1]).get('q');

afterEach(() => setViewportWidth(1280));

describe('a program board (PLN-008)', () => {
  it('[PLN-008] shows teams by period, outcomes first, closed work in words and the rest of a cell as its search', async () => {
    renderBoard();
    const table = await screen.findByRole('table', { name: 'Spring PI' });
    const heads = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(heads).toEqual([
      'Team',
      'Not scheduled',
      'Nov 2 – Nov 8 · Now',
      'Nov 9 – Nov 15',
      'Nov 16 – Nov 22',
    ]);
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((h) => h.textContent),
    ).toEqual(['Web', 'Ops', 'Other or no team']);
    const cell = within(table).getByRole('cell', { name: 'Web, Nov 2 – Nov 8, 5 cards' });
    const keys = within(cell)
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('data-card'));
    expect(keys).toEqual(['SHOP-1', 'SHOP-2']);
    const more = within(cell).getByRole('link', { name: 'and 3 more' });
    expect(searched(more)).toBe(
      '(track IN ("SHOP", "OPS")) AND hierarchyLevel IN (0, 1) AND cf[40] = 3 AND due >= "2026-11-02" AND due <= "2026-11-08"',
    );
    // A card of a team the plan does not plan with says which; closed work says so and stays put.
    const other = within(table).getByRole('cell', { name: /^Other or no team, Not scheduled/ });
    expect(other).toHaveTextContent('Team: Data');
    // OPS-9's status is "Done", of the closed stage: the card says "Closed" beside it.
    const closed = within(table).getByRole('cell', { name: /^Ops, Nov 16 – Nov 22/ });
    expect(closed).toHaveTextContent('Feature · Done · Closed');
    expect(within(closed).queryByRole('button', { name: /Move/ })).toBeNull();
  });

  it('[PLN-008] moves a card with its Move dialog: the Team value and the days, with the version read', async () => {
    const user = userEvent.setup();
    const client = renderBoard();
    await user.click(await screen.findByRole('button', { name: 'Move SHOP-2…' }));
    const dialog = screen.getByRole('dialog', { name: 'Move SHOP-2' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Team' }), 'Ops');
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Period' }),
      'Nov 9 – Nov 15',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(client.moves).toEqual([
      { key: 'SHOP-2', change: { version: 3, fields: { '40': 4 }, dueDate: '2026-11-12' } },
    ]);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'SHOP-2 moved to Ops, Nov 9 – Nov 15.',
    );
    // The board reads again after its own move.
    await waitFor(() => expect(client.reads()).toBe(2));
  });

  it('[PLN-008] says a card changed meanwhile, changes nothing more and reads the board again', async () => {
    const user = userEvent.setup();
    const client = renderBoard({ refuse: 'version_conflict' });
    await user.click(await screen.findByRole('button', { name: 'Move OPS-7…' }));
    const dialog = screen.getByRole('dialog', { name: 'Move OPS-7' });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Period' }),
      'Not scheduled',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(client.moves).toEqual([{ key: 'OPS-7', change: { version: 3, dueDate: null } }]);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'OPS-7 changed while you moved it, perhaps moved by someone else.',
    );
    await waitFor(() => expect(client.reads()).toBe(2));
  });

  it('[PLN-008] says why the ticket route refused a move, in words', async () => {
    const user = userEvent.setup();
    renderBoard({ refuse: 'forbidden' });
    await user.click(await screen.findByRole('button', { name: 'Move SHOP-1…' }));
    const dialog = screen.getByRole('dialog', { name: 'Move SHOP-1' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Team' }), 'Ops');
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'SHOP-1 could not move: you may not change its team or its days in its track.',
    );
  });

  it('[PLN-008] reads its cards again within a moment of the local copy moving', async () => {
    const engine = engineWithOneChange();
    const client = renderBoard({}, withEngine(engine));
    await screen.findByRole('table', { name: 'Spring PI' });
    await act(async () => {});
    const before = client.reads();
    // Someone else moved a card: the log moved, and the board reads again on its own.
    await act(async () => {
      await engine.pull();
    });
    await waitFor(() => expect(client.reads()).toBe(before + 1));
    engine.stop();
  });

  it('[PLN-008] reads again once a held card is let go, for a change that came while it was held', async () => {
    const engine = engineWithOneChange();
    const client = renderBoard({}, withEngine(engine));
    const table = await screen.findByRole('table', { name: 'Spring PI' });
    await act(async () => {});
    const before = client.reads();
    const held = table.querySelector('li[data-card="SHOP-2"]') as HTMLElement;
    fireEvent.dragStart(held, { dataTransfer: { setData() {}, effectAllowed: 'all' } });
    // Someone else moves a card while this one is held: no read yet, it would undo the drag.
    await act(async () => {
      await engine.pull();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(client.reads()).toBe(before);
    // Let go without a move (Escape, or outside any cell): the change is read now.
    fireEvent.dragEnd(held);
    await waitFor(() => expect(client.reads()).toBe(before + 1));
    engine.stop();
  });

  it('[PLN-008] keeps a moved card in its new cell when a read begun before the move answers', async () => {
    const user = userEvent.setup();
    const second = deferred<ProgramBoard>();
    const answer = deferred<CardMoved>();
    const client = renderBoard({
      readWith: (n) => (n === 2 ? second.promise : undefined),
      moveWith: () => answer.promise,
    });
    await user.click(await screen.findByRole('button', { name: 'Move SHOP-2…' }));
    const dialog = screen.getByRole('dialog', { name: 'Move SHOP-2' });
    // Someone else's change starts a read; this person moves the card before it answers.
    act(() => announceTicketChange());
    expect(client.reads()).toBe(2);
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Team' }), 'Ops');
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    const ops = () => screen.getByRole('cell', { name: /^Ops, Nov 2 – Nov 8,/ });
    expect(cardIn(ops(), 'SHOP-2')).toHaveClass('is-pending');
    // The read from before the move answers: it does not put the card back.
    await act(async () => second.resolve(boardFixture()));
    expect(cardIn(ops(), 'SHOP-2')).toHaveClass('is-pending');
    expect(
      cardIn(screen.getByRole('cell', { name: /^Web, Nov 2 – Nov 8,/ }), 'SHOP-2'),
    ).toBeUndefined();
    // The move's own answer reads again.
    await act(async () => answer.resolve({ ok: true, ticket: { version: 4 } }));
    await waitFor(() => expect(client.reads()).toBe(3));
  });

  it('[PLN-008] sends a move whose card left the board meanwhile, with the version read, and says it changed', async () => {
    const user = userEvent.setup();
    const client = renderBoard({
      refuse: 'version_conflict',
      readWith: (n) => (n === 2 ? Promise.resolve(withoutShop2()) : undefined),
    });
    await user.click(await screen.findByRole('button', { name: 'Move SHOP-2…' }));
    const dialog = screen.getByRole('dialog', { name: 'Move SHOP-2' });
    // Someone else moved SHOP-2 off this board while the dialog was open.
    act(() => announceTicketChange());
    const table = screen.getByRole('table', { name: 'Spring PI' });
    await waitFor(() => expect(table.querySelector('[data-card="SHOP-2"]')).toBeNull());
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Period' }),
      'Nov 9 – Nov 15',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(client.moves).toEqual([
      { key: 'SHOP-2', change: { version: 3, dueDate: '2026-11-12' } },
    ]);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'SHOP-2 changed while you moved it',
    );
  });

  it('[PLN-008] moves a card again with the version its own move made, before the board reads again', async () => {
    const user = userEvent.setup();
    // Every read after the first is still on its way.
    const client = renderBoard({ readWith: (n) => (n > 1 ? new Promise(() => {}) : undefined) });
    const moveTo = async (period: string) => {
      await user.click(await screen.findByRole('button', { name: 'Move SHOP-2…' }));
      const dialog = screen.getByRole('dialog', { name: 'Move SHOP-2' });
      await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Period' }), period);
      await user.click(within(dialog).getByRole('button', { name: 'Move' }));
      expect(await screen.findByRole('status')).toHaveTextContent(
        `SHOP-2 moved to Web, ${period}.`,
      );
    };
    await moveTo('Nov 9 – Nov 15');
    await moveTo('Nov 16 – Nov 22');
    expect(client.moves.map((m) => m.change)).toEqual([
      { version: 3, dueDate: '2026-11-12' },
      { version: 4, dueDate: '2026-11-19' },
    ]);
  });

  it('[PLN-008] starts the Move dialog in its first field, and gives focus to the card where it lands', async () => {
    const user = userEvent.setup();
    // The read after the move is on its way: the card stays where it was put.
    renderBoard({ readWith: (n) => (n > 1 ? new Promise(() => {}) : undefined) });
    await user.click(await screen.findByRole('button', { name: 'Move SHOP-2…' }));
    const dialog = screen.getByRole('dialog', { name: 'Move SHOP-2' });
    expect(within(dialog).getByRole('combobox', { name: 'Team' })).toHaveFocus();
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Period' }),
      'Nov 9 – Nov 15',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    // Its Move button went with it while it moves: focus is on the card, not the page.
    const cell = screen.getByRole('cell', { name: /^Web, Nov 9 – Nov 15,/ });
    expect(within(cell).getByRole('link', { name: 'SHOP-2 Pay by card' })).toHaveFocus();
    // Cancel gives focus back to the Move button.
    await user.click(await screen.findByRole('button', { name: 'Move SHOP-1…' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Move SHOP-1' })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(screen.getByRole('button', { name: 'Move SHOP-1…' })).toHaveFocus();
  });

  it('[PLN-008] gives focus to a refused card where the board reads it back', async () => {
    const user = userEvent.setup();
    const client = renderBoard({ refuse: 'forbidden' });
    await user.click(await screen.findByRole('button', { name: 'Move SHOP-2…' }));
    const dialog = screen.getByRole('dialog', { name: 'Move SHOP-2' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Team' }), 'Ops');
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(client.reads()).toBe(2));
    const back = screen.getByRole('cell', { name: /^Web, Nov 2 – Nov 8,/ });
    await waitFor(() =>
      expect(within(back).getByRole('link', { name: 'SHOP-2 Pay by card' })).toHaveFocus(),
    );
  });

  it('[PLN-013] marks a dependency within one sprint in words and colour, and says a chosen type’s phrase', async () => {
    renderBoard({
      board: boardFixture({
        links: [
          { from: 103, to: 102, linkTypeId: 1, sameSprint: true },
          { from: 101, to: 102, linkTypeId: 7 },
        ],
        linkTypes: [
          { id: 1, name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
          { id: 7, name: 'Precedes', outward: 'precedes', inward: 'is preceded by' },
        ],
        sameSprint: true,
      }),
    });
    const table = await screen.findByRole('table', { name: 'Spring PI' });
    const badge = table.querySelector('[data-card="SHOP-2"] .program-card-badge') as HTMLElement;
    expect(badge).toHaveTextContent('Blocked by 3 tickets, 2 late, 1 in the same sprint');
    expect(badge).toHaveClass('is-same-sprint');
    const list = screen.getByRole('region', { name: 'Dependencies' });
    expect(list).toHaveTextContent('SHOP-1 Checkout (precedes)');
    expect(list).toHaveTextContent('Same sprint');
  });

  it('[PLN-008] carries the plan’s filters back to the list of boards', async () => {
    renderBoard({}, undefined, { filters: { assignee: 'me' }, group: null });
    expect(await screen.findByRole('link', { name: 'All program boards' })).toHaveAttribute(
      'href',
      '#/plans/12/boards?assignee=me',
    );
  });

  it('[PLN-008] [PLN-006] badges a waiting card and lists its dependencies, hidden ones only counted', async () => {
    renderBoard();
    const table = await screen.findByRole('table', { name: 'Spring PI' });
    const card = within(table)
      .getAllByRole('listitem')
      .find((li) => li.getAttribute('data-card') === 'SHOP-2') as HTMLElement;
    expect(card).toHaveTextContent('Blocked by 2 tickets, 1 late');
    const list = screen.getByRole('region', { name: 'Dependencies' });
    expect(list).toHaveTextContent('OPS-7');
    expect(list).toHaveTextContent('Late:');
    expect(list).toHaveTextContent('1 ticket outside this plan');
  });

  it('[PLN-008] on a phone shows one team at a time, each period a list, moved with its button', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderBoard();
    const picker = await screen.findByRole('combobox', { name: 'Team' });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('region', { name: 'Web, Nov 2 – Nov 8' })).toHaveTextContent('SHOP-1');
    await user.selectOptions(picker, 'Ops');
    const week = screen.getByRole('region', { name: 'Ops, Nov 9 – Nov 15' });
    expect(within(week).getByRole('button', { name: 'Move OPS-7…' })).toBeInTheDocument();
  });

  it('[PLN-008] moves nothing on an archived board', async () => {
    const client = fakeBoardClient();
    const board = await client.read(12, 5, {});
    renderBoard({ board: { ...board, board: { ...board.board, archived: true } } });
    await screen.findByRole('table', { name: 'Spring PI' });
    expect(screen.getByText(/This program board is archived/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
  });
});

describe('moving a card (PLN-008)', () => {
  const weeks = [
    { start: '2026-11-02', end: '2026-11-08' },
    { start: '2026-11-09', end: '2026-11-15' },
  ];
  const months = [
    { start: '2027-01-01', end: '2027-01-31' },
    { start: '2027-02-01', end: '2027-02-28' },
  ];
  const card = { version: 7, start: '2026-11-03', due: '2026-11-06' };

  it('[PLN-008] shifts both days by the periods’ distance, the due day kept in the new period', () => {
    expect(cardChange(card, { team: 3, column: 1 }, { team: 3, column: 2 }, weeks, 40)).toEqual({
      version: 7,
      startDate: '2026-11-10',
      dueDate: '2026-11-13',
    });
    // 31 January moved a month lands on the last day of February.
    expect(
      cardChange(
        { version: 1, start: null, due: '2027-01-31' },
        { team: null, column: 1 },
        { team: null, column: 2 },
        months,
        40,
      ),
    ).toEqual({ version: 1, dueDate: '2027-02-28' });
  });

  it('[PLN-008] gives work from Not scheduled the period’s last day, and clears it going back', () => {
    expect(
      cardChange(
        { version: 1, start: '2026-11-20', due: null },
        { team: 3, column: 0 },
        { team: 3, column: 1 },
        weeks,
        40,
      ),
    ).toEqual({ version: 1, startDate: '2026-11-02', dueDate: '2026-11-08' });
    expect(cardChange(card, { team: 3, column: 1 }, { team: 3, column: 0 }, weeks, 40)).toEqual({
      version: 7,
      dueDate: null,
    });
  });

  it('[PLN-008] sets or clears only the Team value for another row, and nothing for the same place', () => {
    expect(cardChange(card, { team: 3, column: 1 }, { team: null, column: 1 }, weeks, 40)).toEqual({
      version: 7,
      fields: { '40': null },
    });
    expect(cardChange(card, { team: 3, column: 1 }, { team: 3, column: 1 }, weeks, 40)).toBeNull();
    // Without a Team field a row change is nothing.
    expect(
      cardChange(card, { team: null, column: 1 }, { team: 4, column: 1 }, weeks, null),
    ).toBeNull();
  });
});

describe('a plan’s program boards (PLN-008)', () => {
  const renderList = (
    options: FakeBoardOptions = {},
    view?: React.ComponentProps<typeof ProgramBoardsPage>['view'],
  ) => {
    const client = fakeBoardClient(options);
    render(
      <I18nProvider locale="en">
        <ProgramBoardsPage
          planId={12}
          client={client}
          now={() => new Date('2026-11-04T09:00:00Z')}
          {...(view ? { view } : {})}
        />
      </I18nProvider>,
    );
    return client;
  };

  it('[PLN-008] lists three or more active boards, then archived ones, and its editors make one', async () => {
    const user = userEvent.setup();
    const client = renderList();
    const list = await screen.findByRole('list');
    const names = within(list)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(names).toEqual(['Spring PI', 'Summer PI', 'Autumn PI', 'Winter PI · Archived']);
    expect(within(list).getByRole('link', { name: 'Spring PI' })).toHaveAttribute(
      'href',
      '#/plans/12/boards/5',
    );
    await user.click(screen.getByRole('button', { name: 'New program board' }));
    const dialog = screen.getByRole('dialog', { name: 'New program board' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Autumn PI');
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Number of periods' }),
      '4',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(client.created).toEqual([
      { name: 'Autumn PI', teamFieldId: 40, from: '2026-11-04', periods: 4 },
    ]);
    expect(await screen.findByRole('status')).toHaveTextContent('Autumn PI is saved.');
  });

  it('[PLN-008] archives with the version read, and deletes only after saying what happens', async () => {
    const user = userEvent.setup();
    const client = renderList();
    await user.click(await screen.findByRole('button', { name: 'Archive Summer PI' }));
    expect(client.updated).toEqual([{ boardId: 6, input: { archived: true, version: 1 } }]);
    await user.click(screen.getByRole('button', { name: 'Delete Spring PI' }));
    expect(client.removed).toEqual([]);
    expect(screen.getByText(/The board Spring PI goes for everyone/)).toBeInTheDocument();
    await user.click(
      screen.getAllByRole('button', { name: 'Delete Spring PI' }).at(-1) as HTMLElement,
    );
    await waitFor(() => expect(client.removed).toEqual([5]));
  });

  it('[PLN-008] keeps a refused delete’s question open, and gives focus to the list once a board is gone', async () => {
    const user = userEvent.setup();
    const options: FakeBoardOptions = { refuseRemove: true };
    const client = renderList(options);
    await user.click(await screen.findByRole('button', { name: 'Delete Spring PI' }));
    const confirm = () => screen.getAllByRole('button', { name: 'Delete Spring PI' }).at(-1);
    await user.click(confirm() as HTMLElement);
    expect(await screen.findByRole('alert')).toHaveTextContent('That could not be saved.');
    // Refused: the question stays, to try again or cancel.
    expect(screen.getByText(/The board Spring PI goes for everyone/)).toBeInTheDocument();
    options.refuseRemove = false;
    await user.click(confirm() as HTMLElement);
    await waitFor(() => expect(client.removed).toEqual([5]));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Spring PI' })).toBeNull());
    // The row and its buttons are gone: focus is on the list's heading, and the old alert too.
    expect(screen.getByRole('heading', { name: 'Program boards' })).toHaveFocus();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Spring PI');
  });

  it('[PLN-008] carries the plan’s filters to each board', async () => {
    renderList({}, { filters: { assignee: 'me' }, group: null });
    expect(await screen.findByRole('link', { name: 'Spring PI' })).toHaveAttribute(
      'href',
      '#/plans/12/boards/5?assignee=me',
    );
  });

  it('[PLN-008] offers nothing to make without a Team field, and nothing to change to others', async () => {
    renderList({ list: { teamFields: [], editable: false } });
    expect(
      await screen.findByText(/A program board places cards by a Team field/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New program board' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Archive / })).toBeNull();
  });
});
