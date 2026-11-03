import { api } from '../../api/client';
import type { TicketLink, WebLink } from '../view/client';

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
  /** Links are on in the workspace. */
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
  scope: { trackKey?: string | undefined; exclude?: string | undefined } = {},
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
    `(${clauses.join(' OR ')})`,
  ];
  return `${where.join(' AND ')} ORDER BY updated DESC`;
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
};
