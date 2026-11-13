import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Popover } from './Popover';

/** The chips, popover, check boxes and scroll bar other pages can use, together. */
function Controls() {
  const [on, setOn] = useState(['Rin Okafor']);
  const [pressed, setPressed] = useState(true);
  const names = Array.from({ length: 16 }, (_, i) => (i === 0 ? 'Rin Okafor' : `Person ${i}`));
  return (
    <div className="filter-row">
      <fieldset className="filter-chips">
        <legend className="visually-hidden">Filters</legend>
        <button
          type="button"
          className="filter-chip"
          aria-pressed={pressed}
          onClick={() => setPressed(!pressed)}
        >
          On
        </button>
        <button type="button" className="filter-chip" aria-pressed={false}>
          Off
        </button>
        <Popover label={`People (${on.length} chosen)`} title="People" on={on.length > 0}>
          <ul className="popover-list thin-scroll">
            {names.map((name) => (
              <li key={name}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={on.includes(name)}
                    onChange={(event) =>
                      setOn(event.target.checked ? [...on, name] : on.filter((n) => n !== name))
                    }
                  />
                  <span>{name}</span>
                </label>
              </li>
            ))}
          </ul>
        </Popover>
      </fieldset>
    </div>
  );
}

const meta = {
  title: 'Shell/Popover',
  component: Controls,
  decorators: [
    (Story) => (
      <main style={{ padding: 24, minHeight: 480 }}>
        <Story />
        <p>The page under the popover stays where it is.</p>
      </main>
    ),
  ],
} satisfies Meta<typeof Controls>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Closed: a chip that is on has a tick; one that is off has none. */
export const Closed: Story = {};

/** Open over the page: what is under it does not move, and its list scrolls inside itself. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const under = canvas.getByText('The page under the popover stays where it is.');
    const before = under.getBoundingClientRect().top;
    await userEvent.click(canvas.getByRole('button', { name: /^People/ }));
    await expect(canvas.getByRole('group', { name: 'People' })).toBeVisible();
    await expect(under.getBoundingClientRect().top).toBe(before);
    await expect(canvas.getByRole('checkbox', { name: 'Rin Okafor' })).toBeChecked();
    const list = canvas.getByRole('list');
    await expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  },
};

/** Escape closes it and focus goes back to its button. */
export const ClosedWithEscape: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const opener = canvas.getByRole('button', { name: /^People/ });
    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('group', { name: 'People' })).toBeNull();
    await expect(opener).toHaveFocus();
  },
};
