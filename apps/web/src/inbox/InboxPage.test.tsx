import {
  act,
  type BoundFunctions,
  type queries,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { listPath, snoozeTimes } from './client';
import { ALERT_ITEM, fakeInboxClient, ITEMS, NOW } from './fixtures';
import { InboxPage } from './InboxPage';

function renderInbox(client = fakeInboxClient()) {
  render(
    <I18nProvider locale="en">
      <InboxPage client={client} now={() => NOW} />
    </I18nProvider>,
  );
  return { client, page: within(screen.getByRole('region', { name: 'Inbox' })) };
}
const cards = async (page: BoundFunctions<typeof queries>) =>
  (await page.findAllByRole('listitem')).filter((li) => li.classList.contains('inbox-item'));

describe('the inbox page (M1-058)', () => {
  it('[IAM-018] ASVS 11.1.8: a security alert names the rule and whom it is about, and leads to the audit log', async () => {
    const user = userEvent.setup();
    const { page, client } = renderInbox(fakeInboxClient([ALERT_ITEM, ...ITEMS]));
    const [first] = await cards(page);
    const card = first as HTMLElement;
    expect(card).toHaveTextContent('Failed sign-ins for one account: 10 in 60 minutes');
    const link = within(card).getByRole('link');
    expect(link).toHaveTextContent('Account: Kalo Smith · From 203.0.113.9');
    expect(link).toHaveAttribute('href', '#/admin/audit');
    expect(page.getByRole('button', { name: 'Priority 3', pressed: false })).toBeVisible();
    await user.click(within(card).getByRole('button', { name: 'Mark this alert as read' }));
    await waitFor(() => expect(client.items()[0]?.read).toBe(true));
  });

  it('[NTF-003] lists mentions and changes newest first, unread marked, quoting comments', async () => {
    const { page } = renderInbox();
    const items = await cards(page);
    expect(items.map((li) => within(li).getByRole('link').textContent)).toEqual([
      'SHOP-12 Checkout fails for expired cards',
      'SHOP-19 Refunds show the wrong currency',
      'OPS-3 Rotate the backup bucket keys',
      'SHOP-12 Checkout fails for expired cards',
    ]);
    const first = items[0] as HTMLElement;
    expect(first).toHaveTextContent('Unread: Ana Ruiz mentioned you in a comment');
    expect(within(first).getByText('@Kalo Smith can you reproduce this on staging?')).toBeVisible();
    expect(within(first).getByRole('link')).toHaveAttribute('href', '#/tickets/SHOP-12?comment=41');
    expect(items[1]).toHaveTextContent('Mi Rivera assigned it to you');
    expect(items[2]).toHaveTextContent('Jo Park: Comment added');
    expect(items[2]).not.toHaveTextContent('Unread');
    expect(items[3]).toHaveTextContent('Someone: Ticket updated');
    expect(page.getByText('3 unread')).toBeVisible();
    expect(page.getByRole('button', { name: 'Priority 2', pressed: false })).toBeVisible();
  });

  it('[CORE-012] [CORE-014] shows the ticket’s type and priority as named icons', async () => {
    const { page } = renderInbox();
    const [first] = await cards(page);
    expect(within(first as HTMLElement).getByRole('img', { name: 'Bug' })).toBeVisible();
    expect(within(first as HTMLElement).getByRole('img', { name: 'Urgent' })).toBeVisible();
  });

  it('[NTF-003] the Priority tab holds only direct asks; unread only hides what was read', async () => {
    const user = userEvent.setup();
    const { page, client } = renderInbox();
    await cards(page);
    await user.click(page.getByRole('button', { name: /^Priority/ }));
    expect(page.getByRole('button', { name: /^Priority/ })).toHaveAttribute('aria-pressed', 'true');
    expect((await cards(page)).map((li) => within(li).getByRole('link').textContent)).toEqual([
      'SHOP-12 Checkout fails for expired cards',
      'SHOP-19 Refunds show the wrong currency',
    ]);
    await user.click(page.getByRole('button', { name: /^All/ }));
    await user.click(page.getByRole('checkbox', { name: 'Unread only' }));
    expect(await cards(page)).toHaveLength(3);
    expect(client.calls.filter((c) => c.method === 'list').map((c) => c.args[0])).toEqual([
      { view: 'all', unread: false },
      { view: 'priority', unread: false },
      { view: 'all', unread: false },
      { view: 'all', unread: true },
    ]);
  });

  it('[NTF-003] filters by type and by track', async () => {
    const user = userEvent.setup();
    const { page, client } = renderInbox();
    await cards(page);
    await user.selectOptions(page.getByRole('combobox', { name: 'Type' }), 'Comment added');
    expect((await cards(page)).map((li) => within(li).getByRole('link').textContent)).toEqual([
      'OPS-3 Rotate the backup bucket keys',
    ]);
    await user.selectOptions(page.getByRole('combobox', { name: 'Type' }), 'Any type');
    await user.selectOptions(await page.findByRole('combobox', { name: 'Track' }), 'Shop (SHOP)');
    await waitFor(async () => expect(await cards(page)).toHaveLength(3));
    expect(client.calls.filter((c) => c.method === 'list').at(-1)?.args[0]).toEqual({
      view: 'all',
      unread: false,
      track: 'SHOP',
    });
  });

  it('[NTF-003] marks one read and unread, snoozes one and marks all read', async () => {
    const user = userEvent.setup();
    const { page, client } = renderInbox();
    await cards(page);
    await user.click(page.getByRole('button', { name: 'Mark SHOP-19 as read' }));
    expect(await page.findByRole('button', { name: 'Mark SHOP-19 as unread' })).toBeVisible();
    expect(page.getByText('2 unread')).toBeVisible();
    await user.click(page.getByRole('button', { name: 'Mark SHOP-19 as unread' }));
    expect(await page.findByText('3 unread')).toBeVisible();

    // Snoozed until tomorrow morning: it leaves the list and waits in Snoozed.
    await user.click(page.getByRole('button', { name: 'Snooze OPS-3' }));
    expect(page.getByRole('button', { name: 'Snooze OPS-3' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await user.click(page.getByRole('button', { name: 'Until tomorrow' }));
    expect(client.calls.at(-1)).toEqual({
      method: 'update',
      args: ['12', { snoozedUntil: snoozeTimes(NOW).tomorrow.toISOString() }],
    });
    expect(await cards(page)).toHaveLength(3);
    await user.click(page.getByRole('button', { name: 'Snoozed' }));
    const snoozed = await cards(page);
    expect(snoozed).toHaveLength(1);
    expect(snoozed[0]).toHaveTextContent('Snoozed until');
    await user.click(
      within(snoozed[0] as HTMLElement).getByRole('button', {
        name: 'Put OPS-3 back in the inbox',
      }),
    );
    expect(await page.findByText('Nothing snoozed.')).toBeVisible();

    await user.click(page.getByRole('button', { name: /^All/ }));
    await cards(page);
    await user.click(page.getByRole('button', { name: 'Mark all as read' }));
    expect(await page.findByText('4 items marked as read.')).toBeVisible();
    expect(client.calls.find((c) => c.method === 'readAll')?.args[0]).toEqual({
      view: 'all',
      upTo: '15',
    });
    expect(page.getByText('nothing unread')).toBeVisible();
    expect(page.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  });

  it('[NTF-003] shows a new item as soon as the realtime socket says the inbox changed', async () => {
    const { page, client } = renderInbox();
    await cards(page);
    await act(async () => {
      client.push({
        ...(ITEMS[0] as (typeof ITEMS)[number]),
        id: '20',
        actor: { id: 5, name: 'Lee Chen' },
        comment: { id: 50, excerpt: 'Quick one for you' },
      });
    });
    const items = await cards(page);
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent('Lee Chen mentioned you in a comment');
    expect(page.getByText('4 unread')).toBeVisible();
  });

  it('[NTF-003] pages through a long inbox, and offers a retry when it cannot be read', async () => {
    const user = userEvent.setup();
    const { page } = renderInbox(fakeInboxClient(ITEMS, { pageSize: 3 }));
    expect(await cards(page)).toHaveLength(3);
    await user.click(page.getByRole('button', { name: 'Show more' }));
    expect(await cards(page)).toHaveLength(4);
    expect(page.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('[NTF-003] says when the inbox cannot be read, or is empty', async () => {
    const failing = renderInbox(fakeInboxClient(ITEMS, { fail: true }));
    expect(
      await failing.page.findByText('Your inbox could not be read. Try again in a moment.'),
    ).toBeVisible();
    expect(failing.page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('[NTF-003] is empty with a word on what arrives there', async () => {
    const { page } = renderInbox(fakeInboxClient([]));
    expect(
      await page.findByText(
        'Nothing here. Mentions and changes to tickets you follow arrive here.',
      ),
    ).toBeVisible();
  });

  it('[NTF-003] works on a phone: the same cards and actions', async () => {
    setViewportWidth(390);
    const { page } = renderInbox();
    const items = await cards(page);
    expect(items).toHaveLength(4);
    expect(
      within(items[0] as HTMLElement).getByRole('button', { name: 'Snooze SHOP-12' }),
    ).toBeVisible();
    setViewportWidth(1440);
  });

  it('[NTF-003] is in the navigation and reads the inbox from the backend at #/inbox', async () => {
    const calls = stubBackend({
      [`GET ${listPath({ view: 'all' })}`]: () =>
        jsonResponse(200, { items: ITEMS, unread: { all: 3, priority: 2 }, next: null }),
    });
    // No realtime socket here.
    vi.stubGlobal('WebSocket', undefined);
    window.location.hash = '#/inbox';
    render(<App session={MEMBER} />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Inbox' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByText('Ana Ruiz mentioned you in a comment')).toBeVisible();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('GET /inbox?view=all');
    window.location.hash = '';
  });
});
