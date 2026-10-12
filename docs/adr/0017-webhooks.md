# ADR-017: Webhooks with signatures, idempotency, replay and no expiry

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024

## Context

Jira's dynamic webhooks expire after 30 days and filter on a subset of JQL, two of the most
cited integration pains. The spec (API-009) asks for full query-language filters, an
HMAC-SHA256 signature, a unique delivery id, retries with backoff, a failed-delivery list with
replay, and no expiry.

## Decision

- **Source of events: the transactional outbox** (ADR-015). Every domain event is written in
  the transaction that caused it; a relay fans each event out to the subscriptions whose filter
  matches, enqueuing one delivery job per subscription with the event id as the idempotency key.
- **Filters are queries.** A subscription's filter is compiled by the query compiler
  (ADR-010) and evaluated against the affected item at relay time, so custom fields and
  functions work in filters exactly as in search.
- **Delivery:** HTTPS only (HTTP allowed for localhost in development); headers carry the
  delivery id, event type, timestamp and `X-Taskmoor-Signature: sha256=<hmac>` over
  timestamp plus body; the shim adds `X-Hub-Signature`. Up to 5 retries with exponential
  backoff on 408, 409, 425, 429 and 5xx; other 4xx are failures without retry. Delivery
  timeout 10 s; receiver clock skew tolerated at 5 minutes for signature checks.
- **Operations:** the subscription page shows recent deliveries with request, response and
  timing; failed deliveries can be replayed singly or in bulk; a subscription that fails for 7
  days is paused with a notification, never deleted. Secrets rotate with an overlap window
  (both signatures sent).
- **No expiry.** Subscriptions live until deleted.

## Options considered

| Option | For | Against |
|---|---|---|
| Outbox-driven, signed, replayable (chosen) | Exactly-once semantics at the source; audit trail; no lost events on crash | Delivery lag of one relay cycle (tens of milliseconds) |
| Send from the request path | Lowest latency | Lost on crash; slows the request; no replay |
| Expiring subscriptions | Garbage collects forgotten endpoints | The pain this product removes; pausing after failures achieves the same hygiene |

## Consequences

Webhooks share the queue's observability (depth, failures) and its tests. The same relay feeds
the automation engine's event triggers (AUT-002) and the OpenSearch adapter (ADR-011).
