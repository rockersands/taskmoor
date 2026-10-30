import { api } from '../../api/client';
import type { BulkItem, BulkOperation } from '../../bulk/client';

/** A track the copies may go to, as `GET /api/v1/tracks` lists it. */
export interface CloneTrack {
  id: number;
  key: string;
  name: string;
}

/** What `POST /api/v1/tickets/:id/clone` takes (M1-124; CORE-023). */
export interface CloneRequest {
  track?: string;
  summary?: string;
  subtickets: boolean;
  descendants: boolean;
  attachments: boolean;
  links: boolean;
}

/** The endpoints the clone dialog uses; stories and tests pass their own. */
export interface CloneClient {
  tracks(): Promise<CloneTrack[]>;
  /** Starts the clone: a bulk operation that makes the copies. */
  start(ticketId: number, request: CloneRequest): Promise<BulkOperation>;
  progress(operationId: number): Promise<BulkOperation>;
  /** The result for the ticket asked for: the first item, with its copy. */
  first(operationId: number): Promise<BulkItem | null>;
}

export const cloneClient: CloneClient = {
  tracks: async () => {
    // Every track the person sees, a page at a time.
    const all: CloneTrack[] = [];
    let after: string | null = null;
    do {
      const page: { tracks: CloneTrack[]; next: string | null } = await api(
        `/tracks?limit=500${after === null ? '' : `&after=${encodeURIComponent(after)}`}`,
      );
      all.push(...page.tracks);
      after = page.next;
    } while (after !== null && all.length < 10_000);
    return all;
  },
  start: async (ticketId, request) =>
    (
      await api<{ bulkOperation: BulkOperation }>(`/tickets/${ticketId}/clone`, {
        method: 'POST',
        body: request,
      })
    ).bulkOperation,
  progress: async (id) =>
    (await api<{ bulkOperation: BulkOperation }>(`/bulk-operations/${id}`)).bulkOperation,
  first: async (id) =>
    (await api<{ items: BulkItem[] }>(`/bulk-operations/${id}/items?limit=1`)).items[0] ?? null,
};
