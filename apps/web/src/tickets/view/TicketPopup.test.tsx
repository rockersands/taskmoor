import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { MEMBER } from '../../admin/fixtures';
import { fakeAttachmentClient } from '../../attachments/fixtures';
import { fakeCommentClient } from '../../comments/fixtures';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { Connect } from '../../richtext/CollaborativeEditor';
import { addressRoute, currentRoute, overlayRoute, router } from '../../routing/router';
import { SessionProvider } from '../../session/SessionProvider';
import { fakeCloneClient } from '../clone/fixtures';
import { fakeToolsClient } from '../tools/fixtures';
import type { TicketClient, TicketDetails } from './client';
import { fakeTicketClient, SHOP_41 } from './fixtures';
import { TicketPage } from './TicketPage';
import { hasDraft, TicketPopup } from './TicketPopup';
import { useTicketChanges } from './ticketChanges';

const inPage: Connect = (_name, onStatus) => {
  const document = new Y.Doc();
  queueMicrotask(() => onStatus('live'));
  return { document, provider: null, destroy: () => document.destroy() };
};

const NAME = 'SHOP-41 Checkout fails for expired cards';
const clientProps = () => ({
  comments: fakeCommentClient(),
  attachments: fakeAttachmentClient(),
  clone: fakeCloneClient().client,
  connect: inPage,
  mentions: () => async () => [],
});

let stop = () => {};
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.location.hash = '#/tracks/SHOP/board?people=7';
  stop = router.start();
});
afterEach(() => {
  stop();
  cleanup();
});

/** A page with a link, as a board's card is, and the pop-up over it. */
function renderPopup(client: TicketClient = fakeTicketClient(), page?: React.ReactNode) {
  const onChange = vi.fn();
  function Page() {
    useTicketChanges(onChange);
    return page ?? <a href="#/tickets/SHOP-41">The card</a>;
  }
  render(
    <I18nProvider locale="en">
      <SessionProvider session={MEMBER}>
        <main>
          <h1>The board</h1>
          <Page />
          <TicketPopup client={client} {...clientProps()} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return { client, onChange };
}

const opened = async () => {
  const dialog = await screen.findByRole('dialog', { name: NAME });
  await within(dialog).findByRole('button', { name: 'Clone' });
  return dialog;
};

describe('the ticket pop-up', () => {
  it('[CORE-031] [CORE-032] [CORE-033] holds the ticket tools, working as on the full page', async () => {
    const user = userEvent.setup();
    const tools = fakeToolsClient();
    const onChange = vi.fn();
    function Page() {
      useTicketChanges(onChange);
      return <a href="#/tickets/SHOP-41">The card</a>;
    }
    render(
      <I18nProvider locale="en">
        <SessionProvider session={MEMBER}>
          <main>
            <Page />
            <TicketPopup client={fakeTicketClient()} tools={tools} {...clientProps()} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    await user.click(screen.getByRole('link', { name: 'The card' }));
    const dialog = await opened();
    // Checklists: a tick counts at once, and the page beneath hears of it.
    const list = await within(dialog).findByRole('region', { name: 'Before release' });
    expect(within(list).getByText('3 of 4 done (75%)')).toBeVisible();
    await user.click(within(list).getByRole('checkbox', { name: 'Tell the people' }));
    expect(await within(list).findByText('4 of 4 done (100%)')).toBeVisible();
    expect(onChange).toHaveBeenCalled();
    // Subtickets.
    const subs = await within(dialog).findByRole('region', { name: 'Subtickets' });
    await user.type(
      within(subs).getByRole('textbox', { name: 'New subticket' }),
      'From the pop-up{Enter}',
    );
    expect(await within(subs).findByText('From the pop-up')).toBeVisible();
    // Links, by keyboard; Escape closes the list and the form, not the pop-up.
    const links = within(dialog).getByRole('region', { name: 'Links' });
    await user.click(within(links).getByRole('button', { name: 'Add a link' }));
    const picker = await within(links).findByRole('combobox', { name: 'Ticket number or name' });
    await waitFor(() => expect(picker).toHaveFocus());
    await user.keyboard('retry');
    await within(dialog).findByRole('option', { name: /SHOP-40/ });
    await user.keyboard('{Enter}');
    expect(await within(links).findByRole('link', { name: 'SHOP-40' })).toBeVisible();
    await waitFor(() => expect(picker).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(within(links).queryByRole('combobox', { name: 'Ticket number or name' })).toBeNull(),
    );
    expect(screen.getByRole('dialog', { name: NAME })).toBeVisible();
    // A closed picker leaves no list behind, so the next Escape closes the pop-up.
    expect(within(dialog).queryByRole('listbox')).toBeNull();
  });

  it('[CORE-033] counts a half-written item as a draft, and not a saved name', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en">
        <SessionProvider session={MEMBER}>
          <main>
            <a href="#/tickets/SHOP-41">The card</a>
            <TicketPopup client={fakeTicketClient()} tools={fakeToolsClient()} {...clientProps()} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    await user.click(screen.getByRole('link', { name: 'The card' }));
    const dialog = await opened();
    const list = await within(dialog).findByRole('region', { name: 'Before release' });
    await user.click(within(list).getByRole('button', { name: 'Edit Print it' }));
    expect(hasDraft(dialog)).toBe(false);
    await user.keyboard('{Escape}');
    await user.type(
      within(list).getByRole('textbox', { name: 'Add an item to Before release' }),
      'half',
    );
    expect(hasDraft(dialog)).toBe(true);
  });

  it('[NTF-013] Escape closes the slash menu and leaves the pop-up open', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en">
        <SessionProvider session={MEMBER}>
          <main>
            <a href="#/tickets/SHOP-41">The card</a>
            <TicketPopup client={fakeTicketClient()} tools={fakeToolsClient()} {...clientProps()} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    await user.click(screen.getByRole('link', { name: 'The card' }));
    const dialog = await opened();
    const editor = await waitFor(() => {
      const found = dialog.querySelector<HTMLElement>('.comment-composer [contenteditable]');
      if (!found) throw new Error('no composer yet');
      return found;
    });
    await user.click(editor);
    await user.keyboard('/hea');
    await within(dialog).findByRole('listbox', { name: 'Blocks to add' });
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(within(dialog).queryByRole('listbox', { name: 'Blocks to add' })).toBeNull(),
    );
    expect(screen.getByRole('dialog', { name: NAME })).toBeVisible();
  });

  it('[AGL-018] opens over the page at the ticket’s address, and the page stays', async () => {
    const user = userEvent.setup();
    renderPopup();
    const card = screen.getByRole('link', { name: 'The card' });
    await user.click(card);
    const dialog = await opened();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { name: NAME })).toBeVisible();
    // The page is the same element, and what it reads as its route has not moved.
    expect(screen.getByRole('heading', { level: 1, name: 'The board' })).toBeVisible();
    expect(card).toBeInTheDocument();
    expect(addressRoute()).toBe('#/tickets/SHOP-41');
    expect(currentRoute()).toBe('#/tracks/SHOP/board?people=7');
  });

  it('[AGL-018] shows its frame at once, with the ticket still on its way', async () => {
    const user = userEvent.setup();
    const client = fakeTicketClient();
    client.get = () => new Promise<TicketDetails>(() => {});
    renderPopup(client);
    await user.click(screen.getByRole('link', { name: 'The card' }));
    const dialog = screen.getByRole('dialog', { name: 'SHOP-41' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('Reading the ticket');
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeVisible();
    expect(within(dialog).getByRole('link', { name: 'Open full page' })).toHaveAttribute(
      'href',
      '#/tickets/SHOP-41',
    );
  });

  it('[NFR-005] closes with Escape, the button or a click outside, and focus returns', async () => {
    const user = userEvent.setup();
    renderPopup();
    const card = screen.getByRole('link', { name: 'The card' });
    for (const close of [
      () => user.keyboard('{Escape}'),
      () => user.click(screen.getByRole('button', { name: 'Close' })),
      () => user.click(screen.getByRole('button', { name: 'Close this ticket' })),
    ]) {
      await user.click(card);
      await opened();
      await close();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(card).toHaveFocus();
      expect(addressRoute()).toBe('#/tracks/SHOP/board?people=7');
    }
  });

  it('[NFR-005] gives focus to the same link when the card was drawn again', async () => {
    const user = userEvent.setup();
    const redraw = { now: () => {} };
    function Redrawn() {
      const [times, setTimes] = useState(0);
      redraw.now = () => setTimes((n) => n + 1);
      return (
        <a key={times} href="#/tickets/SHOP-41">
          The card
        </a>
      );
    }
    renderPopup(fakeTicketClient(), <Redrawn />);
    const first = screen.getByRole('link', { name: 'The card' });
    await user.click(first);
    await opened();
    act(() => redraw.now());
    expect(screen.getByRole('link', { name: 'The card', hidden: true })).not.toBe(first);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('link', { name: 'The card' })).toHaveFocus();
  });

  it('[NFR-005] Escape closes only what is open inside: a menu, a dialog, a field, an edit', async () => {
    const user = userEvent.setup();
    renderPopup();
    await user.click(screen.getByRole('link', { name: 'The card' }));
    const dialog = await opened();

    await user.click(within(dialog).getByRole('button', { name: /Status/ }));
    expect(within(dialog).getByRole('menu')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(within(dialog).queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog', { name: NAME })).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Keyboard shortcuts' }));
    const shortcuts = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(shortcuts).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    expect(screen.getByRole('dialog', { name: NAME })).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Edit summary' }));
    expect(within(dialog).getByRole('textbox', { name: 'Summary' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(within(dialog).queryByRole('textbox', { name: 'Summary' })).toBeNull();
    expect(screen.getByRole('dialog', { name: NAME })).toBeVisible();

    // A plain field: the first Escape leaves it, the second closes.
    within(dialog).getByRole('combobox', { name: 'Priority' }).focus();
    within(dialog).getByLabelText('Due date').focus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: NAME })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: NAME })).toBeNull());
  });

  it('[AGL-018] the ticket’s keys work inside, and the page’s beneath do not fire', async () => {
    const user = userEvent.setup();
    const beneath = fakeTicketClient();
    const client = fakeTicketClient();
    renderPopup(
      client,
      <>
        <a href="#/tickets/SHOP-41">The card</a>
        <TicketPage ticket="SHOP-41" client={beneath} {...clientProps()} />
      </>,
    );
    await screen.findByRole('button', { name: 'Follow (2)' });
    await user.click(screen.getByRole('link', { name: 'The card' }));
    const dialog = await opened();
    await within(dialog).findByRole('button', { name: 'Follow (2)' });
    const follows = (c: ReturnType<typeof fakeTicketClient>) =>
      c.calls.filter((x) => x.action === 'follow').length;

    await user.keyboard('w');
    await within(dialog).findByRole('button', { name: 'Follow (3)' });
    expect(follows(client)).toBe(1);
    expect(follows(beneath)).toBe(0);

    await user.keyboard('?');
    const help = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await user.keyboard('w');
    expect(follows(client)).toBe(1);
    within(help).getByRole('button', { name: 'Close' }).click();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull(),
    );
  });

  it('[AGL-018] Back closes it and keeps the filter; a link inside steps through tickets', async () => {
    const user = userEvent.setup();
    const client = fakeTicketClient();
    const other = { ...SHOP_41, key: 'SHOP-50', summary: 'Another one', parent: null };
    const parent = {
      id: 50,
      key: 'SHOP-50',
      summary: 'Another one',
    };
    client.get = async (key) => (key === 'SHOP-50' ? other : { ...SHOP_41, parent });
    renderPopup(client);
    await user.click(screen.getByRole('link', { name: 'The card' }));
    const dialog = await opened();

    await user.click(await within(dialog).findByRole('link', { name: 'SHOP-50 Another one' }));
    expect(await screen.findByRole('dialog', { name: 'SHOP-50 Another one' })).toBeVisible();
    expect(addressRoute()).toBe('#/tickets/SHOP-50');
    expect(currentRoute()).toBe('#/tracks/SHOP/board?people=7');

    window.history.back();
    expect(await screen.findByRole('dialog', { name: NAME })).toBeVisible();
    expect(addressRoute()).toBe('#/tickets/SHOP-41');

    window.history.back();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(addressRoute()).toBe('#/tracks/SHOP/board?people=7');
    expect(screen.getByRole('link', { name: 'The card' })).toHaveFocus();

    // Two tickets deep, one press closes it all, and the entries below are the page's.
    await user.click(screen.getByRole('link', { name: 'The card' }));
    await user.click(
      await within(await opened()).findByRole('link', { name: 'SHOP-50 Another one' }),
    );
    await screen.findByRole('dialog', { name: 'SHOP-50 Another one' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(addressRoute()).toBe('#/tracks/SHOP/board?people=7');
  });

  it('[AGL-018] a reload brings it back over its page; a shared link has no page beneath', async () => {
    const user = userEvent.setup();
    renderPopup();
    await user.click(screen.getByRole('link', { name: 'The card' }));
    await opened();
    // A reload starts everything again from the entry's state.
    cleanup();
    renderPopup();
    expect(await opened()).toBeVisible();
    expect(screen.getByRole('link', { name: 'The card' })).toBeInTheDocument();
    expect(currentRoute()).toBe('#/tracks/SHOP/board?people=7');
    cleanup();

    window.history.pushState(null, '', '/#/tickets/SHOP-41');
    renderPopup();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(currentRoute()).toBe('#/tickets/SHOP-41');
    expect(overlayRoute()).toBeNull();
  });

  it('[AGL-018] opening the full page leaves the page beneath; Ctrl-click stays out of it', async () => {
    const user = userEvent.setup();
    renderPopup();
    const card = screen.getByRole('link', { name: 'The card' });
    const plain = (init: MouseEventInit) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
      window.addEventListener('click', (e) => e.preventDefault(), { once: true });
      card.dispatchEvent(event);
    };
    plain({ ctrlKey: true });
    plain({ metaKey: true });
    plain({ button: 1 });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(overlayRoute()).toBeNull();

    await user.click(card);
    await user.click(within(await opened()).getByRole('link', { name: 'Open full page' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(currentRoute()).toBe('#/tickets/SHOP-41');
    expect(overlayRoute()).toBeNull();
    // Back from the full page: the pop-up over its board, as it was.
    window.history.back();
    expect(await screen.findByRole('dialog', { name: NAME })).toBeVisible();
    expect(currentRoute()).toBe('#/tracks/SHOP/board?people=7');
  });

  it('[AGL-018] an edit reaches the page beneath at once', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPopup();
    await user.click(screen.getByRole('link', { name: 'The card' }));
    const dialog = await opened();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Due date'), {
      target: { value: '2027-02-01' },
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });
});

describe('cloning from the ticket pop-up', () => {
  it('[CORE-023] the clone dialog opens inside, Escape closes only it, and the copy opens in place', async () => {
    const user = userEvent.setup();
    const client = fakeTicketClient();
    const copy = { ...SHOP_41, key: 'PAY-40', summary: 'The copy', id: 400 };
    client.get = async (key) => (key === 'PAY-40' ? copy : SHOP_41);
    renderPopup(client);
    await user.click(screen.getByRole('link', { name: 'The card' }));
    const dialog = await opened();

    await user.click(within(dialog).getByRole('button', { name: 'Clone' }));
    expect(await screen.findByRole('dialog', { name: 'Clone SHOP-41' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Clone SHOP-41' })).toBeNull();
    expect(screen.getByRole('dialog', { name: NAME })).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Clone' }));
    const box = within(await screen.findByRole('dialog', { name: 'Clone SHOP-41' }));
    await user.click(box.getByRole('button', { name: 'Clone' }));
    expect(
      await screen.findByRole('dialog', { name: 'PAY-40 The copy' }, { timeout: 5000 }),
    ).toBeVisible();
    expect(addressRoute()).toBe('#/tickets/PAY-40');
    expect(currentRoute()).toBe('#/tracks/SHOP/board?people=7');

    window.history.back();
    expect(await screen.findByRole('dialog', { name: NAME })).toBeVisible();
  });
});

describe('a draft in the ticket pop-up', () => {
  async function typeLabels() {
    const user = userEvent.setup();
    renderPopup();
    await user.click(screen.getByRole('link', { name: 'The card' }));
    const dialog = await opened();
    await user.click(within(dialog).getByRole('button', { name: 'Edit labels' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Labels' }), ' typed');
    return { user, dialog };
  }
  const asked = () =>
    screen.findByRole('alertdialog', { name: 'Discard what you have not saved?' });

  it('[NFR-005] a click outside, Escape or a link ask first, and keeping it loses nothing', async () => {
    const { user, dialog } = await typeLabels();
    const labels = within(dialog).getByRole('textbox', { name: 'Labels' });
    const value = (labels as HTMLInputElement).value;

    await user.click(screen.getByRole('button', { name: 'Close this ticket' }));
    await user.click(within(await asked()).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(labels).toHaveValue(value);

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await asked();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: NAME })).toBeVisible();

    // A field's Escape only leaves it; the next one is the pop-up's, and asks.
    labels.focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.keyboard('{Escape}');
    await asked();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));

    await user.click(within(dialog).getByRole('link', { name: 'Open full page' }));
    await user.click(within(await asked()).getByRole('button', { name: 'Discard it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(currentRoute()).toBe('#/tickets/SHOP-41');
  });

  it('[NFR-005] discarding closes it', async () => {
    const { user } = await typeLabels();
    await user.click(screen.getByRole('button', { name: 'Close this ticket' }));
    await user.click(within(await asked()).getByRole('button', { name: 'Discard it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(addressRoute()).toBe('#/tracks/SHOP/board?people=7');
  });

  it('[NFR-005] Back with a draft comes forward again and asks', async () => {
    const { user, dialog } = await typeLabels();
    window.history.back();
    await asked();
    await waitFor(() => expect(addressRoute()).toBe('#/tickets/SHOP-41'));
    expect(within(dialog).getByRole('textbox', { name: 'Labels' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Discard it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(addressRoute()).toBe('#/tracks/SHOP/board?people=7');
  });

  it('[NFR-005] a form with nothing changed in it is no draft', async () => {
    const user = userEvent.setup();
    renderPopup();
    await user.click(screen.getByRole('link', { name: 'The card' }));
    const dialog = await opened();
    await user.click(within(dialog).getByRole('button', { name: 'Edit labels' }));
    await user.click(screen.getByRole('button', { name: 'Close this ticket' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('[NFR-005] reads typed text, an editor’s text, and not what is in a dialog over it', () => {
    const root = document.createElement('div');
    root.setAttribute('role', 'dialog');
    root.innerHTML = `
      <form><div contenteditable="true"> </div><input type="date" value="2027-01-01"></form>
      <form data-no-draft><input value="saved"></form>
      <div role="dialog"><form><input value="prefilled"></form></div>
      <input value="outside any form">`;
    expect(hasDraft(root)).toBe(false);
    (root.querySelector('[contenteditable]') as HTMLElement).textContent = 'typing';
    expect(hasDraft(root)).toBe(true);
  });
});
