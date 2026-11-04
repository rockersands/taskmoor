import type { InboxClient, InboxItem, InboxPage, InboxQuery, UnreadCounts } from './client';

/** A fixed clock for stories and tests: Thursday 29 October 2026, 10:00 UTC. */
export const NOW = new Date('2026-10-29T10:00:00Z');

const ticket = (key: string, summary: string, id: number) => ({
  id,
  key,
  summary,
  ticketType: { name: 'Bug', icon: 'bug' },
  priority: { name: 'Urgent', level: 1 },
  track: { id: 1, key: key.split('-')[0] as string },
});

/** Synthetic inbox items, newest first. */
export const ITEMS: readonly InboxItem[] = [
  {
    id: '15',
    event: 'mentioned',
    direct: true,
    ticket: ticket('SHOP-12', 'Checkout fails for expired cards', 12),
    actor: { id: 2, name: 'Ana Ruiz' },
    mentionedIn: ['comment'],
    comment: { id: 41, excerpt: '@Kalo Smith can you reproduce this on staging?' },
    createdAt: '2026-10-29T09:41:00Z',
    read: false,
    snoozedUntil: null,
  },
  {
    id: '14',
    event: 'ticket_assigned',
    direct: true,
    ticket: ticket('SHOP-19', 'Refunds show the wrong currency', 19),
    actor: { id: 3, name: 'Mi Rivera' },
    fields: ['assigneeId'],
    comment: null,
    createdAt: '2026-10-29T08:12:00Z',
    read: false,
    snoozedUntil: null,
  },
  {
    id: '12',
    event: 'ticket_commented',
    direct: false,
    ticket: ticket('OPS-3', 'Rotate the backup bucket keys', 3),
    actor: { id: 4, name: 'Jo Park' },
    comment: { id: 40, excerpt: 'Done for staging; production is next week.' },
    createdAt: '2026-10-28T16:30:00Z',
    read: true,
    snoozedUntil: null,
  },
  {
    id: '11',
    event: 'ticket_updated',
    direct: false,
    ticket: ticket('SHOP-12', 'Checkout fails for expired cards', 12),
    actor: null,
    fields: ['priorityId'],
    comment: null,
    createdAt: '2026-10-28T11:05:00Z',
    read: false,
    snoozedUntil: null,
  },
];

/** A security alert as a site administrator gets it (ADR-109): about no ticket. */
export const ALERT_ITEM: InboxItem = {
  id: '16',
  event: 'security_alert',
  direct: true,
  ticket: null,
  alert: {
    rule: 'sign_in_failures_account',
    count: 10,
    threshold: 10,
    windowMinutes: 60,
    userId: 7,
    userName: 'Kalo Smith',
    userEmail: 'kalo@example.com',
    address: '203.0.113.9',
  },
  actor: null,
  comment: null,
  createdAt: '2026-10-29T09:55:00Z',
  read: false,
  snoozedUntil: null,
};

/** A track group shared with the reader, with a role (T-206): about no ticket. */
export const GROUP_ITEM: InboxItem = {
  id: '17',
  event: 'track_group_shared',
  direct: false,
  ticket: null,
  group: { id: 4, name: 'Quarter plan', how: 'shared', role: 'Members' },
  actor: { id: 2, name: 'Ana Ruiz' },
  comment: null,
  createdAt: '2026-10-29T09:58:00Z',
  read: false,
  snoozedUntil: null,
};

const shown = (item: InboxItem, now: Date) =>
  item.snoozedUntil === null || Date.parse(item.snoozedUntil) <= now.getTime();

/**
 * An inbox in memory that behaves as the server does: views, unread only, pages of `pageSize`,
 * read, unread, snooze and mark all read. `push` adds an item and tells subscribers, as the
 * realtime socket would; `fail` makes every list call fail.
 */
export function fakeInboxClient(
  items: readonly InboxItem[] = ITEMS,
  options: { pageSize?: number; now?: Date; fail?: boolean } = {},
): InboxClient & {
  push: (item: InboxItem) => void;
  calls: { method: string; args: unknown[] }[];
  items: () => InboxItem[];
} {
  let store = items.map((i) => ({ ...i }));
  const listeners = new Set<() => void>();
  const calls: { method: string; args: unknown[] }[] = [];
  const now = options.now ?? NOW;
  const pageSize = options.pageSize ?? 50;
  const counts = (): UnreadCounts => {
    const unread = store.filter((i) => !i.read && shown(i, now));
    return { all: unread.length, priority: unread.filter((i) => i.direct).length };
  };
  const matching = (q: InboxQuery) =>
    store.filter(
      (i) =>
        (q.view === 'snoozed' ? !shown(i, now) : shown(i, now)) &&
        (q.view !== 'priority' || i.direct) &&
        (!q.unread || !i.read) &&
        (!q.event || i.event === q.event) &&
        (!q.track || i.ticket?.track.key === q.track),
    );
  return {
    calls,
    items: () => store,
    push: (item) => {
      store = [item, ...store];
      for (const l of listeners) l();
    },
    list: async (q): Promise<InboxPage> => {
      calls.push({ method: 'list', args: [q] });
      if (options.fail) throw new Error('offline');
      const all = matching(q);
      const start = q.cursor ? Number(q.cursor) : 0;
      const page = all.slice(start, start + pageSize);
      return {
        items: page.map((i) => ({ ...i })),
        unread: counts(),
        next: start + pageSize < all.length ? String(start + pageSize) : null,
      };
    },
    update: async (id, change) => {
      calls.push({ method: 'update', args: [id, change] });
      store = store.map((i) => {
        if (i.id !== id) return i;
        const snoozedUntil =
          change.snoozedUntil === undefined ? i.snoozedUntil : change.snoozedUntil;
        const read = change.read ?? (change.snoozedUntil ? false : i.read);
        return { ...i, read, snoozedUntil };
      });
      const item = store.find((i) => i.id === id) as InboxItem;
      return { item: { ...item }, unread: counts() };
    },
    readAll: async (q) => {
      calls.push({ method: 'readAll', args: [q] });
      let marked = 0;
      store = store.map((i) => {
        const fits =
          !i.read &&
          shown(i, now) &&
          (q.view !== 'priority' || i.direct) &&
          (!q.event || i.event === q.event) &&
          (!q.track || i.ticket?.track.key === q.track) &&
          (q.upTo === undefined || BigInt(i.id) <= BigInt(q.upTo));
        if (!fits) return i;
        marked++;
        return { ...i, read: true };
      });
      return { marked, unread: counts() };
    },
    tracks: async () => [
      { id: 1, key: 'OPS', name: 'Operations' },
      { id: 2, key: 'SHOP', name: 'Shop' },
    ],
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
}
