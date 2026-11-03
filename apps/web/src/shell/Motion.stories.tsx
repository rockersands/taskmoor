import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, within } from 'storybook/test';

/** Each shared class of styles/motion.css on a surface (ADR-114, section 11). */
const CLASSES = [
  ['motion-swell', 'A floating surface: menus, popovers, dialogs, the command palette.'],
  ['motion-settle', 'Something that opens in the page or arrives in it: a section, a notice.'],
  ['motion-rise', "A whole region, such as a tab's contents: no fade and no overshoot."],
  ['motion-slide', 'In from the start of the line: the navigation drawer.'],
  ['motion-dock', "Up from the bottom edge: the phone's docked panel."],
  ['motion-drop', 'One card landing after a move.'],
  ['motion-bulge', 'The mark of the current place, swelling into place.'],
  ['motion-fade', 'A backdrop.'],
  ['motion-collapse', 'What has just left, melting away.'],
] as const;

function Motion() {
  const [round, setRound] = useState(0);
  return (
    <main style={{ display: 'grid', gap: 24, padding: 24 }}>
      <h1 className="page-title">Motion</h1>
      <div>
        <button type="button" className="button-primary" onClick={() => setRound((n) => n + 1)}>
          Play them again
        </button>
      </div>
      <ul
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 16rem), 1fr))',
          gap: 24,
          margin: 0,
          padding: 0,
          listStyle: 'none',
        }}
      >
        {CLASSES.map(([name, note]) => (
          <li key={name} style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
            <h2 style={{ margin: 0, fontSize: 'var(--font-size-300)' }}>{name}</h2>
            <p style={{ margin: 0 }}>{note}</p>
            <div
              key={round}
              data-testid={name}
              className={`glass-card ${name}`}
              style={{ minHeight: 80 }}
            />
          </li>
        ))}
      </ul>
    </main>
  );
}

const meta = {
  title: 'Shell/Motion',
  component: Motion,
} satisfies Meta<typeof Motion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SharedClasses: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const [name] of CLASSES) {
      const style = getComputedStyle(canvas.getByTestId(name));
      await expect(style.animationName).toBe(name);
      // The story tests run with reduced motion asked for (vitest.stories.config.ts), so this is
      // the one switch in tokens.css at work in a real browser.
      await expect(style.animationDuration).toBe('0s');
    }
  },
};
