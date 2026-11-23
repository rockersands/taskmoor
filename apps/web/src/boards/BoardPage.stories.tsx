import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { fakeSprintClient } from '../sprints/fixtures';
import { expectWithinBudget } from '../test/budget';
import { gripsTooSmall, onARealTouchScreen } from '../test/touch';
import { BoardPage } from './BoardPage';
import { CARDS, fakeBoardClient, longColumn, manyCards, ONE_LANE, SCRUM_BOARD } from './fixtures';

/** The pointer this file's drags use: one no other test's clicks share. */
const POINTER = 47;
const pointer = (type: string, at: { x: number; y: number }) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: POINTER,
    pointerType: 'touch',
    isPrimary: true,
    clientX: at.x,
    clientY: at.y,
  });

/**
 * A finger on a card's grip (T-162b) moved over the top of `to`, laid out by the browser itself.
 * The story's frame is a phone's width, so `to` is first brought into view: the press is on the
 * grip wherever it then is, and the finger ends over `to`.
 */
function dragOver(grip: Element, to: Element) {
  const from = grip.getBoundingClientRect();
  const a = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
  grip.dispatchEvent(pointer('pointerdown', a));
  to.scrollIntoView({ block: 'center', inline: 'center' });
  const box = to.getBoundingClientRect();
  const b = { x: box.left + box.width / 2, y: box.top + Math.min(box.height / 4, 10) };
  for (let i = 1; i <= 6; i++) {
    window.dispatchEvent(
      pointer('pointermove', { x: a.x + ((b.x - a.x) * i) / 6, y: a.y + ((b.y - a.y) * i) / 6 }),
    );
  }
  return b;
}

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
  // A drag a story leaves under way ends before the next one starts.
  beforeEach: () => () => {
    window.dispatchEvent(pointer('pointercancel', { x: 0, y: 0 }));
  },
} satisfies Meta<typeof BoardPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  const edge = box.getBoundingClientRect().right;
  // The columns scroll inside the board, so what is in them may reach beyond it.
  const out = [...box.querySelectorAll('*')]
    .filter((el) => !el.parentElement?.closest('.board-scroll'))
    .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
    .map((el) => `${el.tagName} ${el.getAttribute('class') ?? ''}`);
  await expect(out).toEqual([]);
};

/** Three columns, an Expedite lane above the catch-all; Doing is over its maximum of 2. */
export const Board: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // A track's board: titled by its section, the track named above it (D26).
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Board' })).toBeVisible();
    await expect(canvas.getByText('Over the maximum')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: /^Expedite/ })).toBeVisible();
    // The filters sit on a slab of their own, with a fill and an edge in either skin (D28).
    const slab = getComputedStyle(
      canvas.getByRole('group', { name: 'Board filters' }).closest('.board-filters') as Element,
    );
    await expect(slab.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    await expect(slab.borderTopWidth).toBe('1px');
  },
};

/**
 * NFR-007, ADR-033: on a real touch screen at a desktop's width, every card's grip and the pencil
 * beside it are a finger's size (T-231).
 */
export const GripsOnATouchScreen: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(window.innerWidth).toBeGreaterThanOrEqual(768);
    await expect(
      await gripsTooSmall(canvasElement, ['.board-card-grip', '.board-card-move']),
    ).toEqual([]);
  },
};

/** The same on a phone. */
export const GripsOnATouchPhone: Story = {
  tags: ['touch'],
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(window.innerWidth).toBeLessThan(768);
    await expect(
      await gripsTooSmall(canvasElement, ['.board-card-grip', '.board-card-move']),
    ).toEqual([]);
  },
};

/** A card's title being edited in place: Enter saves, Escape cancels (AGL-006). */
export const EditingATitle: Story = {
  args: { client: fakeBoardClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit the title of SHOP-19' }));
    await expect(canvas.getByRole('textbox', { name: 'Title of SHOP-19' })).toHaveFocus();
  },
};

/** A title that was refused says why on the card, at a phone's width. */
export const TitleRefused: Story = {
  args: {
    client: fakeBoardClient({
      retitleRefusal: () => new ApiError(403, { error: 'forbidden' }),
    }),
  },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit the title of SHOP-19' }));
    await userEvent.keyboard(' now{Enter}');
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'You may not edit this ticket.',
    );
    await fitsPhoneWidth(canvas);
  },
};

/** A board filter on: cards narrow, counts stay whole, and the chip shows a tick. */
export const FilterOn: Story = {
  args: { client: fakeBoardClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'My work' }));
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
    await userEvent.click(canvas.getByRole('button', { name: 'People' }));
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
    // Drawn at the end of the body (OverlayLayer), opaque with no blur like every dialog (D3).
    const dialog = await within(document.body).findByRole('dialog', {
      name: 'Move SHOP-23 to Review and done',
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.parentElement).toBe(document.body);
    await expect(getComputedStyle(dialog).backdropFilter).toBe('none');
    // An opaque fill: Chrome writes a colour with any transparency as rgba().
    await expect(getComputedStyle(dialog).backgroundColor).toMatch(/^rgb\(/);
    // A modal dialog (T-222): a veil over the page, and Tab goes round the choices, never out.
    const veil = within(document.body).getByRole('button', { name: 'Close without moving' });
    await expect(veil).toBeVisible();
    await expect(veil.classList.contains('create-backdrop')).toBe(true);
    for (let i = 0; i < 5; i++) {
      await userEvent.tab();
      await expect(dialog.contains(document.activeElement)).toBe(true);
    }
    // It still floats near the bottom edge, as wide as its choices need.
    const box = dialog.getBoundingClientRect();
    await expect(window.innerHeight - box.bottom).toBeLessThan(40);
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    await expect(box.width).toBeLessThanOrEqual(28 * rem + 1);
    // Escape closes it and gives focus back to the card it was about.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(within(document.body).queryByRole('dialog')).toBeNull());
    await expect(document.activeElement).toBe(canvas.getByRole('link', { name: /SHOP-23/ }));
  },
};

/**
 * SHOP-19 in hand by its grip, over the top of SHOP-23 in Doing (T-162b): the cell and the place
 * are marked, the card fades where it was, a label follows the finger, and the page says what is
 * in hand and that Escape cancels.
 */
export const CardInHand: Story = {
  args: { client: fakeBoardClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const doing = await canvas.findByRole('list', { name: 'Doing in Everything else' });
    const target = within(doing)
      .getByRole('link', { name: /^SHOP-23 / })
      .closest('li') as Element;
    dragOver(canvas.getByRole('button', { name: 'Move SHOP-19' }), target);
    await waitFor(() => expect(target).toHaveClass('is-drop-before'));
    await expect(doing).toHaveClass('is-drop-target');
    await expect(
      canvas.getByText('Moving SHOP-19: drop it on a place in a column. Escape cancels.'),
    ).toBeInTheDocument();
    await expect(document.querySelector('.drag-ghost')).toHaveTextContent('SHOP-19');
    await expect(document.body).toHaveClass('is-pointer-dragging');
  },
};

/** Let go there: SHOP-19 lands in Doing, before SHOP-23, and only it drops into place. */
export const CardDropped: Story = {
  args: { client: fakeBoardClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const doing = await canvas.findByRole('list', { name: 'Doing in Everything else' });
    const target = within(doing)
      .getByRole('link', { name: /^SHOP-23 / })
      .closest('li') as Element;
    const at = dragOver(canvas.getByRole('button', { name: 'Move SHOP-19' }), target);
    window.dispatchEvent(pointer('pointerup', at));
    await waitFor(() =>
      expect(
        within(doing)
          .getAllByRole('link')
          .map((link) => link.textContent?.split(' ')[0]),
      ).toEqual(['SHOP-19', 'SHOP-23', 'SHOP-24']),
    );
    await expect(canvas.getByText('SHOP-19 moved to Doing.')).toBeInTheDocument();
    await expect(document.querySelector('.drag-ghost')).toBeNull();
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
const watch = { arrival: 0, menu: 0 };
function watchBoard() {
  watch.arrival = performance.now();
  watch.menu = 0;
  const check = () => {
    if (!watch.menu && document.querySelector('.board-move-menu')) {
      watch.menu = performance.now() - watch.arrival;
      observer.disconnect();
      return;
    }
    const button = document.querySelector<HTMLButtonElement>('.board-card-move[aria-expanded]');
    if (button && button.getAttribute('aria-expanded') !== 'true') button.click();
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * 5,000 cards (M1-046; 05b: under 1 s to interactive): from the data's arrival until a card's
 * move menu opens. Each cell draws only the cards near the screen (T-193), so the board is whole
 * at once and passes axe like the small ones.
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
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(watch.menu).toBeGreaterThan(0), { timeout: 15_000, interval: 50 });
    await expectWithinBudget(watch.menu, 1000, '5,000-card board interactive (ms)');
    // Six cells of hundreds of cards each, and only those near the screen on the page.
    const drawn = canvasElement.querySelectorAll('.board-card').length;
    await expect(drawn).toBeGreaterThan(6);
    await expect(drawn).toBeLessThan(400);
  },
};

const inView = (el: Element) => {
  const box = el.getBoundingClientRect();
  return box.top >= 0 && box.bottom <= window.innerHeight;
};

/**
 * One column of 5,000 cards (T-193): the cards near the screen are drawn, each saying its place;
 * End and Home reach the last and first card, drawn and brought into view; the Move menu opens
 * whole, nothing clipping it; and the card with the menu and the focus stays while the page
 * scrolls far down, where the cards on the screen are drawn.
 */
export const LongColumn: Story = {
  args: { client: fakeBoardClient({ cards: longColumn(5000), lanes: ONE_LANE }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const todo = await canvas.findByRole('list', { name: 'To do' });
    const items = within(todo).getAllByRole('listitem');
    await expect(items.length).toBeLessThan(200);
    await expect(items[0]).toHaveAttribute('aria-posinset', '1');
    await expect(items[0]).toHaveAttribute('aria-setsize', '5000');
    // The page keeps the column's whole length, so its scroll bar tells how long it is.
    await expect(document.documentElement.scrollHeight).toBeGreaterThan(5000 * 60);
    const link = (n: number) => canvas.getByRole('link', { name: new RegExp(`^SHOP-${n} `) });

    link(1).focus();
    await userEvent.keyboard('{End}');
    await expect(link(5000)).toHaveFocus();
    await waitFor(() => expect(inView(link(5000))).toBe(true));
    await expect(link(5000).closest('li')).toHaveAttribute('aria-posinset', '5000');
    await userEvent.keyboard('{ArrowUp}');
    await expect(link(4999)).toHaveFocus();
    await userEvent.keyboard('{Home}');
    await expect(link(1)).toHaveFocus();
    await waitFor(() => expect(inView(link(1))).toBe(true));

    // Every choice of the menu shows where it is, and a press there reaches it.
    await userEvent.click(canvas.getByRole('button', { name: 'Move SHOP-1' }));
    const menu = link(1).closest('li') as HTMLElement;
    for (const choice of within(menu).getAllByRole('button').slice(2)) {
      choice.scrollIntoView({ block: 'center' });
      const box = choice.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      await expect(choice.contains(hit)).toBe(true);
    }

    // Far down the column: the cards there are drawn, and SHOP-1 with its menu stays.
    window.scrollTo(0, document.documentElement.scrollHeight / 2);
    const x = todo.getBoundingClientRect().left + 40;
    await waitFor(() =>
      expect(
        document.elementFromPoint(x, window.innerHeight / 2)?.closest('.board-card'),
      ).not.toBeNull(),
    );
    await expect(canvas.getByRole('button', { name: 'Move SHOP-1' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(todo.querySelectorAll('.board-card').length).toBeLessThan(200);
    window.scrollTo(0, 0);
  },
};

/** The person filter at the width of a small phone: only the columns scroll sideways. */
export const PersonFilterAtPhoneWidth: Story = {
  args: { client: fakeBoardClient() },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Me' }));
    await userEvent.click(canvas.getByRole('button', { name: 'People' }));
    await expect(canvas.getByRole('checkbox', { name: 'Rin Okafor' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/**
 * A Kanban board on a phone (NFR-007; the second sweep's long Closed column): each column ends at
 * its last card, so a short one is not a screen and more of empty frame beside a long one.
 */
export const ShortColumnBesideALongOneOnAPhone: Story = {
  args: { client: fakeBoardClient({ cards: longColumn(16, 2), lanes: ONE_LANE }) },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const todo = await canvas.findByRole('list', { name: 'To do' });
    const doing = canvas.getByRole('list', { name: 'Doing' });
    await expect(matchMedia('(max-width: 640px)').matches).toBe(true);
    const cards = within(doing).getAllByRole('listitem');
    await expect(cards).toHaveLength(2);
    const last = cards[cards.length - 1]?.getBoundingClientRect().bottom ?? 0;
    // The cell's own padding below its last card, and no more.
    await expect(doing.getBoundingClientRect().bottom - last).toBeLessThan(24);
    await expect(todo.getBoundingClientRect().height).toBeGreaterThan(
      doing.getBoundingClientRect().height * 3,
    );
  },
};

/**
 * The same phone board, a card dragged by its grip from deep in the long column sideways into the
 * short one, far below its last card (M1-046, NFR-007; T-162b): Doing is the place under the
 * finger, and the card lands at its end.
 */
export const DropBelowAShortColumnOnAPhone: Story = {
  args: { client: fakeBoardClient({ cards: longColumn(16, 2), lanes: ONE_LANE }) },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: 'To do' });
    const doing = canvas.getByRole('list', { name: 'Doing' });
    const grip = canvas.getByRole('button', { name: 'Move SHOP-14' });
    grip.scrollIntoView({ block: 'center', inline: 'nearest' });
    const from = grip.getBoundingClientRect();
    const a = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
    grip.dispatchEvent(pointer('pointerdown', a));
    window.dispatchEvent(pointer('pointermove', { x: a.x, y: a.y + 12 }));
    // The columns scroll sideways, the page stays: Doing is beside the finger, its cards far above.
    const scroller = doing.closest('.board-scroll') as HTMLElement;
    scroller.scrollLeft += doing.getBoundingClientRect().left - 40;
    const box = doing.getBoundingClientRect();
    const b = { x: box.left + box.width / 2, y: a.y + 12 };
    const cards = within(doing).getAllByRole('listitem');
    await expect(cards[cards.length - 1]?.getBoundingClientRect().bottom ?? 0).toBeLessThan(
      b.y - 200,
    );
    window.dispatchEvent(pointer('pointermove', b));
    await waitFor(() => expect(doing).toHaveClass('is-drop-target'));
    window.dispatchEvent(pointer('pointerup', b));
    await waitFor(() =>
      expect(
        within(doing)
          .getAllByRole('link')
          .map((link) => link.textContent?.split(' ')[0]),
      ).toEqual(['SHOP-1', 'SHOP-2', 'SHOP-14']),
    );
    await expect(args.client).toHaveProperty('moves', [
      expect.objectContaining({ ticket: 114, after: 102 }),
    ]);
    // Once the card is down, the short column ends at its last card again.
    const last = within(doing).getAllByRole('listitem').at(-1)?.getBoundingClientRect().bottom;
    await expect(doing.getBoundingClientRect().bottom - (last ?? 0)).toBeLessThan(24);
    window.scrollTo(0, 0);
  },
};

/**
 * A Scrum board with an active sprint, for someone who manages its sprints (T-106; AGL-010):
 * Complete sprint opens a pop-up that counts its done and open tickets from the board.
 */
export const CompleteSprint: Story = {
  args: {
    client: fakeBoardClient({ board: SCRUM_BOARD, cards: manyCards(8) }),
    sprints: fakeSprintClient(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Complete sprint' }));
    // The dialog is drawn at the end of the page's body (shell/OverlayLayer.tsx).
    const dialog = within(
      await within(document.body).findByRole('dialog', { name: 'Complete Checkout Sprint 1?' }),
    );
    await expect(dialog.getByText('4 tickets are done and 4 are open.')).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Open tickets go to' })).toBeVisible();
  },
};

/** The same board at a phone's width: the header's buttons wrap, nothing sticks out. */
export const CompleteSprintAtPhoneWidth: Story = {
  args: {
    client: fakeBoardClient({ board: SCRUM_BOARD, cards: manyCards(8) }),
    sprints: fakeSprintClient(),
  },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Complete sprint' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** A board that could not be read: the page still says what it is. */
export const Failed: Story = {
  args: {
    client: {
      ...fakeBoardClient(),
      board: async () => {
        throw new Error('down');
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Board', level: 1 })).toBeVisible();
  },
};
