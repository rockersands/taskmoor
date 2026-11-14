import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { MoveMenu } from './MoveMenu';
import { followPointerDrag } from './pointerDrag';

/** Rows, each led by a grip whose menu and Alt with the arrows reorder them. */
function Rows({ onDragStart, start }: { onDragStart: () => void; start: string[] }) {
  const [rows, setRows] = useState(start);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length) return;
    const next = rows.filter((_, i) => i !== from);
    next.splice(to, 0, rows[from] as string);
    setRows(next);
  };
  return (
    <ol style={{ display: 'grid', gap: 8, listStyle: 'none', padding: 0, maxWidth: 360 }}>
      {rows.map((row, i) => (
        <li key={row} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <MoveMenu
            label={`Move ${row}`}
            handle={row}
            onDragStart={(event) => {
              onDragStart();
              // A press followed as the pages follow theirs, so it can become a drag.
              followPointerDrag(event, { start() {}, move() {}, drop() {}, cancel() {} });
            }}
            onStep={(direction) => move(i, i + direction)}
            items={[
              ...(i > 0 ? [{ key: 'up', label: 'Move up', onSelect: () => move(i, i - 1) }] : []),
              ...(i < rows.length - 1
                ? [{ key: 'down', label: 'Move down', onSelect: () => move(i, i + 1) }]
                : []),
            ]}
          />
          <span>{row}</span>
        </li>
      ))}
    </ol>
  );
}

const meta = {
  title: 'Shell/MoveMenu',
  component: Rows,
  args: { onDragStart: fn(), start: ['Card payments', 'Order total', 'Gift cards'] },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, minHeight: 320 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Rows>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Grips at rest: a 44 px target on touch, a drag handle for a mouse or a finger. */
export const Grips: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Move Order total' })).toHaveAttribute(
      'aria-haspopup',
      'menu',
    );
  },
};

/** A grip pressed: the menu of the moves its drag makes (T-162; ADR-114, section 7). */
export const MenuOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Move Order total' }));
    const menu = within(canvas.getByRole('menu'));
    await expect(menu.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Move up',
      'Move down',
    ]);
  },
};

/** The grip pressed again with its menu open and dragged: the menu goes once it is a drag (T-228). */
export const DragClosesTheMenu: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grip = canvas.getByRole('button', { name: 'Move Order total' });
    await userEvent.click(grip);
    await expect(canvas.getByRole('menu')).toBeVisible();
    const box = grip.getBoundingClientRect();
    const at = (type: string, dy: number) =>
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 31,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2 + dy,
      });
    grip.dispatchEvent(at('pointerdown', 0));
    window.dispatchEvent(at('pointermove', 30));
    await waitFor(() => expect(canvas.queryByRole('menu')).toBeNull());
    window.dispatchEvent(at('pointerup', 30));
  },
};

/** Alt and an arrow move a row from its grip, and the grip keeps the keyboard. */
export const ByKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole('button', { name: 'Move Gift cards' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await expect(canvas.getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      'Card payments',
      'Gift cards',
      'Order total',
    ]);
    await expect(canvas.getByRole('button', { name: 'Move Gift cards' })).toHaveFocus();
  },
};

/** A row alone, with no move to offer: its grip opens no empty menu and says it is unavailable. */
export const NothingToMove: Story = {
  args: { start: ['Card payments'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grip = canvas.getByRole('button', { name: 'Move Card payments' });
    await expect(grip).toHaveAttribute('aria-disabled', 'true');
    await expect(grip).not.toHaveAttribute('aria-haspopup');
    await userEvent.click(grip);
    await expect(canvas.queryByRole('menu')).toBeNull();
  },
};
