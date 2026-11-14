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
import { applyStylesheet } from '../test/stylesheets';
import { setViewportWidth } from '../test/viewport';
import { listPath, snoozeTimes } from './client';
import { ALERT_ITEM, CHECKLIST_ITEM, fakeInboxClient, GROUP_ITEM, ITEMS, NOW } from './fixtures';
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
  it('[NTF-003] lays out Type and Track by one rule, on a wide screen and on a phone (PL-30)', async () => {
    const wide = applyStylesheet('inbox.css');
    const { page } = renderInbox();
    const type = page.getByRole('combobox', { name: 'Type' });
    const track = page.getByRole('combobox', { name: 'Track' });
    const label = (select: HTMLElement) => select.closest('label') as HTMLElement;
    for (const select of [type, track]) {
      expect(getComputedStyle(select).width).toBe('14rem');
      expect(getComputedStyle(label(select)).flexWrap).toBe('nowrap');
    }
    const phone = applyStylesheet('inbox.css', 'max-width: 599px');
    try {
      for (const select of [type, track]) {
        expect(getComputedStyle(label(select)).display).toBe('grid');
        expect(getComputedStyle(select).width).toBe('100%');
      }
    } finally {
      phone();
      wide();
    }
  });

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
    await user.click(within(card).getByRole('button', { name: 'Mark as read: this alert' }));
    await waitFor(() => expect(client.items()[0]?.read).toBe(true));
  });

  it('[IAM-034] a track group shared with the reader names the group and who shared it, and leads to the Tracks page', async () => {
    const user = userEvent.setup();
    const { page, client } = renderInbox(
      fakeInboxClient([
        GROUP_ITEM,
        { ...GROUP_ITEM, id: '18', group: { id: 5, name: 'Handover', how: 'set', role: null } },
        ...ITEMS,
      ]),
    );
    const [shared, set] = (await cards(page)) as HTMLElement[];
    expect(shared).toHaveTextContent(
      'Ana Ruiz shared a track group with you, with the role Members',
    );
    const link = within(shared as HTMLElement).getByRole('link');
    expect(link).toHaveTextContent('Quarter plan');
    expect(link).toHaveAttribute('href', '#/tracks');
    expect(set).toHaveTextContent('Ana Ruiz set a track group on you, a copy of your own');
    await user.click(
      within(shared as HTMLElement).getByRole('button', {
        name: 'Mark as read: the group Quarter plan',
      }),
    );
    await waitFor(() => expect(client.items()[0]?.read).toBe(true));
    // The Type filter offers it.
    await user.selectOptions(
      page.getByRole('combobox', { name: 'Type' }),
      'A track group is shared with you or set on you',
    );
    expect(client.calls.filter((c) => c.method === 'list').at(-1)?.args[0]).toMatchObject({
      event: 'track_group_shared',
    });
  });

  it('[NTF-015] a run of checklist changes is one item that says who and how many, and leads to the ticket', async () => {
    const user = userEvent.setup();
    const { page, client } = renderInbox(
      fakeInboxClient([
        CHECKLIST_ITEM,
        { ...CHECKLIST_ITEM, id: '20', checklist: { changes: 1, others: 0 } },
        { ...CHECKLIST_ITEM, id: '21', checklist: { changes: 7, others: 2 } },
        ...ITEMS,
      ]),
    );
    const [many, one, several] = (await cards(page)) as HTMLElement[];
    expect(many).toHaveTextContent('Mi Rivera made 5 changes to checklists');
    expect(one).toHaveTextContent('Mi Rivera changed a checklist');
    expect(several).toHaveTextContent('Mi Rivera and 2 more made 7 changes to checklists');
    const link = within(many as HTMLElement).getByRole('link');
    expect(link).toHaveAttribute('href', '#/tickets/SHOP-19');
    // The Type filter offers it.
    await user.selectOptions(
      page.getByRole('combobox', { name: 'Type' }),
      'A checklist changes on a ticket you follow',
    );
    expect(client.calls.filter((c) => c.method === 'list').at(-1)?.args[0]).toMatchObject({
      event: 'checklist_changed',
    });
  });

  it('[NTF-015] says the same in Spanish, a draft of the catalogue', async () => {
    render(
      <I18nProvider locale="es">
        <InboxPage
          client={fakeInboxClient([
            CHECKLIST_ITEM,
            { ...CHECKLIST_ITEM, id: '21', checklist: { changes: 3, others: 1 } },
          ])}
          now={() => NOW}
        />
      </I18nProvider>,
    );
    expect(
      await screen.findByText('Mi Rivera hizo 5 cambios en listas de comprobación'),
    ).toBeVisible();
    expect(
      screen.getByText('Mi Rivera y 1 persona más hicieron 3 cambios en listas de comprobación'),
    ).toBeVisible();
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

  it('[CORE-005] [CORE-014] shows the ticket’s type and priority as named icons', async () => {
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

  it('[NFR-005] names each action with the words it shows, so voice control finds it', async () => {
    const { page } = renderInbox();
    await cards(page);
    const actions = page.getAllByRole('button').filter((b) => b.className.includes('inbox-action'));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.getAttribute('aria-label')).toContain(action.textContent as string);
    }
  });

  it('[NTF-003] marks one read and unread, snoozes one and marks all read', async () => {
    const user = userEvent.setup();
    const { page, client } = renderInbox();
    await cards(page);
    await user.click(page.getByRole('button', { name: 'Mark as read: SHOP-19' }));
    expect(await page.findByRole('button', { name: 'Mark as unread: SHOP-19' })).toBeVisible();
    expect(page.getByText('2 unread')).toBeVisible();
    await user.click(page.getByRole('button', { name: 'Mark as unread: SHOP-19' }));
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
        name: 'Back to the inbox: OPS-3',
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
    // The count is the eyebrow above the title, capitalised like the others.
    expect(page.getByText('Nothing unread', { exact: true })).toBeVisible();
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
