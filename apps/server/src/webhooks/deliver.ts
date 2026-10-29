import { createHmac } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { openSecret, type PepperRing } from '@taskmoor/iam';
import { type Kysely, sql } from 'kysely';
import type { JobRunner } from '../events/queue';
import { retryable, type WebhookFormat } from './model';
import { DELIVER_TASK } from './subscriber';

/**
 * Sending a webhook delivery (M1-067; API-009; ADR-055), one job per sending.
 *
 * - Headers: `X-Taskmoor-Event`, `X-Taskmoor-Delivery` (the id receivers deduplicate on; a
 *   replay keeps it), `X-Taskmoor-Webhook`, and for `json` with a secret
 *   `X-Taskmoor-Signature: sha256=<hex>`, the HMAC-SHA256 of the body's exact bytes with the
 *   secret. Matrix gets the access token as a bearer token, and the delivery id as the
 *   message's transaction id, so the homeserver drops a repeat itself.
 * - A 2xx answer delivers. 408, 409, 425, 429, 5xx, a timeout or a network error retry with
 *   the job queue's backoff (2, 4, 8, 16, 32 seconds) up to five times; anything else (other
 *   4xx, a redirect: redirects are not followed) fails at once. Each attempt is written to the
 *   delivery row. A webhook disabled or deleted meanwhile leaves the delivery failed.
 */
export interface DeliverDeps {
  peppers?: PepperRing | undefined;
  /** Replaced in tests; the platform's fetch otherwise. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class RetryLater extends Error {}

/** The signature header's value for a body. */
export function signature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function registerWebhookJobs(
  runner: JobRunner,
  db: Kysely<Database>,
  deps: DeliverDeps = {},
): void {
  const send = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  runner.handle(DELIVER_TASK, async (job) => {
    const { deliveryId } = job.payload as { deliveryId: string };
    const row = await db
      .selectFrom('webhook_delivery as d')
      .leftJoin('webhook as w', 'w.id', 'd.webhook_id')
      .select([
        'd.id',
        'd.state',
        'd.attempts',
        'd.event_type',
        'd.body',
        'w.id as webhook_id',
        'w.url',
        'w.format',
        'w.enabled',
        'w.secret_sealed',
      ])
      .where('d.id', '=', deliveryId)
      .executeTakeFirst();
    if (!row || row.state === 'delivered') return;
    const record = (values: {
      state?: 'pending' | 'delivered' | 'failed';
      last_status?: number | null;
      last_error?: string | null;
      duration_ms?: number | null;
    }) =>
      db
        .updateTable('webhook_delivery')
        .set({
          ...values,
          attempts: sql<number>`attempts + 1`,
          last_attempt_at: new Date(),
          ...(values.state === 'delivered' ? { delivered_at: new Date() } : {}),
        })
        .where('id', '=', deliveryId)
        .execute();
    if (!row.webhook_id || !row.enabled || !row.url) {
      await db
        .updateTable('webhook_delivery')
        .set({ state: 'failed', last_error: 'The webhook is disabled or deleted' })
        .where('id', '=', deliveryId)
        .execute();
      return;
    }
    const format = row.format as WebhookFormat;
    const body = JSON.stringify(row.body);
    const secret = row.secret_sealed ? openSecret(row.secret_sealed, deps.peppers) : null;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'Taskmoor-Webhook/1',
      'x-taskmoor-event': row.event_type,
      'x-taskmoor-delivery': row.id,
      'x-taskmoor-webhook': String(row.webhook_id),
    };
    if (format === 'json' && secret) headers['x-taskmoor-signature'] = signature(secret, body);
    if (format === 'matrix' && secret) headers.authorization = `Bearer ${secret}`;
    const target =
      format === 'matrix'
        ? `${row.url.replace(/\/+$/, '')}/${encodeURIComponent(row.id)}`
        : row.url;
    const started = Date.now();
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await send(target, {
        method: format === 'matrix' ? 'PUT' : 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      // The answer's body is not kept; reading it frees the connection.
      await res.arrayBuffer().catch(() => undefined);
    } catch (e) {
      error =
        e instanceof Error ? (e.name === 'TimeoutError' ? 'Timed out' : e.message) : String(e);
    }
    const duration = Date.now() - started;
    if (status !== null && status >= 200 && status < 300) {
      await record({
        state: 'delivered',
        last_status: status,
        last_error: null,
        duration_ms: duration,
      });
      return;
    }
    const retry = status === null || retryable(status);
    const last = job.attempts >= job.maxAttempts;
    const message = error ?? `HTTP ${status}`;
    await record({
      state: retry && !last ? 'pending' : 'failed',
      last_status: status,
      last_error: message,
      duration_ms: duration,
    });
    // The queue runs it again later with backoff; on the last attempt it stays failed.
    if (retry && !last) throw new RetryLater(message);
  });
}

/** Deliveries that went out keep 30 days; failed ones stay until replayed or deleted. */
export async function trimWebhookDeliveries(
  db: Kysely<Database>,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const result = await db
    .deleteFrom('webhook_delivery')
    .where('state', '=', 'delivered')
    .where('delivered_at', '<', cutoff)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
