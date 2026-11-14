import type { BulkClient, BulkItem, BulkOperation } from './client';

/** A bulk edit of 1,200 tickets, part way through. */
export const RUNNING: BulkOperation = {
  id: 7,
  action: 'edit',
  status: 'running',
  cancelRequested: false,
  total: 1200,
  succeeded: 640,
  failed: 3,
  skipped: 0,
  pending: 557,
  createdAt: '2026-10-29T09:00:00Z',
  startedAt: '2026-10-29T09:00:01Z',
  finishedAt: null,
};

export const FAILURES: BulkItem[] = [
  {
    position: 4,
    ref: 'SHOP-12',
    key: 'SHOP-12',
    outcome: 'failed',
    statusCode: 403,
    error: {
      error: 'forbidden',
      permission: 'edit',
      locks: [
        {
          by: 'status',
          statusId: 4,
          statusName: 'Approved',
          allowed: [{ type: 'group', id: 7, name: 'Approvers' }],
        },
      ],
    },
  },
  {
    position: 9,
    ref: 'SHOP-19',
    key: 'SHOP-19',
    outcome: 'failed',
    statusCode: 403,
    error: { error: 'forbidden', permission: 'edit_tickets' },
  },
  {
    position: 31,
    ref: 'OLD-3',
    key: null,
    outcome: 'failed',
    statusCode: 404,
    error: { error: 'not_found' },
  },
];

/** An in-memory operation that moves on each read until it is done, or is cancelled. */
export function fakeBulkClient(
  start: BulkOperation = RUNNING,
  options: {
    step?: number;
    failures?: BulkItem[];
    /** The tickets changed, for the links under a finished change (D14). */
    changed?: BulkItem[];
    priorities?: { id: number; name: string }[];
  } = {},
): BulkClient & { cancelled: () => boolean } {
  let op = { ...start };
  let cancelled = false;
  const step = options.step ?? 0;
  return {
    get: async () => {
      if (op.status === 'running' && step > 0) {
        if (op.cancelRequested) {
          op = { ...op, status: 'cancelled', skipped: op.pending, pending: 0 };
        } else {
          const n = Math.min(step, op.pending);
          op = { ...op, succeeded: op.succeeded + n, pending: op.pending - n };
          if (op.pending === 0) op = { ...op, status: 'done' };
        }
      }
      return { ...op };
    },
    failures: async () => ({ items: options.failures ?? FAILURES, next: null }),
    changed: async () => ({ items: options.changed ?? [], next: null }),
    priorities: async () => options.priorities ?? [],
    cancel: async () => {
      cancelled = true;
      op = { ...op, cancelRequested: true };
      return { ...op };
    },
    cancelled: () => cancelled,
  };
}
