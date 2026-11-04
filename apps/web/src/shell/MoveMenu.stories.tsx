import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { MoveMenu } from './MoveMenu';

/** Three rows, each led by a grip whose menu and Alt with the arrows reorder them. */
function Rows({ onDragStart }: { onDragStart: () => void }) {
  const [rows, setRows] = useState(['Card payments', 'Order total', 'Gift cards']);
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
            onDragStart={onDragStart}
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
  args: { onDragStart: fn() },
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
