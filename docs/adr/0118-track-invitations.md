# ADR-118: Invitations into a track, and who may appoint a track's administrators

- Status: Accepted
- Date: 2026-11-03
- Backlog: track invitations (workstream `claude/track-invites`); requirements IAM-027 to IAM-030

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
links. A link can also be chosen where mail works. The answer carries it once, and the database
never holds it.

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

## Options considered

| Option | For | Against |
|---|---|---|
| Two track permissions in access policies (chosen) | Per policy, explained, audited, works with the existing page | Everyone must learn two more permissions |
| A site-wide on/off setting | One switch | Not per track or per group; a second place that says who may do what |
| Only site administrators give the Administrators role | Simplest and strictest | The user changed this on 2026-11-03: managers appoint by default |
| Keep every invitation pending, also for existing accounts | No leak through the role list | The user asked for the role at once |
| Create the account at invitation time | Simpler accept | Junk accounts for every typo; the People page lists people who never came |
| Sign in directly after redeeming, as password links do | One step fewer in code | Skips two-factor, which breaks the external-people rule |

## Consequences

- Upgrades: nobody loses or gains an ability; the upgrade seed proves the grants and the table.
- The one-event rule holds: redeeming and accepting emit `track_invitation.accepted`, whose payload
  says whether an account was made and which role was given, rather than three events. A person
  picked by name emits `track_role.actor_added`. `user.created` is therefore **not** emitted for an
  account made this way; the audit log shows `accountCreated: true`.
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
