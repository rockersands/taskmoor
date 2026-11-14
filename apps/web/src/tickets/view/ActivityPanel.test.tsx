import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { Comment, CommentClient } from '../../comments/client';
import { fakeCommentClient } from '../../comments/fixtures';
import { I18nProvider } from '../../i18n/I18nProvider';
import { ActivityPanel } from './ActivityPanel';
import type { ActivityEntry, HistoryEntry, TicketClient, TimeEntry } from './client';
import { fakeTicketClient } from './fixtures';

afterEach(cleanup);

const GRACE = { id: 2, name: 'Grace Hopper' };
const hour = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString();

/**
 * A busy ticket, answered as the API does (T-309): 80 summary changes, then 120 comments, each
 * by its own commenter, and two time entries. The history route gives the newest 50 changes a
 * page, the comments route the oldest 100 comments a page; the activity route all of it, newest
 * first, 50 rows a page with the time entries of the stretch each page covers.
 */
function busyTicket() {
  interface Row {
    id: number;
    at: string;
    actor: { id: number; name: string };
    field: string;
    from: string | null;
    to: string | null;
  }
  const rows: Row[] = [];
  for (let i = 1; i <= 80; i++) {
    rows.push({
      id: i,
      at: hour(i),
      actor: GRACE,
      field: 'summary',
      from: `v${i - 1}`,
      to: `v${i}`,
    });
  }
  const comments: Comment[] = [];
  for (let i = 1; i <= 120; i++) {
    const at = hour(100 + i);
    const author = { id: 100 + i, name: `Commenter ${i}` };
    rows.push({ id: 80 + i, at, actor: author, field: 'comment', from: null, to: String(i) });
    comments.push({
      id: i,
      author,
      body: { type: 'doc', content: [{ type: 'paragraph' }] },
      visibility: null,
      version: 1,
      createdAt: at,
      updatedAt: at,
      edited: null,
      reactions: [],
      can: { edit: false, delete: false },
    });
  }
  const time: TimeEntry[] = [
    {
      id: 1,
      author: { id: 9, name: 'Worker Early' },
      startedAt: hour(5.5),
      duration: 2 * 3600,
      description: '',
      visibility: null,
    },
    {
      id: 2,
      author: { id: 10, name: 'Worker Late' },
      startedAt: hour(219.5),
      duration: 3600,
      description: '',
      visibility: null,
    },
  ];
  const newest = [...rows].reverse();
  const asHistory = (r: Row): HistoryEntry => ({
    id: String(r.id),
    at: r.at,
    actor: r.actor,
    field: r.field,
    from: { value: r.from, display: r.from },
    to: { value: r.to, display: r.to },
    transitionId: null,
  });
  const client = {
    ...fakeTicketClient(),
    history: async (_id: number, before?: string) => {
      const from = before === undefined ? newest : newest.filter((r) => r.id < Number(before));
      const page = from.slice(0, 50);
      return {
        changes: page.map(asHistory),
        next: from.length > 50 ? String(page.at(-1)?.id) : null,
      };
    },
    timeEntries: async () => structuredClone(time),
    activity: async (_id: number, cursor?: string) => {
      const from = cursor === undefined ? newest : newest.filter((r) => r.id < Number(cursor));
      const page = from.slice(0, 50);
      const oldest = from.length > 50 ? page.at(-1) : undefined;
      const upper = cursor === undefined ? null : rows.find((r) => r.id === Number(cursor))?.at;
      const activity: ActivityEntry[] = page.map((r) => ({
        changeSet: String(r.id),
        at: r.at,
        actor: r.actor,
        comment: r.field === 'comment' ? { id: Number(r.to), excerpt: '' } : null,
        changes: [
          {
            field: r.field,
            from: { value: r.from, display: r.from },
            to: { value: r.to, display: r.to },
          },
        ],
      }));
      const timeEntries = time
        .filter(
          (e) => (upper ? e.startedAt < upper : true) && (!oldest || e.startedAt >= oldest.at),
        )
        .reverse();
      return { activity, timeEntries, next: oldest ? String(oldest.id) : null };
    },
  };
  const said: CommentClient = {
    ...fakeCommentClient(),
    list: async () => ({
      comments: comments.slice(0, 100),
      next: 100,
      can: { add: true, react: true },
      lock: null,
    }),
  };
  return { client, said };
}

function renderAll(
  client: TicketClient = busyTicket().client,
  said: CommentClient = busyTicket().said,
) {
  const panel = (revision: number) => (
    <I18nProvider locale="en">
      <ActivityPanel
        ticket={{ id: 41, key: 'SHOP-41' }}
        client={client}
        comments={said}
        tab="all"
        revision={revision}
      />
    </I18nProvider>
  );
  const { rerender } = render(panel(0));
  return Object.assign(screen.getByRole('tabpanel', { name: 'All' }), {
    /** The ticket changed, here or live from someone else. */
    changed: (revision: number) => rerender(panel(revision)),
  });
}

describe('a busy ticket’s All feed (T-309)', () => {
  it('[CORE-022] shows the newest comment of a ticket with more comments than one page', async () => {
    const all = renderAll();
    expect(await within(all).findByText('Commenter 120')).toBeVisible();
    // Newest first: the last comment heads the feed, after the latest time entry.
    const actors = within(all)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.ticket-feed-actor')?.textContent);
    expect(actors.slice(0, 3)).toEqual(['Commenter 120', 'Worker Late', 'Commenter 119']);
  });

  it('[CORE-022] reaches history past the newest 50 changes with Show older activity', async () => {
    const user = userEvent.setup();
    const all = renderAll();
    await within(all).findByText('Commenter 120');
    expect(within(all).queryByText('Changed Summary from v0 to v1')).toBeNull();
    for (let i = 0; i < 4; i++) {
      const more = within(all).queryByRole('button', { name: 'Show older activity' });
      if (!more) break;
      const shown = within(all).getAllByRole('listitem').length;
      await user.click(more);
      await waitFor(() =>
        expect(within(all).getAllByRole('listitem').length).toBeGreaterThan(shown),
      );
    }
    expect(await within(all).findByText('Changed Summary from v0 to v1')).toBeVisible();
    expect(within(all).queryByRole('button', { name: 'Show older activity' })).toBeNull();
    // Everything once, in order: 80 changes, 120 comments and the two time entries.
    const items = within(all).getAllByRole('listitem');
    expect(items.length).toBe(202);
    const texts = items.map((li) => li.querySelector('.ticket-feed-text')?.textContent);
    expect(texts.at(-1)).toBe('Changed Summary from v0 to v1');
    expect(texts.at(-6)).toBe('Logged 2 h');
  });

  it('[CORE-022] reads the feed again when the ticket changes, a live update included', async () => {
    const client = fakeTicketClient();
    const all = renderAll(client);
    expect(await within(all).findByText('Changed Status from New to Active')).toBeVisible();
    expect(within(all).getByText('Commented')).toBeVisible();
    expect(within(all).getByText('Logged 2 h')).toBeVisible();
    await client.edit(41, { summary: 'Checkout fails on expired cards' });
    all.changed(1);
    expect(await within(all).findByText(/^Changed Summary from/)).toBeVisible();
    expect(client.calls.filter((c) => c.action === 'activity').length).toBe(2);
  });

  /** The busy ticket, with the activity reads it was asked for and a way to hold them. */
  function heldTicket() {
    const busy = busyTicket();
    const asked: (string | undefined)[] = [];
    const held: (() => void)[] = [];
    let holding = false;
    const client: TicketClient = {
      ...busy.client,
      activity: async (id, cursor) => {
        asked.push(cursor);
        if (holding) await new Promise<void>((resolve) => held.push(resolve));
        return busy.client.activity(id, cursor);
      },
    };
    return {
      client,
      said: busy.said,
      asked,
      hold: (on: boolean) => {
        holding = on;
      },
      /** Lets the oldest held read answer. */
      release: async () => {
        await act(async () => held.shift()?.());
      },
    };
  }
  const older = (all: HTMLElement) =>
    within(all).getByRole('button', { name: 'Show older activity' });
  async function openOlder(user: ReturnType<typeof userEvent.setup>, all: HTMLElement) {
    const shown = within(all).getAllByRole('listitem').length;
    await user.click(older(all));
    await waitFor(() => expect(within(all).getAllByRole('listitem').length).toBeGreaterThan(shown));
  }

  it('[CORE-022] keeps the older pages a reader opened when the ticket changes', async () => {
    const user = userEvent.setup();
    const ticket = heldTicket();
    const all = renderAll(ticket.client, ticket.said);
    await within(all).findByText('Commenter 120');
    await openOlder(user, all);
    await openOlder(user, all);
    const shown = within(all).getAllByRole('listitem').length;
    expect(within(all).getByText('Changed Summary from v79 to v80')).toBeVisible();
    all.changed(1);
    // The three pages shown are read again, and stay.
    await waitFor(() => expect(ticket.asked.length).toBe(6));
    await waitFor(() => expect(within(all).getAllByRole('listitem').length).toBe(shown));
    expect(within(all).getByText('Changed Summary from v79 to v80')).toBeVisible();
    expect(older(all)).toBeVisible();
  });

  it('[CORE-022] leaves no gap when Show older activity is pressed while the feed reads again', async () => {
    const user = userEvent.setup();
    const ticket = heldTicket();
    const all = renderAll(ticket.client, ticket.said);
    await within(all).findByText('Commenter 120');
    await openOlder(user, all);
    // A live update starts a fresh read; the reader asks for the third page before it ends.
    ticket.hold(true);
    all.changed(1);
    await waitFor(() => expect(ticket.asked.length).toBe(3));
    await user.click(older(all));
    await waitFor(() => expect(ticket.asked.length).toBe(4));
    ticket.hold(false);
    await ticket.release();
    await ticket.release();
    // Pages one to three, the second included: nothing between them is missing.
    await waitFor(() =>
      expect(within(all).getByText('Changed Summary from v79 to v80')).toBeVisible(),
    );
    await waitFor(() => expect(within(all).getAllByRole('listitem').length).toBe(151));
    expect(within(all).getByText('Commenter 50')).toBeVisible();
    expect(within(all).getByText('Commenter 21')).toBeVisible();
  });

  it('[CORE-022] puts the focus on the first row the last page brought, as its button goes', async () => {
    const user = userEvent.setup();
    const all = renderAll();
    await within(all).findByText('Commenter 120');
    older(all).focus();
    for (let i = 0; i < 3; i++) {
      const shown = within(all).getAllByRole('listitem').length;
      await user.keyboard('{Enter}');
      await waitFor(() =>
        expect(within(all).getAllByRole('listitem').length).toBeGreaterThan(shown),
      );
      if (i < 2) expect(older(all)).toHaveFocus();
    }
    expect(within(all).queryByRole('button', { name: 'Show older activity' })).toBeNull();
    const row = within(all).getByText('Changed Summary from v49 to v50').closest('li');
    await waitFor(() => expect(row).toHaveFocus());
  });
});

describe('a busy ticket’s History tab (T-311)', () => {
  it('[CORE-022] keeps the older pages a reader opened when the ticket changes', async () => {
    const user = userEvent.setup();
    const { client, said } = busyTicket();
    const panel = (revision: number) => (
      <I18nProvider locale="en">
        <ActivityPanel
          ticket={{ id: 41, key: 'SHOP-41' }}
          client={client}
          comments={said}
          tab="history"
          revision={revision}
        />
      </I18nProvider>
    );
    const { rerender } = render(panel(0));
    const history = screen.getByRole('tabpanel', { name: 'History' });
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(50));
    await user.click(within(history).getByRole('button', { name: 'Show older changes' }));
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(100));
    await user.click(within(history).getByRole('button', { name: 'Show older changes' }));
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(150));
    rerender(panel(1));
    // The three pages shown are read again, and stay; the fourth is still a click away.
    await act(async () => {});
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(150));
    expect(within(history).getByRole('button', { name: 'Show older changes' })).toBeVisible();
    await user.click(within(history).getByRole('button', { name: 'Show older changes' }));
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(200));
  });
});
