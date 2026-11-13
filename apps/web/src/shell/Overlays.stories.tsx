import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { NAV_ITEMS } from '../App';
import { AppShell } from './AppShell';
import { CommandPalette } from './CommandPalette';
import { IconSelect } from './IconSelect';
import { ModalDialog } from './ModalDialog';

/**
 * Menus, the command palette and dialogs over a real page (D3, T-220): opaque, and a dialog's veil
 * covers the whole window wherever the dialog is opened from. The top bar and the page's cards are
 * glass with a blur, and an element with a blur traps a fixed descendant inside itself, so each
 * story opens its surface from inside one of them and measures what is drawn.
 */

/** The text a see-through surface would show: long, dark and right under where they open. */
function Lines() {
  return (
    <>
      <h2 className="section-title">Tracks and tickets</h2>
      {Array.from({ length: 6 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed sample lines
        <p key={i} className="page-note">
          Not started. Work through the first steps of the tutorial before anything else.
        </p>
      ))}
    </>
  );
}

function PageBehind() {
  return (
    <section className="page">
      <div className="glass-card" style={{ padding: 24 }}>
        <Lines />
      </div>
    </section>
  );
}

const commands = [
  { id: 'go-home', labelId: 'nav.home', run: () => {} },
  { id: 'go-tracks', labelId: 'nav.tracks', run: () => {} },
  { id: 'go-settings', labelId: 'nav.settings', run: () => {} },
] as const;

/** The alpha of a computed colour: 1 for `rgb(...)`, the fourth value for `rgba(...)`. */
function alphaOf(colour: string): number {
  const parts = colour.match(/[\d.]+/g) ?? [];
  return parts.length >= 4 ? Number(parts[3]) : colour === 'transparent' ? 0 : 1;
}

/** Opaque, with no blur of its own: nothing under it shows through, and it traps nothing. */
async function expectOpaque(surface: HTMLElement) {
  const style = getComputedStyle(surface);
  await expect(alphaOf(style.backgroundColor)).toBe(1);
  await expect(style.backdropFilter).toBe('none');
}

/** A veil over the whole window, not over the box that holds whatever opened it. */
async function expectWholeWindow(veil: HTMLElement) {
  const box = veil.getBoundingClientRect();
  await expect(Math.round(box.left)).toBe(0);
  await expect(Math.round(box.top)).toBe(0);
  await expect(Math.round(box.width)).toBe(window.innerWidth);
  await expect(Math.round(box.height)).toBe(window.innerHeight);
}

const meta = {
  title: 'Shell/Overlays',
  component: AppShell,
  args: { items: NAV_ITEMS, activeId: 'home', children: null },
} satisfies Meta<typeof AppShell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** PL-3: the palette opens from the top bar, whose blur used to hold both it and its veil. */
export const PaletteFromTheTopBar: Story = {
  render: (args) => (
    <AppShell {...args} topbarEnd={<CommandPalette commands={commands} />}>
      <PageBehind />
    </AppShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Search or jump to/ }));
    const body = within(document.body);
    const palette = await body.findByRole('dialog', { name: 'Command palette' });
    await waitFor(() => expect(palette).toBeVisible());
    await expect(palette.closest('.shell-topbar')).toBeNull();
    await expectOpaque(palette);
    await expectWholeWindow(body.getByRole('button', { name: 'Close the command palette' }));
  },
};

function DialogFromACard() {
  const [open, setOpen] = useState(true);
  return (
    <section className="page">
      <div className="glass-card" style={{ padding: 24 }}>
        <Lines />
        <button type="button" className="button-secondary" onClick={() => setOpen(true)}>
          New track
        </button>
        {open && (
          <ModalDialog
            onClose={() => setOpen(false)}
            labelledBy="overlay-dialog-title"
            closeLabel="Close New track"
          >
            <h2 id="overlay-dialog-title" className="section-title">
              New track
            </h2>
            <p className="page-note">A track holds tickets, a board and its own settings.</p>
          </ModalDialog>
        )}
      </div>
    </section>
  );
}

/** AD-10 and PL-46: a dialog opened from inside glass still veils the whole window. */
export const DialogFromInsideGlass: Story = {
  render: (args) => (
    <AppShell {...args}>
      <DialogFromACard />
    </AppShell>
  ),
  play: async () => {
    const body = within(document.body);
    const dialog = await body.findByRole('dialog', { name: 'New track' });
    await expect(dialog.closest('.glass-card')).toBeNull();
    await expectOpaque(dialog);
    await expectWholeWindow(body.getByRole('button', { name: 'Close New track' }));
  },
};

function TypeChoice() {
  const [value, setValue] = useState('');
  return (
    <div className="glass-card" style={{ padding: 24, maxWidth: 420, minHeight: 360 }}>
      <IconSelect
        aria-label="Ticket type"
        value={value}
        onChange={setValue}
        placeholder="Choose a type"
        options={['Bug', 'Chore', 'Outcome', 'Subticket'].map((name) => ({
          value: name,
          label: name,
          icon: <span aria-hidden="true">•</span>,
        }))}
      />
      <p className="page-note">Description: what happened, what you expected, and the steps.</p>
      <p className="page-note">Summary (required)</p>
    </div>
  );
}

/** PL-22 and AD-6: a menu over a form reads on its own surface. */
export const MenuOverAForm: Story = {
  render: (args) => (
    <AppShell {...args}>
      <TypeChoice />
    </AppShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox', { name: 'Ticket type' }));
    await expectOpaque(await canvas.findByRole('listbox'));
  },
};
