import { api } from '../../api/client';
import { everyTrack } from '../../api/tracks';
import type { BulkItem, BulkOperation } from '../../bulk/client';
import type { ReadFieldNames } from '../customFieldNames';
import { ticketClient } from '../view/client';

/** A track the copies may go to, as `GET /api/v1/tracks` lists it. */
export interface CloneTrack {
  id: number;
  key: string;
  name: string;
  /** Its colour, edging its mark in the Track picker (T-255). */
  color?: string | null;
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
  /**
   * The custom fields of a track (by its id), from the field catalogue, to name a field the copy
   * was made without (T-352). Without it such a field reads 'a custom field'.
   */
  fieldNames?: ReadFieldNames | undefined;
}

export const cloneClient: CloneClient = {
  // Every track the person sees, a page at a time.
  tracks: () => everyTrack<CloneTrack>(),
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
  fieldNames: ticketClient.fieldNames,
};
