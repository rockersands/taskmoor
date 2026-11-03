import { api } from '../api/client';

export const WEBHOOK_FORMATS = ['json', 'slack', 'teams', 'mattermost', 'matrix'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** A webhook as `GET /api/v1/webhooks` shows it; the secret is write-only. */
export interface Webhook {
  id: number;
  name: string;
  url: string;
  format: WebhookFormat;
  events: string[];
  filterQuery: string | null;
  hasSecret: boolean;
  enabled: boolean;
  version: number;
}

export type DeliveryState = 'pending' | 'delivered' | 'failed';

/** One event sent, or waiting to be sent, to a webhook. */
export interface Delivery {
  id: string;
  eventType: string;
  state: DeliveryState;
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  replays: number;
  createdAt: string;
}

export interface WebhookInput {
  name: string;
  url: string;
  format: WebhookFormat;
  events: string[];
  filterQuery: string | null;
  /** A new one; null removes it; left out keeps it. */
  secret?: string | null;
  enabled: boolean;
}

/** The endpoints the webhooks page uses. Stories and tests pass their own. */
export interface WebhooksClient {
  list: () => Promise<Webhook[]>;
  create: (input: WebhookInput) => Promise<void>;
  update: (id: number, version: number, input: WebhookInput) => Promise<void>;
  remove: (id: number) => Promise<void>;
  deliveries: (id: number, state: DeliveryState | null) => Promise<Delivery[]>;
  /** These deliveries, or every failed one. */
  replay: (id: number, deliveryIds: string[] | 'failed') => Promise<void>;
}

export const webhooksClient: WebhooksClient = {
  list: async () => (await api<{ webhooks: Webhook[] }>('/webhooks')).webhooks,
  create: async (input) => {
    await api<unknown>('/webhooks', { method: 'POST', body: input });
  },
  update: async (id, version, input) => {
    await api<unknown>(`/webhooks/${id}`, { method: 'PATCH', body: { version, ...input } });
  },
  remove: async (id) => {
    await api<unknown>(`/webhooks/${id}`, { method: 'DELETE' });
  },
  deliveries: async (id, state) =>
    (
      await api<{ deliveries: Delivery[] }>(
        `/webhooks/${id}/deliveries?limit=100${state ? `&state=${state}` : ''}`,
      )
    ).deliveries,
  replay: async (id, deliveryIds) => {
    await api<unknown>(`/webhooks/${id}/deliveries/replay`, {
      method: 'POST',
      body: deliveryIds === 'failed' ? { failed: true } : { deliveryIds },
    });
  },
};
