# ADR-077: Clone and deep clone run as a bulk operation, each copy made through the create route

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-124

## Context

CORE-023 asks for a clone with options (subtickets, attachments, links) that leaves a Copies
link to its original, and a deep clone of a parent with everything below it into another
track. Its acceptance criteria are: (1) a clone with subtickets, attachments and links creates a
Copies link to the source; (2) a deep clone copies an outcome and three levels of descendants
into another track. Moving tickets (criterion 3) was built with M1-008.

Forces:

- A copy is a new ticket. Creating one involves the track's type set, the workflow map's initial
  status and its create effects, field rules and create layouts, field locks, the visibility
  level, formulas, custom field side tables, history and the `ticket.created` event. The create
  route already does all of that; writing rows directly would duplicate it and drift.
- A deep clone can be hundreds or thousands of tickets, and attachments can be gigabytes: too
  much for one request.
- The Copies link type already exists (migration 0019 seeds it with `is_copy`); it can be
  renamed but never deleted.
- With the default levels an outcome (level 1) has two levels below it: features and
  subtickets. Three levels below one ticket need a level above Outcome (CORE-006 lets an
  administrator add one).

## Decision

- **One route, one bulk operation.** `POST /api/v1/tickets/:id/clone` takes `track` (the
  ticket's own by default), `summary` (the first copy's), and `subtickets`, `attachments`,
  `links` (all on by default) and `descendants` (off; on is a deep clone). It answers 202 with a
  bulk operation of the new action `clone` (migration 0061), whose items are the tickets to copy
  in depth-first order, parents before children and children by rank. The progress, the
  per-ticket results, the cancel, the 14-day retention and the `tickets_per_bulk_operation`
  limit are the bulk operation's own (ADR-043). Cloning needs to see the ticket and "Create
  tickets" in the target track, not "Make bulk changes": a clone is one person's own change.
- **What is copied.** Only tickets the person may see, and nothing below one they may not; the
  trash stays behind. A subticket lives with its parent, so it is copied into its own track only
  (400 `track: subticket`). Every copy goes into the target track; the first sits under the
  original's parent when the person sees it.
- **Each copy through the create route**, as the person who asked, with the original's type,
  summary, description, environment, assignee, dates, priority, labels, original estimate and
  custom values (not formulas, which are computed, nor read-only text, which belongs to its
  integration), and in the same track its open releases and areas and its visibility level
  when that differs from the track's default. The requester is copied for people who may name
  one; otherwise the person cloning is the requester, as for any ticket they create. A copy
  starts in its workflow's first status, open.
- **Leave out, don't fail.** When the create route refuses a value this person may not set or
  the track does not take (an assignee they may not assign, a field the create layout leaves
  out, a locked field, estimates with time tracking off), the copy is made again without it,
  and the item's result lists it in `left`. The type, the parent, the visibility level and
  required fields are never left out: a refusal of those fails the item, and the tickets below
  it fail with `parent_not_cloned`. A copy is never seen by more people than its original in the
  same track.
- **What comes with it**, in one transaction that also records the item's outcome and emits one
  `ticket.cloned` event: the Copies link from the copy to its original (made while ticket links
  are on in the workspace, without "Link tickets": it records where the copy came from), the
  original's links and web links when asked for and the person may link there (a link between
  two tickets that are both copied joins the two copies, made by whichever is copied second;
  links of the copy type are not repeated), and its clean or still-scanning attachments when
  asked for and the person may attach there. Attachment bytes are copied to the active store
  under a new key before that transaction (stored objects are never shared: deleting an
  attachment deletes its object), registered as uploads so the sweep removes them if the
  transaction does not keep them. A file the original's scan found clean, with the same SHA-256,
  stays clean; others are scanned as new.
- **Resumable.** The copy's id is written to `bulk_item.result_ticket_id` as soon as the create
  route made it. An item cut short goes on from that copy, so a worker that dies repeats the
  links and files, never the ticket. A child finds its parent's copy there
  (`bulk_item_ticket_idx`).
- **Results.** `bulk_item.result` holds the copy's key, the counts copied and `left`; the items
  route shows it, with the copy's current key, while the reader may see the copy.
- **The ticket view** has a Clone action: a small dialog with the copy's summary, the track, the
  options (deep clone only for tickets at level 1 or above; no track or subtickets for a
  subticket) and a note that copies link to their originals. It follows the operation and opens
  the copy when everything was copied with nothing left out; otherwise it says what was not and
  links to the copy and the operation's page.

## Options considered

| Option | For | Against |
|---|---|---|
| Copy rows directly in one transaction | Atomic; one event | Duplicates the create route's rules (workflow, layouts, locks, formulas, history), and one transaction cannot hold a deep clone of thousands or gigabytes of files |
| A synchronous clone and a separate asynchronous deep clone | The API answers the copy at once | Two code paths and two API shapes; a single ticket with large attachments still blocks a request |
| One bulk operation for both, through the create route (chosen) | Same checks as creating by hand; progress, cancel, limits and retention for free; resumable | A copy is not atomic: its links and files come in a second transaction (a crash in between is finished by the retry); the caller polls |
| Fail the copy when a value is refused | Simple | A Member cloning someone else's ticket would fail on the assignee or a locked field; Jira-like tools copy what they can |

## Consequences

- The `bulk_operation.created` and `bulk_operation.cancelled` events, the API's
  `BulkOperation.action` and the audit log name a fourth action, `clone`; `BulkItem` gained
  `result`. `ticket.cloned` is ticket activity, not audited, and not a webhook event (spec 02a
  section 1.3 does not list it); webhooks see each copy's `ticket.created`.
- The copy's mentions notify as any new ticket's do.
- Not built: mapping ticket types or statuses when the target track lacks the original's type
  (the item fails with `ticketTypeId: not_in_track`; move's mapping wizard is the model),
  copying comments, followers, time entries or sprint membership, and a choice of which link
  types to copy. Revisit if people ask for cloning across track types.
