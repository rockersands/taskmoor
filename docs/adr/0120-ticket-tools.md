# ADR-120: Ticket tools: links, subtickets, checklists and a slash menu

- Status: Accepted
- Date: 2026-11-03
- Backlog: none yet (proposed in the task file `docs/plan/ticket-tools-tasks.md`)

## Context

The user asked on 2026-11-03 for tools on every type of ticket for 1.0: links chosen from the
ticket's page, subtickets with a completion percentage, checklists, and a slash menu of blocks in
the rich-text editor. Requirements: CORE-031, CORE-032, CORE-033, NTF-013, NTF-014.

The slash menu's scope was set by the coordinator's list and by what the document format support
in this repository already holds. No competing product, its documentation or its screens were
opened for it (ADR-003, `docs/legal/clean-room.md`). Names, order and icons are our own.

## Decision

### Links (CORE-031)

- A new panel replaces the read-only list on the ticket page. Each side of a link type is one
  category; a type that reads the same from both sides is one.
- **The picker looks only in the ticket's own track**, as the user asked. It is a condition in the
  query the picker writes, not a rule of the route: the API and imports still link across tracks
  (CORE-018), and those links show and can be removed. It goes through `POST /api/v1/search`,
  whose permission filter is part of the statement (QRY-008), so it offers only what the person
  may see. Only letters and digits reach the text search, so typing cannot change the query.
- `GET /api/v1/tickets/:id/links` gains `mayLink` and `enabled`, for what the panel offers; the
  write routes keep checking both.

### Subtickets (CORE-032)

- A subticket is an ordinary ticket and follows the track's workflow (the user's answer, 2026-11-03).
- Progress is direct children in a status of the closed stage, over all direct children the person
  may see. `POST /api/v1/tickets/subticket-progress` answers for many tickets in one statement,
  with the permission filter in it, for the page, board cards and lists; the percent is worked out
  where it shows.
- A ticket above the standard level holds the next level down in the same section, under its own
  title, because the hierarchy has no subtickets under an outcome (spec 01a section 1.2).

### Checklists (CORE-033)

- Two tables, `ticket_checklist` and `ticket_checklist_item` (migration 0091). Item text is plain:
  a checklist is a list of things to do, not a document, so it has no rich text to convert.
- The four states are for checklist items only; a subticket's status comes from the track's workflow
  (the user's answer, 2026-11-03).
- **A rejected item is left out of the percentage: 3 done, 1 open and 1 rejected reads 75%. Decided
  by the user on 2026-11-03.** It lives in one small function, `checklistProgress`.
- Every change needs "Edit tickets" and respects a status's edit lock (WF-007). Every route answers
  the whole of the ticket's checklists, so the client never works out a change by itself.
- A change is history with the words it changed, one `ticket.checklist_changed` event with ids only,
  and it touches the ticket's updated time, not its version, as comments do (ADR-044): the change log
  brings open pages up to date (ADR-013), and nobody's edit of another field is refused over a ticked
  box. Followers are not notified of each tick: it would flood them. The event is available to
  webhooks.
- Clone copies the lists with every item open, since a copy starts in the first status of its
  workflow. Export writes one record per checklist with its items; an export from before this has
  no such file and imports as before. Erasure leaves the items, whose author becomes the placeholder
  account like any other record; the person's own items are in their data download.
- Limits: 20 checklists a ticket, 200 items a checklist, 200 and 1,000 characters.
