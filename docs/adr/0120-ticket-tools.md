# ADR-120: Ticket tools: links, subtickets, checklists and a slash menu

- Status: Accepted
- Date: 2026-11-03
- Backlog: none yet (proposed in the task file `docs/plan/ticket-tools-tasks.md`)

## Context

The user asked on 2026-11-03 for tools on every type of ticket for 1.0: links chosen from the
ticket's page, subtickets with a completion percentage, checklists, and a slash menu of blocks in
the rich-text editor. Requirements: CORE-031, CORE-032, CORE-033, NTF-013, NTF-014, and NTF-015
for the checklist notices the user chose on 2026-11-04.

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
- A refusal names the fields the track asks for: a system field from the catalogue, a custom one by
  the name its type's create form gives it (`GET /api/v1/tracks/:key/layout`, the request the create
  form makes), a seeded one in the reader's language. The panel reads that form once per type, as a
  subticket is first written, so a refusal never makes a request of its own; a field the form does
  not name, or a form that could not be read, goes by its number and is asked for again (T-201).

### Checklists (CORE-033)

- Two tables, `ticket_checklist` and `ticket_checklist_item` (migration 0096). Item text is plain:
  a checklist is a list of things to do, not a document, so it has no rich text to convert.
- The four states are for checklist items only; a subticket's status comes from the track's workflow
  (the user's answer, 2026-11-03).
- **A rejected item is left out of the percentage: 3 done, 1 open and 1 rejected reads 75%. Decided
  by the user on 2026-11-03.** It lives in one small function, `checklistProgress`.
- Every change needs "Edit tickets" and respects a status's edit lock (WF-007). Every route answers
  the whole of the ticket's checklists, so the client never works out a change by itself.
- Items change order with Move up and Move down, by keyboard or pointer, and by dragging a grip
  with a mouse or a finger (TT-5): the drag sends the same order route, so it needs nothing new
  on the server.
- A change is history with the words it changed, one `ticket.checklist_changed` event with ids only,
  and it touches the ticket's updated time, not its version, as comments do (ADR-044): the change log
  brings open pages up to date (ADR-013), and nobody's edit of another field is refused over a ticked
  box. The event is available to webhooks. Followers hear of it only where the track turns that on,
  and then a run of ticks as one notice: see [Checklist notices](#checklist-notices-ntf-015).
- Clone copies the lists with every item open, since a copy starts in the first status of its
  workflow. Export writes one record per checklist with its items; an export from before this has
  no such file and imports as before. Erasure leaves the items, whose author becomes the placeholder
  account like any other record; the person's own items are in their data download. An item keeps
  who last rewrote its words (`edited_by`, migration 0109; T-203), so that download holds the words
  of the items a person added or rewrote only where they wrote them last; ticks and moves do not
  change it. Items rewritten before the migration take the writer from the ticket's history rows
  (`checklistItem`), which a rewrite made together with a tick also wrote. A clone keeps each
  item's writer (the cloner adds the copy, the words stay whose they were), and the export writes
  it as the item's `editor`, which the import sets again.
- Limits: 20 checklists a ticket, 200 items a checklist, 200 and 1,000 characters.

### Checklist notices (NTF-015)

The question this record left open, whether followers hear of checklist changes (TT-7), was
answered by the user on 2026-11-04 (T-196a), with the option recommended to them: a notice that a
track's administrators turn on, off by default.

- **A choice of the track's.** `track.notify_checklist_changes` (migration 0103), off for every
  track, existing or new; `PATCH /api/v1/tracks/:id` with `checklistNotices` needs "Run the track",
  like the track's other settings, and is recorded as a `track.updated` with what changed. A copy
  of a track (`copyFrom`) takes the source's choice; a template starts with it off. In the web app
  it is a box on the track's **Manage** page (`#/manage/tracks/:id`), the page its administrators
  have, under **Notices to followers**.
- **A product event, `checklist_changed`**, outside notification policies like a mention or a
  shared track group (spec 01c section 3): it reaches a ticket's followers and nobody else, so a
  policy cannot widen it, and each person chooses its channels in their settings like any other
  event, with their email delivery, digests and quiet hours as for the rest.
- **Never one's own change**, whatever "Tell me about changes I make myself" says: a person ticking
  through a list knows they did.
- **Only those who may see the ticket**, at its visibility level, when the change is handled; the
  inbox and the mailer judge it again before showing or sending, as every ticket notification. A
  notice holds no list's name and no item's text: the ticket, who made the changes and how many.
  Checklists are read with the ticket's own permission, so nothing in a notice is more than its
  reader may open, and nothing goes stale in an inbox after an item is edited.
- **One notice for a run.** The mailer already gathers one ticket's changes within the workspace's
  batch window (two minutes by default) into one email (NTF-002). A checklist change follows the
  same window one step earlier: it joins the person's open notice about that ticket on each
  channel instead of writing another. A notice is open while it is unread, not snoozed and not yet
  emailed, until the batch window from its first change has passed, and for up to 100 changes; the
  next change after that starts a new one. It counts its changes and keeps who made them (up to 50
  people), so the inbox says "Ana and 2 more made 7 changes to checklists" and the email one line
  of the same. Reading the notice in the inbox marks its email read too (NTF-003 (2)), so both
  channels start afresh together. While a run is still gathering, the ticket's instant email
  waits for it, older changes and all, so they go together in one email (NTF-002 (1)), but never
  more than one window after the email fell due. A run that began inside the email's window has
  ended by then and goes whole (T-232); one that began after the email fell due (the mailer runs
  every 30 seconds) goes as it stands at that bound. Wave 10 sent the older changes on their own
  in that second case, and the run in an email of its own; the user chose on 2026-11-13 (T-248,
  decisions.csv) to hold them for one email, at most one window later. A digest at its hour, the
  bound above, or a mailer that runs while a change made inside the window is still on its way to
  the worker can send a run in mid-run; the inbox notice goes on and the
  next change starts another email, so one notice can cover several emails, and reading it marks
  all of them read, found by the events the notice lists. The reverse never happens, so a read
  never has to split an email: when an inbox notice closes, by a snooze or its window, the email
  closes with it, and the next change starts both. A snoozed notice's email still goes out, as for
  any notification.
- **At least once, counted once.** A notice lists the events it holds; an event delivered twice
  finds itself there and writes nothing. One ticket's notices are written one change at a time
  (an advisory lock on the ticket), so two workers never both start a notice for the same run.

### The slash menu and new blocks (NTF-013, NTF-014)

- "/" at the start of a line or after a space opens the menu, through the same suggestion plugin as
  mentions. Blocks that need something ask for it in a small form above the text: a code block's
  language, a status label's words and colour, a date, an emoji, a file, a ticket.
- Four new nodes, all with Taskmoor's names: `expand`, `columnLayout` with `column`, `attachmentRef`
  and `ticketRef`. Panels, status labels, dates and emoji were already in the schema.
- **A file is referred to by its name, not its id or address.** A clone and an import give a file a
  new id, and a document that holds no address cannot point anywhere else. Whoever shows it looks the
  name up among the ticket's attachments, with the reader's rights; a name that is not there shows as
  text. **Two files of one name are told apart by a digest (TT-4)**: the reference may also hold the
  first 16 hexadecimal digits of the file's SHA-256 (`digest`), which a clone and an import keep,
  because they keep the bytes. It is no id and no address. The file shown is the one of that name
  whose SHA-256 starts with it, else the first listed of the name; a reference without one shows the
  first, as before.
- **A ticket reference holds only the key.** It shows no summary, so a document never shows what a
  reader may not see. Old keys resolve (CORE-023), so it survives a move.
- A collapsible section is the browser's own `details` element in read mode, so it needs no script.
  In the editor its title is a field, beside a toggle that hides its text (TT-1, below).
- Values are checked at the door (`docShapeProblem`): a key must be a ticket key, a name and a title a
  line of text within a length. No block holds HTML or an address. A section title read from pasted
  HTML or from Markdown goes through one rule, `expandTitleLine`: control characters and runs of
  white space become one space, and it is held to the length, so a section copied from another
  Taskmoor document is never refused on save (T-202). The editor's title field turns a typed or
  pasted control character into a space as it goes.
- What a document format cannot hold follows the existing rule for losses:

| Block | Jira-compatible format | Markdown | Wiki markup | Plain text and email |
|---|---|---|---|---|
| Collapsible section | `expand` | `> [!EXPAND] Title`; tabs and control characters in a title read as spaces, and a quote whose text starts with an escaped `\[!EXPAND]` stays a quote | `{expand:Title}`; a section in a section loses its frame, `}` in a title is dropped, control characters read as spaces | title, then its text |
| Columns | `layoutSection`, `layoutColumn` with width | `> [!COLUMNS]` holding one `> > [!COLUMN] 40%` quote per column (TT-3); a width that is not a percentage above 0 and up to 100 with at most ten decimals is not written | `{section}` holding `{column:width=40%}` ... `{column}` blocks (TT-3); **lost:** the frame of columns inside a column, and widths as in Markdown | blocks in order |
| File of the ticket | `mediaSingle` or `mediaGroup` with `media` of our own collection, its `digest` on the media node; the media node's other attributes and marks (size, alt text, border) are kept and written back | `![n](attachment:n#digest)` or `[n](attachment:n)`; the media node's own attributes lost | `!name!` for a picture, `[^name]` for another file (TT-3); **lost:** the digest, and a name the markup cannot hold (`!` or `\|` in a picture's, brackets or `\|` in another's, white space at an end, an address) reads back as text | its name |
| Ticket reference | `inlineCard` with `/browse/KEY` | `[KEY](ticket:KEY)` | `[KEY\|/browse/KEY]`, a link to the ticket by its key (TT-3) | its key |

  Other `expand`, `mediaSingle`, `mediaGroup`, `layoutSection` and `inlineCard` nodes that do not fit
  stay kept whole as before (`unknownBlock`, `unknownInline`). An imported `expand` or layout that fits
  now shows and edits as these blocks, instead of the placeholder.
- The menu's list and order are our own and came from general editor patterns and what this repository
  already supports; no other product's menu was opened or consulted (ADR-003).

## Follow-ups (T-196, 2026-11-03)

The task file named eight things left out of the first build (TT-1 to TT-8). T-196 built seven;
the eighth waited on the user and has since been built too (TT-7 below).

### TT-1: hiding a section's text while editing

- A toggle before the title hides and shows the section's text. **Hiding is each person's own view
  and is never written to the document**: in a description edited together, nobody hides text from
  anyone else, and nobody's typing disappears under someone else's toggle. Nothing is stored, so a
  section opens again when the page loads.
- The hidden text still takes everyone's changes as they arrive (the Yjs document is the same); the
  section then says "Changed while hidden" beside its toggle, which also describes the toggle.
- **The caret never stays in hidden text.** Hiding moves it just past the section (before it at the
  end of a document). Anything that puts the caret back inside, such as undo, a find or the arrow
  keys, shows the text again. Down or Escape in the title of a hidden section go past it, onto a new
  paragraph when nothing follows; Enter shows it and goes in; Up goes to the text before. Up on the
  first line of a section's text goes to its title, and Shift+Tab from there to the toggle.
- Wherever hiding or these keys move the caret, it steps over every other section the person hid,
  so a run of hidden sections stays hidden: the caret lands in the next text that can be seen.

### TT-2: column widths in the editor

- "Column widths" in the slash menu, offered only inside columns, sets every column of the layout in
  one step (one undo, one change for the others): equal, or a few shares for two or three columns, or
  the widths it has now. Widths are percentages, as the Jira-compatible format holds them.
- **The first build's premise was wrong:** a style attribute needs no change to the content security
  policy, which allows style attributes (`style-src-attr`, ADR-080) and nothing else. The layout's
  `--rt-columns` property is built from numbers only (`columnTracks`), so a document can put nothing
  else into a style; a width that is not a number is refused at the door. Columns are equal unless
  every one has a width above 0 and up to 100, and stack on a narrow screen as before.

### TT-3: columns, files and ticket references in the text formats

- The forms are in the table above. Markdown follows the pattern of panels and sections: a quote with
  a marker, here quotes of quotes. Wiki markup uses the markup's own forms for a ticket's files and a
  plain link for a ticket reference; `{section}` and `{column}` are block macros of our choosing in
  the markup's style, since the markup has no columns of its own. All read back, and the corpus cases
  hold them (`markdown-corpus.ts`, `wiki-corpus.ts`).
- Text that only looks like a marker stays text: the writers escape `[!COLUMNS]`, `!name!` and
  `[^name]` written as text, and a quote or `{section}` that holds anything but one to six columns
  reads as what it holds.

### TT-4: two files of one name

- The digest above. The picker lists every file, a name shared by two with each one's size, date and
  who added it (their place in the list when nothing else tells them apart).
- Markdown writes it after `#`, since a name is written encoded and a bare `#` cannot be part of it;
  wiki markup cannot hold it, so a reference written there reads back as the first file of the name.

### TT-5: dragging checklist items

- A grip among each item's controls, for a pointer only; Move up and Move down are the keyboard's
  way, so the grip is hidden from assistive technology. Pointer events carry the drag, so a mouse and
  a finger work alike; Escape or a cancelled touch ends it with nothing moved.

### TT-6: a subticket's status from its parent's list

- Each status in the list is the ticket page's status control: a menu of where that ticket can go,
  read as it opens, through the ticket page's own routes. The workflow, its conditions and the
  person's rights apply as on the ticket's page, so no new route, permission or event is needed. A
  move that asks for a close reason or a priority asks for it in the panel, in a form under the list
  whose first field takes the focus (Escape or Cancel goes back to the status); one that asks for
  other fields sends the person to the ticket.

### TT-8: a code block's language

- The prompt lists about thirty common languages, narrowed as you type, by keyboard or pointer. Any
  one word still goes in; the editor still does not highlight by language.

### Email and plain text

- A comment quoted in an email (and an excerpt in the inbox, the activity list and the AI's context)
  now reads a date as its day, a status label in brackets, an emoji as itself and a kept inline node
  by its text; they were left out. Columns read as their blocks in order, a file as its name.

### TT-7: answered by the user

Whether followers hear of checklist changes waited on the user, with three options: leave it as
built, a choice per track, or a notice only when a checklist is completed. On 2026-11-04 (T-196a)
they chose the choice per track, off by default. It is built: see
[Checklist notices](#checklist-notices-ntf-015).

## T-318: text colours checked at the door (answered on 2026-11-16)

A colour on text comes only from an import or another format; no tool makes one (T-120 below). Its
value went into the style it is shown with as stored, and the page's security policy allows style
attributes (ADR-080), so a document written through the API or an import could carry other style
rules to everyone who read it. Markdown and wiki markup already kept only safe values. The user
accepted the recommendation on 2026-11-16:

- **A safe colour is a hexadecimal value or a colour name** (`SAFE_COLOR`, now in `adf.ts`, which
  the Markdown and wiki readers and writers share).
- **The schema writes only a safe colour** into a style; another shows as plain text, in read mode
  and in the editor.
- **An import keeps another colour aside**: the Jira-compatible reader makes it an `unknownMark`, as
  for any mark the editor does not show, so an export writes it back unchanged.
- **A save takes another colour off its text rather than refusing the document** (`withSafeColors`,
  run by `checkRichText`): the text and its other marks stay, and a document stored before this,
  or one written by the API, still saves. `docShapeProblem` gains no colour rule for that reason.

## Options considered

| Option | For | Against |
|---|---|---|
| File by id in the document | Exact when names repeat | A clone or an import points at the wrong file or none; an import loads files after the documents that name them |
| File by name (chosen) | Survives clone and import; holds no address | Two files of one name show the first |
| Checklist items as rich text | The same editor | Conversions, Yjs and limits for what is a line of text |
| Checklist changes as a policy event | Policies already name recipients | Any policy could send every tick to a whole group; the user asked for followers only, per track |
| A notice per checklist change | Simplest | A run of ticks floods the inbox, which is why TT-7 waited |
| One notice for a run, in the batch window (chosen) | One item and one email line per run, the window the mailer already uses | A notice changes after it is written, so it lists the events it holds |
| Item text in the notice | Says what changed | Stale once an item is edited; the history on the ticket has the words |

## Consequences

Checklists, links and subtickets need no new permission. A new document node needs every writer in
`packages/richtext` updated, and the corpus says so when one is missed. What would make us revisit
this: people asking for a ticket reference that shows its summary.
