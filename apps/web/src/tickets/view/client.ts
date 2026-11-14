import type { PmJson } from '@taskmoor/richtext';
import { api } from '../../api/client';
import { everyPage } from '../../api/pages';
import { lockOfField } from '../../locks/useLockText';
import type { TicketForm } from '../form';

export interface Person {
  id: number;
  name: string;
}

/** A ticket as `GET /api/v1/tickets/:id` shows it, as far as the ticket view uses it. */
export interface TicketDetails {
  id: number;
  key: string;
  track: { id: number; key: string; name: string };
  ticketType: { id: number; name: string; icon?: string | null; level?: { rank: number } };
  parent: { id: number; key: string | null; summary: string | null } | null;
  status: { id: number; name: string; stage: 'new' | 'active' | 'closed' };
  summary: string;
  description?: PmJson | null;
  assignee: Person | null;
  requester: Person | null;
  creator?: Person | null;
  startDate: string | null;
  dueDate: string | null;
  priority: { id: number; name: string; level?: number } | null;
  closeReason: { id: number; name: string } | null;
  visibilityLevel: { id: number; name: string } | null;
  labels: string[];
  targetReleases: { id: number; name: string }[];
  foundInReleases: { id: number; name: string }[];
  areas: { id: number; name: string }[];
  followerCount: number;
  voteCount: number;
  timeTracking: {
    originalEstimate: number | null;
    remainingEstimate: number | null;
    timeSpent: number;
  };
  version: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Whether the reader may edit it: said when the ticket is read, and in the answer to an edit or
   * a transition, for the ticket as the change left it.
   */
  mayEdit?: boolean;
  /**
   * The fields the reader may change now (`summary`, `assignee`, `cf[12]`), said with `mayEdit`:
   * permissions, the status's locks, field rules and the edit layout all allow it.
   */
  editableFields?: string[];
  /** Custom values, keyed by field id. */
  fields?: Record<string, unknown>;
}

/**
 * Whether the reader may change a field (T-191): as reading the ticket said, else, from a server
 * that does not say per field, whether they may edit the ticket. The server checks again.
 */
export function mayChange(ticket: TicketDetails, key: string): boolean {
  return ticket.editableFields ? ticket.editableFields.includes(key) : ticket.mayEdit !== false;
}

/** A number field on the ticket's edit form, such as Points (AGL-007). */
export interface NumberField {
  id: number;
  name: string;
  /** A field rule or the ticket's status keeps the person from changing it. */
  locked: boolean;
}

export interface Transition {
  id: number;
  name: string;
  to: { id: number; name: string; stage: string };
  /** Fields the transition asks for; the view runs those without any. */
  layout: string[];
}

export interface HistoryEntry {
  id: string;
  at: string;
  actor: Person | null;
  field: string;
  /** A custom field's row: its name, when it applies to the ticket where it is now (T-277). */
  fieldName?: string | null;
  /** A custom field's row: its values are calendar days (`date`) or instants (`datetime`). */
  valueType?: 'date' | 'datetime' | null;
  from: { value: string | null; display: string | null };
  to: { value: string | null; display: string | null };
  transitionId: number | null;
}

/**
 * One entry of a ticket's activity, as `GET /api/v1/tickets/:id/activity` answers it: a change
 * set (who, when, the fields it changed), with the comment it added or deleted when the reader
 * may read it (`excerpt` null once deleted).
 */
export interface ActivityEntry {
  changeSet: string;
  at: string;
  actor: Person | null;
  comment: { id: number; excerpt: string | null } | null;
  changes: Pick<HistoryEntry, 'field' | 'fieldName' | 'valueType' | 'from' | 'to'>[];
}

/**
 * A page of a ticket's whole activity, newest first (T-309): its change sets, the time entries
 * that started in the stretch of time they cover, and where the next page starts.
 */
export interface ActivityPage {
  activity: ActivityEntry[];
  timeEntries: TimeEntry[];
  next: string | null;
}

export interface TimeEntry {
  id: number;
  author: Person;
  startedAt: string;
  duration: number;
  description: string;
  visibility: unknown;
}

export interface TicketLink {
  id: number;
  type: { id: number; name: string };
  phrase: string;
  ticket: { id: number; key: string; summary: string; closed: boolean };
}

export interface WebLink {
  id: number;
  url: string;
  title: string;
}

/** A ticket's read-only info fields, as `GET /api/v1/tickets/:id/info` answers (M1-125). */
export interface TicketInfo {
  firstResponse: string | null;
  lastComment: string | null;
  daysSinceLastComment: number | null;
  participants: Person[];
  timeInStatus: { status: { id: number; name: string }; seconds: number; visits: number }[];
}

export interface Priority {
  id: number;
  name: string;
  /** Which of the six icons it shows, from its place in the order (CORE-014). */
  level?: number;
}

export type TicketEdit = Partial<{
  summary: string;
  assigneeId: number | null;
  priorityId: number | null;
  labels: string[];
  startDate: string | null;
  dueDate: string | null;
  fields: Record<string, number | null>;
}>;

/** The endpoints the ticket view uses. Stories and tests pass their own. */
export interface TicketClient {
  get: (ticket: string) => Promise<TicketDetails>;
  /** Records that the person opened the ticket, for their Recent list (M1-052). */
  visit?: (id: number) => Promise<void>;
  edit: (id: number, change: TicketEdit) => Promise<TicketDetails>;
  transitions: (id: number) => Promise<Transition[]>;
  transition: (
    id: number,
    transitionId: number,
    fields?: Record<string, unknown>,
  ) => Promise<TicketDetails>;
  following: (id: number) => Promise<{ count: number; mine: boolean }>;
  follow: (id: number, on: boolean) => Promise<void>;
  votes: (id: number) => Promise<{ count: number; mine: boolean }>;
  vote: (id: number, on: boolean) => Promise<void>;
  history: (
    id: number,
    before?: string,
  ) => Promise<{ changes: HistoryEntry[]; next: string | null }>;
  /** A page of everything that happened on the ticket, newest first (CORE-022 "All"). */
  activity: (id: number, cursor?: string) => Promise<ActivityPage>;
  timeEntries: (id: number) => Promise<TimeEntry[]>;
  logTime: (id: number, entry: { duration: string; description: string }) => Promise<TimeEntry>;
  links: (id: number) => Promise<{ links: TicketLink[]; webLinks: WebLink[] }>;
  /** The read-only info fields (M1-125); without it the panel is not shown. */
  info?: (id: number) => Promise<TicketInfo>;
  priorities: () => Promise<Priority[]>;
  closeReasons: () => Promise<Priority[]>;
  /** The number fields on its edit form; without it the page shows none. */
  numberFields?: (id: number) => Promise<NumberField[]>;
}

export const ticketClient: TicketClient = {
  get: async (ticket) =>
    (await api<{ ticket: TicketDetails }>(`/tickets/${encodeURIComponent(ticket)}`)).ticket,
  visit: async (id) => {
    await api<unknown>(`/me/recent-tickets/${id}`, { method: 'PUT' });
  },
  edit: async (id, change) =>
    (await api<{ ticket: TicketDetails }>(`/tickets/${id}`, { method: 'PATCH', body: change }))
      .ticket,
  transitions: async (id) =>
    (await api<{ transitions: Transition[] }>(`/tickets/${id}/transitions`)).transitions,
  transition: async (id, transitionId, fields) =>
    (
      await api<{ ticket: TicketDetails }>(`/tickets/${id}/transitions`, {
        method: 'POST',
        body: { transitionId, ...(fields && Object.keys(fields).length > 0 ? { fields } : {}) },
      })
    ).ticket,
  following: (id) => api<{ count: number; mine: boolean }>(`/tickets/${id}/followers`),
  follow: async (id, on) => {
    await api<unknown>(`/tickets/${id}/followers/me`, { method: on ? 'PUT' : 'DELETE' });
  },
  votes: (id) => api<{ count: number; mine: boolean }>(`/tickets/${id}/votes`),
  vote: async (id, on) => {
    await api<unknown>(`/tickets/${id}/votes`, { method: on ? 'PUT' : 'DELETE' });
  },
  history: (id, before) =>
    api<{ changes: HistoryEntry[]; next: string | null }>(
      `/tickets/${id}/history?limit=50${before === undefined ? '' : `&cursor=${before}`}`,
    ),
  activity: (id, cursor) =>
    api<ActivityPage>(
      `/tickets/${id}/activity?kind=all&limit=50${cursor === undefined ? '' : `&cursor=${cursor}`}`,
    ),
  // Every entry, oldest first: the route answers 100 a page by default, and the newest are last.
  timeEntries: (id) =>
    everyPage<TimeEntry, number>(async (after) => {
      const page = await api<{ timeEntries: TimeEntry[]; next: number | null }>(
        `/tickets/${id}/time-entries?limit=500${after === null ? '' : `&cursor=${after}`}`,
      );
      return { items: page.timeEntries, next: page.next };
    }),
  logTime: async (id, entry) =>
    (
      await api<{ timeEntry: TimeEntry }>(`/tickets/${id}/time-entries`, {
        method: 'POST',
        body: entry,
      })
    ).timeEntry,
  links: (id) => api<{ links: TicketLink[]; webLinks: WebLink[] }>(`/tickets/${id}/links`),
  info: async (id) => (await api<{ info: TicketInfo }>(`/tickets/${id}/info`)).info,
  priorities: async () => (await api<{ priorities: Priority[] }>('/priorities')).priorities,
  numberFields: async (id) => {
    const form = await api<TicketForm>(`/tickets/${id}/layout?operation=edit`);
    const placed = new Set(
      form.layout.tabs.flatMap((tab) => tab.sections.flatMap((s) => s.fields.map((f) => f.key))),
    );
    return form.customFields
      .filter((f) => f.type === 'number' && placed.has(`cf[${f.id}]`))
      .map((f) => ({
        id: f.id,
        name: f.name,
        locked: lockOfField(form.locks, `cf[${f.id}]`) !== null,
      }));
  },
  closeReasons: async () =>
    (await api<{ closeReasons: Priority[] }>('/close-reasons')).closeReasons,
};
