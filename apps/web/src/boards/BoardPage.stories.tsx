import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { expectWithinBudget } from '../test/budget';
import { BoardPage } from './BoardPage';
import { CARDS, fakeBoardClient, manyCards } from './fixtures';

const meta = {
  title: 'Boards/BoardPage',
  component: BoardPage,
  args: { boardId: 7, client: fakeBoardClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof BoardPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three columns, an Expedite lane above the catch-all; Doing is over its maximum of 2. */
export const Board: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Checkout team' })).toBeVisible();
    await expect(canvas.getByText('Over the maximum')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: /^Expedite/ })).toBeVisible();
  },
};

/** "Only my tickets" on: cards narrow, counts stay whole. */
export const FilterOn: Story = {
  args: { client: fakeBoardClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Only my tickets' }));
    await expect(await canvas.findByText('2 hidden by board filters')).toBeVisible();
  },
};

/** The person filter: "Me" and a person from the menu; any of them shows (AGL-005 (3)). */
export const PersonFilter: Story = {
  args: { client: fakeBoardClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Me' }));
    await expect(await canvas.findByRole('link', { name: /SHOP-21/ })).toBeVisible();
    await userEvent.click(canvas.getByText('People'));
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Rin Okafor' }));
    await expect(await canvas.findByRole('link', { name: /SHOP-23/ })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: /SHOP-19/ })).toBeNull();
  },
};

/** Nobody's cards: the board says so and offers to clear the filter. */
export const PersonFilterEmpty: Story = {
  args: {
    client: fakeBoardClient({ cards: CARDS.filter((c) => !c.mine) }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Me' }));
    await expect(await canvas.findByText('No cards for these people')).toBeVisible();
  },
};

/** A move into the last column, where two transitions lead: the board asks which. */
export const ChooseTransition: Story = {
  args: { client: fakeBoardClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Move SHOP-23' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Forward to Review and done' }));
    await expect(
      await canvas.findByRole('dialog', { name: 'Move SHOP-23 to Review and done' }),
    ).toBeVisible();
  },
};

/** Without lanes: one row of columns. */
export const NoLanes: Story = {
  args: {
    client: fakeBoardClient({
      lanes: [{ id: 'all', name: '', catchAll: true }],
      cards: CARDS.map((c) => ({ ...c, laneId: 'all' })),
    }),
  },
};

export const Empty: Story = {
  args: { client: fakeBoardClient({ cards: [] }) },
};

/**
 * The 5,000-card board, watched on the page from the moment its data arrives (the story's play
 * function starts only once the page is drawn, too late to press anything): the first move
 * button is pressed as soon as it exists, and the board is interactive when its menu opens.
 */
const watch = { arrival: 0, menu: 0, cardsAtMenu: 0, all: 0 };
function watchBoard() {
  watch.arrival = performance.now();
  const check = () => {
    const cards = document.querySelectorAll('.board-card').length;
    if (!watch.menu && document.querySelector('.board-move-menu')) {
      watch.menu = performance.now() - watch.arrival;
      watch.cardsAtMenu = cards;
    }
    const button = document.querySelector<HTMLButtonElement>('.board-card-move');
    if (!watch.menu && button && button.getAttribute('aria-expanded') !== 'true') button.click();
    if (cards === 5000) {
      watch.all = performance.now() - watch.arrival;
      observer.disconnect();
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * 5,000 cards (M1-046; 05b: under 1 s to interactive): from the data's arrival until a card's
 * move menu opens, then every card on the page. A cell's first cards are drawn at once and the
 * rest in a transition that yields to input. Timing only: the same board passes axe in the
 * stories above, and axe over 5,000 cards measures axe.
 */
export const FiveThousandCards: Story = {
  args: {
    client: (() => {
      const inner = fakeBoardClient({ cards: manyCards(5000) });
      return {
        ...inner,
        data: async (...args: Parameters<typeof inner.data>) => {
          const data = await inner.data(...args);
          watchBoard();
          return data;
        },
      };
    })(),
  },
  parameters: { a11y: { test: 'off' } },
  play: async () => {
    await waitFor(() => expect(watch.all).toBeGreaterThan(0), { timeout: 15_000, interval: 50 });
    expect(watch.menu).toBeGreaterThan(0);
    // The menu opened before every card was drawn: the rest did not hold the page.
    expect(watch.cardsAtMenu).toBeLessThan(5000);
    await expectWithinBudget(watch.menu, 1000, '5,000-card board interactive (ms)');
    await expectWithinBudget(watch.all, 4000, 'all 5,000 cards on the page (ms)');
  },
};
