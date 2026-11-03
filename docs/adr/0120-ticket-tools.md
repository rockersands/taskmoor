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
