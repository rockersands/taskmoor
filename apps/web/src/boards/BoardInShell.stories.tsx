import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { NAV_ITEMS } from '../App';
import { AppShell } from '../shell/AppShell';
import { BoardPage } from './BoardPage';
import { fakeBoardClient, longColumn, ONE_LANE } from './fixtures';

/**
 * A board inside the app's shell, whose top bar stays over the top of the page as it scrolls
 * (T-193; AGL-013, WCAG 2.4.11): a card that Up, Home, End or a keyboard move brings into view
 * stops whole below the bar, never under it.
 */
const meta = {
  title: 'Boards/BoardInShell',
  component: BoardPage,
  args: { boardId: 7, client: fakeBoardClient() },
  decorators: [
    (Story) => (
      <AppShell items={NAV_ITEMS} activeId="tracks">
        <Story />
      </AppShell>
    ),
  ],
} satisfies Meta<typeof BoardPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Where the top bar ends on the screen. */
const barBottom = () =>
  (document.querySelector('.shell-topbar') as HTMLElement).getBoundingClientRect().bottom;

const cardLink = (n: number) =>
  document.querySelector<HTMLElement>(`.board-card-link[title^="SHOP-${n} "]`);

const nextFrame = () => new Promise((done) => requestAnimationFrame(() => done(null)));

/** The column a card is in, when it scrolls inside itself (a phone's, under the third sweep). */
const ownScroller = (card: Element) => {
  const column = card.closest<HTMLElement>('.board-cell');
  return column && column.scrollHeight > column.clientHeight ? column : null;
};

/** Where cards can be seen: below the top bar and on the screen, inside a column that scrolls. */
function seen(card: Element) {
  const column = ownScroller(card)?.getBoundingClientRect();
  return {
    top: Math.max(barBottom(), column?.top ?? Number.NEGATIVE_INFINITY),
    bottom: Math.min(window.innerHeight, column?.bottom ?? Number.POSITIVE_INFINITY),
  };
}

/** The card is on the screen whole, below the top bar (and inside its column's window). */
async function clearOfBar(n: number) {
  const li = (cardLink(n) as HTMLElement).closest('li');
  const card = li?.getBoundingClientRect();
  if (!li || !card) throw new Error(`SHOP-${n} is not on the page`);
  const room = seen(li);
  await expect(card.top).toBeGreaterThanOrEqual(room.top - 0.5);
  await expect(card.bottom).toBeLessThanOrEqual(room.bottom + 0.5);
}

/**
 * Scrolls the page (or, on a phone, the column, its top brought up to the bar first) until card
 * `n` is drawn, then until its top is level with the bottom of the top bar or the column's top,
 * or the share `hidden` of it is beyond that edge, and focuses it there.
 */
async function atTheTop(n: number, hidden = 0) {
  const first = document.querySelector('.board-card');
  const column = first ? ownScroller(first) : null;
  if (column) {
    window.scrollBy(0, column.getBoundingClientRect().top - barBottom());
    await nextFrame();
  }
  const scroller = column ?? window;
  for (let tries = 0; tries < 100 && !cardLink(n); tries += 1) {
    const onScreen = [...document.querySelectorAll<HTMLElement>('.board-card')]
      .filter((li) => {
        const box = li.getBoundingClientRect();
        return box.bottom > 0 && box.top < window.innerHeight;
      })
      .map((li) => Number(li.getAttribute('aria-posinset')));
    const down = onScreen.length === 0 || n > Math.max(...onScreen);
    scroller.scrollBy(0, ((down ? 1 : -1) * window.innerHeight) / 2);
    await nextFrame();
    await nextFrame();
  }
  const link = cardLink(n) as HTMLElement;
  const card = link.closest('li') as HTMLElement;
  const under = card.offsetHeight * hidden;
  const edge = () => seen(card).top;
  scroller.scrollBy(0, card.getBoundingClientRect().top - edge() + under);
  await waitFor(() =>
    expect(Math.abs(card.getBoundingClientRect().top - edge() + under)).toBeLessThan(2),
  );
  link.focus({ preventScroll: true });
  await expect(link).toHaveFocus();
}

const play: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await canvas.findByRole('list', { name: 'To do' });
  // The bar stays at the top of the screen while the page scrolls beneath it.
  window.scrollTo(0, 600);
  await nextFrame();
  await expect(barBottom()).toBeGreaterThan(0);

  // Up from the card at the top of the screen: the card above comes down below the bar.
  await atTheTop(60);
  await userEvent.keyboard('{ArrowUp}');
  await expect(cardLink(59)).toHaveFocus();
  await clearOfBar(59);

  // Home from far down the column.
  await atTheTop(120);
  await userEvent.keyboard('{Home}');
  await expect(cardLink(1)).toHaveFocus();
  await clearOfBar(1);

  // End, to the bottom of the screen.
  await userEvent.keyboard('{End}');
  await expect(cardLink(300)).toHaveFocus();
  await clearOfBar(300);

  // A card half under the bar, moved up a place: it lands where it can be seen.
  await atTheTop(80, 0.5);
  await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
  await waitFor(() => expect(cardLink(80)?.closest('li')).toHaveAttribute('aria-posinset', '79'));
  await waitFor(() => expect(cardLink(80)).toHaveFocus());
  await clearOfBar(80);

  // Focus moving into the bar itself leaves the page where it is.
  window.scrollTo(0, 900);
  await nextFrame();
  const before = window.scrollY;
  const inBar = document.querySelector<HTMLElement>(
    '.shell-topbar a, .shell-topbar button, .shell-topbar input',
  );
  if (!inBar) throw new Error('no control in the top bar');
  inBar.focus();
  await nextFrame();
  await expect(window.scrollY).toBe(before);
  window.scrollTo(0, 0);
};

/** A desktop: the bar spans the page above the sidebar. */
export const KeyboardBelowTheBar: Story = {
  args: { client: fakeBoardClient({ cards: longColumn(300), lanes: ONE_LANE }) },
  play,
};

/**
 * A phone: the bar holds the menu button, and the long column scrolls inside itself; the same
 * cards stop below the bar, inside the column's window.
 */
export const KeyboardBelowTheBarOnAPhone: Story = {
  args: { client: fakeBoardClient({ cards: longColumn(300), lanes: ONE_LANE }) },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async (context) => {
    const todo = await within(context.canvasElement).findByRole('list', { name: 'To do' });
    await waitFor(() => expect(ownScroller(todo.querySelector('li') as Element)).toBe(todo));
    await play?.(context);
  },
};
