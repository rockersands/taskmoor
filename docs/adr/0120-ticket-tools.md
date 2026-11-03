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

### The slash menu and new blocks (NTF-013, NTF-014)

- "/" at the start of a line or after a space opens the menu, through the same suggestion plugin as
  mentions. Blocks that need something ask for it in a small form above the text: a code block's
  language, a status label's words and colour, a date, an emoji, a file, a ticket.
- Four new nodes, all with Taskmoor's names: `expand`, `columnLayout` with `column`, `attachmentRef`
  and `ticketRef`. Panels, status labels, dates and emoji were already in the schema.
- **A file is referred to by its name, not its id or address.** A clone and an import give a file a
  new id, and a document that holds no address cannot point anywhere else. Whoever shows it looks the
  name up among the ticket's attachments, with the reader's rights; a name that is not there shows as
  text. Two files of one name resolve to the first listed.
- **A ticket reference holds only the key.** It shows no summary, so a document never shows what a
  reader may not see. Old keys resolve (CORE-023), so it survives a move.
- A collapsible section is the browser's own `details` element in read mode, so it needs no script;
  in the editor it stays open, with its title as a field.
- Values are checked at the door (`docShapeProblem`): a key must be a ticket key, a name and a title a
  line of text within a length. No block holds HTML or an address.
- What a document format cannot hold follows the existing rule for losses:

| Block | Jira-compatible format | Markdown | Wiki markup | Plain text and email |
|---|---|---|---|---|
| Collapsible section | `expand` | `> [!EXPAND] Title` | `{expand:Title}`; a section in a section loses its frame, `}` in a title is dropped | title, then its text |
| Columns | `layoutSection`, `layoutColumn` with width | **lost:** their blocks, one column after the other; widths lost | **lost:** the same | blocks in order |
| File of the ticket | `mediaSingle` or `mediaGroup` with `media` of our own collection | `![n](attachment:n)` or `[n](attachment:n)` | **lost:** its name, reading back as text | its name |
| Ticket reference | `inlineCard` with `/browse/KEY` | `[KEY](ticket:KEY)` | **lost:** its key, reading back as text | its key |

  Other `expand`, `mediaSingle`, `mediaGroup`, `layoutSection` and `inlineCard` nodes that do not fit
  stay kept whole as before (`unknownBlock`, `unknownInline`). An imported `expand` or layout that fits
  now shows and edits as these blocks, instead of the placeholder.
- The menu's list and order are our own and came from general editor patterns and what this repository
  already supports; no other product's menu was opened or consulted (ADR-003).

## Options considered

| Option | For | Against |
|---|---|---|
| File by id in the document | Exact when names repeat | A clone or an import points at the wrong file or none; an import loads files after the documents that name them |
| File by name (chosen) | Survives clone and import; holds no address | Two files of one name show the first |
| Checklist items as rich text | The same editor | Conversions, Yjs and limits for what is a line of text |

## Consequences

Checklists, links and subtickets need no new permission. A new document node needs every writer in
`packages/richtext` updated, and the corpus says so when one is missed. What would make us revisit
this: people asking for columns in Markdown, or for a ticket reference that shows its summary.
