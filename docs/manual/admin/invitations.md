---
title: "Inviting people and running a track"
audience: admins
sources: apps/server/src/routes/invitations.ts, apps/server/src/authz/track-admins.ts, apps/server/src/authz/permissions.ts, apps/server/src/routes/authz.ts, apps/server/src/email/invitation.ts, apps/server/src/sso/sign-in.ts, packages/db/src/migrations/0087_track_invitations.ts, apps/web/src/trackpeople/ManagedTracksPage.tsx, apps/web/src/trackpeople/TrackPeoplePage.tsx, apps/web/src/trackpeople/InviteDialog.tsx, apps/web/src/trackpeople/InvitationPage.tsx, apps/web/src/trackpeople/CreateTracksBox.tsx, apps/server/src/authz/create-tracks.ts, packages/db/src/migrations/0097_invitation_create_tracks.ts, apps/web/src/i18n/messages.en.ts, docs/adr/0118-track-invitations.md, docs/specs/05a-administration-security-and-self-hosting.md, apps/web/src/trackpeople/ChecklistNoticesBox.tsx, apps/server/src/routes/tracks.ts, packages/db/src/migrations/0103_checklist_notices.ts, docs/adr/0120-ticket-tools.md, apps/web/src/sets/trackScope.tsx, apps/web/src/shell/StandaloneFrame.tsx, apps/server/src/routes/groups.ts, apps/server/src/routes/users.ts, apps/server/src/trackgroups/access.ts, apps/server/src/ldap/accounts.ts, docs/plan/decisions.csv, apps/web/src/trackpeople/client.ts, apps/web/src/api/managedTracks.ts, apps/web/src/shell/DangerAction.tsx
accessed: 2026-11-16
attestation: own-words
---
# Inviting people and running a track

Anyone can have a Taskmoor account with their email address, personal or company. There is no
open sign-up: people come in because someone invited them, a site administrator added them, or
single sign-on, a directory or SCIM brought them. This page is for site administrators and for
the people who run a track.

## Tracks you run

If you run a track you do not need to be a site administrator to manage it. Open **Administration**,
then **Tracks you run** (`#/manage/tracks`), and **Manage** a track. The list holds every track
you run that is not archived, however many there are. A track's page shows:

- **Who holds which role**, with **Remove** on the roles you may take away;
- **Give a role**: choose the **Role**, find a person by name and **Add**. With the role that runs
  the track you may also see **Also let them create tracks**: see
  [Letting a manager create tracks](#letting-a-manager-create-tracks);
- **Invite people**, when that is on for you;
- **Invitations waiting**;
- for a track with its own configuration, **Its own configuration**: links to the track's own
  **Layout sets** (where fields appear on its forms) and **Configuration sets** (its ticket types
  and field rules). See [A track's own sets](fields.md#a-tracks-own-sets).
- **Notices to followers**: **Tell followers when a checklist changes**, off until you tick it. It
  saves at once and says so under the box, or says there why not and goes back. The followers of the track's tickets then hear of changes to
  checklists and their items, in their inbox and by email as each of them chooses, never of their
  own changes, and changes close together on one ticket come as one notice that names no checklist
  and no item (see [Checklist changes](../use/notifications.md#checklist-changes)). Through the
  API it is `checklistNotices` on `PATCH /api/v1/tracks/:id`.

What an action did, or why it was refused, shows right beside the row you pressed it on, however
long the list: under that person, group or invitation, or under the box. When the action takes the
row away (a role removed, an invitation withdrawn, a person given a role from the search), the
answer takes the row's place in the list. A screen reader reads it out.

Finding people by name uses **See people and groups**. If that permission has been taken away, a
person can still be invited by address. Managers give roles to people; giving a role to a group
stays with site administrators, who have the group list. Site administrators reach the same page
through **People and invitations** under **Manage** in **Settings** > **Tracks**.

## Two permissions

Both are track permissions, so they are given in access policies, on
[Permissions and access](permissions.md).

| Permission | Code | What it allows | Given by default to |
|---|---|---|---|
| **Invite people** | `invite_people` | Invite people into a track the person also runs | Nobody: off until a site administrator gives it |
| **Give the role that runs the track** | `appoint_track_admins` | Give or take a role that runs the track, and change the track's owner | Whoever may run the track: the Administrators role and the track owner |

A site administrator always holds both.

### Turning inviting on

1. Open **Settings** > **Permissions** > **Access policies** and **Manage** the policy your tracks
   use.
2. **Give a permission**: **Invite people**, to the role **Administrators**.

To take it away, **Remove** the grant. Only a site administrator may do either; a configuration
administrator is refused. Open links of people who no longer may invite stop working at once, and
show **No longer valid** on the list. A site administrator may send them again, which makes them
their own.

A local-mode track starts without this permission even when its source policy has it. A site
administrator gives it on that track's own policy.

### Stopping managers from appointing managers

**Remove** the grants of **Give the role that runs the track** from the policy. A track's
administrators can then still give and remove the other roles, but not that one, and cannot name
a new owner. Whoever may edit the policy may do this: site and configuration administrators, or,
on a local-mode track's own policy, its administrators while they hold the permission themselves.

"A role that runs the track" means one that holds **Run the track** in the track's policy.
Renaming the role changes nothing. The permission reaches only that track. A manager who takes a
site administrator out of a track's role changes only that: the site administrator keeps every
right they have.

### Letting a manager create tracks

On a new site only site administrators create tracks (see
[Tracks](tracks.md#who-may-create-one)). When you give someone a role that runs the track, under
**Give a role** or in the **Invite people** dialog, a box appears under the role: **Also let them
create tracks**. It is ticked; untick it to give the role alone. Ticked, the person also gets the
global permission **Create tracks with their own configuration**, for the whole site, not only
this track.

- You see the box only if you could give that permission anyway: you are a site administrator, or
  you may create tracks yourself. Nobody else is offered it, and the server refuses a request that
  asks for it ("Only site administrators and people who can create tracks themselves can give that
  permission.").
- It goes to people, never to groups, and only with a role given there and then: someone who
  already holds the role gets nothing more.
- An invitation keeps the box until it is taken up. If the person who backs it can no longer give
  the permission by then, the role still comes, without the permission.
- **The permission goes with the role.** When the person no longer runs any track, the permission
  that came with the box goes too: when you take their role away under **Who does what**, take a
  group's role that was how they ran it, withdraw the invitation that gave it, remove them from
  that group (or the group, or its place inside another group), take back the shared group of
  tracks that gave them their last role there (or they leave it, or it is deleted, or its owner is
  erased), or deactivate them (here, through SCIM, or when a directory removes or disables them).
  Someone who still runs another track keeps it, including a track every signed-in person runs.
- **A permission given separately stays.** If a site administrator gave it on **Settings** >
  **Permissions** > **Global permissions**, or the person had it before you ticked the box, losing
  the role leaves it; remove it there, where each person who holds it is listed by name. To let a
  former manager keep creating tracks, give it to them there.

The grant shows in the audit log inside the event that gave the role: `createTracksGrantId` on
`track_role.actor_added`, `track_invitation.created`, `.resent` or `.accepted`. Its removal shows
inside the event of the change that took it, as `createTracksGrantsRemoved` (for example on
`track_role.actor_removed`, `group.member_removed`, `track_group.unshared`, `user.deactivated` or
`directory.user_updated`).

Changes that take no one's role away directly leave the permission until a site administrator
removes it: an access policy's administer permission taken from a role, a track deleted or given
another policy, and group changes that come from a directory sync or single sign-on for someone
who stays active.

### A track keeps someone to run it

Removing the last active person who may run a track is refused, for everyone: "This is the last
person who runs the track: give the role to someone else first." (`409 last_track_admin`). People
count through a role, a group, a direct grant, or as the track's owner. Site administrators do not
count; they can run every track anyway. A local-mode track's own policy cannot lose its last such
grant either. A shared policy can, since its editors change it for every track that uses it, and
deactivating a person is not stopped.

## Inviting

**Invite people** opens a small dialog.

1. Type or paste **Email addresses**: commas, semicolons, spaces and lines all work, and so does
   `Name <address>`. Or **Find a person by name**.
2. Choose a **Role**. Only the roles you may give are offered. With the role that runs the track,
   **Also let them create tracks** may appear, ticked
   ([Letting a manager create tracks](#letting-a-manager-create-tracks)).
3. Choose how it travels: **Taskmoor sends an email**, or **I copy a link and pass it on**. Where
   the site sends email, only site administrators see this choice: see
   [Who may copy a link](#who-may-copy-a-link).

Up to 50 addresses go at once. One inviter sends up to 100 an hour, and one address gets at most 5
an hour, per server process.

A link works once and for seven days. It is shown only at that moment, and the server keeps only a
hash of it. Each email or link carries one track and one role. It gives nothing else.

### Who may copy a link

A copied link lets whoever holds it take up the invitation without showing that the mailbox is
theirs. So where the site sends email, **only site administrators copy links**. A track's
administrators who are not site administrators send every invitation by email: the dialog offers
no choice, **New link** is not shown on waiting invitations, and one line on the page and in the
dialog says "Your invitations go by email: on a site that sends email, only site administrators
copy links." The server refuses such a link from anyone else with `403 email_invitations_only`, also
through the API, and the list's `canCopyLinks` says whether the person asking may.

A site administrator may still make a link, for their own invitations or someone else's, with
**New link** or **I copy a link and pass it on**.

### Without a mail server

A site with no mail server cannot send anything, and the dialog says so: "Email is not set up on
this site". Links are then the only way, for everyone who may invite. See [the configuration reference](configuration.md) for
setting up mail. Pass a link only to the person it is for: whoever holds it can take up the
invitation, and for a new address that means making the account.

### Someone who already has an account

They get the role at once and an email saying so. A person found by name does not appear under
**Invitations waiting**. An address does, until they follow the email's link or the invitation
runs out; **Withdraw** then takes the role back, if this invitation is what gave it.

Taskmoor does not tell you whether an address has an account: the answer, the list and the page
the link opens read the same either way. A deactivated account gets the same answer and nothing
else: no role, no email. You may notice a name appear under **Who holds which role**.

### Waiting invitations

The list holds every invitation still waiting, the most recently sent first, however many there
are.

**Send again** and **New link** make a new link and end the old one. **New link** is there for those
who may copy links ([Who may copy a link](#who-may-copy-a-link)), and shows the link to copy inside
that invitation's row. **Withdraw**, in the danger colour, ends the invitation after asking: the
link sent to the address stops working, and a role this invitation already gave goes too. The
question reads the same whether the address has an account or not. **Cancel**, which has the focus,
or Escape keeps it.
**Email not sent** means the mail server refused it; try **Send again**.

## What the invited person sees

The link opens a page saying who invited them, to which track and as what. They choose how to come
in:

- **Choose a name and a password**, for a new account. Password rules are those of
  [People and groups](people-and-groups.md#password-rules). Then the ordinary sign-in happens, and
  they land in the track.
- **Sign in**, with their password or a single sign-on provider of the site. Then they land in the
  track.

A link can never change the password of an existing account. Someone signed in as another person is
asked to sign out first.

The page stands on its own, with the product name and **Go to sign in** at the top. A link cut
short says it has no invitation in it; one that was used, withdrawn or ran out says so. Both say
to ask a site administrator for a new one.

### Two-factor for people outside the organization

Where a site has set its organization's domains (**Settings** > **Security**), anyone at another
domain is external and must use two-factor authentication. A personal address counts. Invitations
keep to this rule: the inviter is told **This address is outside your organisation**, the page says
so too, and after choosing a password the person sets up an authenticator app before they get a
session. Until then they hold the role but cannot sign in. On a site with no domain list, nothing
changes.

### Single sign-on

A provider that vouches for the invited address (see [Single sign-on](sso.md)) opens the invitation,
also when its **Create accounts at a first sign-in** is off: an address with a live invitation gets
an account, and the link then gives the role. Any other address with no account is still refused.
A provider still serves only its own domains. Where a provider serves the address, the page opens
at signing in, with that provider offered first; choosing a password stays one click away unless the
domain enforces single sign-on, where it is refused and the page moves to signing in. A provider's
own checks replace Taskmoor's second factor there. For invitations to Gmail addresses, see
[Signing in with Google](sso.md#signing-in-with-google).

## Through the API

| Method and path | What it does |
|---|---|
| `GET /api/v1/me/managed-tracks` | The tracks the person runs, by key, 500 a page: `limit` (500 at most) and `after`, the `next` of the page before; `next` is null on the last page |
| `GET /api/v1/tracks/:id/roles` | The roles, with `runsTrack` and `givable` |
| `GET`, `POST /api/v1/tracks/:id/invitations` | Waiting invitations, with `emailAvailable` and `canCopyLinks`; invite (`addresses`, `userIds`, `roleId`, `delivery`, and `createTracks`) |
| `PUT /api/v1/tracks/:id/roles/:roleId/users/:userId` | Give a person a role; `{"createTracks": true}` with a role that runs the track |
| `POST /api/v1/tracks/:id/invitations/:invitationId/resend` | A new link (`delivery`); `"link"` only for those who may copy links |
| `DELETE /api/v1/tracks/:id/invitations/:invitationId` | Withdraw |
| `POST /api/v1/invitations/inspect`, `redeem`, `accept` | The invited person's side: the token in the body, `accept` with a session |

The invitation routes need an API token's `admin` scope. So does `createTracks` when giving a role,
since it writes a site-wide grant; giving the role alone needs `write`. In the audit log, `track_invitation.created`,
`.resent`, `.revoked` and `.accepted` name who did it and how the link travelled, never the link; an
account made through a link shows as `accountCreated: true` on `.accepted`.
