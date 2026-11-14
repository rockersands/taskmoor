import { api } from '../api/client';
import type { Lock } from '../locks/useLockText';

/** A bulk operation as `GET /api/v1/bulk-operations/:id` shows it (M1-021; CORE-024). */
export interface BulkOperation {
  id: number;
  action: 'edit' | 'move' | 'transition' | 'delete' | 'clone';
  status: 'queued' | 'running' | 'done' | 'cancelled';
  cancelRequested: boolean;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  pending: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** What the change was: the action's own part of the request, and the query that chose them. */
  params?: BulkParams;
}

/** The change a bulk operation makes, as it was asked for (D14 names it on the page). */
export interface BulkParams {
  /** For an edit: the fields set, as the ticket route takes them (`priorityId`, `labels`, …). */
  edit?: Record<string, unknown>;
  /** For a move: the track the tickets go to, by key or id. */
  move?: { track?: string | number };
  /** For a transition: the status to reach, or the workflow transition to take, and its fields. */
  transition?: { statusId?: number; transitionId?: number; fields?: Record<string, unknown> };
  /** The query whose results were the tickets, when one chose them. */
  query?: string;
}

/** Why a ticket was not changed: the answer its own route gave. */
export interface BulkError {
  error?: string;
  permission?: string;
  locks?: Lock[];
  by?: string;
}

export interface BulkItem {
  position: number;
  ref: string;
  /** The ticket's key, when the reader may see it now. */
  key: string | null;
  outcome: 'done' | 'failed' | 'skipped' | 'pending';
  statusCode: number | null;
  error: BulkError | null;
  /** For a clone (M1-124): the copy the item made, while the reader may see it. */
  result?: {
    ticket: { id: number; key: string };
    attachments: number;
    links: number;
    webLinks: number;
    left: string[];
  } | null;
}

/** The endpoints the page uses; stories and tests pass their own. */
export interface BulkClient {
  get(id: number): Promise<BulkOperation>;
  failures(id: number, after?: number): Promise<{ items: BulkItem[]; next: number | null }>;
  /** The tickets the change reached, to link them (D14). */
  changed?(id: number, after?: number): Promise<{ items: BulkItem[]; next: number | null }>;
  /** The site's priorities, to name the one an edit set. */
  priorities?(): Promise<{ id: number; name: string }[]>;
  /** The site's statuses, to name the one a transition or an edit took the tickets to. */
  statuses?(): Promise<{ id: number; name: string }[]>;
  /** The site's close reasons, to name the one an edit set. */
  closeReasons?(): Promise<{ id: number; name: string }[]>;
  cancel(id: number): Promise<BulkOperation>;
}

const items = (id: number, outcome: 'failed' | 'done', after: number | undefined) =>
  api<{ items: BulkItem[]; next: number | null }>(
    `/bulk-operations/${id}/items?outcome=${outcome}&limit=100${after === undefined ? '' : `&after=${after}`}`,
  );

export const bulkClient: BulkClient = {
  get: async (id) =>
    (await api<{ bulkOperation: BulkOperation }>(`/bulk-operations/${id}`)).bulkOperation,
  failures: (id, after) => items(id, 'failed', after),
  changed: (id, after) => items(id, 'done', after),
  priorities: async () =>
    (await api<{ priorities: { id: number; name: string }[] }>('/priorities')).priorities,
  statuses: async () =>
    (await api<{ statuses: { id: number; name: string }[] }>('/statuses')).statuses,
  closeReasons: async () =>
    (await api<{ closeReasons: { id: number; name: string }[] }>('/close-reasons')).closeReasons,
  cancel: async (id) =>
    (
      await api<{ bulkOperation: BulkOperation }>(`/bulk-operations/${id}/cancel`, {
        method: 'POST',
      })
    ).bulkOperation,
};
