---
title: "Working with tickets"
audience: users
sources: apps/web/src/tickets/view/drafts.tsx, apps/server/src/routes/tickets.ts, apps/web/src/richtext/slashTools.ts, apps/web/src/richtext/BlockPrompt.tsx, packages/richtext/src/schema.ts, packages/richtext/src/adf.ts, apps/web/src/tickets/tools/ChecklistsPanel.tsx, apps/server/src/routes/checklists.ts, apps/server/src/notifications/checklists.ts, apps/web/src/tickets/tools/SubticketsPanel.tsx, apps/web/src/tickets/tools/client.ts, apps/server/src/routes/subtickets.ts, apps/web/src/tickets/tools/LinksPanel.tsx, apps/web/src/tickets/tools/TicketPicker.tsx, docs/adr/0120-ticket-tools.md, apps/web/src/App.tsx, apps/web/src/routing/ImportedLinkPage.tsx, packages/webconfig/src/links.ts, docs/adr/0097-imported-keys-and-links.md, apps/web/src/home/HomePage.tsx, apps/web/src/home/client.ts, apps/web/src/shell/CommandPalette.tsx, apps/web/src/shell/OverlayLayer.tsx, apps/web/src/tickets/CreateTicketDialog.tsx, apps/web/src/tickets/CreateTicketPage.tsx, apps/web/src/tickets/view/TicketPage.tsx, apps/web/src/tickets/view/ActivityPanel.tsx, apps/web/src/comments/CommentsPanel.tsx, apps/web/src/attachments/AttachmentPanel.tsx, apps/web/src/attachments/AttachmentPreview.tsx, apps/web/src/richtext/RichTextEditor.tsx, apps/web/src/richtext/CollaborativeEditor.tsx, apps/web/src/locks/useLockText.ts, apps/web/src/bulk/BulkOperationPage.tsx, apps/web/src/i18n/messages.en.ts, apps/server/src/routes/bulk.ts, apps/server/src/tickets/followers.ts, docs/adr/0042-edit-locks.md, docs/adr/0043-bulk-operations.md, docs/adr/0044-comments.md, docs/adr/0046-home-create-dialog-palette.md, docs/specs/00-terminology.md, docs/specs/01a-core-work-tracking.md, apps/web/src/tickets/view/InfoPanel.tsx, apps/server/src/tickets/info.ts, apps/web/src/tickets/clone/CloneDialog.tsx, apps/server/src/routes/clone.ts, apps/server/src/clone/run.ts, docs/adr/0077-clone-and-deep-clone.md, apps/web/src/shell/NavList.tsx, apps/web/src/shell/PageHeader.tsx, apps/web/src/shell/HelpTip.tsx, docs/adr/0114-glass-interface-and-clear-sections.md, apps/web/src/tickets/view/TicketPopup.tsx, apps/web/src/routing/router.ts, apps/web/src/tickets/templates/TemplatePicker.tsx, apps/web/src/tickets/templates/start.ts, apps/server/src/routes/ticket-templates.ts, docs/adr/0113-ticket-templates.md, apps/web/src/tracks/recentTracks.ts, apps/server/src/tracks/membership.ts, apps/web/src/tutorial/FirstRunOffer.tsx, apps/web/src/attachments/FileDrop.tsx, apps/web/src/richtext/expandView.ts, apps/web/src/tickets/tools/ChildStatusMenu.tsx, apps/web/src/tickets/view/StatusMenu.tsx, apps/web/src/styles/print.css, apps/web/src/styles/ticket-view.css, docs/plan/page-review-findings.md, apps/web/src/tickets/PersonPicker.tsx, apps/web/src/shell/TrackSelect.tsx, apps/web/src/tickets/form.ts, apps/server/src/routes/layouts.ts, apps/server/src/routes/rich-text.ts
accessed: 2026-11-13
attestation: own-words
---
# Working with tickets

A ticket is one piece of tracked work. It lives in a track and has a key such as `PAY-42`. This
page covers finding your tickets, creating them, and everything on a ticket's own page. For the
terms used here, see [Concepts and terms](../concepts.md).

## Getting around

The navigation on the left is in three sections: **Your work** (Home, Inbox), **Plan and track**
(Tracks, Boards, Search, Dashboards) and **Manage** (Settings). Every page says in one line under
its title what it is for; the round **?** button beside a title, or beside a panel's name,
explains more and closes again with Escape.

## Home

**Home** is the first entry in the navigation. Signed in, it greets you. **Your tracks** comes
first, then four ways to start: a new ticket, a board, a search, and the tutorials (**Take the
tour**, see [Tutorials](tutorials.md)). The first time you see Home, a welcome panel above Your
tracks offers the tutorial's sections. From your next visit on, and as soon as you answer it, it
is one small **Getting started** link to Settings, Tutorials, so your own work comes first. Under
the ways to start are three lists:

| List | What it holds |
|---|---|
| **Assigned to you** | Open tickets assigned to you, the most recently changed first |
| **Opened lately** | Tickets you opened lately, newest first, whichever browser you used |
| **You follow** | Tickets you follow |

On a wide screen the lists sit side by side, and one left alone on its row takes the whole row.
An empty list says how it fills and offers a next step. Each list loads on its own, so if one
cannot be read the others still show. A ticket appears in
these lists only while you may see it: following or having opened a ticket gives no access.

### Your tracks

**Your tracks** holds the tracks you belong to, among those you may see:

- a track where you hold a role, given to you or to a group you are in;
- a track you lead (its owner);
- a track your team works on: one of your [teams](../admin/people-and-groups.md#teams) owns one of
  its areas, or its board belongs to that team.

A track you can see only because it is open to everyone, because its access policy lets you or
one of your groups look, or because you are an administrator, is not one of yours, so it is not
listed here. The **Tracks** page lists every track you can see.

Home shows six of your tracks as cards, the ones you opened most lately first, then by name.
Each card's badge shows the track's whole key.
However many tracks you belong to, hundreds included, the ones you opened lately still come first
while you belong to them. Which ones you opened lately is remembered **per browser**: another
browser or device starts with your tracks by name until you open some there. With more than six, **All tracks** leads to the
**Tracks** page. If you are in no track yet, the section says so and offers **Go to Tracks**, and
**New track** too if you may make one.

## The command palette

The top bar's **Search or jump to…** button (**Search** on a small phone), or Ctrl K (Cmd K on a
Mac) anywhere, opens the **Command palette** over a dimmed page. Type a few letters to filter the
commands, move with the arrow keys, press Enter to run one and Escape or a tap outside to close.
On a phone or a touch screen its prompt is shorter and leaves out the Ctrl K hint. It offers:

- the pages of the navigation (Home, Inbox, Tracks, Boards, Search, Dashboards, Settings);
- **Create ticket**, **Account**, the three appearance choices and **Sign out**;
- the administration pages, for site administrators;
- on a ticket's page, that ticket's actions (see [Keyboard shortcuts](#keyboard-shortcuts)).

The palette runs commands. To find tickets, use [search](search.md).

## Creating a ticket

Open the create dialog with the **New ticket** button in the top bar, with the C key anywhere
outside a text field, or with **Create ticket** in the palette. Escape or a click outside closes
it. The same form also has its own page at the address ending in `create`.

1. Choose the **Track** and the **Ticket type**. Each track in the list shows its mark (the first
   letter of its key), its key and its name. The form then shows the fields that track and type
   ask for. Required fields say **(required)**; fields hidden for the type are not shown. Some
   fields sit under further tabs, such as **More fields**.
2. Fill in the fields. Rich text fields (description and environment) use the editor described
   in [Descriptions and rich text](#descriptions-and-rich-text). Separate labels with spaces or commas.
3. Press **Create**. The dialog says **PAY-42 was created.** and offers **Open PAY-42**.

People, the parent, releases and areas are chosen with pickers:

| Field | How you choose it |
|---|---|
| **Assignee** | Type part of a name and pick the person from the matches. Only people who may be given tickets in the track are offered. **Remove** clears the choice so you can pick someone else. |
| A custom person field | The same way, among the people of the site. A field that holds several people keeps its search field for the next one. |
| **Parent** | Type the parent's key, such as `PAY-12`, or words from its summary, and pick it from the list with the mouse or the arrow keys and Enter. **Remove** clears it. |
| **Target releases**, **Found in releases**, **Areas** | Tick each one that applies. A track with none leaves the field out, unless it is required: then the form says the track has none to choose. |

Some fields are not set in this form. **Close reason** never is, and some others, such as
**Requester** (you, unless changed later), team and group fields, are set on the ticket once it
exists. Fields you do not have the permission to set on a new ticket, such as **Assignee** without
the permission to assign tickets or the dates without the permission to schedule them, are left
out too. One of these that is not required is simply left out. One required at create stays on
the form, with its name, and says why: that this form cannot set it yet, or that you may not set
it on a new ticket. The ticket is then created only if a default or the workflow fills it in; if
not, ask an administrator of the track. In the dialog, **Create** stays in view at its foot while
the form scrolls.

To start from an existing ticket, enter its key under **Start from a ticket (its key)** and
press **Copy its fields**. The form takes that ticket's track, type, summary, description,
environment, priority, labels and dates. People, releases and custom fields are not copied.

### Starting from a template

When a track has ticket templates that fit the chosen ticket type, the form offers **Start from a
template**. Choosing one fills in the form: nothing is created until you press **Create**, so
change anything that differs. Clearing a value leaves it off the ticket. Choosing **No template**
clears what it filled in, and changing the ticket type lets go of the template and keeps what is
in the form.

A template's summary can hold today's date, the track's key and your name, and its dates count from
today. Its people, releases and areas are not filled into the form's pickers: they show under
**Also from this template** with a checkbox, as do its subtickets (**Create its 2 subtickets**).
One you choose in the form yourself, such as another assignee, takes the place of the template's.

A template never gets round what you may do. Fields that are hidden for this type or that you may
not set do not show, and they stay off the ticket. After **Create** the form names them: **Left
out, because they cannot be set here: Labels.** A value you enter yourself is treated as yours, and
is refused with a message if you may not set it. Subtickets are made one by one; if one fails the
form lists it, and the ticket stays.

Administrators keep templates: see [ticket templates](../admin/tracks.md#ticket-templates). A
track's summary page links to its templates, under **Ticket templates**, for anyone to read.

When the server refuses a value, the message shows next to the field, for example **This field
is required.** If there is no track you may create tickets in, the form says so.

Boards' backlogs and a track's list can also make a ticket from a summary alone: see
[the backlog](boards.md#the-backlog) and [the list view](views.md#the-list-view).

## The ticket view

Each ticket has its own page, at an address ending in `tickets/PAY-42`. Its title is the key
and the summary; above it are the track and the ticket type. The help mark beside the title
explains the page; its text opens under the title. On a wide screen the details sit in a column
on the right, with the activity under the description; on a phone everything is in one column,
with **Details** before **Activity**.

Clicking a ticket on a board, in a list, a backlog, the calendar, search results, the inbox or
anywhere else opens it in a pop-up over the page, with everything the ticket's page has. The page
beneath stays as it is, with its scroll and filters, and shows your edits at once.

- **To close it**: Escape, **Close** or a click outside. Focus goes back to the card or row you
  opened it from. Escape closes a menu, a dialog or a field first, when one is open.
- **The address** changes to the ticket's while it is open, so you can copy it from the address
  bar. Back closes the pop-up, or returns to the ticket before if you followed a link inside it.
  Reloading brings the pop-up back over its page.
- **A shared link** opens the ticket's full page. **Open full page** in the pop-up does the same, and
  so do Ctrl click, Cmd click and a middle click, in a new tab.
- **Text you have not saved**, such as a comment you are writing, is safe: closing the pop-up, a
  link inside it and Back all ask before it goes.
- On a phone the pop-up fills the screen.

The ticket's full page keeps unsaved text safe the same way. A link elsewhere in the app, such as
the navigation or **Back to** a board, a command palette command or a menu entry that goes to
another page, and the browser's Back button ask **Discard what you have not saved?** first:
**Keep editing** leaves everything as it was, **Discard it** goes on. Closing or reloading the tab
gets the browser's own question, and only while there is unsaved text. A link to a comment on the
same ticket, or a ticket opened in a pop-up over the page, does not ask: the page stays as it is
beneath. Nor does **Add and open** under **Subtickets**: the summary you typed is saved as the new
subticket, which opens.

The timeline's bars still open their days panel, and links inside a comment or description open in a
new tab.

A ticket also opens by a key it had before: after a move to another track, or when it came from
another tracker under a key that changed there. The address then shows its current key. Links
kept from that tracker, such as `.../browse/PAY-42` or an old filter or board link, open the
ticket, saved search or board the import made of them (see
[Old links keep working](../admin/import-export.md#old-links-keep-working)).

The header holds the ticket's status, which also moves it (see
[Moving a ticket through its workflow](#moving-a-ticket-through-its-workflow)), **Follow** and
**Vote** with their counts, **Clone** (see [Cloning a ticket](#cloning-a-ticket)), **Copy link**
(the ticket's full address; if the browser refuses the clipboard, the page shows the link to copy by
hand) and
**Keyboard shortcuts**. **Edit summary** changes the summary: press Save, or Escape to cancel.

### Details

The **Details** section lists the ticket's fields. Some can be changed in place, but only those
you may change: your role's permissions, the ticket's status, the track's field rules and its edit
form decide which. A field you may not change shows its value with no control, on the page and in
the pop-up alike, and its keyboard shortcut and command palette entry are not offered either. For
example, without **Assign tickets** there is no **Assign to me**, and a due date only some group
may set is a date to read. What you may change can itself change with the ticket: when you take
it, hand it on or move it to another status, the controls follow at once.

| Field | What you can do there |
|---|---|
| **Status** | Read the status, and the close reason once the ticket is closed |
| **Assignee** | **Assign to me** or **Unassign** |
| **Requester** | Read |
| **Priority** | Choose from the list, each with its icon and name. A ticket always has one: a new ticket starts with its track's default, and there is no empty choice. Only an imported ticket can have none, until someone chooses |
| **Labels** | **Edit**, then type labels separated by spaces or commas and press **Save**; a label has no spaces |
| **Start date**, **Due date** | Pick a date, or clear it |
| **Original estimate**, **Time spent**, **Remaining estimate** | Read, in hours |
| **Target releases**, **Areas** | Read |
| **Visibility level** | Read; **Everyone who can browse the track** when none is set |
| **Parent** | Follow the link to the parent ticket |
| **Created**, **Updated** | Read |

Each change saves at once and the page says **Saved.** If someone changed the ticket since you
opened it, the page says so: read it again and retry.

Number fields on the ticket's edit form, such as **Points**, show in the details too, reading
**None** while empty: type a value and press Enter or leave the box, clear it to remove the value, and Escape puts back what is
saved. Someone who may not change it reads the value. The ticket view does not yet show other
custom fields; they can be shown as columns in [search results](search.md#search-results).

### Info

The **Info** section under **Details** shows what Taskmoor works out from the ticket's comments
and history:

- **Date of first response**: when someone other than the requester first commented;
- **Days since last comment**;
- **Participants**: the requester, the assignee and everyone who commented;
- **Time in status**: how long the ticket has spent in each status since it was created, and
  how many times it entered each one.

Only comments everyone who can see the ticket may read count, so a comment restricted to a role
or a group changes none of these. The first three are also [search fields](search.md):
`daysSinceLastComment > 7`, `firstResponse IS EMPTY`, `participants = currentUser()`, and
`ORDER BY firstResponse` or `ORDER BY daysSinceLastComment`.

### Descriptions and rich text

The description is edited in place by everyone who may edit the ticket, at the same time.
Changes save as you type, and the field names the others who are editing it (not you in another
tab). Opening a ticket without typing in it saves nothing and leaves its **Updated** time alone.
If the connection
drops, what you type is kept and sent when it is back. People who may only read it see
**You can read this text but not edit it.**

The editor has a **Formatting** toolbar: bold, italic, strikethrough, code, link, headings,
bulleted and numbered lists, checklists, quotes, code blocks, a divider, tables, mentions, undo
and redo; in the description, undo and redo take back only your own edits. On a phone the toolbar
shows its first tools and **More tools** for the rest. Markdown shortcuts work as you type: `## ` for a heading, `- ` for a list, `[] ` for a
checklist, `> ` for a quote. Ctrl B makes text bold and Ctrl K adds a link. Pasted Markdown
turns into rich text. Press Escape, then Tab, to leave the editor.

Type `/` at the start of a line or after a space, in a description or a comment, for a menu of
blocks; go on typing to narrow it, as in `/hea`. The arrow keys walk it, Enter or Tab picks, and
Escape closes it and leaves what you typed. It offers:

| Kind | Blocks |
|---|---|
| Text | Paragraph, headings 1 to 6, quote |
| Lists | Bulleted, numbered, checklist |
| Panels | Information, note, warning, success, error |
| Layout | Collapsible section, two or three columns, table, divider |
| In a line | Link, mention, another ticket, emoji, date, status label |
| Other | Code block with a language, a file of this ticket |

A block that needs something asks for it above the text, such as a code block's language or a
status label's words and colour. A code block's language is one word, such as `sql`; a list of
common ones narrows as you type, and the arrow keys and Enter, or a click, pick one.

A collapsible section has a title and opens with a click where it is read. Its title is one line:
tabs and other control characters in it become spaces, whether you type them, paste them or bring
the section in from Markdown or another Taskmoor document. While you edit, the button before its
title hides and shows its text. That is only for you: nothing changes in the text, the others
editing with you keep their own view, and the section opens again when the page reloads. Hidden
text still takes the others' changes, and the section then says **Changed while hidden**. The caret
never stays in hidden text: hiding moves it past the section, and going back into the text shows it
again. In the title, Down or Escape goes past a hidden section (onto a new line when nothing
follows it), Enter shows its text and goes in, and Up goes to the text before; Up on the first line
of a section's text goes back to its title. On the way, the caret steps over any other section you
hid, so it stays hidden.

Columns are equal unless you give them widths: with the caret in a column, `/width` offers
**Column widths**, such as a quarter and three quarters, for all of them at once. Columns stack on
a phone. A file is found by its name among the ticket's attachments and opens for whoever may see
it. When two files share a name, the list says each one's size, when it came and who added it, and
the text keeps the one you picked. A ticket shows only its key, so a document never gives away the
summary of a ticket someone may not see. Every block can be written in Markdown and in
[wiki markup](../admin/rest-api.md#rich-text), with a few losses listed there.

### Comments and mentions

The **Activity** section opens on **Comments**, oldest first. Write in **Add a comment** and
press **Comment**. Under **Who can see it**, choose **Everyone who can see the ticket**, **Only a
role** or **Only a group** (a group you are in). A restricted comment says who can see it.

Type `@` in a comment or description to mention someone. The list marks people who cannot see
the ticket; they are not notified. After posting, the panel warns about anyone who was not told.
Mentioned people get a notification in their [inbox](notifications.md).

On each comment you can **Copy link**, add a reaction, and **Edit** or **Delete** it where your
permissions allow. **Delete** asks first, in the danger colour: the comment disappears from the
ticket for everyone. An edited comment shows when it was edited.

### Attachments

The **Attachments** section lists files with their size, who added them and when. Add files
with **Attach files**, by pasting them into the section, or by dropping them anywhere on the
ticket, on its page or in its pop-up: while files from your computer are over the ticket, an
outline goes round all of it with a card saying **Drop to attach to** the ticket and the size
limit (or why you cannot attach files there), and the files you let go join its attachments.
Each file must fit the size limit the section names, and the storage quota when a site
administrator set one: an upload that would pass yours, or the site's, is refused with what
is used and what is left.
**Preview** opens images, PDF files, videos, text and the
contents of ZIP files; **Download all as ZIP** takes every file at once. Deleting a file asks
first and is for good. If the server checks files for viruses, a file is held until it passes.

### Checklists

Every ticket type can hold one or several named checklists, separate from the description. Press
**Add a checklist**, give it a name, and add items with **Add an item**: type, press Enter and go on
typing the next.

An item is **Open**, **In progress**, **Done** or **Rejected**. Ticking its box makes it done and
unticking makes it open; the list beside it sets any of the four. An item in progress shows its box
half ticked, also after you edit its words. Each checklist shows how far along
it is with a bar and the numbers, such as **3 of 4 done (75%)**, and when a ticket has any, the
section shows the same for all of them together. **A rejected item is left out of the percentage**,
because it will never be done: three done, one open and one rejected reads 75%.

**Edit** changes an item's words or a checklist's name, **Move up** and **Move down** change the
order, with the keyboard as with the pointer, and **Remove** takes it away. With a mouse or a
finger you can also drag an item by its grip (the six dots among its controls) to another place in
its checklist; a line shows where it will land, and Escape stops the drag with nothing moved. Every change shows in the
ticket's [history](#history) and reaches others who have the ticket open. Changing a checklist needs
the **Edit tickets** permission; a status that reserves editing to some people holds here too, and
the section says so. Everyone who can see the ticket can read them.

Where the track's administrators turn it on, the ticket's followers are told when its checklists
change, and a run of changes comes as one notice that says who made them and how many, never what
an item says. You are never told of your own changes. See [Notifications and your
inbox](notifications.md#checklist-changes).

[Cloning a ticket](#cloning-a-ticket) copies its checklists with every item open again. They travel
in [exports](../admin/import-export.md), go to the trash with the ticket, and the items you wrote are
in [your data download](account.md).

### Subtickets

The **Subtickets** section lists the tickets under this one, each with its status, and how far
along they are: a bar, and the numbers in text, such as **1 of 2 closed (50%)**. A subticket counts
as closed when its status is in the closed stage of its workflow. You only see, and count, the ones
you may see.

To add one, type its summary and press **Add**, or Enter, to stay here and add another; **Add and
open** takes you to it. If the track has several subticket types, the form asks which. When the
track asks for more fields than the summary, the page names them, a field someone added by the name
the create form shows. Subtickets are ordinary tickets: they move through the track's workflow like
any other. Each one's status in the list is a menu, like the status on a ticket's own page: open it
and pick where the subticket goes. It offers only what its workflow and your permissions allow, and
asks for a close reason or a priority when the move needs one, in a form under the list that takes
the focus (Escape or **Cancel** goes back to the status); a move that needs more sends you to the
subticket's own page. A subticket
has no subtickets of its own, so its page has no such section. On an outcome, the section is called
**Tickets under this** and holds the tickets one level down, the same way.

The same small progress shows on [board cards](boards.md) and in [the list view](views.md#the-list-view)
and search results, for tickets that have any.

### Links

The **Links** section shows the ticket's links to other tickets, grouped under what they say
from this ticket's side (such as **blocks**, **is blocked by** or **relates to**), whichever
ticket they were made from, and its web links.

Press **Add a link**. Under **How it relates**, choose one of your site's link types, read from
this ticket's side. In **Ticket number or name**, type a ticket's number or words from its summary:
matching tickets of the same track appear as you type, and only ones you may see. Arrow keys walk
the list, Enter picks and Escape closes it. Pick as many as you need, then press **Done**.
**Remove** beside a link takes it away from both tickets.

The list only looks in this ticket's track. Links to other tracks, which an import or the
[REST API](../admin/rest-api.md) can make, show and can be removed like any other. Changing
links needs the **Link tickets** permission. Site and configuration administrators manage the
link types, and can turn links off, through the [REST API](../admin/rest-api.md).

### Following and voting

**Follow** adds the ticket to your followed tickets, so its changes reach your inbox and email.
By default you also follow the tickets you create, edit or comment on. **Vote** counts
your support. Both buttons show the current count; press again to undo.

### Time entries

The **Time entries** tab lists the time logged on the ticket. To log time, enter **Time spent**
(for example `1h 30m` or `2d`), optionally **What was done**, and press **Log time**. If time
tracking is off for your site, the tab says so.

### History

The **History** tab lists every change, newest first: who, when and what, such as "Changed
Priority from Normal to High". **Show older changes** reads further back. The **All** tab mixes
comments, changes and time entries in one stream.

### Printing a ticket

Printing a ticket's page (Ctrl P or Cmd P) prints only the ticket: its title, its details, its
description and its comments, in one column. The top bar, the navigation, the toolbars, the
comment box and the buttons are left out. With a ticket open in its pop-up, printing gives that
ticket the same way, without the page beneath it or the pop-up's bar.

## Moving a ticket through its workflow

The status in the ticket's header is one control. Open it, with a click or by pressing **T**, and
it shows where the ticket is now (**Now: Active**, say) and lists the statuses the ticket can go
to, in the same words as the board's columns. Pick one and
the ticket moves at once. On the workflow a site starts with, nothing is asked: any ticket goes to
any status, and entering **Closed** sets the close reason **Completed**. If you want to say why,
write a comment.

An administrator can set stricter rules on a workflow. If a move then needs a close reason or a
priority, a short form asks for it first; if it needs other fields, the page names them. When the
workflow refuses a move, the page says why in plain words.

Tickets also move by dragging their cards on a [board](boards.md).

## Cloning a ticket

**Clone** in a ticket's header, on its page or in its pop-up, makes a copy of it. The copy opens where
you are: in the pop-up over the same page, with Back returning to the original. The dialog asks for:

- **Summary of the copy**: the original's, until you change it.
- **Track**: where the copy goes, the ticket's own track by default, chosen from a list that shows
  each track's mark, key and name. You need permission to create tickets there. A subticket is always copied into its own track, under its parent.
- **Copy with it**: **Subtickets**, **Attachments** and **Links and web links**, all ticked at
  first. On an outcome, or a ticket at a level above it, **Everything below it, at every level
  (deep clone)** also copies every ticket below it, with their subtickets unless you untick
  **Subtickets**.

Press **Clone**. The copies are made in the background, parents first, and the dialog shows how
many are done. Each copy:

- starts in the first status of its workflow, with the original's type, description, people,
  dates, priority, labels, estimate and custom fields, and its checklists with every item open. In the same track it also keeps the
  original's releases, areas and visibility level;
- is linked to its original with the **copies** link (the original reads **is copied by**);
- under a deep clone, sits under the copy of its parent, and two copied tickets that were linked
  to each other are linked as copies too.

Only the tickets you can see are copied, and none in the trash. When everything was copied, the
page opens the copy. If something was left out, such as an assignee you may not set or a field
the new track does not have, or a ticket could not be copied, the dialog says so and offers
**Open PAY-43** and **See each ticket's result**, which shows every ticket that was not copied
and why, as for [bulk changes](#bulk-changes). Comments, followers and logged time are not
copied. A ticket whose type the other track does not offer is not copied, and neither is
anything below it.

The same is available through the [REST API](../admin/rest-api.md) as
`POST /api/v1/tickets/{id}/clone`.

## Locked fields and statuses

A workflow can reserve actions in a status to some roles or groups, and a field can be limited
to some people. In the create form, comments, attachments and search results, a locked control
is read-only and says why, for example "In status Approved, only the Approvers group can add or
remove files." or "Only the Finance group can set this field." On a ticket's page and in its
pop-up, a field locked for you shows its value with no control (see [Details](#details)); the
page does not yet say who may change it. Elsewhere a refused change says
**You may not make this change to this ticket.** Ask one of the people named, or your
administrator.

## Bulk changes

People with the **Change many tickets at once** permission can edit, move, transition or delete
many tickets in one request through the REST API: up to 10,000 by default, a limit site
administrators change as **Tickets per bulk change** on the guardrails page. A change and its
result for every ticket stay readable for 14 days after it finishes. The web app shows its progress at an address
ending in `bulk/` and the operation's number: how many tickets were changed, not changed,
skipped or waiting, a **Cancel the rest** button while it runs, and every ticket that was not
changed with the reason. When some tickets were not changed, a warning takes the place of
**Done.** at the top: it names the change, says whether it finished or was cancelled, and counts
the tickets changed, the tickets not changed and the tickets skipped; the list below it gives the
reasons. Only the person who asked and site administrators see it. The web app does not yet
have a screen to start a bulk change.

## Keyboard shortcuts

On a ticket's page or in its pop-up, outside text fields:

| Key | Action |
|---|---|
| M | Write a comment |
| W | Follow or stop following |
| A | Assign to me |
| T | Go to the transitions |
| E | Edit the summary |
| ? | Show these shortcuts |

Everywhere: C opens the create dialog and Ctrl K (Cmd K) opens the command palette. On a
ticket's page the palette also lists each transition, assigning, following, voting, commenting,
the activity tabs and **Copy the link to PAY-42**.
