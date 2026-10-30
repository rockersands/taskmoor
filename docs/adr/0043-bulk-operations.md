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

## The bulk API (M1-130; API-007)

The routes above are the asynchronous bulk API; M1-130 makes them part of the stable contract
and adds the two things API-007 asks for beyond them.

- **Contract.** `createBulkOperation` (202), `listBulkOperations`, `getBulkOperation`,
  `listBulkItems` (keyset pages, `next` cursor) and `cancelBulkOperation` (202) are stable
  operations under the "Bulk changes" tag, with `BulkOperation` and `BulkItem` schemas. The
  contract test calls each one, so the OpenAPI document and the SDK cannot drift from the
  routes.
- **A configurable limit.** The most tickets one operation may take is the guardrail
  `tickets_per_bulk_operation` (default 10,000; ADR-051's table of limits, overridable per
  workspace by a site administrator). The route takes the smaller of the guardrail and the
  hard ceiling of 100,000, for a ticket list and a query alike, and answers 400
  `too_many_tickets` with `max` and the guardrail's name, so a client can say which limit it
  met. The guardrail page shows its usage as the largest operation so far.
- **Fourteen days of results.** An operation and its per-ticket results stay readable for 14
  days after it finishes (`BULK_RETENTION_DAYS`). The housekeeping loop deletes finished
  operations older than that (`trimBulkOperations`; items go with them by the foreign key);
  queued and running ones are never trimmed. After that, the routes answer 404 as for an
  operation that never existed.
- **Measured.** A transition of 1,000 tickets, half to one status and half to another, with
  ten that have no such transition, finishes with 990 succeeded and 10 failed with
  `no_transition`, and the items read back a page at a time (`bulk/bulk.test.ts`).

## Clones (M1-124; CORE-023)

A clone or deep clone is a bulk operation of a fifth action, `clone`, started by
`POST /api/v1/tickets/:id/clone` without "Make bulk changes" (ADR-077). Its items run one at a
time, parents first, and record their own outcome; `bulk_item` gained `result_ticket_id` (the
copy) and `result` (what came with it), and the items route shows the copy as `result`
(migration 0061).

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
