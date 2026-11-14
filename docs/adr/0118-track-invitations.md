# ADR-118: Invitations into a track, and who may appoint a track's administrators

- Status: Accepted
- Date: 2026-11-03
- Backlog: track invitations (workstream `claude/track-invites`); requirements IAM-027 to IAM-030;
  who may create tracks (T-087a, IAM-033); the permission goes with the role (T-087b, 2026-11-13)

## Context

Accounts come from a site administrator, a single sign-on provider, a directory or SCIM. There
is no way for the person who runs a track to bring someone in, and no page in the web app for a
track's administrators who are not site administrators, although the server has let them manage
their track's roles since M1-002. A self-hosted site may have no mail server, and nobody runs a
hosted service for it: importing people from outside services or adding reCAPTCHA would mean
every operator bringing their own accounts, so neither is built.

The user decided on 2026-11-03:

1. People sign in with their email address, personal or company; accounts are not limited to a
   domain. No open sign-up: people come in by invitation.
2. Invite by email with a set role; a manager with the invite permission can invite brand-new
   users, not only existing ones.
3. Site administrators decide who may invite: a permission they can give and take away, off
   until they turn it on. Site administrators can always invite.
4. Track managers' web pages are part of 1.0.
5. Track managers **can** appoint other managers by default, and this must be a permission that
   can be removed. It reaches only the track they run, and gives nothing global. (This replaces
   an earlier decision the same day that only site administrators could.)
6. Who creates tracks (`decisions.csv`, "Who creates tracks"): the permission to create tracks is
   ticked by default when someone is given the manager role, and can be unticked in that same
   step. Read with it, and implemented: on a new site it is off for everyone else by default.

## Decision

### Two new track permissions

Both are in the **Administration** group of the catalogue, so access policies grant, list and
explain them like any other, and a site administrator holds them everywhere.

- **`invite_people`** ("Invite people"). No default grant, on new installs or upgrades: inviting
  is **off until a site administrator turns it on**, by giving it in an access policy, usually
  to the Administrators role. To invite, a person needs it **and** `administer_track`, so an
  inviter always runs the track. Only a site administrator gives or takes it, including through
  a policy's copy. A configuration administrator does not hold it through their global
  permission, and neither gives it nor keeps it when copying a policy. A local-mode track's copy
  of the default policy leaves it out: anyone may make a local-mode track, and that must not be a
  way around the site administrator's decision.
- **`appoint_track_admins`** ("Give the role that runs the track"). Migration 0087 gives it
  **wherever `administer_track` is granted** on every existing policy, whoever the grantee: so
  upgrades change nobody's abilities, the Administrators role and the track owner hold it on a
  new install, and imports add the same pair. A policy's editors can remove it. Without it, a
  track's administrators still give and remove every other role.

A separate permission fits the model better than a setting or a flag: the access policy is where
a site already says who may do what per track, the explainer and the Permissions page work
unchanged, and "off for this group of tracks" is simply another policy.

**A role that runs the track** is one the track's access policy gives `administer_track`. The
grants decide, not the role's name, so renaming Administrators changes nothing.

Giving or taking such a role needs `appoint_track_admins`:

- `PUT` and `DELETE` of a track's role actors, for people and for groups. Taking is the same
  decision as giving, including taking it from oneself.
- An invitation with that role, and resending or withdrawing one.
- Changing a track's owner, because the owner may run the track (site and configuration
  administrators keep this, as before).
- On a local-mode track's own policy, its administrators may change grants of `administer_track`
  and `appoint_track_admins` only while they hold `appoint_track_admins`. Otherwise they could
  hand it back to themselves, or appoint through the policy what they may not appoint through a
  role. On any other policy these grants belong to the policy's editors, as all grants do.

Nothing here reaches beyond the one track: a manager who removes a site administrator from the
Administrators role of a track changes that row and nothing else. The site administrator keeps
their flag and every other track.

### The last administrator

The code base already refuses to demote the last active site administrator
(`activeAdminCount`), so a track gets the same protection: a removal that would leave a track with
**no active person who holds `administer_track`** answers `409 last_track_admin`, for everyone,
site administrators included; they run every track anyway and do not count. People count through
a role, a group (nested too), a direct grant, or as owner. Also refused: withdrawing an invitation
whose role was the last, and removing the last such grant from a local-mode track's own policy.
Not covered: removing a grant from a shared policy (its editors change it for all its tracks at
once) and deactivating or erasing the person (a site administrator's act about the person; the
site administrator can still run the track).

### Invitations

`track_invitation` holds one address, one track, one role, one inviter. The link's token is random
(256 bits), stored only as a SHA-256 hash like `password_link`, works once and expires in **seven
days**, since people read such mail later than a password link's three days allow. There is at most
one open invitation per track and address. An invitation grants nothing global. The email has no
free-text message, so it cannot carry someone's advert. A failed send is shown on the invitation;
nothing retries by itself, because a queue would have to keep the token. Sending happens in the
request, after the commit.

A new link replaces the old. A row is `lapsed` once it runs out or its inviter no longer may give
it: **taking the permission away, or the inviter leaving, ends their open links**, and a site
administrator can resend, which makes the invitation theirs.

**An address with an account** gets the role at once and a different email. If they were picked by
name, nothing waits. If they were given as an address, the row still waits on the list, so the list
reads the same as for a new address; withdrawing it takes back only a role this invitation gave.

**Answers do not reveal accounts.** The invite answer, the list and the link's page are the same for
either kind of address, deactivated accounts included. Every page offers both ways in.
`redeem` hashes the password whichever kind it is and answers the same; for an existing account it
changes nothing and leaves the link open. **A link can never set an existing account's password**,
which matters because a copied link passes through the inviter's hands. Taking up an invitation
for an existing account needs a session as that very address (`accept`).

**Setting a password does not sign in.** `password-links/redeem` starts a session; `invitations/redeem`
does not. The page calls the ordinary sign-in next, with the password just typed, so whatever
sign-in requires it still requires. That is how the invitation flow copes with the external-people
rule (decided 2026-10-30; IAM-004, M1-085), which is unchanged: an address outside the
organization's domain list, on a site that has set one, must set up two-factor before getting a
session. The inviter is told at the invitation, and the person on the page, from the address and the
site's rules alone.

**No mail server.** `emailAvailable` comes with the list; the dialog says so plainly and offers only
links. The answer carries it once, and the database never holds it.

**Where mail works, only site administrators copy links** (the user's decision of 2026-11-13,
T-053). A copied link skips the proof that the mailbox is the invited person's, so where the site
sends email a link is for site administrators alone: anyone else who asks for one, on an invitation
or a resend, is refused `403 email_invitations_only` before anything is written, and their
invitations go by email. The list carries `canCopyLinks` so the web app hides **New link** and the
choice of delivery, and says why in one line. Without a mail server nothing changes: a link is the
only way, for everyone who may invite. Earlier, any inviter could choose a link where mail worked.

**Single sign-on.** An invitation can be accepted by signing in through an enabled provider that
vouches for that same address: the page's sign-in returns to the link, and `accept` does the rest.
A provider with **Create accounts at a first sign-in** off makes an account only for a verified
address, in its own domains, with a live invitation (`invitationOpensAccount`); any other address
with no account is still refused `no_account`. Nothing here names a particular provider. A domain
that enforces single sign-on refuses a password (`sso_required`) and the page moves to signing in.

**Limits.** Fifty addresses a request. Sends are limited per inviter (100 at once, 100 an hour) and
per address, whoever sends (5 at once, 5 an hour), in each API process's memory like the other rate
limits (ADR-075), so a client may reach them once per process. Unknown tokens count against the
client address, as password links do.

**API tokens.** The invitation routes need the `admin` scope, since they let people in; `accept`
needs a person at a browser. `/api/v1/tracks/:id/roles` and the role-actor routes stay as they were.

### Web pages

Administration (first Settings; moved with ADR-114) gains **Tracks you run** (`#/manage/tracks`), listing what `allowedTracks('administer_track')`
returns. Each leads to `#/manage/tracks/:id`: who holds which role, giving and taking roles, the
invite dialog and the waiting invitations. It reads a person's name search from the existing
`GET /people/mentionable`, so **See people and groups** decides whether a manager can search by name.
The group list stays a site administrator's: a manager sees and removes groups, but gives roles to
people. `#/admin/tracks` keeps its own panel and links to the same page. The invited person's page
(`#/invite`) stands alone, like a password link.

### Who may create tracks (T-087a; IAM-033)

The permission is the existing global `create_local_tracks` (**Create tracks with their own
configuration**); shared-mode tracks stay with site and configuration administrators. Migration 0004
gives it to everyone signed in, and a site set up before keeps that: no migration changes a grant.
**First-run setup removes that grant**, so on a new site only site administrators (who hold every
global permission) create tracks until someone is given it. Setup is where the other new-site
defaults are written (two-factor for administrators, storage quotas), and it runs once, so an
upgraded site is never touched.

**The box.** Giving a person a role that runs the track (`runsTrack`) offers **Also let them create
tracks**, ticked; the giver may untick it. It is on both ways of giving the role: **Give a role**
(`PUT .../roles/:roleId/users/:userId` with `{"createTracks": true}`) and an invitation
(`createTracks` in `POST .../invitations`). Ticked, it writes an ordinary `global_grant` to that
person, so the Permissions page, the explainer and the authorizer's cache work unchanged.

The rules, which the server enforces whatever the web app shows:

- **Only someone who could give it anyway ticks it**: a site administrator, or a person who holds
  `create_local_tracks` themselves. As with sharing, nobody hands on what they do not have. Anyone
  else gets no box, and a request that asks is refused `403` with `permission: "create_local_tracks"`,
  and nothing is changed: not the role either.
- **A token needs the admin scope** to tick it, since it writes a site-wide grant (`403
  insufficient_scope`); giving the role alone still needs `write`. The invitation routes needed
  `admin` already.
- **Only with a role that runs the track, only to a person, only with a role given now.** Another
  role or a group answers `400`; a person who already holds the role gets nothing more, and a person
  who already has a grant of their own keeps it, and no second one is written.
- **One event.** The grant's id travels in the event of the change that gave the role,
  `createTracksGrantId` on `track_role.actor_added`, `track_invitation.created`, `.resent` or
  `.accepted`, and so in its audit record; there is no `global_grant.added` beside it (M1-005). The
  field is optional, so older events still match their type.
- **Invitations keep the box** (`track_invitation.grants_create_tracks`, migration 0097) until the
  role is given: at once for an address with an account, otherwise when the link is taken up. Then
  the grant is written only if whoever backs the invitation (its inviter, or whoever sent it again)
  still may give it. If not, the role still comes, alone, as an invitation's role does.

**The grant goes with the role** (T-087b, the user's decision of 2026-11-13, replacing "removing
the role leaves the grant"). When someone loses the manager role, the permission to create tracks
that came with it goes too:

- **Which grant.** Only one that came with a role: a `global_grant` whose id a
  `track_role.actor_added`, `track_invitation.created`, `track_invitation.resent` or
  `track_invitation.accepted` event names as `createTracksGrantId`. The events are the record of where it came from; no column was added.
  **A grant given separately stays**: one a site administrator gave on **Global permissions**, and
  one the person already held when the box was ticked (no second grant is written, so the event
  names none). A site administrator removes those as before. A site administrator who wants a
  former manager to keep creating tracks gives the permission again there, and it then stays.
- **When.** Once the person runs no track: they hold `administer_track` on no live track through a
  role (their own, a group's, nested groups included, or one a shared track group gave), a grant
  to them, a group of theirs, every signed-in person or anyone, or as an owner (the ways
  `trackKeepsAdministrator` counts), or they are deactivated. Someone who still runs another track keeps it: they are still a manager.
- **Where.** Every change that can take that last role away, in its own transaction: taking a
  person's or a group's role on the People page, withdrawing an invitation that gave the role at
  once, removing someone from a group, taking a group out of another, deleting a group, deactivating
  a person (Administration, SCIM `active: false` or DELETE, and every directory deactivation: an
  entry removed or disabled, an account linked to a disabled entry, a directory deleted, all through
  `ldap/accounts.ts` `deactivateAccount`), a SCIM group's members or deletion, every take-back of
  what shared track groups gave (a share taken back, a group left or deleted, a track moved out of
  a shared group, and an erasure, through `trackgroups/access.ts` `releaseShares`; ADR-121), and the
  erasure of the person themselves, who is deactivated with it.
- **One event.** The change's own event lists what went, `createTracksGrantsRemoved: [{ userId,
  grantId }]`, on `track_role.actor_removed`, `track_invitation.revoked`, `group.member_removed`,
  `group.unnested`, `group.deleted`, `user.deactivated`, `user.erased`, `scim.user_updated`,
  `scim.user_removed`, `scim.group_updated`, `scim.group_deleted`, `directory.user_removed`,
  `directory.user_updated`, `directory.user_created`, `directory.deleted`, `track_group.unshared`,
  `track_group.left`, `track_group.deleted`, `track_group.created` and `track_group.track_moved`,
  and so its audit record; no `global_grant.removed` beside it (M1-005). Optional, so older
  events still match.
- **Cost.** The check reads the events only for a person who holds a grant of their own and runs
  no track any more; it scans `domain_event` by type, which a site with many events may notice on
  those rare changes. A column on `global_grant` saying where it came from would make it one read;
  that needs a migration, left for when one is due.
- **Not covered**, since they take no person's role away directly: a role losing `administer_track`
  in an access policy, a track moved to another policy, a track deleted, a role deleted, and a
  directory sync's or single sign-on's group changes for a person who stays active. Those leave the
  grant until the person's next change of the kinds above or a site administrator removes it.
  Reactivating a person does not give it back.

## Options considered

| Option | For | Against |
|---|---|---|
| Two track permissions in access policies (chosen) | Per policy, explained, audited, works with the existing page | Everyone must learn two more permissions |
| A site-wide on/off setting | One switch | Not per track or per group; a second place that says who may do what |
| Only site administrators give the Administrators role | Simplest and strictest | The user changed this on 2026-11-03: managers appoint by default |
| Keep every invitation pending, also for existing accounts | No leak through the role list | The user asked for the role at once |
| Create the account at invitation time | Simpler accept | Junk accounts for every typo; the People page lists people who never came |
| Sign in directly after redeeming, as password links do | One step fewer in code | Skips two-factor, which breaks the external-people rule |
| Create tracks: anyone who gives the manager role may tick the box (rejected) | Fewer refusals | A manager could hand on a site-wide permission they do not hold |
| Create tracks: a migration removes everyone's grant on upgrade (rejected) | One default everywhere | Takes an ability away from people on an upgraded site; the user asked only about new sites |
| Create tracks: removing the role removes the grant that came with it, once the person runs no track (chosen, T-087b) | A former manager cannot keep creating tracks | Reads the events to tell a role's grant from one given separately |
| Create tracks: removing the role leaves the grant (the first build; replaced 2026-11-13) | Never takes a right given for another reason | A former manager keeps a site-wide right nobody meant to leave them |
| Create tracks: removing a role removes any grant the person holds (rejected) | No record needed | Takes a permission a site administrator gave separately |

## Consequences

- Upgrades: nobody loses or gains an ability; the upgrade seed proves the grants and the table.
- The one-event rule holds: redeeming and accepting emit `track_invitation.accepted`, whose payload
  says whether an account was made and which role was given, rather than three events. A person
  picked by name emits `track_role.actor_added`. `user.created` is therefore **not** emitted for an
  account made this way; the audit log shows `accountCreated: true`.
- Who may create tracks: nobody gains or loses anything on upgrade; the upgrade seed proves the
  grant to everyone and the invitation column. A new site differs from an upgraded one only in that
  grant, and the manual says how to remove it on an older site.
- What remains visible, and is accepted here: a manager who invites an address sees a new name in the
  role list when that address had an account; anyone holding a copied link can tell the two kinds
  apart by trying to use it; and `GET /people/mentionable` already matches an email's start for
  anyone holding **See people and groups**.
- A copied link lets whoever holds it make the new account at that address without proving the
  mailbox is theirs, as an administrator's activation link does. The choice is recorded as
  `delivery: "link"` in the audit log, and the page warns.
- Single sign-on does not ask for Taskmoor's second factor (`admin/sso.md`): the provider's own
  checks apply. So an external person who comes in through a provider gets no Taskmoor second
  factor. That is the existing rule for single sign-on, unchanged here.

Revisit if sites want a custom message in the email, or invitations into several tracks at once.
