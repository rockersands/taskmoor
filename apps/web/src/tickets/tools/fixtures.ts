import type { TicketLink } from '../view/client';
import type {
  Checklist,
  ChecklistItem,
  ChecklistProgress,
  ChildTicket,
  LinkType,
  PickedTicket,
  TicketChecklists,
  TicketLinks,
  TicketToolsClient,
} from './client';

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

export const STARTING_CHILDREN: ChildTicket[] = [
  {
    id: 201,
    key: 'SHOP-201',
    summary: 'Write the retry rules',
    status: { name: 'Done', stage: 'closed' },
  },
  {
    id: 202,
    key: 'SHOP-202',
    summary: 'Test on the slow network',
    status: { name: 'In progress', stage: 'active' },
  },
];

/** As the server works it out (`checklistProgress`): a rejected item is left out. */
const progressOf = (items: readonly ChecklistItem[]): ChecklistProgress => {
  const counted = items.filter((item) => item.state !== 'rejected');
  const done = counted.filter((item) => item.state === 'done').length;
  return {
    done,
    counted: counted.length,
    percent: counted.length === 0 ? null : Math.round((done / counted.length) * 100),
  };
};

const items = (...rows: [string, ChecklistItem['state']][]): ChecklistItem[] =>
  rows.map(([text, state], i) => ({ id: 300 + i, text, state }));

export const STARTING_CHECKLISTS: Checklist[] = [
  {
    id: 30,
    name: 'Before release',
    items: items(
      ['Write the notes', 'done'],
      ['Tag the build', 'done'],
      ['Run the upgrade', 'done'],
      ['Tell the people', 'open'],
      ['Print it', 'rejected'],
    ),
    progress: { done: 3, counted: 4, percent: 75 },
  },
];

/** The custom fields on a subticket's create form, as the fake answers for every type. */
export const CHILD_FORM_FIELDS = [
  { id: 12, name: 'Customer' },
  { id: 41, name: 'Points' },
];

export interface FakeToolsClient extends TicketToolsClient {
  calls: { action: string; args: unknown[] }[];
}

/** An in-memory backend for the ticket's tools, for stories and tests. */
export function fakeToolsClient(
  start: {
    links?: TicketLink[];
    mayLink?: boolean;
    enabled?: boolean;
    children?: ChildTicket[];
    childTypes?: { id: number; name: string }[];
    checklists?: Checklist[];
    canEdit?: boolean;
  } = {},
): FakeToolsClient {
  const links = structuredClone(start.links ?? STARTING_LINKS);
  const calls: FakeToolsClient['calls'] = [];
  const children = structuredClone(start.children ?? STARTING_CHILDREN);
  let next = 100;
  let lists = structuredClone(start.checklists ?? STARTING_CHECKLISTS);
  const answer = (): TicketChecklists => {
    for (const list of lists) list.progress = progressOf(list.items);
    return {
      checklists: structuredClone(lists),
      progress: progressOf(lists.flatMap((list) => list.items)),
      canEdit: start.canEdit ?? true,
      lock: null,
    };
  };
  const listById = (id: number) => lists.find((list) => list.id === id) as Checklist;
  const ordered = <T extends { id: number }>(rows: T[], ids: number[]) =>
    ids.map((id) => rows.find((row) => row.id === id) as T);
  const state = (): TicketLinks => ({
    links: structuredClone(links),
    webLinks: start.links
      ? []
      : [{ id: 7, url: 'https://example.test/pr/7', title: 'Pull request 7' }],
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
    checklists: async () => answer(),
    addChecklist: async (ticketId, name) => {
      calls.push({ action: 'addChecklist', args: [ticketId, name] });
      lists.push({
        id: next++,
        name,
        items: [],
        progress: { done: 0, counted: 0, percent: null },
      });
      return answer();
    },
    renameChecklist: async (ticketId, id, name) => {
      calls.push({ action: 'renameChecklist', args: [ticketId, id, name] });
      listById(id).name = name;
      return answer();
    },
    removeChecklist: async (ticketId, id) => {
      calls.push({ action: 'removeChecklist', args: [ticketId, id] });
      lists = lists.filter((list) => list.id !== id);
      return answer();
    },
    orderChecklists: async (ticketId, ids) => {
      calls.push({ action: 'orderChecklists', args: [ticketId, ids] });
      lists = ordered(lists, ids);
      return answer();
    },
    addItem: async (ticketId, checklistId, text) => {
      calls.push({ action: 'addItem', args: [ticketId, checklistId, text] });
      listById(checklistId).items.push({ id: next++, text, state: 'open' });
      return answer();
    },
    updateItem: async (ticketId, checklistId, itemId, change) => {
      calls.push({ action: 'updateItem', args: [ticketId, checklistId, itemId, change] });
      Object.assign(
        listById(checklistId).items.find((i) => i.id === itemId) as ChecklistItem,
        change,
      );
      return answer();
    },
    removeItem: async (ticketId, checklistId, itemId) => {
      calls.push({ action: 'removeItem', args: [ticketId, checklistId, itemId] });
      const list = listById(checklistId);
      list.items = list.items.filter((i) => i.id !== itemId);
      return answer();
    },
    orderItems: async (ticketId, checklistId, ids) => {
      calls.push({ action: 'orderItems', args: [ticketId, checklistId, ids] });
      const list = listById(checklistId);
      list.items = ordered(list.items, ids);
      return answer();
    },
    subticketProgress: async (ids) => {
      calls.push({ action: 'subticketProgress', args: [ids] });
      if (children.length === 0) return {};
      return Object.fromEntries(
        ids.map((id) => [
          String(id),
          {
            total: children.length,
            closed: children.filter((c) => c.status.stage === 'closed').length,
          },
        ]),
      );
    },
    children: async () => ({ tickets: structuredClone(children), next: null }),
    childTypes: async () => start.childTypes ?? [{ id: 9, name: 'Subticket' }],
    childFields: async (track, ticketTypeId) => {
      calls.push({ action: 'childFields', args: [track, ticketTypeId] });
      return CHILD_FORM_FIELDS;
    },
    createChild: async (ticket) => {
      calls.push({ action: 'createChild', args: [ticket] });
      const made = {
        id: next++,
        key: `SHOP-${next + 200}`,
        summary: ticket.summary,
        status: { name: 'To do', stage: 'new' as const },
      };
      children.push(made);
      return { id: made.id, key: made.key };
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
