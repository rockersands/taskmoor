---
title: "Email and notification policies"
audience: admins
sources: apps/server/src/config.ts, apps/server/src/main.ts, apps/server/src/email/transport.ts, apps/server/src/email/deliver.ts, apps/server/src/email/render.ts, apps/server/src/routes/email.ts, apps/server/src/routes/setup.ts, apps/server/src/notifications/model.ts, apps/server/src/notifications/subscriber.ts, apps/server/src/routes/notifications.ts, apps/server/src/routes/tracks.ts, apps/server/src/audit/subscriber.ts, packages/db/src/migrations/0030_notifications.ts, apps/web/src/i18n/messages.en.ts, apps/web/src/account/AccountPage.tsx, deploy/README.md, deploy/compose/docker-compose.yml, deploy/helm/taskmoor/values.yaml, docs/adr/0041-notification-recipients.md, docs/specs/01c-core-work-tracking.md, apps/server/src/email/smtp.ts, apps/server/src/notifications/checklists.ts, packages/db/src/migrations/0103_checklist_notices.ts, docs/adr/0120-ticket-tools.md, apps/web/src/notifications/NotificationPoliciesPage.tsx, apps/web/src/notifications/policiesClient.ts, apps/web/src/admin/EmailSettingsPage.tsx, apps/web/src/admin/sections.ts, apps/web/src/trackpeople/TrackPeoplePage.tsx, apps/server/src/workflows/model.ts
accessed: 2026-11-16
attestation: own-words
---
# Email and notification policies

When something happens to a ticket, Taskmoor tells the people concerned in their inbox and by
email. Three things decide who hears what and how:

- the **notification policy** of the ticket's track names, for each event, the recipients;
- each person chooses, per event, whether it reaches their inbox, their email or both, and how
  email arrives (see [Notifications and your inbox](../use/notifications.md));
- the site's outgoing mail settings decide whether email can be sent at all.

This page covers the first and the last.

## Configuring outgoing mail

Taskmoor sends email through an SMTP server that you name with environment variables, or in
the mail fields of the [first-run setup form](first-run.md) when the environment names none.
The password comes only from the environment (or a secrets manager that fills it), never from
a file in the kit or from the web app.

| Variable | Meaning |
|---|---|
| `TASKMOOR_SMTP_URL` | `smtp://host:port` or `smtps://host:port`, with no user name or password in it. `smtp://` upgrades with STARTTLS when the server offers it (port 587 unless given); `smtps://` speaks TLS from the start (port 465 unless given) |
| `TASKMOOR_SMTP_USER`, `TASKMOOR_SMTP_PASSWORD` | The SMTP sign-in. With `TASKMOOR_SMTP_URL`, set both or neither; the server refuses to start with only one. For the setup form's server, the form keeps the user name and `TASKMOOR_SMTP_PASSWORD` alone gives the password |
| `TASKMOOR_SMTP_FROM` | The From address, for example `Taskmoor <taskmoor@example.com>`. Without it, Taskmoor uses `Taskmoor <taskmoor@host>`, where host is the host name of `PUBLIC_URL` |
| `PUBLIC_URL` | Where people reach Taskmoor. Links in emails are built from it, so set it |

Email goes out from processes that run the worker role, which the default role `all`
includes. When you split roles, set the variables on the worker.

- **Compose kits:** put them in `.env` next to the Compose file and run `install.sh` again.
- **Helm:** add them to `extraEnv`, taking the password from a Kubernetes secret.

See [Configuration reference](configuration.md) for the other variables.

Without `TASKMOOR_SMTP_URL` or the setup form's mail fields, notifications still reach the
inbox, and email waits unsent; the worker logs `email notifications wait unsent` when it starts. Once you
set it, what is waiting goes out, except notifications the person has already read in the
inbox.

The first-run setup page also asks for outgoing mail settings under **Outgoing mail
(optional)**. When the environment names no server, the worker sends through that one, read
again before every round of emails, so no restart is needed. If the form names an SMTP user,
set `TASKMOOR_SMTP_PASSWORD` for it.

### Checking that mail works

Taskmoor has no test-mail button or command yet. To check the settings:

1. **Administration** > **System** > **Email** shows **Mail server: Set up** when the server read
   an SMTP address (`smtpConfigured: true` from `GET /api/v1/admin/email-settings`), and **Not set
   up** otherwise.
2. On your own Account page, keep email **At once** and turn on **Tell me about changes I
   make myself**. Then change a ticket assigned to you in a track that uses the default
   policy.
3. The email should arrive within about two and a half minutes: the batch window (two
   minutes by default) plus the worker's 30-second round.

The worker logs each round that sent or failed something (`notification emails`, with counts),
and a warning when a round could not run. A failed send is recorded and tried again on the next
round.

## How email is sent

- **At once** (each person's default): one email per ticket once its oldest unsent change is
  as old as the batch window. Five edits within the window make one email listing all five.
- **Daily digest** and **Weekly digest**: one email with everything, at the digest hour in
  each person's own time zone; the weekly one on Mondays.
- **Quiet hours** hold a person's email until they end, in their time zone.
- Just before sending, Taskmoor checks again that the person may still see each ticket and
  read each comment; anything they may not is dropped. Notifications already read in the
  inbox are not emailed, and deactivated people get nothing.
- Every email has a text and an HTML part, links to its tickets and to the person's
  notification settings, and carries a one-click unsubscribe link (with the
  `List-Unsubscribe` headers mail clients use). The link turns off email for that event when
  the email is about a single event, and all notification email otherwise.
- There is no daily sending cap. Your SMTP provider may have one.
- Emails are in English for now, whatever a person's language.

Saved-search subscriptions are emailed through the same SMTP server.

### The Email page

Site administrators set the batch window and the digest hour on **Administration** > **System** >
**Email** (`#/admin/email`). The page has:

- **Outgoing mail**: **Mail server** is **Set up** or **Not set up**, with what that means. The
  server's address, its user name and its password are never shown or asked for here: they stay
  where Taskmoor runs (see above).
- **Wait before emailing a ticket's changes, in minutes**: the batch window, from 0 to 60. A part of
  a minute is kept, so a window set through the API in seconds, such as 90, shows as 1.5.
- **Digest hour**: the hour daily digests go out in each person's own time zone, and weekly ones on
  Mondays, from 00:00 to 23:00.
- **Save email settings** saves both and says so; a number of minutes outside 0 to 60 is refused
  on the page.

Configuration administrators and everyone else see only that the page is for site administrators.
Through the API it is the same setting:

```http
PUT /api/v1/admin/email-settings HTTP/1.1
Authorization: Bearer <administrator token>
Content-Type: application/json

{ "batchWindowSeconds": 300, "digestHour": 7 }
```

| Setting | Range | Default |
|---|---|---|
| `batchWindowSeconds` | 0 to 3,600 seconds | 120 |
| `digestHour` | 0 to 23, in each person's time zone | 8 |

## Notification policies

A notification policy is a list of rules. Each rule pairs an event with a recipient type. A
track uses the policy it names, or the site's default policy when it names none.

### Events

| Event | What people see it as | When |
|---|---|---|
| `ticket_created` | Ticket created | A ticket is created |
| `ticket_updated` | Ticket updated | Fields change, other than the two below |
| `ticket_assigned` | Assignee changed | The assignee changes |
| `ticket_close_reason_set` | Close reason set | A close reason is set |
| `ticket_closed` | Ticket closed | A transition moves the ticket into the closed stage |
| `ticket_reopened` | Ticket reopened | A transition moves it out of the closed stage |
| `work_started` | Work started | A transition from the new stage to the active stage |
| `work_stopped` | Work stopped | A transition from the active stage back to the new stage |
| `generic` | Other changes | Any other transition without an event of its own |
| `ticket_commented` | Comment added | A comment is added |
| `ticket_deleted` | Ticket moved to the trash | The ticket is deleted |
| `ticket_moved` | Ticket moved to another track | The ticket moves to another track |
| `time_entry_added` | Time logged | A time entry is added |
| `time_entry_updated` | Logged time changed | A time entry changes |
| `time_entry_deleted` | Logged time deleted | A time entry is deleted |

A transition can fire an event of its own (see [Workflows](workflows.md)). In a policy it is
written `custom:<name>`, for example `custom:Ready for review`, and it replaces the event the
transition would otherwise stand for.

Mentions are not part of policies. A person or team mentioned in a description or comment
hears of it whatever the policy says, if they may see the ticket and read the comment.

Checklist changes are not part of policies either. A track's administrators turn them on for
their track (`checklistNotices`, see [Inviting people and running a
track](invitations.md#tracks-you-run)); then the followers of its tickets who may see them hear of
changes to checklists and items as `checklist_changed`, never of their own. Changes to one ticket
within the batch window below join one notice, which counts them and names who made them, never a
checklist or an item. People choose its channels like any other event. See [Checklist
changes](../use/notifications.md#checklist-changes).

### Recipients

| Recipient | Who it reaches |
|---|---|
| `assignee` | The ticket's assignee |
| `requester` | The ticket's requester |
| `follower` | The ticket's followers |
| `area_owner` | The owners of the ticket's areas |
| `track_owner` | The track owner |
| `user` | One person, named by `userId` |
| `group` | The members of a group, nested groups included, named by `groupId` |
| `role` | The people and groups that hold a track role in the ticket's track, named by `roleId` |
| `user_field` | The people in a user field, named by `fieldKey` such as `cf[12]` |
| `group_field` | The members of the groups in a group field, named by `fieldKey` |
| `current_user` | The person who made the change |

### The default policy

Every site has a policy called **Default notifications**: the assignee, the requester and
the followers hear of every event in the table above. You may change its rules, but not delete
it. Tracks that name no policy use it.

### Who never receives a notification

Whatever a policy says, Taskmoor leaves out:

- people who may not see the ticket, its visibility level included;
- for a comment or time entry restricted to a role or group, people outside it;
- deactivated people;
- the person who made the change, unless they turned on **Tell me about changes I make
  myself**. That also applies to `current_user`, which therefore reaches only people who asked
  to hear of their own changes.

A notification records which fields changed, not their values. The inbox and email read the
ticket as each person may see it, and an email quotes a comment only to people who may read
it.

## Managing policies

Site and configuration administrators manage the shared policies on **Administration** >
**Tracks and setup** > **Notification policies** (`#/admin/notification-policies`). The page lists
every shared policy, the default first, each with its description, the tracks that use it (the
default's line says that tracks naming no other policy use it) and how many rules it has.

- **New policy** opens a form above the list: **Policy name**, **Description** and **Start with**,
  which offers **No rules** or the rules of any listed policy and starts from the default's. The
  new policy opens once it is added.
- **Manage** a policy to open it. Under **Who hears of what in** the policy, its rules are grouped
  by event, in the order of the table above, then the events transitions fire; each recipient has
  **Remove**. A rule names the person, group, role or field it points at by name.
- **Add a rule**: choose the **Event**, **Who hears of it**, and, for a recipient type that names
  one, the person (found by name), group, track role, user field or group field. **Events that
  transitions fire** lists the events of the published workflows; **Another transition event…**
  takes a name you type, checked as the API checks it. A recipient type with nothing to choose from,
  such as group fields on a site with none, is not offered. A rule the policy has already is
  refused before anything is sent. Each rule saves at once.
- **Name and description** of the policy, with **Save name and description**.
- **Delete** a policy no track uses: the page asks first and says what is lost. The default policy
  and a policy tracks use have no **Delete**; the page says why. Choose another policy for those
  tracks on [Which sets a track uses](fields.md#which-sets-a-track-uses), which the page links to.

A local-mode track's own policies are on its own page, `#/manage/tracks/<id>/notification-policies`,
linked from the track's **Manage** page under **Its own configuration** (see [A track's own
sets](fields.md#a-tracks-own-sets)). The people who run the track, and site and configuration
administrators, see there only the policies the track owns, a line saying which policy the track
uses, and the same controls. A new policy there belongs to the track, its rules may name the track's
own fields and its workflows' events, and **Use this policy for** the track makes the track follow
it. Someone who runs tracks but is no administrator is offered, on the shared page, links to the
tracks they run with their own configuration, and nothing else. Groups are listed for site and
configuration administrators only, so on a track's own page someone who is neither cannot add a
rule naming a group; a rule that names one already still shows it.

The same through the API:

| Task | API |
|---|---|
| The events, recipient types and channels | `GET /api/v1/notification-events`; `customEvents` lists the events published transitions fire (`custom:<name>`) for site and configuration administrators, and with `?trackId=<id>` a local-mode track's own too, for those who may change its policy; anyone else gets none |
| List shared policies, or a local-mode track's own | `GET /api/v1/notification-policies` (add `?trackId=<id>` for a track's own) |
| Read one | `GET /api/v1/notification-policies/<id>` |
| Create one | `POST /api/v1/notification-policies` |
| Change one | `PATCH /api/v1/notification-policies/<id>` |
| Delete one | `DELETE /api/v1/notification-policies/<id>` |
| Choose a track's policy | [Which sets a track uses](fields.md#which-sets-a-track-uses) in the web app, or `PATCH /api/v1/tracks/<track id>` with `notificationPolicyId` (`null` for the default) |

A new policy, for example:

```json
{
  "name": "Payments",
  "description": "The team hears of new tickets; followers of comments.",
  "rules": [
    { "event": "ticket_created", "recipient": "group", "groupId": 12 },
    { "event": "ticket_commented", "recipient": "follower" },
    { "event": "ticket_assigned", "recipient": "assignee" },
    { "event": "custom:Ready for review", "recipient": "user_field", "fieldKey": "cf[31]" }
  ]
}
```

- Saving `rules` replaces the whole list. A policy holds up to 2,000 rules. A name already in
  use is refused with `409 name_taken`.
- A rule names exactly what its recipient type needs: `userId`, `groupId`, `roleId` or
  `fieldKey`, and nothing else. A `user_field` rule needs a user field and a `group_field`
  rule a group field.
- Every answer lists the tracks that use the policy (`usedBy`). A policy in use cannot be
  deleted (`409 in_use`, with the tracks), nor can the default one (`409 default_policy`).
- Each rule in an answer also names what it points at: `userName`, `groupName`, `roleName` and
  `fieldName`, null when the rule names nothing of that kind.
- Changes take effect for the next event; nothing already sent changes.

### Who may change policies

- Shared policies: site administrators and configuration administrators. Choosing a shared
  policy for a track needs one of those and the right to administer the track.
- A local-mode track's own policy, and choosing it for that track: also the track's
  administrators, on the track's own page or through the API. Create it with `"trackId": <id>` in
  the body.
- For shared policies, an API token needs the `admin` scope besides `read` or `write`, because
  a token without it leaves its owner's administrator permissions behind (see
  [API tokens and service accounts](api-tokens.md)).

Creating, changing and deleting policies, and changing the email settings, are audit events.

## What people choose for themselves

Each person decides on their Account page, under **Notifications**:

- for each event, **Email** and **Inbox** on or off (both on to begin with);
- how email arrives: **At once**, **Daily digest**, **Weekly digest** or **No email**;
- **Hold email during quiet hours**, with **From** and **Until**;
- **Tell me about changes I make myself** (off to begin with).

A policy decides who may hear of an event; a person's choices only narrow that. See
[Notifications and your inbox](../use/notifications.md).
