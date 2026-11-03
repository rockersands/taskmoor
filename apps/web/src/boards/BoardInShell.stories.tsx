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

/** The card is on the screen whole, below the top bar. */
async function clearOfBar(n: number) {
  const card = (cardLink(n) as HTMLElement).closest('li')?.getBoundingClientRect();
  if (!card) throw new Error(`SHOP-${n} is not on the page`);
  await expect(card.top).toBeGreaterThanOrEqual(barBottom());
  await expect(card.bottom).toBeLessThanOrEqual(window.innerHeight);
}

/**
 * Scrolls the page until card `n` is drawn, then until its top is level with the bottom of the
 * top bar, or the share `hidden` of it is under the bar, and focuses it there.
 */
async function atTheTop(n: number, hidden = 0) {
  for (let tries = 0; tries < 100 && !cardLink(n); tries += 1) {
    const onScreen = [...document.querySelectorAll<HTMLElement>('.board-card')]
      .filter((li) => {
        const box = li.getBoundingClientRect();
        return box.bottom > 0 && box.top < window.innerHeight;
      })
      .map((li) => Number(li.getAttribute('aria-posinset')));
    const down = onScreen.length === 0 || n > Math.max(...onScreen);
    window.scrollBy(0, ((down ? 1 : -1) * window.innerHeight) / 2);
    await nextFrame();
    await nextFrame();
  }
  const link = cardLink(n) as HTMLElement;
  const card = link.closest('li') as HTMLElement;
  const under = card.offsetHeight * hidden;
  window.scrollBy(0, card.getBoundingClientRect().top - barBottom() + under);
  await waitFor(() =>
    expect(Math.abs(card.getBoundingClientRect().top - barBottom() + under)).toBeLessThan(2),
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
  window.scrollTo(0, 0);
};

/** A desktop: the bar spans the page above the sidebar. */
export const KeyboardBelowTheBar: Story = {
  args: { client: fakeBoardClient({ cards: longColumn(300), lanes: ONE_LANE }) },
  play,
};

/** A phone: the bar holds the menu button; the same cards stop below it. */
export const KeyboardBelowTheBarOnAPhone: Story = {
  args: { client: fakeBoardClient({ cards: longColumn(300), lanes: ONE_LANE }) },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play,
};
