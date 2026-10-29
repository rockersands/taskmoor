import { api } from '../api/client';
import type { Lock } from '../locks/useLockText';

/** A bulk operation as `GET /api/v1/bulk-operations/:id` shows it (M1-021; CORE-024). */
export interface BulkOperation {
  id: number;
  action: 'edit' | 'move' | 'transition' | 'delete';
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
}

/** The endpoints the page uses; stories and tests pass their own. */
export interface BulkClient {
  get(id: number): Promise<BulkOperation>;
  failures(id: number, after?: number): Promise<{ items: BulkItem[]; next: number | null }>;
  cancel(id: number): Promise<BulkOperation>;
}

export const bulkClient: BulkClient = {
  get: async (id) =>
    (await api<{ bulkOperation: BulkOperation }>(`/bulk-operations/${id}`)).bulkOperation,
  failures: (id, after) =>
    api<{ items: BulkItem[]; next: number | null }>(
      `/bulk-operations/${id}/items?outcome=failed&limit=100${after === undefined ? '' : `&after=${after}`}`,
    ),
  cancel: async (id) =>
    (
      await api<{ bulkOperation: BulkOperation }>(`/bulk-operations/${id}/cancel`, {
        method: 'POST',
      })
    ).bulkOperation,
};
