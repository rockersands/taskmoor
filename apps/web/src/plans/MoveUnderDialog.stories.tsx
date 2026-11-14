import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { type MoveCandidate, MoveUnderDialog } from './MoveUnderDialog';

const CANDIDATES: MoveCandidate[] = [
  {
    row: 0,
    key: 'SHOP-1',
    summary: 'Checkout that never loses a cart',
    level: 'Outcome',
    problem: null,
  },
  { row: 5, key: 'SHOP-2', summary: 'Faster search', level: 'Outcome', problem: null },
  {
    row: 3,
    key: 'SHOP-44',
    summary: 'Receipts show the wrong currency',
    level: 'Standard',
    problem: 'Its parent must be a ticket of the Outcome level.',
  },
];

/** The rows offered for the text typed: unsearched, only those that can be the parent. */
const candidates = (text: string) => {
  const want = text.trim().toLowerCase();
  const list = CANDIDATES.filter((c) =>
    want === '' ? c.problem === null : c.key.toLowerCase().includes(want),
  );
  return { list, more: 0 };
};

/**
 * Moving a row of a plan's Grid under another parent (PLN-010 acceptance 2; ADR-122 stage 10):
 * one row with everything below it, asked first, sent as the ticket's own change.
 */
const meta = {
  title: 'Plans/MoveUnderDialog',
  component: MoveUnderDialog,
  args: {
    moving: 'SHOP-70',
    from: null,
    below: 0,
    candidates,
    onMove: fn(async (_row: number): Promise<string | null> => null),
    onClose: fn(),
  },
} satisfies Meta<typeof MoveUnderDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const dialogOf = async (canvas: HTMLElement) =>
  within(canvas.ownerDocument.body).findByRole('dialog');

/** From a row's menu: the rows that can be its parent, then the question once one is chosen. */
export const Choose: Story = {
  play: async ({ canvasElement, args }) => {
    const dialog = await dialogOf(canvasElement);
    await expect(within(dialog).getAllByRole('radio')).toHaveLength(2);
    await userEvent.type(within(dialog).getByRole('searchbox'), 'SHOP-44');
    await expect(within(dialog).getByRole('radio', { name: /^SHOP-44/ })).toBeDisabled();
    await userEvent.clear(within(dialog).getByRole('searchbox'));
    await userEvent.click(within(dialog).getByRole('radio', { name: /^SHOP-2/ }));
    await expect(within(dialog).getByText('Move SHOP-70 under SHOP-2?')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await expect(args.onMove).toHaveBeenCalledWith(5);
  },
};

/** After a drop: only the question, with its parent before and after and the rows that go too. */
export const AfterADrop: Story = {
  args: {
    moving: 'ABC-12',
    from: { key: 'GHI-1' },
    below: 6,
    target: { row: 4, key: 'DEF-3' },
  },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await expect(within(dialog).getByText('Its parent changes from GHI-1 to DEF-3.')).toBeVisible();
    await expect(within(dialog).getByText('6 rows move with it.')).toBeVisible();
  },
};

/** The ticket route refused: said in its words, and nothing moved. */
export const Refused: Story = {
  args: {
    moving: 'SHOP-60',
    from: { key: 'SHOP-41' },
    target: { row: 3, key: 'SHOP-44' },
    onMove: fn(async (_row: number): Promise<string | null> => 'You may not change this ticket.'),
  },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'You may not change this ticket.',
    );
  },
};

/** Remove from parent of a subticket, which needs one: said before anything is sent. */
export const SubticketKeepsItsParent: Story = {
  args: {
    moving: 'SHOP-60',
    from: 'hidden',
    target: 'none',
    blocked: 'A subticket needs a parent.',
  },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await expect(
      within(dialog).getByText('Its parent changes from a ticket you may not see to none.'),
    ).toBeVisible();
    await expect(within(dialog).getByText('A subticket needs a parent.')).toBeVisible();
  },
};

/** On a touch screen each choice and button is a finger's size. */
export const OnATouchScreen: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await expect(
      tooSmallForAFinger(dialog, [
        '.plan-grid-move-item label',
        '.form-actions button',
        'input[type="search"]',
      ]),
    ).toEqual([]);
  },
};
