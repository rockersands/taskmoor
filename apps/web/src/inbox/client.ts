import { api, openSocket } from '../api/client';
import { everyTrack } from '../api/tracks';

/** One inbox item, as `GET /api/v1/inbox` gives it (M1-058; NTF-003). */
export interface InboxItem {
  id: string;
  /** The notification event: a policy event (`ticket_updated`…), `custom:<name>` or `mentioned`. */
  event: string;
  /** A direct ask: a mention, or the ticket assigned to the reader. */
  direct: boolean;
  /** The ticket it is about; null for an alert to site administrators (ADR-109) or a group. */
  ticket: {
    id: number;
    key: string;
    summary: string;
    ticketType?: { name: string; icon?: string | null };
    priority?: { name: string; level?: number } | null;
    track: { id: number; key: string };
  } | null;
  /**
   * A security or AI spend alert (`security_alert`, `ai_spend_alert`): the rule, its numbers
   * and whom it is about. Older servers leave it out.
   */
  alert?: InboxAlert;
  /**
   * A track group shared with the reader (`how: 'shared'`) or set on them as a copy of their
   * own (`'set'`), by its name now, with the role it came with (T-206; `track_group_shared`).
   */
  group?: InboxGroup;
  /**
   * A run of checklist changes on a ticket the reader follows (NTF-015; `checklist_changed`):
   * how many, and how many people besides `actor` made them. Never a list's name or an item's text.
   */
  checklist?: { changes: number; others: number };
  actor: { id: number; name: string } | null;
  fields?: string[];
  /** Where the reader was mentioned: `ticket`, `description`, `environment` or `comment`. */
  mentionedIn?: string[];
  /** The comment it is about, quoted only when the reader may read it. */
  comment: { id: number; excerpt: string } | null;
  createdAt: string;
  read: boolean;
  snoozedUntil: string | null;
}

/** A track group an item tells of: never its tracks. */
export interface InboxGroup {
  id: number;
  name: string;
  how: 'shared' | 'set';
  role: string | null;
}

/** What an alert item says (ADR-109). */
export interface InboxAlert {
  rule:
    | 'sign_in_failures_account'
    | 'sign_in_failures_address'
    | 'access_refusals'
    | 'bulk_exports'
    | 'ai_spend';
  count?: number;
  threshold?: number;
  windowMinutes?: number;
  userId?: number | null;
  userName?: string;
  userEmail?: string;
  tokenId?: number | null;
  address?: string | null;
  email?: string | null;
  percent?: number;
}

export type InboxView = 'all' | 'priority' | 'snoozed';
export interface UnreadCounts {
  all: number;
  priority: number;
}
export interface InboxPage {
  items: InboxItem[];
  unread: UnreadCounts;
  next: string | null;
}
export interface InboxQuery {
  view: InboxView;
  unread?: boolean;
  /** One notification event, such as `mentioned`. */
  event?: string;
  /** One track, by key. */
  track?: string;
  cursor?: string | null;
}
export interface InboxTrack {
  id: number;
  key: string;
  name: string;
}
export interface InboxChange {
  read?: boolean;
  snoozedUntil?: string | null;
}

export interface InboxClient {
  list(query: InboxQuery): Promise<InboxPage>;
  update(id: string, change: InboxChange): Promise<{ item: InboxItem; unread: UnreadCounts }>;
  /** Marks what a tab shows read, up to the newest item the reader saw. */
  readAll(query: {
    view: 'all' | 'priority';
    event?: string;
    track?: string;
    upTo?: string;
  }): Promise<{ marked: number; unread: UnreadCounts }>;
  /** The tracks the reader may filter by. */
  tracks(): Promise<InboxTrack[]>;
  /** Calls `onChange` whenever the reader's inbox changes; returns the way to stop. */
  subscribe(onChange: () => void): () => void;
}

/** The query string of a list request. */
export function listPath(query: InboxQuery): string {
  const params = new URLSearchParams({ view: query.view });
  if (query.unread) params.set('unread', 'true');
  if (query.event) params.set('event', query.event);
  if (query.track) params.set('track', query.track);
  if (query.cursor) params.set('cursor', query.cursor);
  return `/inbox?${params.toString()}`;
}

/**
 * The realtime socket (M1-032) also says when the reader's inbox changed (`{"type":"inbox"}`).
 * A dropped socket is opened again after a pause, and the inbox read once more then, since a
 * change may have gone by meanwhile.
 */
function subscribeSocket(onChange: () => void): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let version: string | null = null;
  const open = () => {
    if (stopped || typeof WebSocket === 'undefined') return;
    socket = openSocket('/sync/socket');
    keepAlive = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send('ping');
    }, 25_000);
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; version?: string };
        if (message.type !== 'inbox' || message.version === undefined) return;
        // The first message says where the inbox stands; only a move is a change.
        if (version !== null && message.version !== version) onChange();
        version = message.version;
      } catch {
        // Not ours: ignore.
      }
    });
    socket.addEventListener('close', () => {
      clearInterval(keepAlive);
      if (stopped) return;
      version = null;
      retry = setTimeout(() => {
        onChange();
        open();
      }, 3000);
    });
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(keepAlive);
    socket?.close();
  };
}

export const inboxClient: InboxClient = {
  list: (query) => api<InboxPage>(listPath(query)),
  update: (id, change) =>
    api<{ item: InboxItem; unread: UnreadCounts }>(`/inbox/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: change,
    }),
  readAll: (query) =>
    api<{ marked: number; unread: UnreadCounts }>('/inbox/read', { method: 'POST', body: query }),
  tracks: () => everyTrack<InboxTrack>(),
  subscribe: subscribeSocket,
};

/** When "Snooze" options end, in the reader's own time: in an hour, tomorrow and next week. */
export function snoozeTimes(now: Date): { hour: Date; tomorrow: Date; nextWeek: Date } {
  const hour = new Date(now.getTime() + 60 * 60 * 1000);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const nextWeek = new Date(now);
  // Next Monday at nine; a Monday goes to the one after.
  nextWeek.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  nextWeek.setHours(9, 0, 0, 0);
  return { hour, tomorrow, nextWeek };
}
