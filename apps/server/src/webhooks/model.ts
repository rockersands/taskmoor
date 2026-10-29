import { z } from 'zod';
import type { DomainEvent, EventType } from '../events/catalogue';

/**
 * Webhooks (M1-067; API-009; ADR-055): what a site administrator registers and what is sent.
 *
 * - **Events** are those of spec 02a section 1.3, by their native names: tickets, their
 *   comments, attachments, time entries and links, ticket types, tracks, releases, saved
 *   searches, people, sprints and boards. Sign-ins, tokens, passwords, second factors and the
 *   rest of the security events never leave the instance. A webhook names exact types or a
 *   family (`ticket.*`).
 * - **The query** applies to events about one ticket: the event's ticket must match it as the
 *   webhook's owner sees it. Events about anything else are not filtered.
 * - **Formats**: `json` (the native body, signed with HMAC-SHA256 when a secret is set) or a
 *   chat message for Slack, Microsoft Teams or Mattermost incoming webhooks, or a Matrix room
 *   (the secret is the access token there).
 * - **Retries**: up to five after the first attempt, with backoff, on 408, 409, 425, 429,
 *   5xx and network errors; any other answer fails at once.
 */
export const WEBHOOK_FORMATS = ['json', 'slack', 'teams', 'mattermost', 'matrix'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** Spec 02a section 1.3, in this catalogue's names. */
export const WEBHOOK_EVENTS = [
  'ticket.created',
  'ticket.updated',
  'ticket.transitioned',
  'ticket.moved',
  'ticket.deleted',
  'ticket.restored',
  'ticket.purged',
  'ticket.linked',
  'ticket.unlinked',
  'ticket.web_link_added',
  'ticket.web_link_updated',
  'ticket.web_link_removed',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'attachment.created',
  'attachment.deleted',
  'time_entry.created',
  'time_entry.updated',
  'time_entry.deleted',
  'ticket_type.created',
  'ticket_type.updated',
  'ticket_type.deleted',
  'track.created',
  'track.updated',
  'track.archived',
  'track.restored',
  'track.deleted',
  'track.undeleted',
  'release.created',
  'release.updated',
  'release.reordered',
  'release.shipped',
  'release.unshipped',
  'release.merged',
  'release.deleted',
  'saved_search.created',
  'saved_search.updated',
  'saved_search.deleted',
  'user.created',
  'user.updated',
  'user.deactivated',
  'user.reactivated',
  'sprint.created',
  'sprint.updated',
  'sprint.started',
  'sprint.completed',
  'sprint.deleted',
  'sprint.tickets_added',
  'sprint.tickets_removed',
  'board.created',
  'board.updated',
  'board.deleted',
  'link_policy.updated',
  'time_tracking.settings_updated',
] as const satisfies readonly EventType[];

const OFFERED: ReadonlySet<string> = new Set(WEBHOOK_EVENTS);

/** Whether a webhook taking `patterns` takes an event of `type`. */
export function eventMatches(patterns: readonly string[], type: string): boolean {
  if (!OFFERED.has(type)) return false;
  return patterns.some((p) => p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))));
}

/** An exact offered type, or a family with at least one offered type. */
export function validPattern(pattern: string): boolean {
  if (OFFERED.has(pattern)) return true;
  if (!/^[a-z_]+\.\*$/.test(pattern)) return false;
  const prefix = pattern.slice(0, -1);
  return WEBHOOK_EVENTS.some((t) => t.startsWith(prefix));
}

/**
 * Where a webhook may send: HTTPS, or plain HTTP on this machine (development and tests) or
 * when `TASKMOOR_WEBHOOK_ALLOW_HTTP=true`; never with a user name or password in the address.
 */
export function urlProblem(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'not_a_url';
  }
  if (url.username || url.password) return 'credentials_in_url';
  if (url.protocol === 'https:') return null;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && (local || process.env.TASKMOOR_WEBHOOK_ALLOW_HTTP === 'true')) {
    return null;
  }
  return 'https_required';
}

/** HTTP answers worth another try (API-009); network errors and timeouts count too. */
export function retryable(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/** The first attempt and five retries. */
export const MAX_ATTEMPTS = 6;

/** The ticket an event is about, when it is about one ticket. */
export function ticketOf(event: Pick<DomainEvent, 'subjectType' | 'subjectId' | 'payload'>) {
  if (event.subjectType === 'ticket') return Number(event.subjectId);
  const payload = event.payload as { ticketId?: unknown } | null;
  return typeof payload?.ticketId === 'number' ? payload.ticketId : null;
}

const name = z.string().trim().min(1).max(255);
const url = z.string().trim().min(1).max(2000);
const events = z.array(z.string().trim().min(1).max(100)).min(1).max(200);
const filterQuery = z.string().trim().min(1).max(10_000).nullable();
// A shared secret long enough to be one, or a Matrix access token.
const secret = z.string().min(16).max(2000).nullable();

export const createWebhookBody = z
  .object({
    name,
    url,
    format: z.enum(WEBHOOK_FORMATS).default('json'),
    events,
    filterQuery: filterQuery.optional(),
    secret: secret.optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

export const updateWebhookBody = z
  .object({
    version: z.number().int().positive().optional(),
    name: name.optional(),
    url: url.optional(),
    format: z.enum(WEBHOOK_FORMATS).optional(),
    events: events.optional(),
    filterQuery: filterQuery.optional(),
    secret: secret.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const replayBody = z
  .object({
    /** These deliveries; or every failed one of the webhook (at most 1,000 at a time). */
    deliveryIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
    failed: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (b) => (b.deliveryIds === undefined) !== (b.failed === undefined),
    'deliveryIds or failed',
  );
