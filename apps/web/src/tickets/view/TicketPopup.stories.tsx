import type { Meta, StoryObj } from '@storybook/react-vite';
import { writeDocToYDoc } from '@taskmoor/richtext';
import { expect, userEvent, within } from 'storybook/test';
import * as Y from 'yjs';
import { MEMBER } from '../../admin/fixtures';
import { fakeAttachmentClient } from '../../attachments/fixtures';
import { fakeCommentClient } from '../../comments/fixtures';
import type { Connect } from '../../richtext/CollaborativeEditor';
import { openOverlay } from '../../routing/router';
import { SessionProvider } from '../../session/SessionProvider';
import printSheet from '../../styles/print.css?raw';
import { fakeCloneClient } from '../clone/fixtures';
import type { TicketDetails } from './client';
import { fakeTicketClient, SHOP_41, SHOP_41_SOME_FIELDS } from './fixtures';
import { TicketPopup } from './TicketPopup';

const inPage: Connect = (_name, onStatus) => {
  const document = new Y.Doc();
  if (SHOP_41.description) writeDocToYDoc(document, SHOP_41.description);
  queueMicrotask(() => onStatus('live'));
  return { document, provider: null, destroy: () => document.destroy() };
};

const NAME = 'SHOP-41 Checkout fails for expired cards';

const meta = {
  title: 'Tickets/TicketPopup',
  component: TicketPopup,
  args: {
    client: fakeTicketClient(),
    comments: fakeCommentClient(),
    attachments: fakeAttachmentClient(),
    clone: fakeCloneClient().client,
    connect: inPage,
    mentions: () => async () => [],
  },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <main style={{ padding: 24 }}>
          <h1 className="page-title">The page beneath</h1>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
  // The pop-up reads its ticket from the address, and goes when the entry does.
  beforeEach: () => {
    const before = window.location.href;
    window.history.replaceState(null, '', before);
    openOverlay('#/tickets/SHOP-41');
    return () => window.history.replaceState(null, '', before);
  },
} satisfies Meta<typeof TicketPopup>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Over the page: the same view as the ticket page, with a bar to leave by. */
export const OverThePage: Story = {
  play: async () => {
    const canvas = within(document.body);
    const dialog = await canvas.findByRole('dialog', { name: NAME });
    await expect(dialog).toBeVisible();
    await expect(await within(dialog).findByRole('button', { name: 'Follow (2)' })).toBeVisible();
    await expect(within(dialog).getByRole('link', { name: 'Open full page' })).toBeVisible();
  },
};

/** The frame at once, while the ticket is on its way. */
export const Loading: Story = {
  args: {
    client: { ...fakeTicketClient(), get: () => new Promise<TicketDetails>(() => {}) },
  },
  play: async () => {
    const dialog = await within(document.body).findByRole('dialog', { name: 'SHOP-41' });
    await expect(within(dialog).getByRole('status')).toBeVisible();
  },
};

/** Unsaved text stops a click outside and asks first. */
export const AskingAboutADraft: Story = {
  play: async () => {
    const canvas = within(document.body);
    const dialog = await canvas.findByRole('dialog', { name: NAME });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Edit labels' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Labels' }), ' typed');
    await userEvent.click(canvas.getByRole('button', { name: 'Close this ticket' }));
    await expect(
      await canvas.findByRole('alertdialog', { name: 'Discard what you have not saved?' }),
    ).toBeVisible();
  },
};

/** The same view: a member who may change some fields gets controls only there. */
export const SomeFieldsOnly: Story = {
  args: { client: fakeTicketClient({ ticket: SHOP_41_SOME_FIELDS }) },
  play: async () => {
    const dialog = within(await within(document.body).findByRole('dialog', { name: NAME }));
    await expect(await dialog.findByRole('button', { name: 'Edit labels' })).toBeVisible();
    await expect(dialog.queryByRole('button', { name: 'Edit summary' })).toBeNull();
    await expect(dialog.queryByRole('combobox', { name: 'Priority' })).toBeNull();
  },
};

/** A phone: a full-screen sheet. */
export const OnAPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async () => {
    await expect(await within(document.body).findByRole('dialog', { name: NAME })).toBeVisible();
  },
};

/**
 * The print rules of print.css put in force by hand: the stories' browser draws for a screen.
 * The cleanup also ends a print begun by `startPrinting`.
 */
function asPrinted(): () => void {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(printSheet);
  const style = document.createElement('style');
  style.textContent = Array.from(sheet.cssRules)
    .filter(
      (rule): rule is CSSMediaRule =>
        rule instanceof CSSMediaRule && rule.media.mediaText.includes('print'),
    )
    .flatMap((rule) => Array.from(rule.cssRules, (inner) => inner.cssText))
    .join('\n');
  document.head.append(style);
  return () => {
    window.dispatchEvent(new Event('afterprint'));
    style.remove();
  };
}

/** What the browser says as it starts printing, once the ticket is on screen to hear it. */
function startPrinting() {
  window.dispatchEvent(new Event('beforeprint'));
}

/**
 * Printed with the pop-up open (PL-27, D37): only the ticket, as on its full page. The page
 * beneath and its frame stay off the paper although the pop-up is drawn outside them.
 */
export const Printed: Story = {
  beforeEach: asPrinted,
  play: async () => {
    const canvas = within(document.body);
    const dialog = await canvas.findByRole('dialog', { name: NAME });
    const ticket = within(dialog);
    await expect(await ticket.findByRole('heading', { level: 1 })).toBeVisible();
    await expect(getComputedStyle(dialog).position).toBe('static');
    // The page beneath is not printed, nor the pop-up's bar or the ticket's buttons.
    await expect(
      canvas.getByRole('heading', { name: 'The page beneath', hidden: true }),
    ).not.toBeVisible();
    await expect(
      ticket.getByRole('link', { name: 'Open full page', hidden: true }),
    ).not.toBeVisible();
    await expect(dialog.querySelector('.ticket-toolbar')).not.toBeVisible();
  },
};

/** How light a colour is, 0 for black to 1 for white (the mean of its channels). */
const lightness = (colour: string) => {
  const [r = 0, g = 0, b = 0] = (colour.match(/[\d.]+/g) ?? []).map(Number);
  return (r + g + b) / (3 * 255);
};

/**
 * What the paper shows (PL-27, D37), in both skins: Priority's value as text, no 'saved as you
 * type' note from the editor, and dark text on white even in the dark skin.
 */
export const PrintedOnWhite: Story = {
  beforeEach: asPrinted,
  play: async () => {
    const canvas = within(document.body);
    const dialog = await canvas.findByRole('dialog', { name: NAME });
    const ticket = within(dialog);
    const title = await ticket.findByRole('heading', { level: 1 });
    // Printing takes the light skin, whatever the skin on screen; ending it gives the skin back.
    const skin = document.documentElement.dataset.skin;
    startPrinting();
    await expect(document.documentElement.dataset.skin).toBe('light');
    const priority = await ticket.findByRole('combobox', { name: 'Priority' });
    await expect(priority).toBeVisible();
    await expect(priority).toHaveTextContent(SHOP_41.priority?.name ?? '');
    await expect(getComputedStyle(priority).borderTopStyle).toBe('none');
    const note = await ticket.findByText('Changes are saved as you type.', {}, { timeout: 3000 });
    await expect(note).not.toBeVisible();
    await expect(lightness(getComputedStyle(document.body).backgroundColor)).toBeGreaterThan(0.95);
    await expect(getComputedStyle(document.body).backgroundImage).toBe('none');
    await expect(lightness(getComputedStyle(title).color)).toBeLessThan(0.3);
    // The tones too: a high priority's glyph prints dark on white, its tint stays pale.
    const page = dialog.querySelector('.ticket-page') ?? dialog;
    for (const tone of ['danger', 'warning', 'success', 'blue', 'blush', 'butter']) {
      const probe = document.createElement('span');
      probe.style.color = `var(--color-${tone})`;
      probe.style.backgroundColor = `var(--color-${tone}-soft)`;
      page.append(probe);
      const drawn = getComputedStyle(probe);
      await expect(lightness(drawn.color), tone).toBeLessThan(0.5);
      await expect(lightness(drawn.backgroundColor), `${tone}-soft`).toBeGreaterThan(0.85);
      probe.remove();
    }
    window.dispatchEvent(new Event('afterprint'));
    await expect(document.documentElement.dataset.skin).toBe(skin);
  },
};
