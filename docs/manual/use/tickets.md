---
title: "Working with tickets"
audience: users
sources: apps/web/src/App.tsx, apps/web/src/home/HomePage.tsx, apps/web/src/home/client.ts, apps/web/src/shell/CommandPalette.tsx, apps/web/src/tickets/CreateTicketDialog.tsx, apps/web/src/tickets/CreateTicketPage.tsx, apps/web/src/tickets/view/TicketPage.tsx, apps/web/src/tickets/view/ActivityPanel.tsx, apps/web/src/comments/CommentsPanel.tsx, apps/web/src/attachments/AttachmentPanel.tsx, apps/web/src/attachments/AttachmentPreview.tsx, apps/web/src/richtext/RichTextEditor.tsx, apps/web/src/richtext/CollaborativeEditor.tsx, apps/web/src/locks/useLockText.ts, apps/web/src/bulk/BulkOperationPage.tsx, apps/web/src/i18n/messages.en.ts, apps/server/src/routes/bulk.ts, apps/server/src/tickets/followers.ts, docs/adr/0042-edit-locks.md, docs/adr/0043-bulk-operations.md, docs/adr/0044-comments.md, docs/adr/0046-home-create-dialog-palette.md, docs/specs/00-terminology.md, docs/specs/01a-core-work-tracking.md
accessed: 2026-10-30
attestation: own-words
---
# Working with tickets

A ticket is one piece of tracked work. It lives in a track and has a key such as `PAY-42`. This
page covers finding your tickets, creating them, and everything on a ticket's own page. For the
terms used here, see [Concepts and terms](../concepts.md).

## Home

**Home** is the first entry in the navigation. Signed in, it greets you and shows three lists:

| List | What it holds |
|---|---|
| **Assigned to you** | Open tickets assigned to you, the most recently changed first |
| **Opened lately** | Tickets you opened lately, newest first, whichever browser you used |
| **You follow** | Tickets you follow |

Each list loads on its own, so if one cannot be read the others still show. A ticket appears in
these lists only while you may see it: following or having opened a ticket gives no access.

## The command palette

The top bar's **Search or jump to…** button, or Ctrl K (Cmd K on a Mac) anywhere, opens the
**Command palette**. Type a few letters to filter the commands, move with the arrow keys, press
Enter to run one and Escape to close. It offers:

- the pages of the navigation (Home, Inbox, Tracks, Boards, Search, Dashboards, Settings);
- **Create ticket**, **Account**, the three appearance choices and **Sign out**;
- the administration pages, for site administrators;
- on a ticket's page, that ticket's actions (see [Keyboard shortcuts](#keyboard-shortcuts)).

The palette runs commands. To find tickets, use [search](search.md).

## Creating a ticket

Open the create dialog with the **New ticket** button in the top bar, with the C key anywhere
outside a text field, or with **Create ticket** in the palette. Escape or a click outside closes
it. The same form also has its own page at the address ending in `create`.

1. Choose the **Track** and the **Ticket type**. The form then shows the fields that track and
   type ask for. Required fields say **(required)**; fields hidden for the type are not shown.
   Some fields sit under further tabs, such as **More fields**.
2. Fill in the fields. Rich text fields (description and environment) use the editor described
   in [Descriptions and rich text](#descriptions-and-rich-text). Separate labels with spaces.
3. Press **Create**. The dialog says **PAY-42 was created.** and offers **Open PAY-42**.

Some fields cannot be set in this form yet, such as people, releases and areas. The form says
**Set on the ticket once it is created.** next to them.

To start from an existing ticket, enter its key under **Start from a ticket (its key)** and
press **Copy its fields**. The form takes that ticket's track, type, summary, description,
environment, priority, labels and dates. People, releases and custom fields are not copied.

When the server refuses a value, the message shows next to the field, for example **This field
is required.** If there is no track you may create tickets in, the form says so.

Boards' backlogs and a track's list can also make a ticket from a summary alone: see
[the backlog](boards.md#the-backlog) and [the list view](views.md#the-list-view).

## The ticket view

Each ticket has its own page, at an address ending in `tickets/PAY-42`. Its title is the key
and the summary; above it are the track and the ticket type. On a wide screen the details sit
in a column on the right; on a phone everything is in one column.

The header holds the ticket's status, its transitions (see
[Moving a ticket through its workflow](#moving-a-ticket-through-its-workflow)), **Follow** and
**Vote** with their counts, and **Keyboard shortcuts**. **Edit summary** changes the summary:
press Save, or Escape to cancel.

### Details

The **Details** section lists the ticket's fields. Some can be changed in place:

| Field | What you can do there |
|---|---|
| **Status** | Read the status, and the close reason once the ticket is closed |
| **Assignee** | **Assign to me** or **Unassign** |
| **Requester** | Read |
| **Priority** | Choose from the list, or **None** |
| **Labels** | **Edit**, then type labels separated by commas and press **Save** |
| **Start date**, **Due date** | Pick a date, or clear it |
| **Original estimate**, **Time spent**, **Remaining estimate** | Read, in hours |
| **Target releases**, **Areas** | Read |
| **Visibility level** | Read; **Everyone who can browse the track** when none is set |
| **Parent** | Follow the link to the parent ticket |
| **Created**, **Updated** | Read |

Each change saves at once and the page says **Saved.** If someone changed the ticket since you
opened it, the page says so: read it again and retry. The ticket view does not yet show custom
fields; they can be shown as columns in [search results](search.md#search-results).

### Descriptions and rich text

The description is edited in place by everyone who may edit the ticket, at the same time.
Changes save as you type, and the field names the others who are editing it. If the connection
drops, what you type is kept and sent when it is back. People who may only read it see
**You can read this text but not edit it.**

The editor has a **Formatting** toolbar: bold, italic, strikethrough, code, link, headings,
bulleted and numbered lists, checklists, quotes, code blocks, a divider, tables, mentions, undo
and redo. Markdown shortcuts work as you type: `## ` for a heading, `- ` for a list, `[] ` for a
checklist, `> ` for a quote. Ctrl B makes text bold and Ctrl K adds a link. Pasted Markdown
turns into rich text. Press Escape, then Tab, to leave the editor.

### Comments and mentions

The **Activity** section opens on **Comments**, oldest first. Write in **Add a comment** and
press **Comment**. Under **Who can see it**, choose **Everyone who can see the ticket**, **Only a
role** or **Only a group** (a group you are in). A restricted comment says who can see it.

Type `@` in a comment or description to mention someone. The list marks people who cannot see
the ticket; they are not notified. After posting, the panel warns about anyone who was not told.
Mentioned people get a notification in their [inbox](notifications.md).

On each comment you can **Copy link**, add a reaction, and **Edit** or **Delete** it where your
permissions allow. An edited comment shows when it was edited.

### Attachments

The **Attachments** section lists files with their size, who added them and when. Add files
with **Attach files**, by dropping them on the section, or by pasting them. Each file must fit
the size limit the section names. **Preview** opens images, PDF files, videos, text and the
contents of ZIP files; **Download all as ZIP** takes every file at once. Deleting a file asks
first and is for good. If the server checks files for viruses, a file is held until it passes.

### Links

The **Links** section shows the ticket's links to other tickets, with the link's wording (such
as "blocks" or "relates to"), and its web links. It appears only when there are links. Links
are made through the [REST API](../admin/rest-api.md); the web app does not yet have a form to
add or remove them.

### Following and voting

**Follow** adds the ticket to your followed tickets, so its changes reach your inbox and email.
By default you also follow the tickets you create, edit or comment on. **Vote** counts
your support. Both buttons show the current count; press again to undo.

### Time entries

The **Time entries** tab lists the time logged on the ticket. To log time, enter **Time spent**
(for example `1h 30m` or `2d`), optionally **What was done**, and press **Log time**. If time
tracking is off for your workspace, the tab says so.

### History

The **History** tab lists every change, newest first: who, when and what, such as "Changed
Priority from Normal to High". **Show older changes** reads further back. The **All** tab mixes
comments, changes and time entries in one stream.

## Moving a ticket through its workflow

The buttons next to the status are the transitions you may run now. Press one to move the
ticket. If the transition needs a close reason or a priority, a short form asks for it first.
If it needs other fields, the page names them and cannot run that transition yet. When the
workflow refuses, the page says **The workflow does not let this transition happen now.**

Tickets also move by dragging their cards on a [board](boards.md).

## Locked fields and statuses

A workflow can reserve actions in a status to some roles or groups, and a field can be limited
to some people. In the create form, comments, attachments and search results, a locked control
is read-only and says why, for example "In status Approved, only the Approvers group can add or
remove files." or "Only the Finance group can set this field." Elsewhere a refused change says
**You may not make this change to this ticket.** Ask one of the people named, or your
administrator.

## Bulk changes

People with the **Change many tickets at once** permission can edit, move, transition or delete
many tickets in one request through the REST API: up to 10,000 by default, a limit site
administrators change as **Tickets per bulk change** on the guardrails page. A change and its
result for every ticket stay readable for 14 days after it finishes. The web app shows its progress at an address
ending in `bulk/` and the operation's number: how many tickets were changed, not changed,
skipped or waiting, a **Cancel the rest** button while it runs, and every ticket that was not
changed with the reason. Only the person who asked and site administrators see it. The web app
does not yet have a screen to start a bulk change.

## Keyboard shortcuts

On a ticket's page, outside text fields:

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
