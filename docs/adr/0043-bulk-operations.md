# ADR-043: Bulk operations run through the ticket routes, as the person who asked

- Status: Accepted
- Date: 2026-10-28
- Backlog: M1-021

## Context

CORE-024 asks for bulk edit, transition, move and delete (and later archive, assign, comment
and follow) as background jobs with progress, cancel and a per-ticket result report, for
people with Make bulk changes: 20,000 tickets in one job, tickets failing a check listed while
the rest succeed, no fixed cap, deletes going to the trash. The backlog asks for a 10,000-ticket
bulk edit in under two minutes with history and audit rows. Every single-ticket write already
enforces permissions, visibility levels, per-status and field locks (ADR-042), field rules,
history, events, formulas (M1-013) and the change log (M1-031); a second implementation for
bulk changes would drift from it.

## Decision

- **One implementation.** The ticket routes become plain handlers over a narrow `Caller` (the
  workspace, the person, their authorization context, the token if any, params, query and
  body) and an `Answer` (`code`, `send`): `ticketRoutes()` returns them, `registerTicketRoutes()`
  serves them over HTTP unchanged. A job builds a `Caller` for the person who asked and records
  each answer (`tickets/caller.ts`).
- **Data.** `bulk_operation` (action, its parameters, who, status queued, running, done or
  cancelled, counts, cancel asked) and `bulk_item` (one row per ticket in the order given, the
  reference asked, the ticket it named, and the outcome with the route's status and answer)
  (migration 0040).
- **Running.** The `bulk.run` job takes pending items 50 at a time, runs four at once through
  the matching handler (PATCH, move, DELETE, transitions; a transition by target status first
  reads the transitions offered), writes each outcome as it finishes, recounts after each batch
  and checks for a cancel between batches. A part runs for at most 50 seconds and queues the
  next, so no operation holds a worker for long. A worker that dies repeats at most the
  tickets in hand; edits are idempotent, a repeated transition fails as unavailable.
- **The person.** The operation acts with the asker's permissions as they are at each batch; a
  deactivated asker's remaining items fail as `requester_deactivated`. References that name no
  ticket fail at once as `not_found`, like tickets the asker may not see when their turn
  comes. Only the asker and site administrators see an operation and its items, and item keys
  only for tickets the reader may see now.
- **Audit.** `bulk_operation.created` and `bulk_operation.cancelled` are audited; each ticket's
  change is ticket activity in its history (M1-009), as for single changes.

## Selection by query (M1-037)

`POST /api/v1/bulk-operations` takes `query` (the query language, up to 100,000 characters)
instead of `tickets`; exactly one of the two (400 `tickets_or_query` otherwise). The server
runs the query as the person asking, with the same permission pre-filter as search (QRY-008),
and collects the matching ids in the query's order a keyset page of 1,000 at a time
(`search/run.ts` `collectIds`), each page under the search timeout. More than 100,000 matches
answer 400 `too_many_tickets`, none 400 `no_tickets`, and a query that cannot run the same
error search gives (`invalid_query`, `unsupported_query`, 503 `query_timeout`). The items are
those tickets, referenced by id; the operation's `params` keep the query, so the progress page
can show what chose them. The selection is a snapshot: tickets that match later are not
added, and each item is still checked when its turn comes.

## Options considered

| Option | For | Against |
|---|---|---|
| Handlers over a narrow caller (chosen) | One set of checks; nothing to keep in step | Handlers may only use the caller's fields |
| Set-based SQL per action | Fastest | Re-implements permissions, locks, rules, history, events, formulas |
| HTTP calls from the worker with a minted token | No refactor | A credential to keep and protect; impersonation path |

## Consequences

- New ticket write routes are callable from jobs if they keep to the `Caller` fields.
- Throughput is that of single writes, four at a time: a 10,000-ticket edit took 50 s
  (200 tickets a second, `bulk/bulk.large.test.ts`), within the two-minute budget. Raise the
  concurrency if heavier actions or larger operations need it.
- The progress page (`#/bulk/<id>`) reads the operation every two seconds until it finishes
  and words each refusal with the same texts as single changes (locks through `useLockText`).
- A `JobRunner` may claim only some tasks (`{ tasks }`); the e2e API server runs bulk jobs
  that way without touching other queued work.
- Selecting tickets by a query waits for the query compiler (M1-037); archive, comment and
  follow actions wait for their routes to be callable the same way.
