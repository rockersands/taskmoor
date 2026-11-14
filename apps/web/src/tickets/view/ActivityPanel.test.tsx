import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
});
