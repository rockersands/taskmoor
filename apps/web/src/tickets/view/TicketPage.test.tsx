import { writeDocToYDoc } from '@taskmoor/richtext';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MEMBER } from '../../admin/fixtures';
import { fakeAttachmentClient } from '../../attachments/fixtures';
import { fakeCommentClient } from '../../comments/fixtures';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { Locale } from '../../i18n/locale';
import type { Connect } from '../../richtext/CollaborativeEditor';
import { type Session, SessionProvider } from '../../session/SessionProvider';
import { untranslated, visibleTexts } from '../../test/backend';
import { setViewportWidth } from '../../test/viewport';
import type { TicketDetails } from './client';
import { fakeTicketClient, SHOP_41 } from './fixtures';
import { TicketPage } from './TicketPage';

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

function renderPage(start: Parameters<typeof fakeTicketClient>[0] = {}, locale: Locale = 'en') {
  const client = fakeTicketClient(start);
  const comments = fakeCommentClient();
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={ADA_SESSION}>
        <main>
          <TicketPage
            ticket="SHOP-41"
            client={client}
            comments={comments}
            attachments={fakeAttachmentClient()}
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
  it('[CORE-022] shows the ticket: summary, details, links, attachments and comments', async () => {
    renderPage();
    expect(await heading()).toHaveTextContent('SHOP-41 Checkout fails for expired cards');
    expect(screen.getByText('Shop · Bug')).toBeVisible();
    const facts = details();
    expect(within(facts).getByText('Grace Hopper')).toBeVisible();
    expect(within(facts).getByRole('combobox', { name: 'Priority' })).toHaveValue('2');
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
    // Transitions, follow and vote, as the backend offers them.
    expect(
      await screen.findByRole('button', { name: 'Send to review, to In review' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Follow (2)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
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
    await user.selectOptions(within(details()).getByRole('combobox', { name: 'Priority' }), '1');
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

  it('[WF-006] runs a transition, asking for a close reason when it needs one', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Close, to Closed' }));
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
    expect(screen.getByRole('button', { name: 'Send to review, to In review' })).toHaveFocus();
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
    await within(main).findAllByRole('button', { name: /Send to review/ });
    // The ticket's own values, people and what they wrote are data.
    const ticket: TicketDetails = SHOP_41;
    const data = new Set<string>([
      ticket.summary,
      `${ticket.key} ${ticket.summary}`,
      `${ticket.track.name} · ${ticket.ticketType.name}`,
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
