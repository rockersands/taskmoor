import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { WINDOW_FROM } from './BoardCell';
import { BoardPage, shareCards } from './BoardPage';
import type { BoardCard } from './client';
import { CARDS, fakeBoardClient, longColumn, ONE_LANE } from './fixtures';

// Every card draws its type's icon once: counting the icon counts the cards drawn.
const drawnCards = vi.hoisted(() => ({ count: 0 }));
vi.mock('../shell/TicketIcons', async (original) => {
  const icons = await original<typeof import('../shell/TicketIcons')>();
  return {
    ...icons,
    TypeIcon: (props: Parameters<typeof icons.TypeIcon>[0]) => {
      drawnCards.count += 1;
      return icons.TypeIcon(props);
    },
  };
});

function renderBoard(client = fakeBoardClient()) {
  render(
    <I18nProvider locale="en">
      <BoardPage boardId={7} client={client} />
    </I18nProvider>,
  );
  return client;
}
const longBoard = (n: number, inDoing = 0) =>
  renderBoard(fakeBoardClient({ cards: longColumn(n, inDoing), lanes: ONE_LANE }));
const cell = (name: string) => screen.getByRole('list', { name });
const linkOf = (key: string) => screen.getByRole('link', { name: new RegExp(`^${key} `) });
const itemOf = (key: string) => linkOf(key).closest('li') as HTMLElement;

// jsdom has no layout: every box is empty, the screen 768 px tall, and nothing scrolls.
const scrolled = vi.fn();
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: scrolled,
    configurable: true,
  });
  if (!('DragEvent' in window)) {
    Object.defineProperty(window, 'DragEvent', {
      value: class extends MouseEvent {},
      configurable: true,
    });
  }
});
afterAll(() => {
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});
beforeEach(() => {
  scrolled.mockClear();
});

describe('a long column (T-193)', () => {
  it('[AGL-013] draws the cards near the screen, each saying its place in the column', async () => {
    longBoard(2000);
    const todo = await screen.findByRole('list', { name: 'To do' });
    const items = within(todo).getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(5);
    expect(items.length).toBeLessThan(60);
    expect(items[0]).toHaveAttribute('aria-posinset', '1');
    expect(items[0]).toHaveAttribute('aria-setsize', '2000');
    expect(items.at(-1)).toHaveAttribute('aria-posinset', String(items.length));
    // The room of the cards not drawn stays below them, so the page keeps its length.
    expect(Number.parseFloat(todo.style.getPropertyValue('--cell-skip-after'))).toBeGreaterThan(
      100_000,
    );
    // The column's count is the whole column's.
    expect(screen.getByText('2,000 tickets')).toBeVisible();
  });

  it('[AGL-013] draws every card of a board up to the limit, and says their places too', async () => {
    longBoard(WINDOW_FROM);
    const items = within(await screen.findByRole('list', { name: 'To do' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(WINDOW_FROM);
    expect(items.at(-1)).toHaveAttribute('aria-posinset', String(WINDOW_FROM));
    expect(items.at(-1)).toHaveAttribute('aria-setsize', String(WINDOW_FROM));
  });

  it('[NFR-005] the arrows, Home and End reach every card, drawn, focused and brought into view', async () => {
    const user = userEvent.setup();
    longBoard(2000);
    await screen.findByRole('list', { name: 'To do' });
    expect(screen.queryByRole('link', { name: /^SHOP-2000 / })).toBeNull();
    linkOf('SHOP-1').focus();
    await user.keyboard('{End}');
    expect(linkOf('SHOP-2000')).toHaveFocus();
    expect(itemOf('SHOP-2000')).toHaveAttribute('aria-posinset', '2000');
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest' });
    expect(scrolled.mock.contexts.at(-1)).toBe(itemOf('SHOP-2000'));
    await user.keyboard('{ArrowUp}');
    expect(linkOf('SHOP-1999')).toHaveFocus();
    // Up and Down at either end stay where they are.
    await user.keyboard('{End}{ArrowDown}');
    expect(linkOf('SHOP-2000')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(linkOf('SHOP-1')).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(linkOf('SHOP-3')).toHaveFocus();
    // The card reached is drawn where it belongs, with the room of the cards between.
    await user.keyboard('{End}');
    expect(linkOf('SHOP-1')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^SHOP-1000 / })).toBeNull();
    expect(Number.parseFloat(itemOf('SHOP-2000').style.marginBlockStart)).toBeGreaterThan(100_000);
  });

  it('[NFR-005] puts one card per column in the tab order, the one last reached', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole('list', { name: 'To do in Everything else' });
    const tabbable = (key: string) =>
      [linkOf(key), ...within(itemOf(key)).getAllByRole('button')].map(
        (el) => el.getAttribute('tabindex') !== '-1',
      );
    expect(tabbable('SHOP-19')).toEqual([true, true, true]);
    expect(tabbable('SHOP-21')).toEqual([false, false, false]);
    linkOf('SHOP-19').focus();
    await user.keyboard('{ArrowDown}');
    expect(linkOf('SHOP-21')).toHaveFocus();
    expect(tabbable('SHOP-21')).toEqual([true, true, true]);
    expect(tabbable('SHOP-19')).toEqual([false, false, false]);
    // Tab goes on to the card's own buttons, then to the next column's card.
    await user.tab();
    expect(screen.getByRole('button', { name: 'Edit the title of SHOP-21' })).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(linkOf('SHOP-23')).toHaveFocus();
  });

  it('[AGL-002] a card moved with the keyboard keeps the focus where it lands, far down a column', async () => {
    const user = userEvent.setup();
    const client = longBoard(1000, 999);
    await screen.findByRole('list', { name: 'Doing' });
    linkOf('SHOP-1000').focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await waitFor(() => expect(linkOf('SHOP-1000')).toHaveFocus());
    expect(client.moves).toEqual([{ ticket: 1100, columnId: 'doing' }]);
    expect(cell('Doing')).toContainElement(linkOf('SHOP-1000'));
    expect(itemOf('SHOP-1000')).toHaveAttribute('aria-posinset', '1000');
    expect(itemOf('SHOP-1000')).toHaveAttribute('aria-setsize', '1000');
    expect(scrolled.mock.contexts.at(-1)).toBe(itemOf('SHOP-1000'));
    expect(screen.getByText('SHOP-1000 moved to Doing.')).toBeInTheDocument();
  });

  it('[AGL-013] a drop draws again only the cards that changed, not the whole board', async () => {
    const client = longBoard(2000, 1000);
    await screen.findByRole('list', { name: 'Doing' });
    const drawn = document.querySelectorAll('.board-card').length;
    expect(drawn).toBeLessThan(100);
    const transfer = { setData: () => {}, getData: () => '', effectAllowed: '', dropEffect: '' };
    drawnCards.count = 0;
    fireEvent.dragStart(itemOf('SHOP-1001'), { dataTransfer: transfer });
    fireEvent.dragOver(cell('Doing'), { dataTransfer: transfer, clientY: 10 });
    fireEvent.drop(cell('Doing'), { dataTransfer: transfer });
    await waitFor(() => expect(linkOf('SHOP-1001')).toHaveFocus());
    expect(client.moves).toEqual([{ ticket: 1101, columnId: 'doing', after: 1100 }]);
    expect(itemOf('SHOP-1001')).toHaveAttribute('aria-posinset', '1001');
    // The cards that moved up a place in To do and those of Doing, which now holds one more:
    // a few dozen of the two thousand.
    expect(drawnCards.count).toBeGreaterThan(0);
    expect(drawnCards.count).toBeLessThan(2 * drawn);
    // Dragging over the board draws no card again, only the one in hand.
    await act(async () => {});
    drawnCards.count = 0;
    fireEvent.dragStart(itemOf('SHOP-1002'), { dataTransfer: transfer });
    fireEvent.dragOver(cell('Doing'), { dataTransfer: transfer, clientY: 10 });
    fireEvent.dragOver(cell('To do'), { dataTransfer: transfer, clientY: 10 });
    expect(drawnCards.count).toBe(1);
    fireEvent.dragEnd(itemOf('SHOP-1002'));
  });

  it('[AGL-013] opens the Move menu of a card in a long column in full', async () => {
    const user = userEvent.setup();
    longBoard(2000, 1000);
    await screen.findByRole('list', { name: 'Doing' });
    await user.click(screen.getByRole('button', { name: 'Move SHOP-3' }));
    const menu = within(itemOf('SHOP-3'));
    expect(menu.getByRole('button', { name: 'Forward to Review and done' })).toBeVisible();
    expect(menu.getByRole('button', { name: 'Up in Doing' })).toBeVisible();
    expect(menu.getByRole('button', { name: 'Down in Doing' })).toBeVisible();
  });

  it('[AGL-013] fits a phone, its long column scrolling with the page', async () => {
    setViewportWidth(375);
    longBoard(500);
    const todo = await screen.findByRole('list', { name: 'To do' });
    expect(within(todo).getAllByRole('listitem').length).toBeLessThan(60);
    expect(screen.getByRole('region', { name: 'Columns' })).toHaveClass('board-scroll');
    setViewportWidth(1440);
  });
});

describe('sharing unchanged cards between reads (T-193)', () => {
  it('[AGL-013] keeps each card that did not change as the object already drawn', () => {
    const before = CARDS.map((c) => ({ ...c })) as BoardCard[];
    const read = JSON.parse(JSON.stringify(before)) as BoardCard[];
    (read[1] as BoardCard).summary = 'Changed elsewhere';
    const shared = shareCards(before, read);
    expect(shared[0]).toBe(before[0]);
    expect(shared[1]).toBe(read[1]);
    expect(shared[2]).toBe(before[2]);
    expect(shared).toEqual(read);
    expect(shareCards(undefined, read)).toBe(read);
  });
});
