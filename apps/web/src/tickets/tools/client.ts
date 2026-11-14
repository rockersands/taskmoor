import { api } from '../../api/client';
import type { TicketForm } from '../form';
import {
  type Priority,
  type TicketDetails,
  type TicketLink,
  type Transition,
  ticketClient,
  type WebLink,
} from '../view/client';

/** A ticket the picker offers: what a person may see, as search answers it. */
export interface PickedTicket {
  id: number;
  key: string;
  summary: string;
  status: { name: string };
}

/** The workspace's kinds of link, with the phrase each side reads (CORE-018). */
export interface LinkType {
  id: number;
  name: string;
  outward: string;
  inward: string;
}

/** One choice in the "How it relates" list: a link type read from one side. */
export interface LinkCategory {
  id: string;
  linkTypeId: number;
  direction: 'outward' | 'inward';
  phrase: string;
}

/** What a ticket's links say on its page (`GET /tickets/:id/links`). */
export interface TicketLinks {
  links: TicketLink[];
  webLinks: WebLink[];
  /** May this person add and remove links here. */
  mayLink?: boolean;
  /** Links are on for the site. */
  enabled?: boolean;
}

/**
 * The categories a link type offers, one per side; a type that reads the same from both sides
 * ("relates to") offers one. In the order the site lists its types.
 */
export function linkCategories(types: readonly LinkType[]): LinkCategory[] {
  return types.flatMap((type) => {
    const outward: LinkCategory = {
      id: `${type.id}-outward`,
      linkTypeId: type.id,
      direction: 'outward',
      phrase: type.outward,
    };
    if (type.outward.toLowerCase() === type.inward.toLowerCase()) return [outward];
    return [
      outward,
      { id: `${type.id}-inward`, linkTypeId: type.id, direction: 'inward', phrase: type.inward },
    ];
  });
}

/** A value as the query language reads it: a quoted string with its quotes escaped. */
const quoted = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The query behind the picker (CORE-031): what was typed, read as a ticket's number or key and as
 * words of its summary, the last word as a prefix so that matches appear while typing. Only
 * letters and digits reach the text search, so nothing typed can change the query. Null when
 * nothing was typed that could match.
 *
 * It runs through the search route, whose permission filter is part of the statement, so a ticket
 * the person may not see is never offered (QRY-008).
 */
export function pickerQuery(
  typed: string,
  scope: {
    trackKey?: string | undefined;
    exclude?: string | undefined;
    /** Only tickets at this hierarchy level (CORE-006): a parent one level up (T-265). */
    level?: number | undefined;
  } = {},
): string | null {
  const text = typed.trim();
  if (text === '') return null;
  const clauses: string[] = [];
  const key = /^([A-Za-z][A-Za-z0-9_]*)-(\d{1,9})$/.exec(text);
  if (key) clauses.push(`key = ${quoted(text.toUpperCase())}`);
  const number = /^#?(\d{1,9})$/.exec(text);
  if (number && scope.trackKey) {
    clauses.push(`key = ${quoted(`${scope.trackKey}-${number[1]}`)}`);
  }
  const words = text.match(/[\p{L}\p{N}]+/gu);
  if (words) clauses.push(`summary ~ ${quoted(`${words.join(' ')}*`)}`);
  if (clauses.length === 0) return null;
  const where = [
    ...(scope.trackKey ? [`track = ${quoted(scope.trackKey)}`] : []),
    ...(scope.exclude ? [`key != ${quoted(scope.exclude)}`] : []),
    ...(scope.level !== undefined ? [`hierarchyLevel = ${Math.trunc(scope.level)}`] : []),
    `(${clauses.join(' OR ')})`,
  ];
  return `${where.join(' AND ')} ORDER BY updated DESC`;
}

/** How far along the tickets under a ticket are (CORE-032). */
export interface SubticketProgress {
  total: number;
  closed: number;
}

/** A ticket under another, as its parent's page lists it. */
export interface ChildTicket {
  id: number;
  key: string;
  summary: string;
  /** Search answers the status's id too; the list tells it from where a move goes (TT-6). */
  status: { id?: number; name: string; stage: 'new' | 'active' | 'closed' };
}

/** A ticket type that may sit one level under a ticket. */
export interface ChildType {
  id: number;
  name: string;
  /** The icon the track's administrator chose for the type; its name's own when none. */
  icon?: string | null;
}

export type ItemState = 'open' | 'in_progress' | 'done' | 'rejected';

export interface ChecklistItem {
  id: number;
  text: string;
  state: ItemState;
}

/** How far along a checklist is; a rejected item is left out of `counted` (CORE-033). */
export interface ChecklistProgress {
  done: number;
  counted: number;
  percent: number | null;
}

export interface Checklist {
  id: number;
  name: string;
  items: ChecklistItem[];
  progress: ChecklistProgress;
}

/** A ticket's checklists as every checklist route answers them. */
export interface TicketChecklists {
  checklists: Checklist[];
  progress: ChecklistProgress;
  canEdit: boolean;
  /** The status lock that holds editing back, when one does (WF-007). */
  lock: unknown;
}

/** The endpoints the ticket's tools use. Stories and tests pass their own. */
export interface TicketToolsClient {
  linkTypes: () => Promise<{ enabled: boolean; linkTypes: LinkType[] }>;
  links: (ticketId: number) => Promise<TicketLinks>;
  addLink: (
    ticketId: number,
    link: { linkTypeId: number; direction: 'outward' | 'inward'; ticket: number },
  ) => Promise<TicketLink>;
  removeLink: (ticketId: number, linkId: number) => Promise<void>;
  /** Tickets for the picker, from a query `pickerQuery` wrote. */
  pick: (query: string) => Promise<PickedTicket[]>;
  checklists: (ticketId: number) => Promise<TicketChecklists>;
  addChecklist: (ticketId: number, name: string) => Promise<TicketChecklists>;
  renameChecklist: (ticketId: number, id: number, name: string) => Promise<TicketChecklists>;
  removeChecklist: (ticketId: number, id: number) => Promise<TicketChecklists>;
  orderChecklists: (ticketId: number, ids: number[]) => Promise<TicketChecklists>;
  addItem: (ticketId: number, checklistId: number, text: string) => Promise<TicketChecklists>;
  updateItem: (
    ticketId: number,
    checklistId: number,
    itemId: number,
    change: { text?: string; state?: ItemState },
  ) => Promise<TicketChecklists>;
  removeItem: (ticketId: number, checklistId: number, itemId: number) => Promise<TicketChecklists>;
  orderItems: (ticketId: number, checklistId: number, ids: number[]) => Promise<TicketChecklists>;
  subticketProgress: (ids: number[]) => Promise<Record<string, SubticketProgress>>;
  /** The tickets under a ticket, in key order; through search, so only what the person sees. */
  children: (
    key: string,
    cursor?: string,
  ) => Promise<{ tickets: ChildTicket[]; next: string | null }>;
  /** The track's ticket types one level under `rank`. */
  childTypes: (track: string, rank: number) => Promise<ChildType[]>;
  /**
   * The custom fields on a ticket type's create form, by id and name: the form the create page
   * reads, so a refused subticket can name what it asks for. Without it they go by number.
   */
  childFields?: (track: string, ticketTypeId: number) => Promise<{ id: number; name: string }[]>;
  createChild: (ticket: {
    track: string;
    parent: string;
    ticketTypeId: number;
    summary: string;
  }) => Promise<{ id: number; key: string }>;
  /**
   * Where a subticket can go from its status, and moving it there (CORE-032; TT-6): the ticket
   * page's own routes, so the workflow, its conditions and the person's rights all apply. Without
   * them the list shows each status as text.
   */
  childTransitions?: (id: number) => Promise<Transition[]>;
  moveChild?: (
    id: number,
    transitionId: number,
    fields?: Record<string, unknown>,
  ) => Promise<Pick<TicketDetails, 'id' | 'key' | 'status'>>;
  /** What a move that asks for a close reason or a priority offers. */
  closeReasons?: () => Promise<Priority[]>;
  priorities?: () => Promise<Priority[]>;
}

/**
 * How many tickets the progress route takes at once (the server's `MAX_IDS`): every card of the
 * largest board. A list that has loaded more pages than that asks in parts.
 */
export const SUBTICKET_PROGRESS_IDS = 50_000;

/** Progress for a board or a list: the same route the ticket page reads, in parts if need be. */
export async function loadSubticketProgress(
  ids: number[],
): Promise<Record<string, SubticketProgress>> {
  const unique = [...new Set(ids)];
  const found: Record<string, SubticketProgress> = {};
  for (let at = 0; at < unique.length; at += SUBTICKET_PROGRESS_IDS) {
    const { progress } = await api<{ progress: Record<string, SubticketProgress> }>(
      '/tickets/subticket-progress',
      { method: 'POST', body: { ids: unique.slice(at, at + SUBTICKET_PROGRESS_IDS) } },
    );
    Object.assign(found, progress);
  }
  return found;
}

export const ticketToolsClient: TicketToolsClient = {
  linkTypes: () => api<{ enabled: boolean; linkTypes: LinkType[] }>('/link-types'),
  links: (ticketId) => api<TicketLinks>(`/tickets/${ticketId}/links`),
  addLink: async (ticketId, link) =>
    (
      await api<{ link: TicketLink }>(`/tickets/${ticketId}/links`, {
        method: 'POST',
        body: link,
      })
    ).link,
  removeLink: async (ticketId, linkId) => {
    await api<unknown>(`/tickets/${ticketId}/links/${linkId}`, { method: 'DELETE' });
  },
  pick: async (query) =>
    (
      await api<{ tickets: PickedTicket[] }>('/search', {
        method: 'POST',
        body: { q: query, limit: 8, fields: 'summary,status', count: false },
      })
    ).tickets,
  checklists: (ticketId) => api<TicketChecklists>(`/tickets/${ticketId}/checklists`),
  addChecklist: (ticketId, name) =>
    api<TicketChecklists>(`/tickets/${ticketId}/checklists`, {
      method: 'POST',
      body: { name },
    }),
  renameChecklist: (ticketId, id, name) =>
    api<TicketChecklists>(`/tickets/${ticketId}/checklists/${id}`, {
      method: 'PATCH',
      body: { name },
    }),
  removeChecklist: (ticketId, id) =>
    api<TicketChecklists>(`/tickets/${ticketId}/checklists/${id}`, { method: 'DELETE' }),
  orderChecklists: (ticketId, ids) =>
    api<TicketChecklists>(`/tickets/${ticketId}/checklists/order`, {
      method: 'PUT',
      body: { ids },
    }),
  addItem: (ticketId, checklistId, text) =>
    api<TicketChecklists>(`/tickets/${ticketId}/checklists/${checklistId}/items`, {
      method: 'POST',
      body: { text },
    }),
  updateItem: (ticketId, checklistId, itemId, change) =>
    api<TicketChecklists>(`/tickets/${ticketId}/checklists/${checklistId}/items/${itemId}`, {
      method: 'PATCH',
      body: change,
    }),
  removeItem: (ticketId, checklistId, itemId) =>
    api<TicketChecklists>(`/tickets/${ticketId}/checklists/${checklistId}/items/${itemId}`, {
      method: 'DELETE',
    }),
  orderItems: (ticketId, checklistId, ids) =>
    api<TicketChecklists>(`/tickets/${ticketId}/checklists/${checklistId}/items/order`, {
      method: 'PUT',
      body: { ids },
    }),
  subticketProgress: loadSubticketProgress,
  children: async (key, cursor) => {
    const page = await api<{ tickets: ChildTicket[]; next: string | null }>('/search', {
      method: 'POST',
      body: {
        q: `parent = ${quoted(key)} ORDER BY key ASC`,
        limit: 50,
        fields: 'summary,status',
        count: false,
        ...(cursor ? { cursor } : {}),
      },
    });
    return { tickets: page.tickets, next: page.next };
  },
  childTypes: async (track, rank) =>
    (
      await api<{
        ticketTypes: { id: number; name: string; icon?: string | null; level: { rank: number } }[];
      }>(`/tracks/${encodeURIComponent(track)}/ticket-types`)
    ).ticketTypes
      .filter((type) => type.level.rank === rank - 1)
      .map((type) => ({ id: type.id, name: type.name, icon: type.icon ?? null })),
  childFields: async (track, ticketTypeId) =>
    (
      await api<TicketForm>(
        `/tracks/${encodeURIComponent(track)}/layout?ticketTypeId=${ticketTypeId}&operation=create`,
      )
    ).customFields.map((field) => ({ id: field.id, name: field.name })),
  createChild: async (ticket) =>
    (
      await api<{ ticket: { id: number; key: string } }>('/tickets', {
        method: 'POST',
        body: ticket,
      })
    ).ticket,
  childTransitions: (id) => ticketClient.transitions(id),
  moveChild: (id, transitionId, fields) => ticketClient.transition(id, transitionId, fields),
  closeReasons: () => ticketClient.closeReasons(),
  priorities: () => ticketClient.priorities(),
};
