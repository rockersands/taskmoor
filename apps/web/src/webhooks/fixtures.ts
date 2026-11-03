import { ApiError } from '../api/client';
import type { Delivery, Webhook, WebhooksClient } from './client';

const WEBHOOKS: Webhook[] = [
  {
    id: 3,
    name: 'Payments channel',
    url: 'https://hooks.example.com/taskmoor',
    format: 'json',
    events: ['ticket.*', 'comment.created'],
    filterQuery: 'track = PAY',
    hasSecret: true,
    enabled: true,
    version: 2,
  },
  {
    id: 4,
    name: 'Team chat',
    url: 'https://chat.example.com/hooks/abc',
    format: 'mattermost',
    events: ['release.*'],
    filterQuery: null,
    hasSecret: false,
    enabled: false,
    version: 1,
  },
];

const DELIVERIES: Delivery[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    eventType: 'ticket.created',
    state: 'failed',
    attempts: 6,
    lastStatus: 503,
    lastError: 'Service Unavailable',
    lastAttemptAt: '2026-11-01T10:00:00.000Z',
    deliveredAt: null,
    replays: 0,
    createdAt: '2026-11-01T09:58:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    eventType: 'comment.created',
    state: 'delivered',
    attempts: 1,
    lastStatus: 200,
    lastError: null,
    lastAttemptAt: '2026-11-01T09:00:00.000Z',
    deliveredAt: '2026-11-01T09:00:00.000Z',
    replays: 0,
    createdAt: '2026-11-01T09:00:00.000Z',
  },
];

export interface FakeCall {
  action: string;
  args: unknown[];
}

/** Webhooks in memory, with the server's refusals of a name and an address. */
export function fakeWebhooksClient(
  start: Webhook[] = WEBHOOKS,
): WebhooksClient & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let webhooks = structuredClone(start);
  let next = 50;
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  return {
    calls,
    list: async () => structuredClone(webhooks),
    create: async (input) => {
      log('create', input);
      if (webhooks.some((w) => w.name === input.name)) {
        throw new ApiError(400, { error: 'invalid_fields', fields: { name: 'taken' } });
      }
      if (input.url.startsWith('http:')) {
        throw new ApiError(400, { error: 'invalid_fields', fields: { url: 'https_required' } });
      }
      webhooks.push({
        ...input,
        id: next++,
        hasSecret: Boolean(input.secret),
        version: 1,
      });
    },
    update: async (id, version, input) => {
      log('update', id, version, input);
      const found = webhooks.find((w) => w.id === id);
      if (!found) throw new ApiError(404, { error: 'not_found' });
      if (found.version !== version) throw new ApiError(409, { error: 'version_conflict' });
      const { secret, ...rest } = input;
      Object.assign(found, rest, { version: version + 1 });
      if (secret !== undefined) found.hasSecret = secret !== null;
    },
    remove: async (id) => {
      log('remove', id);
      webhooks = webhooks.filter((w) => w.id !== id);
    },
    deliveries: async (id, state) => {
      log('deliveries', id, state);
      return DELIVERIES.filter((d) => !state || d.state === state);
    },
    replay: async (id, ids) => {
      log('replay', id, ids);
    },
  };
}
