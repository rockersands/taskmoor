import type { WebhookFormat } from './model';

/**
 * What a webhook sends (M1-067; API-009; ADR-055). The native `json` body carries the delivery
 * id, the event as the catalogue records it and, for an event about a ticket the webhook's
 * owner sees, the ticket's key, summary, status, type, track and link. The chat formats turn
 * the same facts into one line of text for Slack, Microsoft Teams, Mattermost or Matrix.
 */
export interface TicketSummary {
  id: number;
  key: string;
  summary: string;
  status: string;
  type: string;
  track: { id: number; key: string };
}

export interface DeliveryFacts {
  deliveryId: string;
  webhook: { id: number; name: string };
  event: {
    id: string;
    type: string;
    occurredAt: Date;
    subjectType: string;
    subjectId: string;
    payload: unknown;
  };
  actor: { id: number; name: string } | null;
  ticket: TicketSummary | null;
  /** Where browsers reach this instance, for links. */
  publicUrl: string;
}

const ticketUrl = (facts: DeliveryFacts, t: TicketSummary) =>
  `${facts.publicUrl.replace(/\/+$/, '')}/#/tickets/${encodeURIComponent(t.key)}`;

/** The native body: what a receiver parses and verifies. */
export function jsonBody(facts: DeliveryFacts) {
  return {
    id: facts.deliveryId,
    event: facts.event.type,
    eventId: facts.event.id,
    occurredAt: facts.event.occurredAt.toISOString(),
    webhook: facts.webhook,
    actor: facts.actor,
    subject: { type: facts.event.subjectType, id: facts.event.subjectId },
    data: facts.event.payload ?? {},
    ...(facts.ticket ? { ticket: { ...facts.ticket, url: ticketUrl(facts, facts.ticket) } } : {}),
  };
}

/** What happened, as a verb phrase about the subject ("commented on"). */
const VERBS: Record<string, string> = {
  'ticket.created': 'created',
  'ticket.updated': 'updated',
  'ticket.transitioned': 'moved',
  'ticket.moved': 'moved to another track',
  'ticket.deleted': 'deleted',
  'ticket.restored': 'restored',
  'ticket.purged': 'purged',
  'ticket.linked': 'linked',
  'ticket.unlinked': 'unlinked',
  'ticket.web_link_added': 'added a web link to',
  'ticket.web_link_updated': 'changed a web link of',
  'ticket.web_link_removed': 'removed a web link from',
  'ticket.property_set': 'set a property of',
  'ticket.property_deleted': 'deleted a property of',
  'comment.created': 'commented on',
  'comment.updated': 'edited a comment on',
  'comment.deleted': 'deleted a comment on',
  'attachment.created': 'attached a file to',
  'attachment.deleted': 'removed a file from',
  'time_entry.created': 'logged time on',
  'time_entry.updated': 'changed logged time on',
  'time_entry.deleted': 'removed logged time from',
};

interface Line {
  /** Who did it, or "Taskmoor" for the system. */
  who: string;
  /** The verb phrase and what it was about, without the ticket. */
  what: string;
  /** The ticket, when the event is about one the owner sees. */
  ticket: { key: string; summary: string; status: string; url: string } | null;
}

function line(facts: DeliveryFacts): Line {
  const who = facts.actor?.name ?? 'Taskmoor';
  const t = facts.ticket;
  if (t) {
    const verb = VERBS[facts.event.type] ?? facts.event.type;
    return {
      who,
      what: verb,
      ticket: { key: t.key, summary: t.summary, status: t.status, url: ticketUrl(facts, t) },
    };
  }
  const payload = facts.event.payload as { name?: unknown } | null;
  const named = typeof payload?.name === 'string' ? ` "${payload.name}"` : '';
  const [noun, action] = facts.event.type.split('.');
  return {
    who,
    what: `${(action ?? '').replaceAll('_', ' ')} ${(noun ?? '').replaceAll('_', ' ')}${named}`,
    ticket: null,
  };
}

const plain = (l: Line) =>
  l.ticket
    ? `${l.who} ${l.what} ${l.ticket.key} ${l.ticket.summary} (${l.ticket.status}) ${l.ticket.url}`
    : `${l.who} ${l.what}`;

/** Slack's mrkdwn: &, < and > are the only characters to escape. */
const slackEscape = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Markdown: the characters that would start formatting or a link. */
const markdownEscape = (s: string) => s.replace(/([\\`*_[\]()<>#|~])/g, '\\$1');

const htmlEscape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** The body for a webhook's format. */
export function bodyFor(format: WebhookFormat, facts: DeliveryFacts): unknown {
  if (format === 'json') return jsonBody(facts);
  const l = line(facts);
  switch (format) {
    case 'slack':
      return {
        text: l.ticket
          ? `${slackEscape(l.who)} ${l.what} <${l.ticket.url}|${slackEscape(l.ticket.key)}> ${slackEscape(l.ticket.summary)} (${slackEscape(l.ticket.status)})`
          : `${slackEscape(l.who)} ${slackEscape(l.what)}`,
      };
    case 'mattermost':
      return {
        text: l.ticket
          ? `${markdownEscape(l.who)} ${l.what} [${markdownEscape(l.ticket.key)}](${l.ticket.url}) ${markdownEscape(l.ticket.summary)} (${markdownEscape(l.ticket.status)})`
          : `${markdownEscape(l.who)} ${markdownEscape(l.what)}`,
      };
    case 'teams':
      // An Adaptive Card in a message, as Teams incoming webhooks and workflows take it.
      return {
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                {
                  type: 'TextBlock',
                  text: l.ticket ? `${l.who} ${l.what} ${l.ticket.key}` : `${l.who} ${l.what}`,
                  wrap: true,
                  weight: 'Bolder',
                },
                ...(l.ticket
                  ? [
                      {
                        type: 'TextBlock',
                        text: `${l.ticket.summary} (${l.ticket.status})`,
                        wrap: true,
                      },
                    ]
                  : []),
              ],
              actions: l.ticket
                ? [{ type: 'Action.OpenUrl', title: `Open ${l.ticket.key}`, url: l.ticket.url }]
                : [],
            },
          },
        ],
      };
    case 'matrix':
      // A room message event: plain text, and HTML for clients that show it.
      return {
        msgtype: 'm.text',
        body: plain(l),
        format: 'org.matrix.custom.html',
        formatted_body: l.ticket
          ? `${htmlEscape(l.who)} ${l.what} <a href="${htmlEscape(l.ticket.url)}">${htmlEscape(l.ticket.key)}</a> ${htmlEscape(l.ticket.summary)} (${htmlEscape(l.ticket.status)})`
          : `${htmlEscape(l.who)} ${htmlEscape(l.what)}`,
      };
  }
}
