---
title: "Notifications and your inbox"
audience: users
sources: apps/web/src/inbox/InboxPage.tsx, apps/web/src/notifications/NotificationsSection.tsx, apps/web/src/notifications/UnsubscribePage.tsx, apps/web/src/notifications/client.ts, apps/web/src/account/AccountPage.tsx, apps/web/src/richtext/mentions.ts, apps/web/src/comments/CommentsPanel.tsx, apps/web/src/i18n/messages.en.ts, apps/server/src/notifications/model.ts, apps/server/src/email/deliver.ts, apps/server/src/email/render.ts, apps/server/src/tickets/comments.ts, apps/server/src/tickets/followers.ts, packages/db/src/migrations/0030_notifications.ts, docs/adr/0041-notification-recipients.md, docs/adr/0047-inbox-mentions-activity.md, docs/specs/00-terminology.md, docs/specs/01c-core-work-tracking.md, apps/server/src/security/notices.ts, docs/adr/0109-security-notices-and-alerts.md, apps/server/src/notifications/track-groups.ts, apps/server/src/routes/inbox.ts, docs/adr/0121-personal-track-groups.md, apps/server/src/notifications/checklists.ts, packages/db/src/migrations/0103_checklist_notices.ts, apps/web/src/trackpeople/ChecklistNoticesBox.tsx, docs/adr/0120-ticket-tools.md, apps/web/src/shell/StandaloneFrame.tsx
accessed: 2026-11-13
attestation: own-words
---
# Notifications and your inbox

Taskmoor tells you about changes to the tickets you work on and follow, about every time
someone mentions you, and when someone shares a group of tracks with you. It tells you in two places: the inbox inside Taskmoor, and email. You
choose which events reach each.

## Who hears about what

Your administrators set a notification policy for each track: which events reach the assignee,
the requester, the followers and other people (see [Email and notification
policies](../admin/notifications.md)). Out of the box, the assignee, the requester and the
followers of a ticket hear of every change to it.

Some rules hold whatever the policy says:

- You hear only about tickets you may see, and about comments you may read. Taskmoor checks this
  again just before showing or sending each notification.
- Mentions always reach the person mentioned, never the writer.
- A group of tracks shared with you, or set on you, reaches you and nobody else.
- Checklist changes reach a ticket's followers only where the track's administrators turn that
  on, and never the person who made them (see [Checklist changes](#checklist-changes)).
- By default you do not hear about changes you make yourself (see [Your notification
  settings](#your-notification-settings)).

## Following tickets

Press **Follow** on a ticket's page (or W there) to follow it, and press it again to stop. By
default you also follow the tickets you create, edit or comment on; the web app has no switch
for this yet. The tickets you follow are listed under **You follow** on **Home**, and
`key IN followedTickets()` finds them in [search](search.md).

## Mentions

Type `@` in a description or a comment and pick a person from the list. People who cannot see
the ticket are marked in the list and are not told. After you post a comment, Taskmoor warns you
about anyone it could not tell, for example because the comment is restricted to a group they
are not in.

A mention reaches the person as **Someone mentions you**, on the channels they keep on for it.
Mentions also count as direct asks in the inbox.

## Checklist changes

A track's administrators can choose to have the followers of its tickets told when a
[checklist](tickets.md#checklists) changes: a list added, renamed, moved or removed, or an item
added, edited, ticked, moved or removed. It is off until they turn it on (see [Inviting people and
running a track](../admin/invitations.md#tracks-you-run)). Where it is on:

- you hear of checklist changes on the tickets you follow and may see;
- you never hear of your own changes, even with **Tell me about changes I make myself** on;
- changes close together on one ticket come as one notice that counts them: "Ana made 5 changes to
  checklists", or "Ana and 1 more made 7 changes to checklists" when others joined in. Changes keep
  joining that notice for a couple of minutes from the first (your administrator's batch window for
  email), until you read or snooze it, or until 100 changes; the next change after that starts a
  new notice. Reading a notice in the inbox keeps the changes it counts out of your email, if the
  email has not gone yet;
- a notice names the ticket and who made the changes, never a checklist's name or an item's words.
  Open the ticket to see them; its [history](tickets.md#history) has each change.

The notices arrive in the inbox and by email as you choose for **A checklist changes on a ticket you
follow** in [your notification settings](#your-notification-settings), and follow your choice under
**Email** like everything else.

## The inbox

**Inbox** in the navigation lists your notifications, newest first. New ones arrive within a
second or so, without reloading.

| Tab | What it holds |
|---|---|
| **All** | Everything |
| **Priority** | Direct asks: mentions, and tickets assigned to you |
| **Snoozed** | Items you put aside, until their time comes |

**Unread only** hides what you have read. **Type** narrows the list to one kind of event and
**Track** to one track; on a phone both take the whole width, their names above them. The page says how many items are unread.

Each item says who did what ("Ana mentioned you in a comment", "Ana assigned it to you"), links
the ticket, and quotes the comment when there is one you may read. A quote, here and in email, is
the comment's text without formatting: a collapsible section's title before its text, columns one
after the other, a date as its day, a status label in brackets such as `[BLOCKED]`, an emoji as
itself, and a file or another ticket by its name or key. Unread items are marked, and
direct asks carry the **Direct ask** badge. Opening the ticket from an item marks it as read and
takes you to the comment it is about.

On each item:

- **Mark as read** or **Mark as unread**.
- **Snooze**: **For an hour**, **Until tomorrow** or **Until next week**. A snoozed item comes
  back unread at the top of the inbox when its time comes. **Back to the inbox** returns it at
  once.

**Mark all as read** clears the whole list. A notification you read in the inbox is not emailed
to you afterwards, digests included.

If a ticket becomes hidden from you, its items leave your inbox and its unread count.

When someone shares one of their [groups of tracks](../admin/tracks.md#groups-of-tracks) with
you, or sets one on you as a copy of your own, an item says who and how ("Ana shared a track
group with you, with the role Members") and names the group as it is called now. It links to
your **Tracks** page. It never names the group's tracks, so it tells you of none you may not
see. If the share is taken back, or you leave the group, the item goes. **Type** finds these
items under **A track group is shared with you or set on you**.

A run of [checklist changes](#checklist-changes) on a ticket you follow is one item that says who
made them and how many, and links the ticket. **Type** finds these under **A checklist changes on a
ticket you follow**.

Site administrators also get **security alerts** and **AI spend alerts** here, under
**Priority**: an item names the rule ("Failed sign-ins for one account: 10 in 60 minutes") and
whom it is about, and links to the audit log (or the AI usage page). They are about no ticket,
and they stay only while you are a site administrator. See
[security alerts](../admin/people-and-groups.md#security-emails-and-alerts).

## Your notification settings

Your settings are in the **Notifications** section of your [account](account.md). Notification
emails link straight to it. Each change saves at once.

Under **Email**, choose how email arrives:

| Choice | What happens |
|---|---|
| **At once** | Changes to one ticket within a few minutes arrive together in one email |
| **Daily digest** | One email a day with everything that happened |
| **Weekly digest** | One email on Mondays with the week before |
| **No email** | Nothing by email; notifications still reach your inbox |

Digests go out at an hour your administrator sets, in your own time zone.

**Hold email during quiet hours**, with **From** and **Until**, keeps email back until the quiet
hours end, in your time zone. **Tell me about changes I make myself** is off unless you turn it
on.

**What you hear about, and where** is a table with one row per event and a box for **Email** and
one for **Inbox**. On a phone each event is a block of its own, with its **Email** and **Inbox**
boxes beneath it:

| Event | When |
|---|---|
| **Someone mentions you** | You are mentioned in a description or comment |
| **A track group is shared with you or set on you** | Someone shares a group of tracks with you, or gives you a copy |
| **A checklist changes on a ticket you follow** | Someone changes a checklist, on a track that tells followers ([Checklist changes](#checklist-changes)) |
| **Ticket created** | A ticket is created |
| **Ticket updated** | A field changes |
| **Assignee changed** | The assignee changes |
| **Close reason set** | A close reason is set |
| **Ticket closed** | The ticket is closed |
| **Comment added** | Someone comments |
| **Ticket reopened** | A closed ticket is opened again |
| **Ticket moved to the trash** | The ticket is deleted |
| **Ticket moved to another track** | The ticket moves to another track |
| **Time logged**, **Logged time changed**, **Logged time deleted** | Time entries change |
| **Work started**, **Work stopped** | Work on the ticket starts or stops |
| **Other changes** | Anything else the policy sends |

Turning a box off stops that event on that channel for you, whatever the policy says.

An email about a track group names the group and who shared it, and the role if one came with
it, and links to your **Tracks** page. It follows your choice under **Email** like any other, and
it is not sent if the group is no longer yours by the time it would go.

A run of checklist changes is one line in the ticket's email, such as "Ana made 5 changes to
checklists", with no checklist's name and no item's words. With email as changes happen, the
ticket's email waits while someone is still in the middle of a run of checklist changes, so the
earlier changes and the run arrive together in one email instead of two. It never waits more
than one batch window (a couple of minutes) past when it would have gone: a run still going on
then is counted as it stands, and its next changes come in a later email.

## Unsubscribing from email

Every notification email has an unsubscribe link. It opens a page that asks whether to stop all
notification emails, or only emails about one event, to your address. Press **Unsubscribe** to
confirm; **Notification settings** takes you to the full settings. A link that is cut short says
so, and one that no longer works says to change your settings after signing in; **Go to sign in**
at the top leads there. Notification emails are in English for now.

Emails of saved-search subscriptions are set up on the search page: see [Saved
searches](search.md#saved-searches).
