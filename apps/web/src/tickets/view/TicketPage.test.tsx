import { writeDocToYDoc } from '@taskmoor/richtext';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { MEMBER } from '../../admin/fixtures';
import { ApiError } from '../../api/client';
import { fakeAttachmentClient } from '../../attachments/fixtures';
import { fakeCommentClient } from '../../comments/fixtures';
import { I18nProvider } from '../../i18n/I18nProvider';
import { type Locale, messagesFor } from '../../i18n/locale';
import type { Connect } from '../../richtext/CollaborativeEditor';
import { rememberBoard } from '../../routing/cameFrom';
import { addressRoute, currentRoute, overlayRoute, router } from '../../routing/router';
import { type Session, SessionProvider } from '../../session/SessionProvider';
import { untranslated, visibleTexts } from '../../test/backend';
import { setViewportWidth } from '../../test/viewport';
import { fakeCloneClient } from '../clone/fixtures';
import type { TicketDetails } from './client';
import { fakeTicketClient, SHOP_41, SHOP_41_SOME_FIELDS } from './fixtures';
import { TicketPage, ticketEditorTools } from './TicketPage';

const member = MEMBER as Extract<Session, { status: 'signed-in' }>;
const ADA_SESSION: Session = {
  status: 'signed-in',
  user: { ...member.user, id: 1, name: 'Ada Lovelace' },
};

const inPage: Connect = (_name, onStatus) => {
  const document = new Y.Doc();
  if (SHOP_41.description) writeDocToYDoc(document, SHOP_41.description);
  queueMicrotask(() => onStatus('live'));
  return { document, provider: null, destroy: () => document.destroy() };
};

function renderPage(
  start: Parameters<typeof fakeTicketClient>[0] = {},
  locale: Locale = 'en',
  /** The app around the page, such as its navigation. */
  around: React.ReactNode = null,
) {
  const client = fakeTicketClient(start);
  const comments = fakeCommentClient();
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={ADA_SESSION}>
        {around}
        <main>
          <TicketPage
            ticket="SHOP-41"
            client={client}
            comments={comments}
            attachments={fakeAttachmentClient()}
            clone={fakeCloneClient().client}
            connect={inPage}
            mentions={() => async () => []}
          />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return { client, comments };
}

const details = () => screen.getByRole('region', { name: 'Details' });
const heading = () => screen.findByRole('heading', { level: 1 });

describe('the ticket view (M1-051)', () => {
  it('[CORE-014] offers no empty priority; an imported ticket with none asks for one', async () => {
    renderPage();
    await heading();
    const user = userEvent.setup();
    await user.click(within(details()).getByRole('combobox', { name: 'Priority' }));
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Highest', 'High', 'Medium']);
    cleanup();
    renderPage({ ticket: { ...SHOP_41, priority: null } });
    await heading();
    expect(within(details()).getByRole('combobox', { name: 'Priority' })).toHaveTextContent(
      'Choose a priority',
    );
  });

  it('[CORE-022] shows the ticket: summary, details, links, attachments and comments', async () => {
    renderPage();
    expect(await heading()).toHaveTextContent('SHOP-41 Checkout fails for expired cards');
    expect(screen.getByText('Shop · Bug')).toBeVisible();
    const facts = details();
    expect(within(facts).getByText('Grace Hopper')).toBeVisible();
    expect(within(facts).getByRole('combobox', { name: 'Priority' })).toHaveTextContent('High');
    expect(within(facts).getByText('payments, checkout')).toBeVisible();
    expect(within(facts).getByLabelText('Due date')).toHaveValue('2026-11-02');
    expect(within(facts).getByRole('link', { name: 'SHOP-40 Card payments' })).toHaveAttribute(
      'href',
      '#/tickets/SHOP-40',
    );
    const links = await screen.findByRole('region', { name: 'Links' });
    expect(within(links).getByRole('link', { name: 'SHOP-39' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Attachments' })).toBeVisible();
    expect(await screen.findByRole('region', { name: 'Comments' })).toBeVisible();
    // Its status as one control, follow and vote, as the backend offers them.
    expect(await screen.findByRole('button', { name: /^Status: / })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Follow (2)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('[CORE-022] leads back to the board it was opened from, and only then', async () => {
    window.sessionStorage.clear();
    renderPage();
    await heading();
    expect(screen.queryByRole('link', { name: /^Back to/ })).toBeNull();
    cleanup();
    rememberBoard('SHOP-41', { id: 7, name: 'Checkout team' });
    renderPage();
    await heading();
    expect(screen.getByRole('link', { name: 'Back to Checkout team' })).toHaveAttribute(
      'href',
      '#/boards/7',
    );
    window.sessionStorage.clear();
  });

  it('[CORE-022] edits the summary, priority, labels and dates in place', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await heading();
    await user.click(screen.getByRole('button', { name: 'Edit summary' }));
    const summary = screen.getByRole('textbox', { name: 'Summary' });
    expect(summary).toHaveFocus();
    await user.clear(summary);
    await user.type(summary, 'Expired cards fail silently{Enter}');
    expect(await heading()).toHaveTextContent('SHOP-41 Expired cards fail silently');
    await user.click(within(details()).getByRole('combobox', { name: 'Priority' }));
    await user.click(screen.getByRole('option', { name: 'Highest' }));
    await user.click(within(details()).getByRole('button', { name: 'Edit labels' }));
    const labels = within(details()).getByRole('textbox', { name: 'Labels' });
    await user.clear(labels);
    await user.type(labels, 'payments, urgent');
    await user.click(within(details()).getByRole('button', { name: 'Save' }));
    expect(await within(details()).findByText('payments, urgent')).toBeVisible();
    fireEvent.change(within(details()).getByLabelText('Due date'), {
      target: { value: '2026-11-09' },
    });
    expect(
      client.calls.filter((c) => c.action === 'edit').map((c) => (c.args as unknown[])[1]),
    ).toEqual([
      { summary: 'Expired cards fail silently' },
      { priorityId: 1 },
      { labels: ['payments', 'urgent'] },
      { dueDate: '2026-11-09' },
    ]);
  });

  it('[WF-006] moves at once when the status needs nothing, and lists only other statuses', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    const control = await screen.findByRole('button', { name: /^Status: / });
    expect(control).toHaveAttribute('aria-haspopup', 'menu');
    await user.click(control);
    const menu = screen.getByRole('menu');
    const names = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(names).not.toContain(SHOP_41.status.name);
    await user.click(within(menu).getByRole('menuitem', { name: 'In review' }));
    expect(await screen.findByText(/^Moved to /)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /what it needs/ })).toBeNull();
    expect(client.calls.find((c) => c.action === 'transition')?.args[1]).toBe(2);
  });

  it('[WF-006] says in plain words why a transition was refused', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    client.transition = async () => {
      throw new ApiError(409, {
        error: 'transition_refused',
        by: 'guard',
        name: 'only-assignee',
      });
    };
    await user.click(await screen.findByRole('button', { name: /^Status: / }));
    await user.click(screen.getByRole('menuitem', { name: 'In review' }));
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('transition_refused');
    expect(alert).not.toHaveTextContent('The workflow does not let');
  });

  it('[WF-006] runs a transition, asking for a close reason when it needs one', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await user.click(await screen.findByRole('button', { name: /^Status: / }));
    await user.click(screen.getByRole('menuitem', { name: 'Closed' }));
    const form = screen.getByRole('form', { name: 'Close: what it needs' });
    expect(within(form).getByRole('combobox', { name: 'Close reason' })).toBeVisible();
    await user.click(within(form).getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('Moved to Closed.')).toBeInTheDocument();
    expect(within(details()).getByText('Closed · Done')).toBeVisible();
    expect(client.calls.find((c) => c.action === 'transition')?.args).toEqual([
      41,
      4,
      { 'close-reason': 1 },
    ]);
  });

  it('[CORE-022] shows history, time entries and everything in one stream, and logs time', async () => {
    const user = userEvent.setup();
    renderPage();
    await heading();
    const tabs = screen.getByRole('tablist', { name: 'Activity' });
    await user.click(within(tabs).getByRole('tab', { name: 'History' }));
    const panel = screen.getByRole('tabpanel', { name: 'History' });
    expect(await within(panel).findByText('Changed Status from New to Active')).toBeVisible();
    expect(within(panel).getByText('Set Priority to High')).toBeVisible();
    // Arrow keys move between tabs.
    await user.keyboard('{ArrowRight}');
    expect(within(tabs).getByRole('tab', { name: 'Time entries' })).toHaveFocus();
    const time = screen.getByRole('tabpanel', { name: 'Time entries' });
    expect(await within(time).findByText('2 h · Reproduced and traced')).toBeVisible();
    await user.type(within(time).getByRole('textbox', { name: 'Time spent' }), '1.5');
    await user.type(within(time).getByRole('textbox', { name: 'What was done (optional)' }), 'Fix');
    await user.click(within(time).getByRole('button', { name: 'Log time' }));
    expect(await within(time).findByText('1.5 h · Fix')).toBeVisible();
    await user.click(within(tabs).getByRole('tab', { name: 'All' }));
    const all = screen.getByRole('tabpanel', { name: 'All' });
    expect(await within(all).findByText('Changed Status from New to Active')).toBeVisible();
    expect(within(all).getAllByText('Commented').length).toBeGreaterThan(0);
    expect(within(all).getByText('Logged 2 h')).toBeVisible();
  });

  it('[AGL-018] keyboard shortcuts: help, follow, assign, comment, edit, transitions', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await screen.findByRole('button', { name: 'Follow (2)' });
    await user.keyboard('?');
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Write a comment')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toHaveFocus();

    await user.keyboard('w');
    expect(await screen.findByRole('button', { name: 'Follow (3)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.keyboard('a');
    expect(await within(details()).findByText('Ada Lovelace', { selector: 'span' })).toBeVisible();
    expect(client.calls.find((c) => c.action === 'edit')?.args[1]).toEqual({ assigneeId: 1 });
    await user.keyboard('t');
    expect(screen.getByRole('button', { name: /^Status: / })).toHaveFocus();
    await user.keyboard('{Escape}');
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('m');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement?.closest('.comment-composer')).not.toBeNull();
    // Typing in a field is typing, not a shortcut.
    await user.keyboard('w');
    expect(screen.getByRole('button', { name: 'Follow (3)' })).toBeVisible();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('e');
    expect(screen.getByRole('textbox', { name: 'Summary' })).toHaveFocus();
  });

  it('[AGL-018] copies the ticket’s full address, and says so in words', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/#/tickets/SHOP-41`);
    expect(await screen.findByText('The link to SHOP-41 is copied.')).toBeVisible();
  });

  it('[AGL-018] shows the link to copy by hand when the clipboard is refused', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(
      await screen.findByText(
        `The browser did not allow copying. The link is ${window.location.origin}/#/tickets/SHOP-41`,
      ),
    ).toBeVisible();
  });

  it("[AGL-007] sets Points in place, in the person's language; someone who may not edit reads it", async () => {
    const user = userEvent.setup();
    const { client } = renderPage({}, 'es');
    const points = await screen.findByRole('spinbutton', { name: 'Puntos' });
    await user.type(points, '5');
    await user.keyboard('{Enter}');
    const edits = () => client.calls.filter((c) => c.action === 'edit').map((c) => c.args[1]);
    await vi.waitFor(() => expect(edits()).toEqual([{ fields: { 31: 5 } }]));
    await vi.waitFor(() => expect(points).toHaveValue(5));
    await user.clear(points);
    await user.tab();
    await vi.waitFor(() => expect(edits().at(-1)).toEqual({ fields: { 31: null } }));
    cleanup();
    renderPage({ ticket: { ...SHOP_41, mayEdit: false, fields: { 31: 8 } } });
    expect(await screen.findByText('Points')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Points' })).toBeNull();
  });

  it('[CORE-014] sets the priority with icon and name; someone who may not edit sees the value', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    const picker = await within(await screen.findByRole('region', { name: 'Details' })).findByRole(
      'combobox',
      { name: 'Priority' },
    );
    await user.click(picker);
    const option = await screen.findByRole('option', { name: /Highest/ });
    expect(option.querySelector('svg')).not.toBeNull();
    await user.click(option);
    expect(client.calls.some((c) => c.action === 'edit')).toBe(true);
    cleanup();

    renderPage({ ticket: { ...SHOP_41, mayEdit: false } });
    const facts = await screen.findByRole('region', { name: 'Details' });
    expect(within(facts).queryByRole('combobox', { name: 'Priority' })).toBeNull();
    expect(within(facts).getByText('High')).toBeVisible();
  });

  it('[CORE-023] opens the clone dialog from the Clone action, and Escape closes it', async () => {
    const user = userEvent.setup();
    renderPage();
    await heading();
    await user.click(await screen.findByRole('button', { name: 'Clone' }));
    const box = await screen.findByRole('dialog', { name: 'Clone SHOP-41' });
    expect(within(box).getByLabelText('Summary of the copy')).toHaveValue(
      'Checkout fails for expired cards',
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Clone SHOP-41' })).toBeNull();
  });

  it('says so when the ticket is not there', async () => {
    renderPage({ missing: true });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'There is no such ticket, or you cannot see it.',
    );
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    await heading();
    expect(screen.getByRole('region', { name: 'Details' })).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Follow (2)' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage({}, 'en-XA');
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    await within(main).findAllByRole('button', { expanded: false });
    // The ticket's own values, people and what they wrote are data.
    const ticket: TicketDetails = SHOP_41;
    const data = new Set<string>([
      ticket.summary,
      `${ticket.key} ${ticket.summary}`,
      `${ticket.track.name} · ${messagesFor('en-XA')['ticketType.name.bug']}`,
      ticket.status.name,
      ...['Grace Hopper', 'Ada Lovelace', 'High', 'Highest', 'Medium', '2.4', 'Payments'],
      'payments, checkout',
      'SHOP-40 Card payments',
      'SHOP-40',
      'Card payments',
      'SHOP-39',
      'Card validation service',
      'is blocked by',
      'Send to review',
      'Close',
      // The info panel's participants and statuses (M1-125).
      'Ada Lovelace and Grace Hopper',
      'To do',
      'In progress',
      'In review',
    ]);
    for (const element of main.querySelectorAll(
      '.comment-body, .comment-author, .comment-date, .rt-content, .attachment-name, .attachment-meta, option[value*=":"], .ticket-feed-date',
    )) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        data.add((node.textContent ?? '').trim());
      }
    }
    const texts = visibleTexts(main).filter(
      (t) =>
        !data.has(t) &&
        !/^[\d,.+]+$/.test(t) &&
        !/\p{Extended_Pictographic}/u.test(t) &&
        !/\d{4}|\d:\d\d/.test(t),
    );
    expect(untranslated(texts)).toEqual([]);
  });
});

describe('what the ticket offers the editors in it (NTF-014)', () => {
  it('[NTF-014] asks for the files again after a read that failed, rather than keeping the failure', async () => {
    const files = fakeAttachmentClient();
    let down = true;
    const list = vi.fn(() => (down ? Promise.reject(new Error('Bad gateway')) : files.list()));
    const tools = ticketEditorTools({ ...files, list }, { pick: async () => [] });
    await expect(tools.attachments?.()).rejects.toThrow('Bad gateway');
    down = false;
    const found = await tools.attachments?.();
    expect(found?.map((file) => file.name)).toContain('checkout-error.png');
    // A good answer is kept for the page: only the menu's own fresh read asks again.
    await tools.attachments?.();
    expect(list).toHaveBeenCalledTimes(2);
    await tools.attachments?.(true);
    expect(list).toHaveBeenCalledTimes(3);
  });
});

describe('controls follow what the reader may change (T-191)', () => {
  it.each([
    ['desktop', 1440],
    ['phone', 375],
  ])(
    '[IAM-010] [WF-007] a member who may change only some fields sees controls only there (%s)',
    async (_name, width) => {
      setViewportWidth(width);
      const user = userEvent.setup();
      const { client } = renderPage({ ticket: SHOP_41_SOME_FIELDS });
      await heading();
      const facts = details();
      // Offered: labels, the due date and Points.
      expect(within(facts).getByRole('button', { name: 'Edit labels' })).toBeVisible();
      expect(within(facts).getByLabelText('Due date')).toHaveValue('2026-11-02');
      expect(await within(facts).findByRole('spinbutton', { name: 'Points' })).toBeVisible();
      // Read only: the summary, the assignee, the priority and the start date show their values.
      expect(screen.queryByRole('button', { name: 'Edit summary' })).toBeNull();
      expect(within(facts).queryByRole('button', { name: 'Assign to me' })).toBeNull();
      expect(within(facts).queryByRole('button', { name: 'Unassign' })).toBeNull();
      expect(within(facts).getByText('Grace Hopper')).toBeVisible();
      expect(within(facts).queryByRole('combobox', { name: 'Priority' })).toBeNull();
      expect(within(facts).getByText('High')).toBeVisible();
      expect(within(facts).queryByLabelText('Start date')).toBeNull();
      expect(within(facts).getByText('Oct 20, 2026')).toBeVisible();
      // Nor do their keys: E and A change nothing.
      await user.keyboard('e');
      await user.keyboard('a');
      expect(screen.queryByRole('textbox', { name: 'Summary' })).toBeNull();
      // What is offered works.
      await user.click(within(facts).getByRole('button', { name: 'Edit labels' }));
      await user.type(within(facts).getByRole('textbox', { name: 'Labels' }), ' urgent');
      await user.click(within(facts).getByRole('button', { name: 'Save' }));
      await vi.waitFor(() =>
        expect(client.calls.filter((c) => c.action === 'edit').map((c) => c.args[1])).toEqual([
          { labels: ['payments', 'checkout', 'urgent'] },
        ]),
      );
      // An answer to an edit does not say what may change: the page keeps what reading said.
      expect(await within(facts).findByText('payments, checkout, urgent')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Edit summary' })).toBeNull();
    },
  );

  it('[WF-007] a transition into a locked status reads again what may change', async () => {
    const user = userEvent.setup();
    const { client } = renderPage({
      ticket: { ...SHOP_41, editableFields: ['summary', 'labels'] },
    });
    expect(await screen.findByRole('button', { name: 'Edit summary' })).toBeVisible();
    // In review, the ticket is locked: reading it again says so.
    const get = client.get;
    client.get = async (key) => ({ ...(await get(key)), editableFields: [] });
    await user.click(await screen.findByRole('button', { name: /^Status: / }));
    await user.click(screen.getByRole('menuitem', { name: 'In review' }));
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Edit summary' })).toBeNull(),
    );
    expect(within(details()).queryByRole('button', { name: 'Edit labels' })).toBeNull();
  });
});

describe('unsaved text on the full page (T-190)', () => {
  let stop = () => {};
  beforeEach(() => {
    window.history.replaceState(null, '', '/#/tracks/SHOP/board');
    window.history.pushState(null, '', '/#/tickets/SHOP-41');
    stop = router.start();
  });
  afterEach(() => {
    stop();
    cleanup();
  });

  const NAV = (
    <nav>
      <a href="#/boards">Boards</a>
    </nav>
  );
  const asked = () =>
    screen.findByRole('alertdialog', { name: 'Discard what you have not saved?' });
  /** Types labels on the page and leaves them unsaved. */
  async function typeLabels() {
    const user = userEvent.setup();
    renderPage({}, 'en', NAV);
    await heading();
    await user.click(within(details()).getByRole('button', { name: 'Edit labels' }));
    const labels = within(details()).getByRole('textbox', { name: 'Labels' });
    await user.type(labels, ' typed');
    return { user, labels };
  }
  /** Whether closing or reloading the tab would make the browser ask. */
  const unloadAsks = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('[NFR-005] a link inside the app asks first; keeping loses nothing and discarding leaves', async () => {
    const { user, labels } = await typeLabels();
    await user.click(screen.getByRole('link', { name: 'Boards' }));
    await user.click(within(await asked()).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(labels).toHaveValue('payments checkout typed');
    expect(currentRoute()).toBe('#/tickets/SHOP-41');

    await user.click(screen.getByRole('link', { name: 'Boards' }));
    await user.click(within(await asked()).getByRole('button', { name: 'Discard it' }));
    await waitFor(() => expect(currentRoute()).toBe('#/boards'));
  });

  it('[NFR-005] with nothing typed a link leaves at once', async () => {
    const user = userEvent.setup();
    renderPage({}, 'en', NAV);
    await heading();
    // A form opened with nothing changed in it is no draft.
    await user.click(within(details()).getByRole('button', { name: 'Edit labels' }));
    await user.click(screen.getByRole('link', { name: 'Boards' }));
    await waitFor(() => expect(currentRoute()).toBe('#/boards'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('[NFR-005] a ticket opened over the page does not leave it, and Back from it does not ask', async () => {
    const { user, labels } = await typeLabels();
    await user.click(within(details()).getByRole('link', { name: 'SHOP-40 Card payments' }));
    expect(overlayRoute()).toBe('#/tickets/SHOP-40');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    window.history.back();
    await waitFor(() => expect(addressRoute()).toBe('#/tickets/SHOP-41'));
    expect(overlayRoute()).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(labels).toHaveValue('payments checkout typed');
  });

  it('[NFR-005] Back with a draft comes back at once and asks; discarding goes back', async () => {
    const { user, labels } = await typeLabels();
    window.history.back();
    await asked();
    await waitFor(() => expect(addressRoute()).toBe('#/tickets/SHOP-41'));
    expect(labels).toHaveValue('payments checkout typed');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(labels).toHaveValue('payments checkout typed');

    window.history.back();
    await user.click(within(await asked()).getByRole('button', { name: 'Discard it' }));
    await waitFor(() => expect(addressRoute()).toBe('#/tracks/SHOP/board'));
  });

  it('[NFR-005] closing or reloading the tab asks only while there is a draft', async () => {
    const user = userEvent.setup();
    renderPage({}, 'en', NAV);
    await heading();
    expect(unloadAsks()).toBe(false);
    await user.click(within(details()).getByRole('button', { name: 'Edit labels' }));
    const labels = within(details()).getByRole('textbox', { name: 'Labels' });
    expect(unloadAsks()).toBe(false);
    await user.type(labels, ' typed');
    expect(unloadAsks()).toBe(true);
    await user.click(within(details()).getByRole('button', { name: 'Save' }));
    await within(details()).findByText('payments, checkout, typed');
    expect(unloadAsks()).toBe(false);
  });
});
