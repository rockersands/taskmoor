import { ApiError } from '../../api/client';
import type { BulkItem, BulkOperation } from '../../bulk/client';
import type { NamedField } from '../customFieldNames';
import type { CloneSource } from './CloneDialog';
import type { CloneClient, CloneRequest, CloneTrack } from './client';

/** SHOP-7, an outcome with tickets below it. */
export const OUTCOME: CloneSource = {
  id: 70,
  key: 'SHOP-7',
  summary: 'Checkout in one step',
  track: { id: 1, key: 'SHOP', name: 'Shop' },
  level: 1,
};

/** SHOP-9, a subticket of SHOP-8. */
export const SUBTICKET: CloneSource = {
  id: 90,
  key: 'SHOP-9',
  summary: 'Card vault',
  track: { id: 1, key: 'SHOP', name: 'Shop' },
  level: -1,
};

export const TRACKS: CloneTrack[] = [
  { id: 1, key: 'SHOP', name: 'Shop' },
  { id: 2, key: 'PAY', name: 'Payments' },
];

const operation = (total: number): BulkOperation => ({
  id: 31,
  action: 'clone',
  status: 'queued',
  cancelRequested: false,
  total,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  pending: total,
  createdAt: '2026-10-30T09:00:00Z',
  startedAt: null,
  finishedAt: null,
});

/** The first item of a clone that made PAY-40, with what it left out. */
export const copied = (left: string[] = []): BulkItem => ({
  position: 0,
  ref: 'SHOP-7',
  key: 'SHOP-7',
  outcome: 'done',
  statusCode: 201,
  error: null,
  result: { ticket: { id: 400, key: 'PAY-40' }, attachments: 1, links: 2, webLinks: 0, left },
});

export interface FakeClone {
  client: CloneClient;
  requests: CloneRequest[];
  /** The tracks (by id) whose field catalogue was read. */
  fieldReads: number[];
}

/** The field catalogues of SHOP (1) and PAY (2): Risk applies to SHOP only. */
export const FIELDS: Record<number, NamedField[]> = {
  1: [
    { id: 12, name: 'Story size' },
    { id: 14, name: 'Risk' },
    { id: 15, name: 'Points' },
  ],
  2: [
    { id: 12, name: 'Story size' },
    { id: 15, name: 'Points' },
  ],
};

/**
 * A clone backend in memory: `start` answers an operation of `total` tickets (or `refuse`),
 * each progress read finishes `step` more, and the first item is `first` once it is done;
 * `failed` of them fail. With `fields`, the field catalogue of each track (by id); `fields: 'refuse'`
 * refuses every read.
 */
export function fakeCloneClient(
  options: {
    total?: number;
    step?: number;
    failed?: number;
    first?: BulkItem;
    refuse?: ApiError;
    fields?: Record<number, NamedField[]> | 'refuse';
  } = {},
): FakeClone {
  const requests: CloneRequest[] = [];
  const fieldReads: number[] = [];
  const catalogues = options.fields;
  const total = options.total ?? 5;
  const failed = options.failed ?? 0;
  let done = 0;
  const now = (): BulkOperation => {
    const pending = total - done;
    return {
      ...operation(total),
      status: pending === 0 ? 'done' : 'running',
      succeeded: done - Math.min(done, failed),
      failed: Math.min(done, failed),
      pending,
    };
  };
  const client: CloneClient = {
    tracks: async () => TRACKS,
    start: async (_id, request) => {
      requests.push(request);
      if (options.refuse) throw options.refuse;
      return operation(total);
    },
    progress: async () => {
      done = Math.min(total, done + (options.step ?? total));
      return now();
    },
    first: async () => (done === total ? (options.first ?? copied()) : null),
    ...(catalogues
      ? {
          fieldNames: async (trackId: number) => {
            fieldReads.push(trackId);
            if (catalogues === 'refuse') throw new ApiError(403, { error: 'forbidden' });
            return catalogues[trackId] ?? [];
          },
        }
      : {}),
  };
  return { client, requests, fieldReads };
}

export const FORBIDDEN = new ApiError(403, { error: 'forbidden', permission: 'create_tickets' });
export const TOO_MANY = new ApiError(400, {
  error: 'too_many_tickets',
  max: 10000,
  guardrail: 'tickets_per_bulk_operation',
});
