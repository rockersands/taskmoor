import type { TicketLink } from '../view/client';
import type { LinkType, PickedTicket, TicketLinks, TicketToolsClient } from './client';

export const LINK_TYPES: LinkType[] = [
  { id: 1, name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
  { id: 2, name: 'Copies', outward: 'copies', inward: 'is copied by' },
  { id: 3, name: 'Duplicates', outward: 'duplicates', inward: 'is duplicated by' },
  { id: 4, name: 'Relates', outward: 'relates to', inward: 'relates to' },
];

/** Tickets of the track SHOP the picker can find, and one of another track it must not. */
export const SHOP_TICKETS: PickedTicket[] = [
  { id: 39, key: 'SHOP-39', summary: 'Payment page times out', status: { name: 'In progress' } },
  { id: 40, key: 'SHOP-40', summary: 'Retry a failed payment', status: { name: 'To do' } },
  { id: 42, key: 'SHOP-42', summary: 'Receipt email is empty', status: { name: 'Closed' } },
];

export const STARTING_LINKS: TicketLink[] = [
  {
    id: 1,
    type: { id: 1, name: 'Blocks' },
    phrase: 'blocks',
    ticket: { id: 39, key: 'SHOP-39', summary: 'Payment page times out', closed: false },
  },
  {
    id: 2,
    type: { id: 1, name: 'Blocks' },
    phrase: 'is blocked by',
    ticket: { id: 88, key: 'OPS-88', summary: 'Database upgrade', closed: true },
  },
];

export interface FakeToolsClient extends TicketToolsClient {
  calls: { action: string; args: unknown[] }[];
}

/** An in-memory backend for the ticket's tools, for stories and tests. */
export function fakeToolsClient(
  start: { links?: TicketLink[]; mayLink?: boolean; enabled?: boolean } = {},
): FakeToolsClient {
  const links = structuredClone(start.links ?? STARTING_LINKS);
  const calls: FakeToolsClient['calls'] = [];
  let next = 100;
  const state = (): TicketLinks => ({
    links: structuredClone(links),
    webLinks: [{ id: 7, url: 'https://example.test/pr/7', title: 'Pull request 7' }],
    mayLink: start.mayLink ?? true,
    enabled: start.enabled ?? true,
  });
  return {
    calls,
    linkTypes: async () => ({ enabled: start.enabled ?? true, linkTypes: LINK_TYPES }),
    links: async () => state(),
    addLink: async (ticketId, link) => {
      calls.push({ action: 'addLink', args: [ticketId, link] });
      const type = LINK_TYPES.find((t) => t.id === link.linkTypeId) as LinkType;
      const other = SHOP_TICKETS.find((t) => t.id === link.ticket) as PickedTicket;
      const made: TicketLink = {
        id: next++,
        type: { id: type.id, name: type.name },
        phrase: type[link.direction],
        ticket: { id: other.id, key: other.key, summary: other.summary, closed: false },
      };
      links.push(made);
      return made;
    },
    removeLink: async (ticketId, linkId) => {
      calls.push({ action: 'removeLink', args: [ticketId, linkId] });
      links.splice(
        links.findIndex((l) => l.id === linkId),
        1,
      );
    },
    pick: async (query) => {
      calls.push({ action: 'pick', args: [query] });
      const wanted = /summary ~ "([^"*]*)\*?"/.exec(query)?.[1]?.toLowerCase() ?? '';
      const key = /key = "([^"]*)"/.exec(query)?.[1];
      return SHOP_TICKETS.filter(
        (ticket) => ticket.key === key || ticket.summary.toLowerCase().includes(wanted),
      );
    },
  };
}
