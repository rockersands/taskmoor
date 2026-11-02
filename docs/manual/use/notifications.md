---
title: "Notifications and your inbox"
audience: users
sources: apps/web/src/inbox/InboxPage.tsx, apps/web/src/notifications/NotificationsSection.tsx, apps/web/src/notifications/UnsubscribePage.tsx, apps/web/src/notifications/client.ts, apps/web/src/account/AccountPage.tsx, apps/web/src/richtext/mentions.ts, apps/web/src/comments/CommentsPanel.tsx, apps/web/src/i18n/messages.en.ts, apps/server/src/notifications/model.ts, apps/server/src/email/deliver.ts, apps/server/src/email/render.ts, apps/server/src/tickets/followers.ts, packages/db/src/migrations/0030_notifications.ts, docs/adr/0041-notification-recipients.md, docs/adr/0047-inbox-mentions-activity.md, docs/specs/00-terminology.md, docs/specs/01c-core-work-tracking.md, apps/server/src/security/notices.ts, docs/adr/0109-security-notices-and-alerts.md
accessed: 2026-11-02
attestation: own-words
---
# Notifications and your inbox

Taskmoor tells you about changes to the tickets you work on and follow, and about every time
someone mentions you. It tells you in two places: the inbox inside Taskmoor, and email. You
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

## The inbox

**Inbox** in the navigation lists your notifications, newest first. New ones arrive within a
second or so, without reloading.

| Tab | What it holds |
|---|---|
| **All** | Everything |
| **Priority** | Direct asks: mentions, and tickets assigned to you |
| **Snoozed** | Items you put aside, until their time comes |

**Unread only** hides what you have read. **Type** narrows the list to one kind of event and
**Track** to one track. The page says how many items are unread.

Each item says who did what ("Ana mentioned you in a comment", "Ana assigned it to you"), links
the ticket, and quotes the comment when there is one you may read. Unread items are marked, and
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
one for **Inbox**:

| Event | When |
|---|---|
| **Someone mentions you** | You are mentioned in a description or comment |
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

## Unsubscribing from email

Every notification email has an unsubscribe link. It opens a page that asks whether to stop all
notification emails, or only emails about one event, to your address. Press **Unsubscribe** to
confirm; **Notification settings** takes you to the full settings. Notification emails are in
English for now.

Emails of saved-search subscriptions are set up on the search page: see [Saved
searches](search.md#saved-searches).
