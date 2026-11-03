---
title: "Boards, sprints and the backlog"
audience: users
sources: docs/adr/0116-one-place-per-track.md, apps/web/src/tracks/TrackLayout.tsx, apps/server/src/routes/boards.ts, apps/web/src/boards/BoardPage.tsx, apps/web/src/boards/BoardPeopleFilter.tsx, apps/web/src/shell/Popover.tsx, apps/web/src/tracks/trackSections.ts, apps/server/src/boards/data.ts, apps/web/src/boards/BoardSettingsPage.tsx, apps/web/src/boards/client.ts, apps/web/src/sprints/BacklogPage.tsx, apps/web/src/sprints/CompleteSprint.tsx, apps/server/src/routes/sprints.ts, apps/web/src/sprints/PlanningPanels.tsx, apps/web/src/sprints/SprintSettingsSection.tsx, apps/web/src/releases/ReleasesPage.tsx, apps/web/src/releases/ReleasePage.tsx, apps/web/src/i18n/messages.en.ts, apps/server/src/routes/releases.ts, apps/server/src/sprints/lifecycle.ts, docs/adr/0049-boards.md, docs/adr/0054-sprints.md, docs/adr/0061-releases-hub.md, docs/specs/00-terminology.md, docs/specs/01b-core-work-tracking.md, packages/db/src/migrations/0093_board_card_defaults.ts, apps/server/src/boards/model.ts, apps/web/src/shell/TicketIcons.tsx, apps/web/src/boards/CardTitleEditor.tsx, apps/server/src/routes/tracks.ts, apps/web/src/configuration/TracksAdminPage.tsx
accessed: 2026-11-03
attestation: own-words
---
# Boards, sprints and the backlog

Each track has one board: its tickets as cards in columns, with one column per status. A column's
name is the status itself. Kanban or Scrum is a setting of the board: Kanban shows the flow of all
the track's tickets, and Scrum adds a backlog and sprints. A Kanban track shows no **Backlog** at
all, and changing the board's kind brings it back or takes it away at once.

## A track's board

Open a track and choose **Board** in its tab bar. There is no list of boards and no form to make
one. A track gets its board from its template, or the first time anyone who can see the track opens
it, and everyone who can browse the track sees that board. A board made that way has no board
administrators of its own: the track's administrators configure it. A track cannot have a second
board, and a board cannot sit outside a track or cross tracks. For a view across tracks, use a saved
search or a dashboard.

A new board starts with one column per status of the track's workflow, named after the status and
ordered from new to closed, the board filter "Recently updated" (changed in the last day), and cards
that show the priority, the assignee and the points, with no colour strip and no days marker. Change
any of it in the board's settings.

Upgrading moved boards still on the old default fields (assignee, then priority) to these; a board
whose card fields are anything else keeps them. If its colour and days were still the old default
too, they changed with it; a colour or days setting someone changed stays. Choosing the same two
fields on purpose looks the same as never choosing, so those boards moved as well: choose again.

A site upgraded from before this rule keeps its older boards. A board whose query was exactly one
track became that track's board, if the track had none; the others stay readable, kept by a person.

## Using a board

The board's header names its kind and location and links to **Board settings** (when you may change
the board). The track's tab bar holds its **Backlog** (Scrum boards only) and its
[**Statistics**](dashboards-and-reports.md#a-tracks-statistics). The columns scroll sideways inside
the board, never the whole page.

Each column shows how many tickets it holds and its limits: **min 2**, **max 5**. A column
above its maximum says **Over the maximum**; below its minimum, **Under the minimum**.

Each card shows the key and the title, the ticket
type's icon and the fields the board chooses: by default the priority's icon, the points where a
ticket has them, and the assignee as a small round mark with their initials, or a dashed circle for
nobody. Each icon and mark has its name as a tooltip and for screen readers, and the words appear
beside the icons while the keyboard is on the card.

Points are a number field: the one the board estimates with (see [Sprint settings](#sprint-settings)),
else a number field named Points or Puntos (an imported one under its source's usual name counts
too). Every workspace starts with a number field called **Points** (**Puntos** in Spanish), and a new
track's board estimates with it. Set a ticket's points in its details, on the create form or in a
search result's cell. A card with no value shows nothing. An administrator may rename the field or
remove it ([Fields](../admin/fields.md#the-points-field)).

If you may edit a ticket, its card has a pencil at the corner (on a touch screen, in a row under the
card): it edits the title in place. **Enter** saves, **Escape** cancels, and if the title cannot be
saved the card says why. A card does not move or drag while its title is being edited.

If the board shows days in column, a card that has waited a day or more shows a small clock with the
number, and a card that has just arrived shows nothing. Cards are in rank order.

A Scrum board shows the tickets of its active sprints; a Kanban board shows every ticket of its
track, so tickets that waited in a backlog are on the board after a change to Kanban. Sprints are kept,
and are there again on a change back to Scrum, but a Kanban track's timeline and calendar do not show
them. While a sprint is running a board cannot change to Kanban: the settings page asks you to complete
the sprint first, and a planned sprint cannot start on a Kanban board. A board shows the first 5,000 cards in rank order and says when it shows only part.

If some tickets are in statuses that no column shows, the board names those statuses and how
many tickets are in them. Someone who may change the board can give them a column.

A card whose ticket has subtickets shows how many are closed, with a small bar, such as **1/2**.

### Moving cards

Moving a card to another column changes the ticket's status to that column's. On the workflow a new
site starts with, a move asks for nothing: any card goes to any column. If you want to give a reason,
write it in a comment. There are three ways to move a card:

- drag the card to a place in another column, or up and down in its own column;
- open the card's **Move PAY-42** menu and choose **Forward to Done**, **Back to To do**, **Up in
  Doing** or **Down in Doing**;
- focus the card and press Alt with the left or right arrow (to the next column) or the up or
  down arrow (within the column).

Only a rule someone put on the workflow, or one that came with an import, can ask for more. Then a
move brings up a form, or a refusal in plain words, such as **PAY-42 cannot go to Done: its workflow
has no step there from To do.** On phones, use the menu or the keyboard.

### Board filters

Board filters are buttons above the columns (or a **Board filters** menu, if the board is set up
that way). Press one to narrow the cards; press it again to drop it. Several filters together
must all match. Column counts still include the hidden cards, and a column says how many of
its cards the filters hide.

### Filtering by person

Anyone who can see a board can filter it to see one person's work, or several people's. It takes
no administrator rights and no access to the board's settings, and it changes the board only for
you. Above the columns:

- **Me** shows the cards assigned to you;
- **Unassigned** shows the cards nobody has;
- **People** opens a list over the board, or at the bottom of the screen on a phone, of the people
  assigned to tickets on this board, and only to tickets you can see. Tick a name to add that
  person. In a long list, **Find a person** narrows it. Escape or a click elsewhere closes it.

A filter that is on shows a tick and a heavier label. Boards used to start with a board filter called
"Only my tickets". It finds the same cards as **Me**, and **Me** combines with other people, so the
filter row no longer shows it, and new boards do not get it. A filter of that kind that someone
renamed or wrote themselves stays, and a board's reports still list the old one.

Choosing several shows the cards of any of them, and the names you chose stay on show beside the
menu: press one to take it away, or **Clear people** to take them all away. The filter works with
board filters: a card must match both. It never shows you a ticket you could not already see, and
column counts still cover every card.

The people you chose are part of the page's address, so you can send the link to someone and they
see the same people's cards, as far as they may see them. **Me** in a shared link means whoever
opens it.

### Swimlanes

A board can group its cards into horizontal lanes: by queries (each card in the first lane whose
query matches, with a last lane for everything else), by assignee, or by parent. Each lane shows
how many tickets it holds. Dragging a card never changes its lane.

## Board settings

**Board settings** is for the board's administrators and the administrators of its track. It
has these sections, saved together with **Save settings**:

| Section | What you set |
|---|---|
| **Board** | **Name**, **Kind**, **Team** (the team whose board this is, or **No team**), **Tickets (a query)**, which can narrow within the track, and **Sub-filter (optional)**, a second query that tickets must also match, for example to hide shipped work |
| **Columns** | Each column's name, **Minimum** and **Maximum**; **Add a column**; move or remove columns; **Column that closes tickets** |
| **This board's columns are its track's statuses** | Whether the board manages its track's workflow; see [Columns and statuses](#columns-and-statuses) |
| **Which column shows each status** | On a board that does not manage its workflow: a column for each status, or **None (unmapped)** |
| **Swimlanes** | **Group cards**: **Not at all**, **By queries**, **By assignee** or **By parent**; for assignee lanes, whether **Unassigned tickets** come **First** or **Last**; for query lanes, each lane's name and query and the name of the lane for everything else |
| **Board filters** | Each filter's name, query and description; **Show board filters as** **Buttons** or **A menu** |
| **Cards** | **Colour cards by** **Nothing**, **Ticket type**, **Priority**, **Assignee** or **Queries (the first that matches)**; up to 10 **Fields on cards**, such as **Priority**, **Assignee** and **Points**; **Show days in column** |
| **Sprints** | Scrum boards only; see [Sprint settings](#sprint-settings) |

The server checks every query when you save, and a problem shows next to its field. A query that
would leave the track is refused, as a board never
shows another track's tickets. If someone else saved the board meanwhile, the page asks you to open
the settings again.

### Columns and statuses

Where nobody else shares the track's workflow and nobody has put guards, checks or rules on it, the
board [manages the workflow](../admin/workflows.md#board-managed-workflows): a column is a status.

- **A new column** makes a status of its own when you save.
- **Renaming a column** renames its status. If other workflows use that status, the column gets a
  status of its own instead, so they do not change.
- **Removing a column that holds cards** asks where they should go first: under **Move them to**,
  choose a column, then **Remove the column**.

**Column that closes tickets** is the rightmost column by default, and it follows that place as you
reorder the columns. You can choose another column, or **No column closes tickets**, and a column you
chose stays chosen when columns move. Reaching this column closes a ticket as Completed, and leaving
it reopens the ticket. Tickets already closed keep their close reason and history when you change it.

### A column no card can reach

A workflow other tracks share never changes by itself. On such a board, a new column can have no
status yet, or nothing in the workflow may lead to it. The settings say so at once, **No card can go
to Parked yet** or **No card can reach Parked**, and the column on the board says so too.

A site or configuration administrator sees **Let cards reach Parked**. It adds the status and the
steps in and out as a new version of the workflow. When other tracks use that workflow, the settings
name them first, as they see the new status too. Anyone else sees who can fix it. A track whose
ticket types follow different workflows cannot be fixed this way: give every type the same workflow
first.

Mapping several statuses to one column remains for boards that do not manage their workflow, in
**Which column shows each status**, and imported boards rely on it.

## The backlog

A Scrum board's **Backlog**, in the track's tab bar, opens **Backlog and sprints**: the active and planned sprints,
then the backlog, each with its tickets in rank order and their totals (count, estimate and,
when time tracking is on, the remaining estimate).

### Ranking and moving tickets

- Drag tickets to rank them, or drop them in another sprint or the backlog.
- Each ticket has a **Move PAY-42 to** menu.
- Alt with the up or down arrow moves a focused ticket past its neighbour.
- Tick tickets one by one, or a whole section with **Select every ticket shown in** that
  section. The selection bar then offers **Move selected to…**, **Move to the top**, **Move to
  the bottom**, **Put selected under…** (an outcome, or **No outcome**), **Add selected to
  release…** and **Clear selection**. A selection moves as one block and keeps its order.

The **Outcomes** and **Releases** panels list the open outcomes and the unshipped releases of
the board's track. Drop tickets on one to put them under that outcome or into that release.
Choose one to show only its tickets; **Show all tickets** brings the rest back.

To add a ticket, type its summary in **New ticket…** at the end of any section and press **Add
ticket**. It is created in the board's track, inside that sprint if the section is one.

If a permission or a rule refuses some tickets, the page says how many were not changed.

### Creating, starting and completing sprints

Managing sprints needs the **Manage sprints** permission in the board's track, or the right to
change the board.

- **Create sprint** adds a planned sprint named after the board, such as "Payments Sprint 4".
- **Start sprint** on a planned sprint makes it active, ending two weeks later. Unless the
  board allows several active sprints, complete the active one first. A sprint cannot start while
  the track's sprints are turned off ([Tracks](../admin/tracks.md#details)).
- An active sprint links to its **Sprint report** (see [Dashboards and
  reports](dashboards-and-reports.md)).
- To finish an active sprint on the backlog, choose where its unfinished tickets go under **Move
  unfinished tickets to**: the **Backlog**, a planned sprint, or **A new sprint**. Then press
  **Complete sprint**. A ticket counts as finished when it is in the board's rightmost column.

You can also finish the active sprint from the board itself. **Complete sprint**, at the top of
the board, opens a pop-up that names the sprint, says how many of its tickets are done and how
many are open, and asks where the open ones go under **Open tickets go to**: the **Backlog**, a
planned sprint, or **A new sprint**. When every ticket is done it asks nothing, as nothing moves.
**Complete sprint** in the pop-up finishes the sprint and the board shows what comes next at once;
**Cancel** or **Escape** closes it and changes nothing.

The pop-up counts the way the board does: a ticket in the rightmost column is done, and any other
ticket of the sprint is open, including one in a status no column shows. Board filters and the
person filter do not change the counts. When several sprints are active at once, the board has a
button for each, named after its sprint, and each pop-up counts only that sprint's tickets. The
button is there only for people who may manage the board's sprints, and the server checks again:
if it refuses, for example because someone else completed the sprint a moment earlier, the pop-up
says why.

While a sprint is running, the track's sprints cannot be turned off, just as the board cannot change
to Kanban. **Sprints in** the track, under **Administration**, **Tracks**, **Manage**, stays on and
names the running sprint, with a link to the track's board to complete it there. With several active
sprints, each one has to be completed first.

### Sprint settings

A Scrum board's settings include **Sprints**:

| Setting | Choices |
|---|---|
| **Estimate with** | **Ticket count**, **Original time estimate**, or a number field you pick under **Number field** |
| **Time tracking** | **None**, or **Remaining estimate and time spent** |
| **Allow several active sprints at once** | On or off |
| **Roll sprints over automatically** | Off, or on with **Days in each sprint** (1 to 91) and the **Time zone of the cycle** |

With automatic roll-over, you start the first sprint yourself. When a sprint ends, its
unfinished tickets move into the next one, which starts at once. A cycle runs one sprint at a
time, so it cannot be combined with several active sprints.

## Releases

Each track has a releases hub, **Releases** in its tab bar. It lists **Upcoming** releases in the track's order and
**Shipped** ones, latest first, with archived releases folded away. Each release shows its date,
a state (**Upcoming**, **Overdue**, **Shipped** or **Archived**) and how many of its tickets are
closed. The track's administrators add releases with **New release**: a **Name** and an
optional **Release date**, then **Add release**.

A release's own page shows:

- **Start date**, **Release date** and **Shipped on**;
- **Progress**: its tickets by stage, each number opening the search that finds them;
- **Warnings**, such as open tickets past the release date or open tickets nobody is assigned
  to, each with **Show these tickets**;
- **Approvals**: the approvers named for the release, where each approver can **Approve** or
  **Decline** with an optional comment;
- **Tickets**: the tickets targeting the release;
- **Release notes**: the closed tickets, grouped by ticket type. Tickets closed without being
  done (not planned, duplicates) are left out and counted. Use **Copy as Markdown** or
  **Download Markdown**.

To ship, the track's administrators press **Ship this release…**, choose the day under **Ship
on** and, if tickets are still open, whether to **Leave them in this release** or move them to
another upcoming release. When approvals are required, every approver must approve first.
