# ADR-055: Webhooks as event-bus subscribers with recorded, replayable deliveries

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-067

## Context

API-009 asks Taskmoor to deliver the events of spec 02a section 1.3 to registered HTTPS
endpoints, filtered by any query (custom fields and functions included), signed with
HMAC-SHA256, with a unique delivery id for deduplication, up to five retries with backoff on
408, 409, 425, 429 and 5xx, a failed-delivery list with replay that keeps the original id,
delivery within 5 s at p95, and no expiry. M1-067 adds chat notifications for Slack, Microsoft
Teams, Mattermost and Matrix. Two-way chat (create tickets from messages, threads as comments)
is NTF-010 in M2. The domain event bus (ADR-015, M1-005) already writes one event per mutation
in its transaction and turns events into keyed, retried jobs per subscriber.

## Decision

- **A subscriber of the event bus** (`apps/server/src/webhooks/subscriber.ts`) takes the
  offered event types. For each enabled webhook of the workspace that takes the type it
  records a `webhook_delivery` (migration 0053) with the exact body to send and queues a
  `webhook:deliver` job, in one transaction keyed by webhook and event: the bus delivering an
  event twice (it is at least once) records one delivery.
- **What is offered** is spec 02a section 1.3 in this catalogue's names (tickets and their
  comments, attachments, time entries and links; ticket types; tracks; releases; saved
  searches; people; sprints, including scope changes; boards; two site options). Sign-ins,
  sessions, tokens, passwords, second factors and other security events never leave the
  instance, whatever a webhook asks for. A webhook names exact types or a family (`ticket.*`).
- **The query runs as the webhook's owner** (the site administrator who registered it): an
  event about one ticket goes out only when the owner sees the ticket and it matches the query
  as the owner reads it (functions like `currentUser()` are the owner's). It is bound with
  the board machinery (`bindCondition`, the compiler's conditions over `ticket k`) and checked
  with one indexed statement per webhook and event. A trashed ticket is judged as it was; a
  purged one reaches only webhooks without a query. Events not about one ticket are not
  filtered. A query that no longer binds records a failed delivery saying why, so a broken
  filter is visible rather than silently dropping events. A deactivated owner's webhook sends
  no ticket events.
- **The body** (`json`) carries the delivery id, the event as the catalogue records it, the
  actor, and for a ticket event the ticket's key, summary, status, type, track and link.
  Chat formats turn the same facts into one line: Slack (`text` in mrkdwn), Mattermost
  (`text` in Markdown), Teams (an Adaptive Card in a message) and Matrix (an `m.room.message`
  with HTML). Each escapes what its renderer would misread; Slack and Teams have no escape for
  `*` and `_`, so a summary with them may show emphasis there.
- **Sending** is one job per sending (`webhooks/deliver.ts`): headers `X-Taskmoor-Event`,
  `X-Taskmoor-Delivery`, `X-Taskmoor-Webhook`, and for `json` with a secret
  `X-Taskmoor-Signature: sha256=<hex>` over the body's exact bytes. Matrix gets the secret as a
  bearer token and the delivery id as the transaction id, so the homeserver drops a repeat.
  Redirects are not followed. 2xx delivers; 408, 409, 425, 429, 5xx, timeouts (10 s) and
  network errors throw, and the job queue retries with its backoff (2, 4, 8, 16, 32 s), six
  attempts in all; anything else fails at once. Every attempt is written to the row.
- **Replay** (`POST /api/v1/webhooks/:id/deliveries/replay`, named ids or every failed one)
  sends the recorded body under the same id with a fresh set of retries (a new job key per
  replay). Deliveries that went out keep 30 days (the worker's housekeeping trims them);
  failed ones stay until replayed or their webhook is deleted. Webhooks never expire.
- **Administration**: `/api/v1/webhooks` is for site administrators and needs a token's admin
  scope. Addresses must be HTTPS, or plain HTTP on this machine or with
  `TASKMOOR_WEBHOOK_ALLOW_HTTP=true`, never with credentials in them. Secrets are sealed with
  the pepper ring and write-only. Changes emit `webhook.created`, `.updated`, `.deleted` and
  `.delivery_replayed`, all audited.

## Options considered

| Option | For | Against |
|---|---|---|
| Event-bus subscriber plus a delivery row per webhook and event (chosen) | Reuses the bus's at-least-once relay and the queue's retries; the row is the failed list and the replay source | A row per delivery to keep and trim |
| Send from the request that changed the ticket | No queue | Slow and failing endpoints stall or fail user requests; no retries |
| Only the job queue, no delivery table | Fewer writes | Nothing to list or replay once a job is done; the body would be rebuilt on replay and differ |
| Evaluate the query with the search engine's paging | One code path with search | A page per event; checking one ticket by id is one indexed statement |
| A list of private address ranges refused (SSRF) | Protects internal services | Self-hosted installs often post to internal chat and CI hosts; only site administrators register, and the audit log records it |

## Consequences

- Latency: the worker relays events every 200 ms when idle, so a delivery goes out well under a
  second after its transaction; the test measures p95 over 20 tickets against the 5 s budget.
- The shim's registration endpoint (`/rest/webhooks/1.0/webhook`) and its `X-Hub-Signature`
  header come with the Jira-compatible API work; they can reuse these tables.
- Not yet: a web page for webhooks (API only), honouring a receiver's `Retry-After`, and
  dynamic registration for apps.
