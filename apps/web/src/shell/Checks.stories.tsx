import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

/** A token's colour as the browser computes it here, read through a probe. */
function colourOf(token: string, root: HTMLElement): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  root.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

function Checks() {
  return (
    <div className="glass-card" style={{ padding: 24, margin: 16, display: 'grid', gap: 12 }}>
      <div className="form-field form-field-inline">
        <input id="check-off" type="checkbox" />
        <label htmlFor="check-off">In a form, off</label>
      </div>
      <div className="form-field form-field-inline">
        <input id="check-on" type="checkbox" defaultChecked />
        <label htmlFor="check-on">In a form, on</label>
      </div>
      <label>
        <input type="checkbox" /> Outside a form, off
      </label>
      <label>
        <input type="checkbox" defaultChecked /> Outside a form, on
      </label>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>A choice</legend>
        <label>
          <input type="radio" name="choice" defaultChecked /> First
        </label>
        <label>
          <input type="radio" name="choice" /> Second
        </label>
      </fieldset>
    </div>
  );
}

const meta = {
  title: 'Shell/Checks',
  component: Checks,
} satisfies Meta<typeof Checks>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * TR-24: every check box and radio is one control, in both skins: drawn by the app, never the
 * browser's flat grey square in the dark skin or its blue where no rule gave the accent.
 */
export const OneControl: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const boxes = [...canvas.getAllByRole('checkbox'), ...canvas.getAllByRole('radio')];
    await expect(boxes).toHaveLength(6);
    const edge = colourOf('--color-field-border', canvasElement);
    const accent = colourOf('--color-accent', canvasElement);
    for (const box of boxes as HTMLInputElement[]) {
      const look = getComputedStyle(box);
      await expect(look.appearance).toBe('none');
      if (box.checked) {
        await expect(look.backgroundColor).toBe(accent);
      } else {
        await expect(look.borderTopColor).toBe(edge);
        await expect(look.backgroundColor).not.toBe(accent);
      }
    }
    const sizes = new Set(
      boxes.map(
        (box) => `${box.getBoundingClientRect().width}x${box.getBoundingClientRect().height}`,
      ),
    );
    await expect(sizes.size).toBe(1);
  },
};
